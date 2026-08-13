const express = require('express');
const router = express.Router();
const mikrotik = require('../helpers/mikrotik');
let pool;

router.setPool = (dbPool) => { pool = dbPool; };

// Helper: get first available router
async function getRouter() {
    const [routers] = await pool.query('SELECT * FROM routers LIMIT 1');
    return routers.length > 0 ? routers[0] : null;
}

// GET /hotspot — Fetch real hotspot users from MikroTik
router.get('/', async (req, res) => {
    try {
        const routerData = await getRouter();
        let users = [];
        let profiles = [{ name: 'default' }];
        let active = [];
        let routerOnline = false;

        if (routerData) {
            const usersResult = await mikrotik.getHotspotUsers(routerData);
            if (usersResult.success) {
                users = usersResult.data;
                routerOnline = true;
            }

            const profilesResult = await mikrotik.getHotspotProfiles(routerData);
            if (profilesResult.success && profilesResult.data.length > 0) {
                profiles = profilesResult.data;
            }

            const activeResult = await mikrotik.getHotspotActive(routerData);
            if (activeResult.success) {
                active = activeResult.data;
                // Mark online users
                const activeSet = new Set(active.map(a => a.user));
                users = users.map(u => ({
                    ...u,
                    isOnline: activeSet.has(u.name)
                }));
            }
        }

        res.render('hotspot', { user: req.session, users, profiles, routerOnline, routerData, currentPage: 'hotspot' });
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// POST /hotspot/api/user/add — Add hotspot user to MikroTik
router.post('/api/user/add', async (req, res) => {
    const { username, password, profile } = req.body;
    try {
        const routerData = await getRouter();
        if (!routerData) return res.json({ success: false, message: 'Belum ada router yang terdaftar' });

        const result = await mikrotik.addHotspotUser(routerData, username, password, profile || 'default');
        if (result.success) {
            res.json({ success: true, message: `User hotspot "${username}" berhasil ditambahkan ke ${routerData.name}` });
        } else {
            res.json({ success: false, message: `Gagal: ${result.message}` });
        }
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// DELETE /hotspot/api/user/:name — Remove hotspot user from MikroTik
router.delete('/api/user/:name', async (req, res) => {
    try {
        const routerData = await getRouter();
        if (!routerData) return res.json({ success: false, message: 'Belum ada router yang terdaftar' });

        const result = await mikrotik.removeHotspotUser(routerData, req.params.name);
        if (result.success) {
            res.json({ success: true, message: `User "${req.params.name}" berhasil dihapus dari router` });
        } else {
            res.json({ success: false, message: `Gagal: ${result.message}` });
        }
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /hotspot/api/profile/add — Add hotspot profile to MikroTik
router.post('/api/profile/add', async (req, res) => {
    const { name, rateLimit, sharedUsers } = req.body;
    try {
        const routerData = await getRouter();
        if (!routerData) return res.json({ success: false, message: 'Belum ada router yang terdaftar' });

        const result = await mikrotik.addHotspotProfile(routerData, name, rateLimit, sharedUsers || 1);
        if (result.success) {
            res.json({ success: true, message: `Profile "${name}" berhasil ditambahkan` });
        } else {
            res.json({ success: false, message: `Gagal: ${result.message}` });
        }
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /hotspot/api/generate — Generate vouchers
router.post('/api/generate', async (req, res) => {
    const { count, profile, price, length, prefix, characters } = req.body;
    try {
        const vouchers = [];
        const charPool = characters || 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        
        // Let's get existing codes to prevent database duplicates
        const [existingRows] = await pool.query('SELECT code FROM vouchers');
        const existingCodes = new Set(existingRows.map(r => r.code));
        
        let attempts = 0;
        const maxAttempts = (count || 10) * 10;
        
        while (vouchers.length < (count || 10) && attempts < maxAttempts) {
            attempts++;
            let randomCode = '';
            for (let j = 0; j < (length || 6); j++) {
                const randomIndex = Math.floor(Math.random() * charPool.length);
                randomCode += charPool[randomIndex];
            }
            const code = (prefix || '') + randomCode;
            
            if (!existingCodes.has(code)) {
                existingCodes.add(code);
                vouchers.push([code, price || 0, profile || 'default']);
            }
        }
        
        if (vouchers.length === 0) {
            return res.status(400).json({ success: false, message: 'Tidak dapat men-generate voucher dengan pengaturan karakter tersebut' });
        }
        
        // Insert into database
        await pool.query('INSERT INTO vouchers (code, price, profile) VALUES ?', [vouchers]);
        
        // Sync to MikroTik if active router exists
        const routerData = await getRouter();
        if (routerData) {
            await mikrotik.safeExecute(routerData, async (api) => {
                for (const v of vouchers) {
                    const code = v[0];
                    const profileName = v[2];
                    const params = [
                        '=name=' + code,
                        '=password=' + code,
                        '=profile=' + profileName
                    ];
                    try {
                        await api.write('/ip/hotspot/user/add', params);
                    } catch (err) {
                        console.error(`[MikroTik] Failed to add user ${code} during bulk generate:`, err.message);
                    }
                }
            }).catch(e => {
                console.error("[MikroTik] Bulk generate failed to connect/write:", e.message);
            });
        }
        
        res.json({ success: true, message: `${vouchers.length} voucher berhasil digenerate` });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// DELETE /hotspot/api/voucher/:id — Delete a single voucher
router.delete('/api/voucher/:id', async (req, res) => {
    try {
        const [[voucher]] = await pool.query('SELECT code FROM vouchers WHERE id = ?', [req.params.id]);
        if (voucher) {
            const routerData = await getRouter();
            if (routerData) {
                await mikrotik.removeHotspotUser(routerData, voucher.code).catch(() => {});
            }
        }
        await pool.query('DELETE FROM vouchers WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Voucher berhasil dihapus' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// DELETE /hotspot/api/vouchers/used — Delete all used vouchers
router.delete('/api/vouchers/used', async (req, res) => {
    try {
        const [result] = await pool.query("DELETE FROM vouchers WHERE status = 'used'");
        res.json({ success: true, message: `${result.affectedRows} voucher used berhasil dihapus` });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// GET /hotspot/print
router.get('/print', async (req, res) => {
    const { ids } = req.query;
    try {
        let vouchers;
        if (ids) {
            const idList = ids.split(',').map(id => parseInt(id));
            [vouchers] = await pool.query('SELECT * FROM vouchers WHERE id IN (?)', [idList]);
        } else {
            [vouchers] = await pool.query('SELECT * FROM vouchers ORDER BY created_at DESC LIMIT 50');
        }
        res.render('print_vouchers', { vouchers });
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// GET /hotspot/vouchers
router.get('/vouchers', async (req, res) => {
    try {
        const [vouchers] = await pool.query('SELECT * FROM vouchers ORDER BY created_at DESC LIMIT 100');
        res.render('vouchers', { user: req.session, vouchers, currentPage: 'vouchers' });
    } catch (err) {
        res.status(500).send(err.message);
    }
});

module.exports = router;
