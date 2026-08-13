const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const tripay = require('../helpers/tripay');
const midtrans = require('../helpers/midtrans');
const flip = require('../helpers/flip');
const xendit = require('../helpers/xendit');
const duitku = require('../helpers/duitku');
const axios = require('axios');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { notifyPaymentProofUploaded } = require('../helpers/notification');
const { logActivity } = require('../helpers/logger');
let pool;

// Configure multer for payment proof uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, '../public/uploads/proofs');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, 'payment_proof-' + uniqueSuffix + ext);
    }
});

const upload = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        const filetypes = /jpeg|jpg|png|gif|webp|pdf/;
        const mimetype = filetypes.test(file.mimetype);
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        if (mimetype && extname) {
            return cb(null, true);
        }
        cb(new Error('Hanya file gambar atau PDF yang diperbolehkan!'));
    },
    limits: { fileSize: 3 * 1024 * 1024 } // limit 3MB
});

router.setPool = (dbPool) => { pool = dbPool; };

// Middleware for Portal Auth
const requirePortalAuth = (req, res, next) => {
    if (!req.session.customerId) {
        return res.redirect('/portal/login');
    }
    next();
};

// GET /portal/login
router.get('/login', (req, res) => {
    if (req.session.customerId) return res.redirect('/portal');
    res.render('portal_login', { error: null });
});

// POST /portal/login
router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [rows] = await pool.query('SELECT * FROM customers WHERE pppoe_username = ? OR phone = ?', [username, username]);
        if (rows.length > 0) {
            const customer = rows[0];
            // Default password is '1234' if portal_password is not set
            const validPass = customer.portal_password ? 
                await bcrypt.compare(password, customer.portal_password) : 
                (password === '1234');
            
            if (validPass) {
                req.session.customerId = customer.id;
                req.session.customerName = customer.name;
                await logActivity(pool, 'customer', customer.id, customer.name, 'Login', req.ip, 'Customer logged into portal');
                return res.redirect('/portal');
            }
        }
        res.render('portal_login', { error: 'Username atau Password salah' });
    } catch (err) {
        res.render('portal_login', { error: 'Terjadi kesalahan sistem' });
    }
});

// GET /portal (Dashboard)
router.get('/', requirePortalAuth, async (req, res) => {
    try {
        const [[customer]] = await pool.query(`
            SELECT c.*, p.name as package_name, p.price as package_price 
            FROM customers c 
            LEFT JOIN packages p ON c.package_id = p.id 
            WHERE c.id = ?`, [req.session.customerId]);
        
        if (!customer) {
            req.session.customerId = null;
            return res.redirect('/portal/login');
        }
        
        const [invoiceRows] = await pool.query('SELECT * FROM invoices WHERE customer_id = ? ORDER BY created_at DESC LIMIT 10', [req.session.customerId]);
        const invoices = invoiceRows;

        const [countRows] = await pool.query('SELECT COUNT(*) as unpaidCount FROM invoices WHERE customer_id = ? AND status = "unpaid"', [req.session.customerId]);
        const unpaidCount = countRows[0] ? countRows[0].unpaidCount : 0;

        const [totalRows] = await pool.query('SELECT COALESCE(SUM(amount),0) as unpaidTotal FROM invoices WHERE customer_id = ? AND status = "unpaid"', [req.session.customerId]);
        const unpaidTotal = totalRows[0] ? totalRows[0].unpaidTotal : 0;

        // Get payment gateway setting
        const [settingsRows] = await pool.query("SELECT setting_key, setting_value FROM settings");
        const settings = {};
        settingsRows.forEach(r => settings[r.setting_key] = r.setting_value);
        
        const paymentGateway = settings.payment_gateway || 'manual';
        const company = {
            company_name: settings.company_name || 'Dino-Net',
            company_phone: settings.company_phone || '',
            company_address: settings.company_address || '',
            bank_name: settings.bank_name || 'BANK BCA',
            bank_account: settings.bank_account || '1234567890',
            bank_holder: settings.bank_holder || settings.company_name || 'Dino-Net'
        };

        // Get active ads if the portal_ads plugin is active
        let activeAds = [];
        if (res.locals.plugins?.portal_ads?.is_active) {
            const [ads] = await pool.query("SELECT * FROM portal_ads WHERE is_active = 1 ORDER BY id DESC");
            activeAds = ads;
        }

        res.render('portal_dashboard', { 
            user: req.session, customer, invoices, unpaidCount, unpaidTotal,
            paymentGateway, company, activeAds
        });
    } catch (err) {
        console.error("PORTAL ERROR:", err);
        res.status(500).send("Gagal memuat portal");
    }
});

