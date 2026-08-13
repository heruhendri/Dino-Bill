const express = require('express');
const router = express.Router();
let pool;

router.setPool = (dbPool) => { pool = dbPool; };

// GET /logs
router.get('/', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 50;
        const offset = (page - 1) * limit;

        // Filters
        let whereClause = '1=1';
        const params = [];

        if (req.query.user_type) {
            whereClause += ' AND user_type = ?';
            params.push(req.query.user_type);
        }

        if (req.query.search) {
            whereClause += ' AND (username LIKE ? OR action LIKE ? OR description LIKE ?)';
            const searchPattern = `%${req.query.search}%`;
            params.push(searchPattern, searchPattern, searchPattern);
        }

        const [countResult] = await pool.query(`SELECT COUNT(*) as total FROM system_logs WHERE ${whereClause}`, params);
        const total = countResult[0].total;
        const totalPages = Math.ceil(total / limit);

        const [logs] = await pool.query(
            `SELECT * FROM system_logs WHERE ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );

        res.render('logs', {
            user: req.session,
            logs,
            currentPage: 'logs',
            page,
            totalPages,
            total,
            query: req.query
        });
    } catch (err) {
        console.error("LOGS ERROR:", err);
        res.status(500).send("Gagal memuat sistem logs: " + err.message);
    }
});

// POST /logs/clear
router.post('/clear', async (req, res) => {
    try {
        if (req.session.role !== 'admin') {
            return res.status(403).send("Forbidden: Hanya admin yang bisa menghapus log.");
        }
        await pool.query('TRUNCATE TABLE system_logs');
        res.redirect('/logs');
    } catch (err) {
        console.error("CLEAR LOGS ERROR:", err);
        res.status(500).send("Gagal membersihkan logs: " + err.message);
    }
});

module.exports = router;
