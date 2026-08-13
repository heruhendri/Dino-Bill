const axios = require('axios');

async function getFlipSettings(pool) {
    const [rows] = await pool.query(
        "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('flip_secret_key','flip_validation_token','flip_mode')"
    );
    const s = {};
    rows.forEach(r => s[r.setting_key] = (r.setting_value || '').trim());
    return s;
}

function getBaseUrl(mode) {
    return mode === 'production'
        ? 'https://bigflip.id/api/v2/pwf/'
        : 'https://bigflip.id/big_sandbox_api/v2/pwf/';
}

/**
 * Create a Flip transaction (Bill)
 * @param {Object} pool - database pool
 * @param {Object} params - { merchantRef, amount, customerName, customerEmail, customerPhone, returnUrl }
 */
async function createTransaction(pool, params) {
    try {
        const s = await getFlipSettings(pool);
        if (!s.flip_secret_key) {
            return { success: false, message: 'Konfigurasi Flip belum lengkap' };
        }

        const baseUrl = getBaseUrl(s.flip_mode);
        const authHeader = Buffer.from(s.flip_secret_key + ':').toString('base64');

        const data = new URLSearchParams();
        data.append('title', `Dino-Bill Invoice #${params.merchantRef.split('-')[1]}`);
        data.append('amount', Math.round(params.amount));
        data.append('type', 'SINGLE');
        data.append('redirect_url', params.returnUrl);
        data.append('step', '1');
        data.append('sender_name', params.customerName);
        data.append('sender_email', params.customerEmail || 'customer@dino.net');
        data.append('sender_phoneNumber', params.customerPhone || '');
        data.append('reference_id', params.merchantRef);

        const res = await axios.post(`${baseUrl}bill`, data, {
            headers: {
                Authorization: `Basic ${authHeader}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            timeout: 15000
        });

        if (res.data && res.data.link_url) {
            return {
                success: true,
                data: {
                    checkout_url: res.data.link_url,
                    bill_id: res.data.id
                }
            };
        }
        return { success: false, message: 'Gagal membuat tagihan ke Flip' };
    } catch (e) {
        console.error('[Flip] API Error:', e.message);
        const msg = (e.response && e.response.data && e.response.data.message) ? JSON.stringify(e.response.data.message) : e.message;
        return { success: false, message: msg };
    }
}

module.exports = {
    getFlipSettings,
    createTransaction
};