// POST /portal/pay/:invoiceId — Create gateway payment
router.post('/pay/:invoiceId', requirePortalAuth, async (req, res) => {
    try {
        const [[inv]] = await pool.query('SELECT * FROM invoices WHERE id = ? AND customer_id = ?', [req.params.invoiceId, req.session.customerId]);
        if (!inv) return res.json({ success: false, message: 'Invoice tidak ditemukan' });
        if (inv.status === 'paid') return res.json({ success: false, message: 'Invoice sudah lunas' });

        const [[customer]] = await pool.query('SELECT * FROM customers WHERE id = ?', [req.session.customerId]);
        const [settingsRows] = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'payment_gateway'");
        const gateway = settingsRows[0] ? settingsRows[0].setting_value : 'manual';
        
        const method = req.body.method || '';
        const merchantRef = `INV-${inv.id}-${Date.now()}`;
        const host = req.get('host');
        const protocol = req.protocol;
        const returnUrl = `${protocol}://${host}/portal`;

        let result;
        if (gateway === 'tripay') {
            result = await tripay.createTransaction(pool, {
                method: method || 'QRIS',
                merchantRef,
                amount: parseInt(inv.amount),
                customerName: customer.name,
                customerPhone: customer.phone || '',
                customerEmail: customer.email || 'customer@dino.net',
                callbackUrl: req.body.callbackUrl || `${protocol}://${host}/api/tripay/callback`,
                returnUrl
            });
        } else if (gateway === 'midtrans') {
            result = await midtrans.createTransaction(pool, {
                merchantRef,
                amount: parseInt(inv.amount),
                customerName: customer.name,
                customerPhone: customer.phone || '',
                customerEmail: customer.email || 'customer@dino.net'
            });
        } else if (gateway === 'flip') {
            result = await flip.createTransaction(pool, {
                merchantRef,
                amount: parseInt(inv.amount),
                customerName: customer.name,
                customerPhone: customer.phone || '',
                customerEmail: customer.email || 'customer@dino.net',
                returnUrl
            });
        } else if (gateway === 'xendit') {
            result = await xendit.createTransaction(pool, {
                merchantRef,
                amount: parseInt(inv.amount),
                customerName: customer.name,
                customerPhone: customer.phone || '',
                customerEmail: customer.email || 'customer@dino.net',
                returnUrl
            });
        } else if (gateway === 'duitku') {
            result = await duitku.createTransaction(pool, {
                merchantRef,
                amount: parseInt(inv.amount),
                customerName: customer.name,
                customerPhone: customer.phone || '',
                customerEmail: customer.email || 'customer@dino.net',
                callbackUrl: `${protocol}://${host}/api/duitku/callback`,
                returnUrl
            });
        } else {
            return res.json({ success: false, message: 'Metode pembayaran online tidak aktif' });
        }

        if (result && result.success) {
            res.json({ success: true, data: result.data });
        } else {
            res.json({ success: false, message: (result && result.message) || 'Gagal membuat pembayaran' });
        }
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /portal/change-password
router.post('/change-password', requirePortalAuth, async (req, res) => {
    const { current_password, new_password } = req.body;
    try {
        const [[customer]] = await pool.query('SELECT * FROM customers WHERE id=?', [req.session.customerId]);
        
        const validPass = customer.portal_password ?
            await bcrypt.compare(current_password, customer.portal_password) :
            (current_password === '1234');
        
        if (!validPass) return res.json({ success: false, message: 'Password lama salah' });
        
        const hashed = await bcrypt.hash(new_password, 10);
        await pool.query('UPDATE customers SET portal_password = ? WHERE id = ?', [hashed, req.session.customerId]);
        await logActivity(pool, 'customer', customer.id, customer.name, 'Change Password', req.ip, 'Customer changed portal password');
        res.json({ success: true, message: 'Password berhasil diperbarui' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /portal/update-profile
router.post('/update-profile', requirePortalAuth, async (req, res) => {
    const { phone, email } = req.body;
    try {
        await pool.query('UPDATE customers SET phone = ?, email = ? WHERE id = ?', [phone, email, req.session.customerId]);
        res.json({ success: true, message: 'Profil berhasil diperbarui' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /portal/ticket — Create trouble ticket
router.post('/ticket', requirePortalAuth, async (req, res) => {
    const { title, description } = req.body;
    try {
        await pool.query(
            'INSERT INTO trouble_tickets (customer_id, title, description, status, priority) VALUES (?, ?, ?, "open", "normal")',
            [req.session.customerId, title, description]
        );
        res.json({ success: true, message: 'Laporan berhasil dikirim, tim kami akan segera memprosesnya.' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// GET /portal/tickets — Fetch customer's own tickets
router.get('/tickets', requirePortalAuth, async (req, res) => {
    try {
        const [tickets] = await pool.query('SELECT * FROM trouble_tickets WHERE customer_id = ? ORDER BY created_at DESC', [req.session.customerId]);
        res.json({ success: true, tickets });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// GET /portal/wifi — Fetch SSID & Password from GenieACS
router.get('/wifi', requirePortalAuth, async (req, res) => {
    try {
        const [[customer]] = await pool.query('SELECT pppoe_username FROM customers WHERE id = ?', [req.session.customerId]);
        if (!customer || !customer.pppoe_username) return res.json({ success: false, message: 'PPPoE Username tidak ditemukan' });

        const [settingsRows] = await pool.query("SELECT * FROM settings WHERE setting_key IN ('acs_url', 'acs_user', 'acs_pass', 'acs_path_pppoe')");
        const s = {}; settingsRows.forEach(r => s[r.setting_key] = r.setting_value);
        if (!s.acs_url) return res.json({ success: false, message: 'ACS belum dikonfigurasi' });

        const pppoePath = s.acs_path_pppoe || 'VirtualParameters.PPPoEUser';
        const config = { auth: s.acs_user ? { username: s.acs_user, password: s.acs_pass } : undefined, timeout: 15000 };

        // 1. Find device by PPPoE Username
        const findRes = await axios.get(`${s.acs_url}/devices`, {
            ...config,
            params: { 
                query: JSON.stringify({ [pppoePath]: customer.pppoe_username }),
                projection: '_id,InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID,InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey'
            }
        });

        const device = findRes.data ? findRes.data[0] : null;
        if (!device) return res.json({ success: false, message: 'ONT tidak terdeteksi online di ACS' });

        const getVal = (obj, path) => {
            const parts = path.split('.');
            let curr = obj;
            for (const p of parts) { 
                curr = (curr && curr[p]) ? curr[p] : undefined; 
            }
            return (curr && curr._value) ? curr._value : curr;
        };

        const ssid = getVal(device, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID');
        const pass = getVal(device, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey');

        res.json({ success: true, ssid: ssid || '', password: pass || '' });
    } catch (e) {
        res.json({ success: false, message: 'Gagal mengambil data WiFi: ' + e.message });
    }
});

// POST /portal/wifi — Update SSID & Password
router.post('/wifi', requirePortalAuth, async (req, res) => {
    const { ssid, password } = req.body;
    try {
        const [[customer]] = await pool.query('SELECT pppoe_username FROM customers WHERE id = ?', [req.session.customerId]);
        const [settingsRows] = await pool.query("SELECT * FROM settings WHERE setting_key IN ('acs_url', 'acs_user', 'acs_pass', 'acs_path_pppoe')");
        const s = {}; settingsRows.forEach(r => s[r.setting_key] = r.setting_value);
        if (!s.acs_url) return res.json({ success: false, message: 'ACS belum dikonfigurasi' });

        const pppoePath = s.acs_path_pppoe || 'VirtualParameters.PPPoEUser';
        const config = { auth: s.acs_user ? { username: s.acs_user, password: s.acs_pass } : undefined, timeout: 5000 };

        // 1. Find device
        const findRes = await axios.get(`${s.acs_url}/devices`, {
            ...config,
            params: { query: JSON.stringify({ [pppoePath]: customer.pppoe_username }), projection: '_id' }
        });

        const device = findRes.data ? findRes.data[0] : null;
        if (!device) return res.json({ success: false, message: 'ONT tidak ditemukan' });

        // 2. Push a single task to update both SSID and Password
        const deviceId = encodeURIComponent(device._id);
        const task = { 
            name: 'setParameterValues', 
            parameterValues: [
                ['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID', ssid, 'xsd:string'],
                ['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey', password, 'xsd:string']
            ] 
        };

        await axios.post(`${s.acs_url}/devices/${deviceId}/tasks`, task, { ...config, params: { connection_request: '' } });

        res.json({ success: true, message: 'Pengaturan WiFi sedang dikirim ke ONT. WiFi akan segera berubah.' });
    } catch (e) {
        res.json({ success: false, message: 'Gagal update WiFi: ' + e.message });
    }
});

// GET /portal/payment-channels
router.get('/payment-channels', requirePortalAuth, async (req, res) => {
    try {
        const result = await tripay.getPaymentChannels(pool);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /portal/upload-proof/:invoiceId
router.post('/upload-proof/:invoiceId', requirePortalAuth, upload.single('proof'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Tidak ada file bukti yang diunggah' });
        }
        
        // Pastikan invoice milik customer ini
        const [[invoice]] = await pool.query('SELECT * FROM invoices WHERE id = ? AND customer_id = ?', [req.params.invoiceId, req.session.customerId]);
        if (!invoice) {
            return res.status(404).json({ success: false, message: 'Invoice tidak ditemukan' });
        }
        
        const proofUrl = '/uploads/proofs/' + req.file.filename;
        await pool.query('UPDATE invoices SET payment_proof = ? WHERE id = ?', [proofUrl, req.params.invoiceId]);
        
        // Kirim notifikasi Telegram ke Admin
        const [[customer]] = await pool.query('SELECT * FROM customers WHERE id = ?', [req.session.customerId]);
        if (customer) {
            notifyPaymentProofUploaded(pool, customer, invoice).catch(err => {
                console.error('Error sending Telegram notification for payment proof:', err.message);
            });
        }
        
        res.json({ success: true, message: 'Bukti pembayaran berhasil diunggah', proofUrl });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// GET /portal/logout
router.get('/logout', (req, res) => {
    req.session.customerId = null;
    req.session.customerName = null;
    res.redirect('/portal/login');
});

module.exports = router;
