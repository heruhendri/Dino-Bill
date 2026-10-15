/**
 * Logger Helper
 * Digunakan untuk mencatat aktivitas sistem ke dalam tabel system_logs
 */

const logActivity = async (pool, user_type, user_id, username, action, ip_address, description) => {
    try {
        let cleanIp = ip_address || '';
        if (typeof cleanIp === 'string') {
            if (cleanIp.includes('::ffff:')) {
                cleanIp = cleanIp.split('::ffff:')[1];
            }
            if (cleanIp === '::1') {
                cleanIp = '127.0.0.1';
            }
        }
        await pool.query(
            `INSERT INTO system_logs (user_type, user_id, username, action, ip_address, description) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [user_type, user_id, username, action, cleanIp, description || '']
        );
    } catch (err) {
        console.error('[Logger Error] Failed to log activity:', err.message);
    }
};

module.exports = {
    logActivity
};
