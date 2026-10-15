const mikrotik = require('./mikrotik');

/**
 * Isolate a customer: move to isolated package (on MikroTik/RADIUS or disable)
 */
async function isolateCustomer(pool, customerId, appLocals = {}) {
    // 1. Fetch customer details
    const [[customer]] = await pool.query(
        `SELECT c.*, r.ip_address as r_ip, r.username as r_user, r.password as r_pass, r.port as r_port, r.connection_method as r_method 
         FROM customers c 
         LEFT JOIN routers r ON c.router_id = r.id 
         WHERE c.id = ?`,
        [customerId]
    );

    if (!customer) {
        throw new Error('Customer tidak ditemukan');
    }

    // 2. Fetch isolir method setting
    const [[isolirMethodRow]] = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'isolir_method'");
    const isolirMethod = isolirMethodRow ? isolirMethodRow.setting_value : 'move_package';

    if (isolirMethod === 'move_package') {
        const [[isolatedPkg]] = await pool.query('SELECT id, speed_limit FROM packages WHERE is_isolir = 1 LIMIT 1');
        if (isolatedPkg) {
            const valOriginalPkg = customer.original_package_id || customer.package_id;
            
            // Update database: move to isolated package and update status
            await pool.query(
                `UPDATE customers 
                 SET status = 'isolated', 
                     package_id = ?, 
                     original_package_id = ? 
                 WHERE id = ?`,
                [isolatedPkg.id, valOriginalPkg, customerId]
            );

            // Update MikroTik profile or RADIUS group
            if (customer.pppoe_username) {
                const profile = isolatedPkg.speed_limit || 'default';
                if (appLocals.radiusHelper && customer.r_method === 'radius') {
                    await appLocals.radiusHelper.isolateToGroup(customer.pppoe_username, profile);
                } else if (customer.r_ip) {
                    const routerData = { ip_address: customer.r_ip, username: customer.r_user, password: customer.r_pass, port: customer.r_port };
                    await mikrotik.setPPPoESecretProfile(routerData, customer.pppoe_username, profile, 'no');
                }
            }
            return true;
        }
    }

    // Fallback or "disable" method: standard isolation by disabling secret/rejecting radius
    await pool.query("UPDATE customers SET status = 'isolated' WHERE id = ?", [customerId]);

    if (customer.pppoe_username) {
        if (appLocals.radiusHelper && customer.r_method === 'radius') {
            await appLocals.radiusHelper.disableRadiusUser(customer.pppoe_username);
        } else if (customer.r_ip) {
            const routerData = { ip_address: customer.r_ip, username: customer.r_user, password: customer.r_pass, port: customer.r_port };
            await mikrotik.disablePPPoESecret(routerData, customer.pppoe_username);
        }
    }
    return true;
}

/**
 * Unisolate a customer: restore to original package (on MikroTik/RADIUS or enable)
 */
async function unisolateCustomer(pool, customerId, appLocals = {}) {
    // 1. Fetch customer details
    const [[customer]] = await pool.query(
        `SELECT c.*, r.ip_address as r_ip, r.username as r_user, r.password as r_pass, r.port as r_port, r.connection_method as r_method 
         FROM customers c 
         LEFT JOIN routers r ON c.router_id = r.id 
         WHERE c.id = ?`,
        [customerId]
    );

    if (!customer) {
        throw new Error('Customer tidak ditemukan');
    }

    // Load isolated package ID
    const [[isolatedPkg]] = await pool.query('SELECT id, speed_limit FROM packages WHERE is_isolir = 1 LIMIT 1');
    const isCurrentPkgIsolir = isolatedPkg && customer.package_id === isolatedPkg.id;

    if (customer.status !== 'isolated' && customer.original_package_id === null && !isCurrentPkgIsolir) {
        return true;
    }

    let restoredPkgId = customer.original_package_id;

    // Self-healing: If original_package_id is null but customer is currently assigned to the isolir package
    if (!restoredPkgId && isCurrentPkgIsolir) {
        // Look up their last invoice to find their original package
        const [[lastInv]] = await pool.query(
            "SELECT package_id FROM invoices WHERE customer_id = ? AND package_id != ? ORDER BY id DESC LIMIT 1",
            [customerId, isolatedPkg ? isolatedPkg.id : 0]
        );
        if (lastInv && lastInv.package_id) {
            restoredPkgId = lastInv.package_id;
        } else {
            // Fallback: get first available non-isolir package
            const [[firstPkg]] = await pool.query('SELECT id FROM packages WHERE is_isolir = 0 LIMIT 1');
            if (firstPkg) {
                restoredPkgId = firstPkg.id;
            }
        }
    }

    if (restoredPkgId) {
        // Fetch restored package details
        const [[restoredPkg]] = await pool.query('SELECT speed_limit FROM packages WHERE id = ?', [restoredPkgId]);
        const profile = restoredPkg && restoredPkg.speed_limit ? restoredPkg.speed_limit : 'default';

        // Update database: restore package and set status active
        await pool.query(
            `UPDATE customers 
             SET status = 'active', 
                 package_id = ?, 
                 original_package_id = NULL 
             WHERE id = ?`,
            [restoredPkgId, customerId]
        );

        // Update MikroTik profile or RADIUS group
        if (customer.pppoe_username) {
            if (appLocals.radiusHelper && customer.r_method === 'radius') {
                await appLocals.radiusHelper.enableRadiusUser(customer.pppoe_username);
                if (customer.r_ip) {
                    const routerData = { ip_address: customer.r_ip, username: customer.r_user, password: customer.r_pass, port: customer.r_port };
                    await mikrotik.kickActivePPPoESession(routerData, customer.pppoe_username).catch(() => {});
                }
            } else if (customer.r_ip) {
                const routerData = { ip_address: customer.r_ip, username: customer.r_user, password: customer.r_pass, port: customer.r_port };
                await mikrotik.setPPPoESecretProfile(routerData, customer.pppoe_username, profile, 'no');
            }
        }
    } else {
        // Fallback: standard active by enabling secret
        await pool.query("UPDATE customers SET status = 'active', original_package_id = NULL WHERE id = ?", [customerId]);

        if (customer.pppoe_username) {
            if (appLocals.radiusHelper && customer.r_method === 'radius') {
                await appLocals.radiusHelper.enableRadiusUser(customer.pppoe_username);
                if (customer.r_ip) {
                    const routerData = { ip_address: customer.r_ip, username: customer.r_user, password: customer.r_pass, port: customer.r_port };
                    await mikrotik.kickActivePPPoESession(routerData, customer.pppoe_username).catch(() => {});
                }
            } else if (customer.r_ip) {
                const routerData = { ip_address: customer.r_ip, username: customer.r_user, password: customer.r_pass, port: customer.r_port };
                await mikrotik.enablePPPoESecret(routerData, customer.pppoe_username);
            }
        }
    }
    return true;
}

module.exports = {
    isolateCustomer,
    unisolateCustomer
};
