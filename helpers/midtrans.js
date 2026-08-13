const axios = require('axios');

async function getMidtransSettings(pool) {
    const [rows] = await pool.query(
        "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('midtrans_client_key','midtrans_server_key','midtrans_mode')"
    );
    const s = {};
    rows.forEach(r => s[r.setting_key] = (r.setting_value || '').trim());
    return s;
}

function getBaseUrl(mode) {
    return mode === 'production'
        ? 'https://app.midtrans.com/snap/v1/'
        : 'https://app.sandbox.midtrans.com/snap/v1/';
}

/**
 * Create a Midtrans transaction
 * @param {Object} pool - database pool
 * @param {Object} params - { merchantRef, amount, customerName, customerEmail, customerPhone }
 */
async function createTransaction(pool, params) {
    try {
        const s = await getMidtransSettings(pool);
        if (!s.midtrans_server_key) {
            return { success: false, message: 'Konfigurasi Midtrans belum lengkap' };
        }

        const baseUrl = getBaseUrl(s.midtrans_mode);
        const authHeader = Buffer.from(s.midtrans_server_key + ':').toString('base64');

        const body = {
            transaction_details: {
                order_id: params.merchantRef,
                gross_amount: Math.round(params.amount)
            },
            customer_details: {
                first_name: params.customerName,
                email: params.customerEmail || 'customer@dino.net',
                phone: params.customerPhone || ''
            }
        };

        const res = await axios.post(`${baseUrl}transactions`, body, {
            headers: {
                Authorization: `Basic ${authHeader}`,
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            timeout: 15000
        });

        if (res.data && res.data.redirect_url) {
            return {
                success: true,
                data: {
                    checkout_url: res.data.redirect_url,
                    token: res.data.token
                }
            };
        }
        return { success: false, message: 'Gagal membuat transaksi ke Midtrans' };
    } catch (e) {
        console.error('[Midtrans] API Error:', e.message);
        const msg = (e.response && e.response.data && e.response.data.message) ? e.response.data.message : e.message;
        return { success: false, message: msg };
    }
}

module.exports = {
    getMidtransSettings,
    createTransaction
};
