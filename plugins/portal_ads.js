/**
 * Plugin: Portal Ads (Iklan Pop-up Portal Pelanggan)
 * Memungkinkan admin memasarkan layanan atau memberikan pengumuman lewat pop-up iklan di portal pelanggan.
 */
module.exports = (app, pool, { requireAuth }) => {

    // 1. Inisialisasi Database saat plugin dimuat
    const initDb = async () => {
        try {
            // Daftarkan plugin ke database jika belum ada
            await pool.query('INSERT IGNORE INTO plugins (plugin_key, name, description, is_active) VALUES (?, ?, ?, ?)', [
                'portal_ads',
                'Portal Ads (Iklan Pop-up)',
                'Tampilkan pop-up promosi/iklan kepada pelanggan saat login ke portal.',
                1 // Aktif secara default untuk developer mode lokal
            ]);

            // Buat tabel portal_ads
            await pool.query(`
                CREATE TABLE IF NOT EXISTS portal_ads (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    title VARCHAR(255) NOT NULL,
                    image_url TEXT NULL,
                    link_url TEXT NULL,
                    content TEXT NOT NULL,
                    is_active BOOLEAN DEFAULT 1,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            console.log("Portal Ads Plugin DB Initialized! ✅");
        } catch (e) {
            console.error("Failed to initialize Portal Ads DB:", e.message);
        }
    };
    initDb();

    // Middleware untuk memastikan plugin aktif
    const checkActive = (req, res, next) => {
        if (!res.locals.plugins?.portal_ads?.is_active) {
            return res.status(403).send('<h1>Akses Ditolak</h1><p>Plugin Portal Ads dinonaktifkan.</p>');
        }
        next();
    };

    // --- ROUTE ADMIN ---

    // Tampilkan Halaman Management Iklan
    app.get('/admin/ads', requireAuth, checkActive, async (req, res) => {
        try {
            const [ads] = await pool.query("SELECT * FROM portal_ads ORDER BY id DESC");
            res.render('admin_ads', {
                user: req.session,
                ads,
                currentPage: 'ads',
                error: null,
                success: null
            });
        } catch (e) {
            console.error(e);
            res.status(500).send("Terjadi kesalahan sistem: " + e.message);
        }
    });

    // Tambah Iklan Baru
    app.post('/admin/ads/add', requireAuth, checkActive, async (req, res) => {
        const { title, image_url, link_url, content } = req.body;
        
        if (!title || !content) {
            try {
                const [ads] = await pool.query("SELECT * FROM portal_ads ORDER BY id DESC");
                return res.render('admin_ads', {
                    user: req.session,
                    ads,
                    currentPage: 'ads',
                    error: 'Judul dan Konten iklan wajib diisi!',
                    success: null
                });
            } catch (err) {
                return res.status(500).send(err.message);
            }
        }

        try {
            await pool.query(
                "INSERT INTO portal_ads (title, image_url, link_url, content, is_active) VALUES (?, ?, ?, ?, 1)",
                [title, image_url || null, link_url || null, content]
            );

            // Invalidate settings/plugins cache to apply changes immediately
            if (app.locals.invalidateSettingsCache) app.locals.invalidateSettingsCache();

            res.redirect('/admin/ads');
        } catch (e) {
            res.status(500).send("Gagal menambah iklan: " + e.message);
        }
    });

    // Toggle Status Aktif Iklan
    app.post('/admin/ads/toggle/:id', requireAuth, checkActive, async (req, res) => {
        const adId = req.params.id;
        try {
            const [[ad]] = await pool.query("SELECT is_active FROM portal_ads WHERE id = ?", [adId]);
            if (!ad) return res.status(404).json({ success: false, message: 'Iklan tidak ditemukan' });

            const newStatus = ad.is_active ? 0 : 1;
            await pool.query("UPDATE portal_ads SET is_active = ? WHERE id = ?", [newStatus, adId]);
            
            res.json({ success: true, newStatus });
        } catch (e) {
            res.status(500).json({ success: false, message: e.message });
        }
    });

    // Hapus Iklan
    app.post('/admin/ads/delete/:id', requireAuth, checkActive, async (req, res) => {
        const adId = req.params.id;
        try {
            await pool.query("DELETE FROM portal_ads WHERE id = ?", [adId]);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, message: e.message });
        }
    });

    console.log("Portal Ads Plugin Initialized! ✅");
};
