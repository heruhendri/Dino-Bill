/**
 * Plugin: WhatsApp Bulk Broadcast
 * This file is downloaded from the License Server upon activation.
 */
module.exports = (app, pool, { requireAuth }) => {
    
    app.get('/wa-bulk', requireAuth, (req, res) => {
        // Double check in DB just in case
        if (!res.locals.plugins?.wa_bulk?.is_active) {
            return res.send('<h1>Akses Ditolak</h1><p>Lisensi Anda tidak mencakup fitur ini.</p>');
        }
        res.render('wa_bulk', { 
            user: req.session,
            currentPage: 'wa_bulk' 
        });
    });

    app.post('/wa-bulk/send', requireAuth, async (req, res) => {
        const { number, message } = req.body;
        const { notifyGeneral } = require('../helpers/notification');
        
        try {
            await notifyGeneral(pool, number, message);
            res.json({ success: true });
        } catch (e) {
            res.json({ success: false, message: e.message });
        }
    });

    app.get('/wa-bulk/get-numbers', requireAuth, async (req, res) => {
        try {
            const [rows] = await pool.query("SELECT phone FROM customers WHERE status='active' AND phone IS NOT NULL AND phone != ''");
            const numbers = rows.map(r => r.phone);
            res.json({ success: true, numbers });
        } catch (e) {
            res.json({ success: false, message: e.message });
        }
    });

    console.log("WhatsApp Bulk Plugin Initialized! ✅");
};
