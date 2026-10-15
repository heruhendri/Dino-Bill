const axios = require('axios');

async function getXenditSettings(pool) {
    const [rows] = await pool.query(
        "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('xendit_secret_key','xendit_callback_token','xendit_mode')"
    );
    const s = {};
    rows.forEach(r => s[r.setting_key] = (r.setting_value || '').trim());
    return s;
}

/**
 * Create a Xendit Invoice transaction
 * @param {Object} pool - database pool
 * @param {Object} params - { merchantRef, amount, customerName, customerEmail, customerPhone, returnUrl }
 */
async function createTransaction(pool, params) {
    try {
        const s = await getXenditSettings(pool);
        if (!s.xendit_secret_key) {
            return { success: false, message: 'Konfigurasi Xendit belum lengkap' };
        }

        const authHeader = Buffer.from(s.xendit_secret_key + ':').toString('base64');

        const body = {
            external_id: params.merchantRef,
            amount: Math.round(params.amount),
            payer_email: params.customerEmail || 'customer@dino.net',
            description: `Pembayaran Internet - ${params.customerName}`,
            success_redirect_url: params.returnUrl,
            failure_redirect_url: params.returnUrl
        };

        const res = await axios.post('https://api.xendit.co/v2/invoices', body, {
            headers: {
                Authorization: `Basic ${authHeader}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });

        if (res.data && res.data.invoice_url) {
            return {
                success: true,
                data: {
                    checkout_url: res.data.invoice_url,
                    invoice_id: res.data.id
                }
            };
        }
        return { success: false, message: 'Gagal membuat tagihan ke Xendit' };
    } catch (e) {
        console.error('[Xendit] API Error:', e.message);
        const msg = (e.response && e.response.data && e.response.data.message) ? e.response.data.message : e.message;
        return { success: false, message: msg };
    }
}

module.exports = {
    getXenditSettings,
    createTransaction
};
