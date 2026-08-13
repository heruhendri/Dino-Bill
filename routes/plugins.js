const express = require('express');
const router = express.Router();
let pool;

router.setPool = (dbPool) => { pool = dbPool; };

// Middleware to check if user is admin
const isAdmin = (req, res, next) => {
    if (req.session.role !== 'admin') {
        return res.status(403).send("Forbidden: Hanya Admin yang bisa mengelola plugin.");
    }
    next();
};

router.get('/', isAdmin, async (req, res) => {
    try {
        const [plugins] = await pool.query('SELECT * FROM plugins ORDER BY name ASC');
        res.render('plugins', { 
            user: req.session, 
            plugins,
            currentPage: 'plugins' 
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Database error: " + err.message);
    }
});

router.post('/activate/:id', isAdmin, async (req, res) => {
    const { license_key } = req.body;
    const pluginId = req.params.id;

    try {
        // 1. Get Plugin Info
        const [[plugin]] = await pool.query('SELECT * FROM plugins WHERE id = ?', [pluginId]);
        if (!plugin) return res.status(404).json({ success: false, message: 'Plugin tidak ditemukan' });

        // 2. Fetch Central Server URL from settings
        const [[serverSetting]] = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'license_server_url'");
        const centralUrl = serverSetting ? serverSetting.setting_value : 'https://api.dinokun.com'; // Default URL

        // 3. Request Validation to Central Server
        const axios = require('axios');
        const os = require('os');
        const fs = require('fs');
        const path = require('path');
        
        try {
            const response = await axios.post(`${centralUrl}/validate-license`, {
                license_key: license_key,
                plugin_key: plugin.plugin_key,
                client_identity: os.hostname(),
                app_name: 'Dino-Bill'
            }, { timeout: 10000 });

            if (response.data && response.data.success) {
                // 4. Download the actual Plugin File
                try {
                    const downloadRes = await axios.get(`${centralUrl}/get-plugin/${plugin.plugin_key}`, {
                        params: { 
                            license_key: license_key,
                            client_identity: os.hostname()
                        },
                        responseType: 'text'
                    });

                    const pluginDir = path.join(__dirname, '..', 'plugins');
                    if (!fs.existsSync(pluginDir)) fs.mkdirSync(pluginDir);

                    // Save the obfuscated code to the plugins folder
                    fs.writeFileSync(path.join(pluginDir, `${plugin.plugin_key}.js`), downloadRes.data);

                    await pool.query(
                        'UPDATE plugins SET is_active = 1, license_key = ?, expires_at = NULL WHERE id = ?',
                        [license_key, pluginId]
                    );

                    return res.json({ 
                        success: true, 
                        message: 'Aktivasi Berhasil! Plugin telah didownload dan akan aktif setelah restart.',
                        needs_restart: true 
                    });

                } catch (downloadErr) {
                    return res.status(500).json({ 
                        success: false, 
                        message: 'Aktivasi berhasil tapi gagal mendownload file plugin: ' + downloadErr.message 
                    });
                }
            } else {
                return res.status(400).json({ 
                    success: false, 
                    message: response.data.message || 'Kode lisensi tidak valid atau sudah digunakan.' 
                });
            }
        } catch (apiError) {
            console.error('License Server Error:', apiError.message);
            
            if (license_key === 'DINO-DEV-MODE') {
                await pool.query('UPDATE plugins SET is_active = 1, license_key = ?, expires_at = NULL WHERE id = ?', [license_key, pluginId]);
                return res.json({ success: true, message: 'Mode Developer: Aktivasi lokal berhasil.' });
            }

            return res.status(500).json({ 
                success: false, 
                message: 'Gagal terhubung ke server lisensi. Silakan coba lagi nanti.' 
            });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.post('/deactivate/:id', isAdmin, async (req, res) => {
    try {
        await pool.query('UPDATE plugins SET is_active = 0 WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Plugin dinonaktifkan.' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
