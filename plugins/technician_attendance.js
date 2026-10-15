/**
 * Plugin: Technician Attendance (Absensi Teknisi)
 * Memungkinkan teknisi melakukan absensi harian dengan lokasi GPS.
 * Admin dapat memantau seluruh riwayat absensi.
 */
module.exports = (app, pool, { requireAuth, requireRole }) => {

    // 1. Inisialisasi Database saat plugin dimuat
    const initDb = async () => {
        try {
            // Daftarkan plugin ke database jika belum ada
            await pool.query('INSERT IGNORE INTO plugins (plugin_key, name, description) VALUES (?, ?, ?)', [
                'technician_attendance',
                'Absensi Teknisi',
                'Fitur absensi harian untuk teknisi dengan lokasi GPS dan riwayat absensi.'
            ]);

            // Buat tabel technician_attendance
            await pool.query(`
                CREATE TABLE IF NOT EXISTS technician_attendance (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    user_id INT NOT NULL,
                    date DATE NOT NULL,
                    clock_in TIME NULL,
                    clock_out TIME NULL,
                    lat_in VARCHAR(50) NULL,
                    lng_in VARCHAR(50) NULL,
                    lat_out VARCHAR(50) NULL,
                    lng_out VARCHAR(50) NULL,
                    status VARCHAR(50) DEFAULT 'present',
                    notes TEXT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE KEY user_date (user_id, date)
                )
            `);
            console.log("Technician Attendance Plugin DB Initialized! ✅");
        } catch (e) {
            console.error("Failed to initialize Technician Attendance DB:", e.message);
        }
    };
    initDb();

    // Middleware to check if the plugin is active
    const checkActive = (req, res, next) => {
        if (!res.locals.plugins?.technician_attendance?.is_active) {
            return res.status(403).send('<h1>Akses Ditolak</h1><p>Lisensi Anda tidak mencakup fitur Absensi Teknisi atau plugin dinonaktifkan.</p>');
        }
        next();
    };

    // --- ROUTE TEKNISI ---

    // Tampilkan Halaman Absensi untuk Teknisi
    app.get('/technician/attendance', requireRole('technician'), checkActive, async (req, res) => {
        try {
            const userId = req.session.userId;
            const today = new Date().toISOString().slice(0, 10);

            // Ambil data absen hari ini jika sudah ada
            const [[attendance]] = await pool.query(
                "SELECT * FROM technician_attendance WHERE user_id = ? AND date = ?",
                [userId, today]
            );

            // Ambil riwayat absen 7 hari terakhir
            const [history] = await pool.query(
                "SELECT * FROM technician_attendance WHERE user_id = ? ORDER BY date DESC LIMIT 7",
                [userId]
            );

            res.render('technician_attendance', {
                user: req.session,
                attendance: attendance || null,
                history,
                currentPage: 'technician'
            });
        } catch (e) {
            console.error(e);
            res.status(500).send("Terjadi kesalahan sistem: " + e.message);
        }
    });

    // Proses Absen Masuk (Clock In)
    app.post('/technician/attendance/clock-in', requireRole('technician'), checkActive, async (req, res) => {
        const { lat, lng, notes } = req.body;
        const userId = req.session.userId;
        const today = new Date().toISOString().slice(0, 10);
        
        try {
            // Cek apakah sudah absen hari ini
            const [existing] = await pool.query(
                "SELECT id FROM technician_attendance WHERE user_id = ? AND date = ?",
                [userId, today]
            );

            if (existing.length > 0) {
                return res.json({ success: false, message: 'Anda sudah melakukan absen masuk hari ini!' });
            }

            // Tentukan status (misal jika lewat jam 08:30 dianggap terlambat, bisa disesuaikan)
            const now = new Date();
            const hours = now.getHours();
            const minutes = now.getMinutes();
            let status = 'present';
            if (hours > 8 || (hours === 8 && minutes > 30)) {
                status = 'late';
            }

            const timeStr = now.toTimeString().split(' ')[0]; // HH:MM:SS

            await pool.query(
                `INSERT INTO technician_attendance 
                (user_id, date, clock_in, lat_in, lng_in, status, notes) 
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [userId, today, timeStr, lat || null, lng || null, status, notes || '']
            );

            res.json({ 
                success: true, 
                message: 'Absen masuk berhasil tercatat! Selamat bekerja.', 
                time: timeStr, 
                status 
            });
        } catch (e) {
            res.status(500).json({ success: false, message: 'Gagal mencatat absen: ' + e.message });
        }
    });

    // Proses Absen Pulang (Clock Out)
    app.post('/technician/attendance/clock-out', requireRole('technician'), checkActive, async (req, res) => {
        const { lat, lng } = req.body;
        const userId = req.session.userId;
        const today = new Date().toISOString().slice(0, 10);
        
        try {
            // Cek apakah sudah absen masuk hari ini
            const [[existing]] = await pool.query(
                "SELECT id, clock_out FROM technician_attendance WHERE user_id = ? AND date = ?",
                [userId, today]
            );

            if (!existing) {
                return res.json({ success: false, message: 'Anda belum melakukan absen masuk hari ini!' });
            }

            if (existing.clock_out) {
                return res.json({ success: false, message: 'Anda sudah melakukan absen pulang hari ini!' });
            }

            const now = new Date();
            const timeStr = now.toTimeString().split(' ')[0]; // HH:MM:SS

            await pool.query(
                `UPDATE technician_attendance 
                SET clock_out = ?, lat_out = ?, lng_out = ? 
                WHERE id = ?`,
                [timeStr, lat || null, lng || null, existing.id]
            );

            res.json({ success: true, message: 'Absen pulang berhasil tercatat! Hati-hati di jalan.', time: timeStr });
        } catch (e) {
            res.status(500).json({ success: false, message: 'Gagal mencatat absen pulang: ' + e.message });
        }
    });

    // --- ROUTE ADMIN ---

    // Panel Absensi untuk Admin
    app.get('/admin/attendance', requireAuth, checkActive, async (req, res) => {
        // Hanya admin yang diizinkan
        if (req.session.role !== 'admin') {
            return res.status(403).send("Forbidden: Hanya Admin yang bisa mengakses halaman ini.");
        }

        try {
            const dateFilter = req.query.date || new Date().toISOString().slice(0, 10);
            
            // Ambil semua daftar teknisi untuk opsi filter/tampilan
            const [technicians] = await pool.query("SELECT id, username FROM users WHERE role = 'technician' ORDER BY username ASC");

            // Ambil rekapan absen berdasarkan tanggal terpilih
            const [logs] = await pool.query(`
                SELECT a.*, u.username as technician_name 
                FROM technician_attendance a
                JOIN users u ON a.user_id = u.id
                WHERE a.date = ?
                ORDER BY a.clock_in ASC
            `, [dateFilter]);

            res.render('admin_attendance', {
                user: req.session,
                technicians,
                logs,
                dateFilter,
                currentPage: 'attendance'
            });
        } catch (e) {
            console.error(e);
            res.status(500).send("Database error: " + e.message);
        }
    });

    console.log("Technician Attendance Plugin Loaded Successfully! 🕒");
};
