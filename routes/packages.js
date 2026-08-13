const express = require('express');
const router = express.Router();
let pool;
const { logActivity } = require('../helpers/logger');

router.setPool = (dbPool) => { pool = dbPool; };

router.get('/', async (req, res) => {
    try {
        const [packages] = await pool.query('SELECT * FROM packages ORDER BY price ASC');
        res.render('packages', { user: req.session, packages, currentPage: 'packages' });
    } catch (err) {
        res.status(500).send("Database error: " + err.message);
    }
});

router.post('/api', async (req, res) => {
    const { name, price, speed_limit, description, type, duration, sync_mikrotik, is_isolir } = req.body;
    try {
        if (sync_mikrotik) {
            const mikrotik = require('../helpers/mikrotik');
            const [routers] = await pool.query('SELECT * FROM routers WHERE status = "active"');
            for (const r of routers) {
                if (type === 'hotspot') {
                    await mikrotik.addHotspotProfile(r, name, speed_limit);
                } else {
                    await mikrotik.addPPPProfile(r, name, speed_limit);
                }
            }
        }
        const valIsolir = is_isolir ? 1 : 0;
        if (valIsolir) {
            await pool.query('UPDATE packages SET is_isolir = 0');
        }
        await pool.query('INSERT INTO packages (name, price, speed_limit, description, type, duration, is_isolir) VALUES (?, ?, ?, ?, ?, ?, ?)', [name, price, speed_limit, description, type || 'pppoe', duration || null, valIsolir]);
        await logActivity(pool, req.session.role, req.session.userId, req.session.username, 'CREATE_PACKAGE', req.ip, `Menambahkan paket ${name}`);
        res.json({ success: true, message: 'Paket berhasil ditambahkan' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.put('/api/:id', async (req, res) => {
    const { name, price, speed_limit, description, type, duration, sync_mikrotik, is_isolir } = req.body;
    try {
        const [oldPkg] = await pool.query('SELECT * FROM packages WHERE id = ?', [req.params.id]);
        if (oldPkg.length > 0 && sync_mikrotik) {
            const oldName = oldPkg[0].name;
            const mikrotik = require('../helpers/mikrotik');
            const [routers] = await pool.query('SELECT * FROM routers WHERE status = "active"');
            for (const r of routers) {
                if (type === 'hotspot') {
                    await mikrotik.editHotspotProfile(r, oldName, name, speed_limit);
                } else {
                    await mikrotik.editPPPProfile(r, oldName, name, speed_limit);
                }
            }
        }
        const valIsolir = is_isolir ? 1 : 0;
        if (valIsolir) {
            await pool.query('UPDATE packages SET is_isolir = 0');
        }
        await pool.query('UPDATE packages SET name=?, price=?, speed_limit=?, description=?, type=?, duration=?, is_isolir=? WHERE id=?', [name, price, speed_limit, description, type || 'pppoe', duration || null, valIsolir, req.params.id]);
        await logActivity(pool, req.session.role, req.session.userId, req.session.username, 'UPDATE_PACKAGE', req.ip, `Memperbarui paket ${name}`);
        res.json({ success: true, message: 'Paket berhasil diperbarui' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.delete('/api/:id', async (req, res) => {
    try {
        const { sync_mikrotik } = req.query;
        const [oldPkg] = await pool.query('SELECT * FROM packages WHERE id = ?', [req.params.id]);
        
        if (oldPkg.length > 0 && sync_mikrotik === 'true') {
            const mikrotik = require('../helpers/mikrotik');
            const [routers] = await pool.query('SELECT * FROM routers WHERE status = "active"');
            for (const r of routers) {
                if (oldPkg[0].type === 'hotspot') {
                    await mikrotik.removeHotspotProfile(r, oldPkg[0].name);
                } else {
                    await mikrotik.removePPPProfile(r, oldPkg[0].name);
                }
            }
        }

        await pool.query('DELETE FROM packages WHERE id = ?', [req.params.id]);
        await logActivity(pool, req.session.role, req.session.userId, req.session.username, 'DELETE_PACKAGE', req.ip, `Menghapus paket ID ${req.params.id}`);
        res.json({ success: true, message: 'Paket berhasil dihapus' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.get('/api/mikrotik-profiles', async (req, res) => {
    try {
        const mikrotik = require('../helpers/mikrotik');
        const [routers] = await pool.query('SELECT * FROM routers LIMIT 1'); // Use the first router to get profiles
        if (routers.length === 0) return res.json({ success: false, message: 'Belum ada router yang terdaftar' });
        
        const result = await mikrotik.getPPPProfiles(routers[0]);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.get('/api/mikrotik-hotspot-profiles', async (req, res) => {
    try {
        const mikrotik = require('../helpers/mikrotik');
        const [routers] = await pool.query('SELECT * FROM routers LIMIT 1'); 
        if (routers.length === 0) return res.json({ success: false, message: 'Belum ada router yang terdaftar' });
        
        const result = await mikrotik.getHotspotProfiles(routers[0]);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

module.exports = router;
