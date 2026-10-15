/**
 * Monitor status PPPoE aktif di MikroTik, kirim Telegram saat online/offline berubah.
 */
const mikrotik = require('./mikrotik');
const { getSettings, notifyPppoeStatusChange } = require('./notification');

async function getMonitorSettings(pool) {
    return getSettings(pool, [
        'pppoe_notify_enabled',
        'pppoe_notify_online',
        'pppoe_notify_offline',
        'pppoe_telegram_bot_token',
        'pppoe_telegram_chat_id'
    ]);
}

function findOnlineOnRouter(activeByRouter, pppoeUsername, preferredRouterId) {
    if (preferredRouterId && activeByRouter.has(preferredRouterId)) {
        const bucket = activeByRouter.get(preferredRouterId);
        if (bucket.set.has(pppoeUsername)) {
            return { routerId: preferredRouterId, routerName: bucket.routerName, conn: bucket.byName.get(pppoeUsername) };
        }
    }
    for (const [routerId, bucket] of activeByRouter) {
        if (bucket.set.has(pppoeUsername)) {
            return { routerId, routerName: bucket.routerName, conn: bucket.byName.get(pppoeUsername) };
        }
    }
    return null;
}

/**
 * @returns {Promise<{ skipped?: boolean, reason?: string, checked?: number, notified?: number }>}
 */
async function runPppoeMonitor(pool) {
    const settings = await getMonitorSettings(pool);

    if (settings.pppoe_notify_enabled !== '1') {
        return { skipped: true, reason: 'disabled' };
    }
    if (!settings.pppoe_telegram_bot_token || !settings.pppoe_telegram_chat_id) {
        return { skipped: true, reason: 'pppoe_telegram_not_configured' };
    }

    const [routers] = await pool.query("SELECT * FROM routers WHERE status = 'active'");
    if (routers.length === 0) {
        return { skipped: true, reason: 'no_routers' };
    }

    const activeByRouter = new Map();
    for (const router of routers) {
        const result = await mikrotik.getActiveConnections(router);
        const set = new Set();
        const byName = new Map();
        if (result.success) {
            result.data.forEach(c => {
                set.add(c.name);
                byName.set(c.name, c);
            });
        }
        activeByRouter.set(router.id, { set, byName, routerName: router.name });
    }

    const [customers] = await pool.query(`
        SELECT id, name, pppoe_username, router_id, phone, status
        FROM customers
        WHERE pppoe_username IS NOT NULL AND TRIM(pppoe_username) != ''
    `);

    // Fetch all session states at once
    const [states] = await pool.query('SELECT customer_id, is_online, last_ip, last_uptime FROM pppoe_session_state');
    const stateMap = new Map();
    states.forEach(s => {
        stateMap.set(s.customer_id, s);
    });

    let notified = 0;
    let checked = 0;

    for (const customer of customers) {
        checked++;
        const match = findOnlineOnRouter(activeByRouter, customer.pppoe_username, customer.router_id);
        const isOnline = !!match;
        const routerId = match ? match.routerId : (customer.router_id || null);
        const routerName = match ? match.routerName : '-';
        const conn = match ? match.conn : null;
        const newIp = conn?.address || null;
        const newUptime = conn?.uptime || null;

        const prev = stateMap.get(customer.id);

        if (!prev) {
            await pool.query(
                `INSERT INTO pppoe_session_state (customer_id, router_id, pppoe_username, is_online, last_ip, last_uptime)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [customer.id, routerId, customer.pppoe_username, isOnline ? 1 : 0, newIp, newUptime]
            );
            continue;
        }

        const wasOnline = prev.is_online === 1;
        const prevIp = prev.last_ip;

        // Only update database when status or IP changes
        if (isOnline !== wasOnline || newIp !== prevIp) {
            await pool.query(
                `UPDATE pppoe_session_state
                 SET router_id = ?, is_online = ?, last_ip = ?, last_uptime = ?, updated_at = NOW()
                 WHERE customer_id = ?`,
                [routerId, isOnline ? 1 : 0, newIp, newUptime, customer.id]
            );
        }

        if (wasOnline === isOnline) continue;

        if (isOnline && settings.pppoe_notify_online === '1') {
            await notifyPppoeStatusChange(pool, customer, 'online', routerName, conn);
            notified++;
        } else if (!isOnline && settings.pppoe_notify_offline === '1') {
            await notifyPppoeStatusChange(pool, customer, 'offline', routerName);
            notified++;
        }
    }

    console.log(`[PPPoE Monitor] Checked ${checked} pelanggan, ${notified} notifikasi Telegram.`);
    return { checked, notified };
}

module.exports = { runPppoeMonitor };
