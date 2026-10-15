const express = require('express');
const router = express.Router();
let pool;

router.setPool = (dbPool) => { pool = dbPool; };

const HiosoOLT = require('../helpers/olt');
const { logActivity } = require('../helpers/logger');

function normalizeBrand(brand) {
    return (brand || 'HIOSO').toString().trim().toUpperCase();
}

function isCdataBrand(brand) {
    const b = normalizeBrand(brand);
    return b === 'CDATA' || b === 'C-DATA';
}

// GET /olt
router.get('/', async (req, res) => {
    try {
        const [olts] = await pool.query('SELECT * FROM hioso_olts');
        const [onus] = await pool.query(`
            SELECT u.*, o.name as olt_name, o.brand as olt_brand
            FROM hioso_onus u 
            JOIN hioso_olts o ON u.olt_id = o.id 
            ORDER BY u.olt_id ASC, u.status DESC, u.rx_power ASC
        `);
        
        res.render('olt', { user: req.session, olts, onus, currentPage: 'olt' });
    } catch (err) {
        console.error(err);
        res.status(500).send("Database error: " + err.message);
    }
});

// Real Sync API using SNMP
router.post('/api/sync', async (req, res) => {
    try {
        const [olts] = await pool.query('SELECT * FROM hioso_olts WHERE status = "active"');
        
        if (olts.length === 0) {
            return res.json({ success: false, message: 'Belum ada OLT yang terdaftar atau aktif.' });
        }

        let totalOnus = 0;
        let successCount = 0;
        let errorMessages = [];

        for (const olt of olts) {
            try {
                const helper = new HiosoOLT(olt.host, olt.community, olt.port);
                const brand = normalizeBrand(olt.brand);
                let onus, detectedProfile;

                if (isCdataBrand(olt.brand)) {
                    ({ onus, detectedProfile } = await helper.getCdataOnuList());
                } else {
                    const profile = brand === 'HIOSO' ? (olt.last_profile || 'HIOSO_C') : olt.brand;
                    ({ onus, detectedProfile } = await helper.getOnuList(profile));
                }

                if (detectedProfile && detectedProfile !== olt.last_profile && !isCdataBrand(olt.brand)) {
                    await pool.query('UPDATE hioso_olts SET last_profile = ? WHERE id = ?', [detectedProfile, olt.id]);
                }

                // Clear old data for this OLT
                await pool.query('DELETE FROM hioso_onus WHERE olt_id = ?', [olt.id]);

                // Bulk Insert new data
                if (onus.length > 0) {
                    const values = onus.map(o => [olt.id, o.index, o.name, o.sn || 'Unknown', o.mac || '', o.tx_power, o.rx_power, o.status]);
                    await pool.query(`
                        INSERT INTO hioso_onus (olt_id, onu_index, name, sn, mac, tx_power, rx_power, status) 
                        VALUES ?
                    `, [values]);
                    totalOnus += onus.length;
                }
                successCount++;
            } catch (err) {
                console.error(`[OLT SYNC] Error for ${olt.name}:`, err.message);
                errorMessages.push(`${olt.name}: ${err.message}`);
            }
        }
        
        if (successCount === 0) {
            return res.json({ success: false, message: 'Gagal sinkronisasi OLT: ' + errorMessages.join(', ') });
        }

        await logActivity(pool, req.session.role || 'system', req.session.userId, req.session.username, 'Sync OLT', req.ip, `Sinkronisasi OLT selesai. Total ${totalOnus} ONU ditemukan.`);

        res.json({ 
            success: true, 
            message: `Sinkronisasi selesai. Berhasil: ${successCount}/${olts.length} OLT. Total ${totalOnus} ONU ditemukan.` 
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Reboot ONU API
router.post('/api/reboot', async (req, res) => {
    const { olt_id, index } = req.body;
    try {
        const [[olt]] = await pool.query('SELECT * FROM hioso_olts WHERE id = ?', [olt_id]);
        if (!olt) return res.json({ success: false, message: 'OLT tidak ditemukan' });

        const helper = new HiosoOLT(olt.host, olt.community, olt.port);
        const success = await helper.rebootOnu(index, olt.web_user, olt.web_password);
        
        if (success) {
            await logActivity(pool, req.session.role || 'system', req.session.userId, req.session.username, 'Reboot ONU', req.ip, `Mengirim perintah reboot ke ONU ${index} (OLT ID: ${olt_id})`);
            res.json({ success: true, message: `Perintah reboot berhasil dikirim ke ONU ${index}` });
        } else {
            res.json({ success: false, message: 'Gagal mengirim perintah reboot. Cek kredensial Web OLT di pengaturan.' });
        }
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Set ONU VLAN API
router.post('/api/onu/vlan', async (req, res) => {
    const { olt_id, index, vlan_id } = req.body;
    try {
        const [[olt]] = await pool.query('SELECT * FROM hioso_olts WHERE id = ?', [olt_id]);
        if (!olt) return res.json({ success: false, message: 'OLT tidak ditemukan' });

        const helper = new HiosoOLT(olt.host, olt.community, olt.port);
        if (isCdataBrand(olt.brand)) {
            return res.json({ success: false, message: 'Setting VLAN via SNMP belum didukung untuk OLT CData.' });
        }
        const success = await helper.setOnuVlan(index, vlan_id, olt.last_profile || (normalizeBrand(olt.brand) === 'HIOSO' ? 'HIOSO_C' : olt.brand));
        
        if (success) {
            await logActivity(pool, req.session.role || 'system', req.session.userId, req.session.username, 'Set ONU VLAN', req.ip, `VLAN ID ${vlan_id} diatur pada ONU ${index} (OLT ID: ${olt_id})`);
            res.json({ success: true, message: `VLAN ID ${vlan_id} berhasil diatur pada ONU ${index}` });
        } else {
            res.json({ success: false, message: 'Gagal mengatur VLAN. Pastikan OLT mendukung perintah ini.' });
        }
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// CRUD for OLTs
router.post('/api/olts', async (req, res) => {
    const { name, host, port, community, web_user, web_password, brand, model } = req.body;
    try {
        await pool.query(
            'INSERT INTO hioso_olts (name, host, port, community, web_user, web_password, brand, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 
            [name, host, port || 161, community || 'public', web_user || 'admin', web_password || 'admin', brand || 'HIOSO', model || null]
        );
        await logActivity(pool, req.session.role || 'system', req.session.userId, req.session.username, 'Add OLT', req.ip, `Menambahkan OLT: ${name} (${host})`);
        res.json({ success: true, message: 'OLT berhasil ditambahkan' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.put('/api/olts/:id', async (req, res) => {
    const { name, host, port, community, status, web_user, web_password, brand, model } = req.body;
    try {
        await pool.query(
            'UPDATE hioso_olts SET name=?, host=?, port=?, community=?, status=?, web_user=?, web_password=?, brand=?, model=? WHERE id=?', 
            [name, host, port, community, status, web_user, web_password, brand || 'HIOSO', model || null, req.params.id]
        );
        await logActivity(pool, req.session.role || 'system', req.session.userId, req.session.username, 'Update OLT', req.ip, `Memperbarui OLT: ${name} (${host})`);
        res.json({ success: true, message: 'OLT berhasil diperbarui' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.delete('/api/olts/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM hioso_olts WHERE id=?', [req.params.id]);
        await logActivity(pool, req.session.role || 'system', req.session.userId, req.session.username, 'Delete OLT', req.ip, `Menghapus OLT ID: ${req.params.id}`);
        res.json({ success: true, message: 'OLT berhasil dihapus' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/api/test', async (req, res) => {
    const { host, community } = req.body;
    try {
        const helper = new HiosoOLT(host, community || 'public');
        // Test with a basic SysName OID
        const sysName = await helper.walk('1.3.6.1.2.1.1.5.0');
        res.json({ 
            success: true, 
            message: `Berhasil! OLT merespon via SNMP: ${(sysName[0] && sysName[0].value) ? sysName[0].value.toString() : 'Connected'}` 
        });
    } catch (e) {
        res.json({ success: false, message: `Gagal SNMP ke ${host}: ${e.message}` });
    }
});

module.exports = router;
