const axios = require('axios');
const crypto = require('crypto');

async function getDuitkuSettings(pool) {
    const [rows] = await pool.query(
        "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('duitku_merchant_code','duitku_api_key','duitku_mode')"
    );
    const s = {};
    rows.forEach(r => s[r.setting_key] = (r.setting_value || '').trim());
    return s;
}

function getBaseUrl(mode) {
    return mode === 'production'
        ? 'https://api.duitku.com/api/merchant/createInvoice'
        : 'https://api-sandbox.duitku.com/api/merchant/createInvoice';
}

/**
 * Create a Duitku transaction (Invoice)
 * @param {Object} pool - database pool
 * @param {Object} params - { merchantRef, amount, customerName, customerEmail, customerPhone, callbackUrl, returnUrl }
 */
async function createTransaction(pool, params) {
    try {
        const s = await getDuitkuSettings(pool);
        if (!s.duitku_merchant_code || !s.duitku_api_key) {
            return { success: false, message: 'Konfigurasi Duitku belum lengkap' };
        }

        const baseUrl = getBaseUrl(s.duitku_mode);
        const amount = Math.round(params.amount);
        const merchantOrderId = params.merchantRef;
        const timestamp = Date.now().toString();

        // Signature: SHA256(merchantCode + amount + merchantOrderId + apiKey)
        const signatureStr = s.duitku_merchant_code + amount + merchantOrderId + s.duitku_api_key;
        const signature = crypto.createHash('sha256').update(signatureStr).digest('hex');

        const body = {
            merchantCode: s.duitku_merchant_code,
            paymentAmount: amount,
            merchantOrderId: merchantOrderId,
            productDetails: `Internet Bill ${params.customerName}`,
            email: params.customerEmail || 'customer@dino.net',
            phoneNumber: params.customerPhone || '',
            callbackUrl: params.callbackUrl,
            returnUrl: params.returnUrl,
            signature: signature,
            itemDetails: [
                {
                    name: 'Tagihan Internet',
                    price: amount,
                    quantity: 1
                }
            ]
        };

        const res = await axios.post(baseUrl, body, {
            headers: {
                'Content-Type': 'application/json',
                'x-duitku-signature': signature,
                'x-duitku-timestamp': timestamp,
                'x-duitku-merchantcode': s.duitku_merchant_code
            },
            timeout: 15000
        });

        if (res.data && res.data.paymentUrl) {
            return {
                success: true,
                data: {
                    checkout_url: res.data.paymentUrl,
                    reference: res.data.reference
                }
            };
        }
        return { success: false, message: res.data.message || 'Gagal membuat tagihan ke Duitku' };
    } catch (e) {
        console.error('[Duitku] API Error:', e.message);
        const msg = (e.response && e.response.data && e.response.data.message) ? e.response.data.message : e.message;
        return { success: false, message: msg };
    }
}

module.exports = {
    getDuitkuSettings,
    createTransaction
};
