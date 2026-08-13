const nodeCrypto = require('crypto');
if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.subtle) {
  try { globalThis.crypto = nodeCrypto.webcrypto || nodeCrypto; } catch (e) { }
}

const express = require('express');
const compression = require('compression');
const path = require('path');
const session = require('express-session');
const fs = require('fs');
const dotenv = require('dotenv');

// Check if .env exists, if not, we are in "install mode"
const envPath = path.join(__dirname, '.env');
const isInstalled = fs.existsSync(envPath);

if (isInstalled) {
  dotenv.config();
}

const app = express();
app.use(compression());
app.set('trust proxy', true);
const PORT = process.env.APP_PORT || 3999;

// Background Task Requirements
const cron = require('node-cron');
const { notifyIsolation, notifyInvoiceCreated, notifyReminder } = require('./helpers/notification');
const mikrotikHelper = require('./helpers/mikrotik');
const bcrypt = require('bcryptjs');
const { handlePaymentSuccess } = require('./helpers/payment');
const { logActivity } = require('./helpers/logger');
const { isolateCustomer, unisolateCustomer } = require('./helpers/customer_status');

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));

let pool; // Global database pool
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback_secret',
  resave: false,
  saveUninitialized: true
}));

// Localization Middleware
const locales = {
  id: JSON.parse(fs.readFileSync(path.join(__dirname, 'locales', 'id.json'), 'utf8')),
  en: JSON.parse(fs.readFileSync(path.join(__dirname, 'locales', 'en.json'), 'utf8'))
};

app.use((req, res, next) => {
  const lang = req.session.lang || 'id';
  res.locals.lang = lang;
  res.locals.t = locales[lang] || locales['id'];
  next();
});

app.get('/set-lang/:lang', (req, res) => {
  const lang = req.params.lang;
  if (['id', 'en'].includes(lang)) {
    req.session.lang = lang;
  }
  res.redirect('back');
});

// Setup Routes
if (!isInstalled) {
  console.log("No .env found. Running in Install Mode.");

  // Redirect all traffic to /install
  app.use((req, res, next) => {
    if (!req.path.startsWith('/install') && !req.path.startsWith('/assets')) {
      return res.redirect('/install');
    }
    next();
  });

  app.get('/install', (req, res) => {
    res.render('installer', { step: 1, error: null });
  });

  app.post('/install/setup', async (req, res) => {
    const { dbHost, dbUser, dbPass, dbName } = req.body;

    // Test DB Connection
    try {
      const mysql = require('mysql2/promise');
      const connection = await mysql.createConnection({
        host: dbHost,
        user: dbUser,
        password: dbPass
      });

      // Create DB if not exists
      await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\`;`);
      await connection.query(`USE \`${dbName}\`;`);

      // Create Users table and insert default admin
      await connection.query(`
        CREATE TABLE IF NOT EXISTS users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          username VARCHAR(50) NOT NULL UNIQUE,
          password VARCHAR(255) NOT NULL,
          role VARCHAR(20) DEFAULT 'admin',
          telegram_id VARCHAR(50),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      const bcrypt = require('bcryptjs');
      const hashedPass = await bcrypt.hash('admin', 10);

      // Check if admin exists
      const [rows] = await connection.query(`SELECT * FROM users WHERE username = 'admin'`);
      if (rows.length === 0) {
        await connection.query(`INSERT INTO users (username, password, role) VALUES ('admin', ?, 'admin')`, [hashedPass]);
      }

      // Generate .env file
      const envContent = `DB_HOST=${dbHost}
DB_PORT=3306
DB_NAME=${dbName}
DB_USER=${dbUser}
DB_PASS=${dbPass}
APP_PORT=3999
APP_NAME=Dino-Bill
NODE_ENV=production
SESSION_SECRET=${Math.random().toString(36).substring(2, 15)}
`;
      fs.writeFileSync(envPath, envContent);

      // Needs restart or dynamic reload
      res.render('installer', { step: 'success', error: null });

      setTimeout(() => {
        console.log("Restarting server to apply .env changes...");
        process.exit(0); // PM2 or nodemon will restart it
      }, 3000);

    } catch (err) {
      res.render('installer', { step: 1, error: "Database Connection Failed: " + err.message });
    }
  });

} else {
  // App is installed, load normal routes
  const mysql = require('mysql2/promise');
  const bcrypt = require('bcryptjs');

  // Create DB pool
  const targetDbHost = (process.env.DB_HOST === 'localhost' || !process.env.DB_HOST) ? '127.0.0.1' : process.env.DB_HOST;
  pool = mysql.createPool({
    host: targetDbHost,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  });
  app.locals.pool = pool;


  // Auto-initialize tables that might be missing
  const initDB = async () => {
    try {
      // 1. Create all base tables first to ensure they exist before migration checks
      await pool.query(`
        CREATE TABLE IF NOT EXISTS packages (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          price DECIMAL(10,2) NOT NULL DEFAULT 0,
          speed_limit VARCHAR(50),
          description TEXT,
          type VARCHAR(20) DEFAULT 'pppoe',
          duration VARCHAR(20) NULL,
          is_isolir TINYINT(1) DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS customers (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          phone VARCHAR(20),
          address TEXT,
          package_id INT,
          router_id INT,
          original_package_id INT DEFAULT NULL,
          odp_id INT DEFAULT NULL,
          pppoe_username VARCHAR(50),
          pppoe_password VARCHAR(50),
          billing_method VARCHAR(20) DEFAULT 'fixed',
          isolation_date INT DEFAULT 20,
          lat VARCHAR(30),
          lng VARCHAR(30),
          portal_password VARCHAR(255),
          email VARCHAR(100),
          status VARCHAR(20) DEFAULT 'active',
          technician_id INT,
          installation_status VARCHAR(20) DEFAULT 'pending',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS invoices (
          id INT AUTO_INCREMENT PRIMARY KEY,
          customer_id INT,
          package_id INT,
          invoice_number VARCHAR(50) DEFAULT '',
          amount DECIMAL(10,2) NOT NULL DEFAULT 0,
          status VARCHAR(20) DEFAULT 'unpaid',
          description TEXT,
          payment_method VARCHAR(50) DEFAULT 'Manual',
          payment_proof VARCHAR(255) NULL,
          due_date DATE,
          paid_at TIMESTAMP NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS routers (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          ip_address VARCHAR(50) NOT NULL,
          username VARCHAR(50) NOT NULL,
          password VARCHAR(100) NOT NULL,
          port INT DEFAULT 8728,
          status VARCHAR(20) DEFAULT 'active',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS settings (
          id INT AUTO_INCREMENT PRIMARY KEY,
          setting_key VARCHAR(50) NOT NULL UNIQUE,
          setting_value TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS technician_users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          username VARCHAR(50) NOT NULL UNIQUE,
          password VARCHAR(255) NOT NULL,
          name VARCHAR(100),
          phone VARCHAR(20),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS sales_users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          username VARCHAR(50) NOT NULL UNIQUE,
          password VARCHAR(255) NOT NULL,
          name VARCHAR(100),
          balance DECIMAL(15,2) DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS trouble_tickets (
          id INT AUTO_INCREMENT PRIMARY KEY,
          customer_id INT,
          title VARCHAR(200),
          description TEXT,
          status VARCHAR(20) DEFAULT 'open',
          priority VARCHAR(20) DEFAULT 'normal',
          technician_id INT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS map_objects (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          type VARCHAR(20) NOT NULL, -- 'server', 'odp'
          lat VARCHAR(50) NOT NULL,
          lng VARCHAR(50) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS map_cables (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(100),
          path TEXT NOT NULL, -- JSON array of [lat, lng]
          color VARCHAR(20) DEFAULT '#3b82f6',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS inventory (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          category VARCHAR(50),
          stock INT DEFAULT 0,
          unit VARCHAR(20) DEFAULT 'pcs',
          description TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS vouchers (
          id INT AUTO_INCREMENT PRIMARY KEY,
          code VARCHAR(50) NOT NULL UNIQUE,
          price DECIMAL(10,2) NOT NULL DEFAULT 0,
          profile VARCHAR(50),
          status VARCHAR(20) DEFAULT 'unused',
          created_by VARCHAR(50) DEFAULT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS hioso_olts (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          host VARCHAR(100) NOT NULL,
          port INT DEFAULT 161,
          community VARCHAR(100) DEFAULT 'public',
          web_user VARCHAR(100) DEFAULT 'admin',
          web_password VARCHAR(100) DEFAULT 'admin',
          status VARCHAR(20) DEFAULT 'active',
          brand VARCHAR(50) DEFAULT 'HIOSO',
          model VARCHAR(50) DEFAULT NULL,
          last_profile VARCHAR(100),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS hioso_onus (
          id INT AUTO_INCREMENT PRIMARY KEY,
          olt_id INT NOT NULL,
          onu_index VARCHAR(100) NOT NULL,
          name VARCHAR(100),
          sn VARCHAR(100),
          mac VARCHAR(100),
          tx_power VARCHAR(20),
          rx_power VARCHAR(20),
          status VARCHAR(50),
          last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY (olt_id, onu_index)
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS pppoe_session_state (
          id INT AUTO_INCREMENT PRIMARY KEY,
          customer_id INT NOT NULL UNIQUE,
          router_id INT,
          pppoe_username VARCHAR(50) NOT NULL,
          is_online TINYINT(1) DEFAULT 0,
          last_ip VARCHAR(50),
          last_uptime VARCHAR(50),
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS plugins (
          id INT AUTO_INCREMENT PRIMARY KEY,
          plugin_key VARCHAR(50) NOT NULL UNIQUE,
          name VARCHAR(100) NOT NULL,
          description TEXT,
          is_active BOOLEAN DEFAULT 0,
          license_key VARCHAR(255),
          expires_at TIMESTAMP NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          username VARCHAR(50) NOT NULL UNIQUE,
          password VARCHAR(255) NOT NULL,
          role VARCHAR(20) DEFAULT 'admin',
          telegram_id VARCHAR(50),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // --- AUTOMATIC FreeRADIUS TABLE INITIALIZATION ---
      await pool.query(`
        CREATE TABLE IF NOT EXISTS radcheck (
          id INT AUTO_INCREMENT PRIMARY KEY,
          username VARCHAR(64) NOT NULL DEFAULT '',
          attribute VARCHAR(64) NOT NULL DEFAULT '',
          op VARCHAR(2) NOT NULL DEFAULT '==',
          value VARCHAR(253) NOT NULL DEFAULT '',
          KEY username (username(32))
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS radreply (
          id INT AUTO_INCREMENT PRIMARY KEY,
          username VARCHAR(64) NOT NULL DEFAULT '',
          attribute VARCHAR(64) NOT NULL DEFAULT '',
          op VARCHAR(2) NOT NULL DEFAULT '=',
          value VARCHAR(253) NOT NULL DEFAULT '',
          KEY username (username(32))
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS radusergroup (
          id INT AUTO_INCREMENT PRIMARY KEY,
          username VARCHAR(64) NOT NULL DEFAULT '',
          groupname VARCHAR(64) NOT NULL DEFAULT '',
          priority INT NOT NULL DEFAULT '1',
          KEY username (username(32))
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS radacct (
          radacctid BIGINT(21) AUTO_INCREMENT PRIMARY KEY,
          acctsessionid VARCHAR(64) NOT NULL DEFAULT '',
          acctuniqueid VARCHAR(32) NOT NULL DEFAULT '',
          username VARCHAR(64) NOT NULL DEFAULT '',
          groupname VARCHAR(64) NOT NULL DEFAULT '',
          realm VARCHAR(64) DEFAULT '',
          nasipaddress VARCHAR(15) NOT NULL DEFAULT '',
          nasportid VARCHAR(15) DEFAULT NULL,
          nasporttype VARCHAR(32) DEFAULT NULL,
          acctstarttime DATETIME DEFAULT NULL,
          acctupdatetime DATETIME DEFAULT NULL,
          acctstoptime DATETIME DEFAULT NULL,
          acctinterval INT(12) DEFAULT NULL,
          acctsessiontime INT(12) DEFAULT NULL,
          acctauthentic VARCHAR(32) DEFAULT NULL,
          connectinfo_start VARCHAR(50) DEFAULT NULL,
          connectinfo_stop VARCHAR(50) DEFAULT NULL,
          acctinputoctets BIGINT(20) DEFAULT NULL,
          acctoutputoctets BIGINT(20) DEFAULT NULL,
          calledstationid VARCHAR(50) NOT NULL DEFAULT '',
          callingstationid VARCHAR(50) NOT NULL DEFAULT '',
          acctterminatecause VARCHAR(32) NOT NULL DEFAULT '',
          servicetype VARCHAR(32) DEFAULT NULL,
          framedprotocol VARCHAR(32) DEFAULT NULL,
          framedipaddress VARCHAR(15) NOT NULL DEFAULT '',
          KEY username (username(32)),
          KEY acctsessionid (acctsessionid(32)),
          KEY acctuniqueid (acctuniqueid(32)),
          KEY framedipaddress (framedipaddress(15))
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS radpostauth (
          id INT AUTO_INCREMENT PRIMARY KEY,
          username VARCHAR(64) NOT NULL DEFAULT '',
          pass VARCHAR(64) NOT NULL DEFAULT '',
          reply VARCHAR(32) NOT NULL DEFAULT '',
          authdate TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS system_logs (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_type VARCHAR(20) NOT NULL,
          user_id INT,
          username VARCHAR(100),
          action VARCHAR(50) NOT NULL,
          ip_address VARCHAR(50),
          description TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Check if admin exists
      const [adminRows] = await pool.query("SELECT * FROM users WHERE username = 'admin'");
      if (adminRows.length === 0) {
        const hashedPass = await bcrypt.hash('admin', 10);
        await pool.query("INSERT INTO users (username, password, role) VALUES ('admin', ?, 'admin')", [hashedPass]);
        console.log("[DB Init] Default admin user created successfully.");
      }

      // 2. Initialize Default Settings (bulk insert)
      const defaultSettings = [
        ['auto_billing_enabled', '1'],
        ['auto_isolate_enabled', '1'],
        ['reminder_days_before', '3'],
        ['auto_generate_day', '1'],
        ['late_tolerance_days', '0'],
        ['invoice_prefix', 'INV'],
        ['currency', 'IDR'],
        ['timezone', 'Asia/Jakarta'],
        ['wa_provider', 'external'],
        ['wa_api_token', ''],
        ['wa_api_url', ''],
        ['wa_delay', '5'],
        ['wa_limit', '50'],
        ['license_server_url', 'https://lis.itosolution.my.id'],
        ['pppoe_notify_enabled', '0'],
        ['pppoe_notify_online', '1'],
        ['pppoe_notify_offline', '1'],
        ['pppoe_telegram_bot_token', ''],
        ['pppoe_telegram_chat_id', ''],
        ['midtrans_client_key', ''], ['midtrans_server_key', ''], ['midtrans_mode', ''],
        ['flip_secret_key', ''], ['flip_validation_token', ''], ['flip_mode', ''],
        ['xendit_secret_key', ''], ['xendit_callback_token', ''], ['xendit_mode', ''],
        ['duitku_merchant_code', ''], ['duitku_api_key', ''], ['duitku_mode', ''],
        ['manual_payment_qris', '']
      ];
      await pool.query('INSERT IGNORE INTO settings (setting_key, setting_value) VALUES ?', [defaultSettings]);

      // Initialize Sample Plugins (bulk insert)
      const samplePlugins = [
        ['wa_bulk', 'WhatsApp Bulk Broadcast', 'Kirim pesan massal ke pelanggan dengan sekali klik.'],
        ['network_monitor', 'Network Real-time Monitor', 'Pantau trafik Mikrotik secara real-time dengan grafik premium.'],
        ['radius_manager', 'External RADIUS Manager', 'Integrasi dengan User Manager Mikrotik atau Radius eksternal.'],
        ['technician_attendance', 'Absensi Teknisi', 'Fitur absensi harian untuk teknisi dengan lokasi GPS dan riwayat absensi.'],
        ['portal_ads', 'Portal Ads (Iklan Pop-up)', 'Tampilkan pop-up promosi/iklan kepada pelanggan saat login ke portal.']
      ];
      await pool.query('INSERT IGNORE INTO plugins (plugin_key, name, description) VALUES ?', [samplePlugins]);

      // 3. Fast schema migration check (1 single query via information_schema)
      const [cols] = await pool.query(
        "SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE()"
      );
      const existingColMap = new Set(cols.map(c => `${c.TABLE_NAME.toLowerCase()}.${c.COLUMN_NAME.toLowerCase()}`));

      const checkAndAddColumn = async (table, column, definition) => {
        if (!existingColMap.has(`${table.toLowerCase()}.${column.toLowerCase()}`)) {
          try {
            await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
            console.log(`[DB Migration] Added column ${column} to ${table}`);
          } catch (e) {
            console.error(`[DB Migration] Failed to add column ${column} to ${table}:`, e.message);
          }
        }
      };

      // 4. Run migrations safely now that all tables are guaranteed to exist
      await checkAndAddColumn('customers', 'router_id', 'INT');
      await checkAndAddColumn('customers', 'isolation_date', 'INT DEFAULT 20');
      await checkAndAddColumn('customers', 'billing_method', "VARCHAR(20) DEFAULT 'fixed'");
      await checkAndAddColumn('customers', 'lat', 'VARCHAR(30)');
      await checkAndAddColumn('customers', 'lng', 'VARCHAR(30)');
      await checkAndAddColumn('packages', 'description', 'TEXT');
      await checkAndAddColumn('packages', 'type', "VARCHAR(20) DEFAULT 'pppoe'");
      await checkAndAddColumn('packages', 'duration', 'VARCHAR(20) NULL');
      await checkAndAddColumn('invoices', 'package_id', 'INT');
      await checkAndAddColumn('invoices', 'paid_at', 'TIMESTAMP NULL');
      await checkAndAddColumn('invoices', 'description', 'TEXT');
      await checkAndAddColumn('invoices', 'payment_method', "VARCHAR(50) DEFAULT 'Manual'");
      await checkAndAddColumn('invoices', 'invoice_number', "VARCHAR(50) DEFAULT ''");
      await checkAndAddColumn('invoices', 'payment_proof', 'VARCHAR(255) NULL');
      await checkAndAddColumn('routers', 'status', "VARCHAR(20) DEFAULT 'active'");
      await checkAndAddColumn('customers', 'updated_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
      await checkAndAddColumn('trouble_tickets', 'closed_at', 'TIMESTAMP NULL');
      await checkAndAddColumn('customers', 'portal_password', 'VARCHAR(255) NULL');
      await checkAndAddColumn('customers', 'pppoe_password', "VARCHAR(100) DEFAULT '123456'");
      await checkAndAddColumn('customers', 'email', 'VARCHAR(100)');
      await checkAndAddColumn('trouble_tickets', 'description', 'TEXT');
      await checkAndAddColumn('hioso_olts', 'last_profile', 'VARCHAR(100)');
      await checkAndAddColumn('hioso_olts', 'brand', "VARCHAR(50) DEFAULT 'HIOSO'");
      await checkAndAddColumn('hioso_olts', 'model', "VARCHAR(50) DEFAULT NULL");
      await checkAndAddColumn('hioso_onus', 'mac', 'VARCHAR(100)');
      await checkAndAddColumn('customers', 'odp_id', 'INT');
      await checkAndAddColumn('customers', 'technician_id', 'INT');
      await checkAndAddColumn('customers', 'installation_status', "VARCHAR(20) DEFAULT 'pending'");
      await checkAndAddColumn('trouble_tickets', 'technician_id', 'INT');
      await checkAndAddColumn('users', 'telegram_id', 'VARCHAR(50)');
      await checkAndAddColumn('routers', 'connection_method', "VARCHAR(20) DEFAULT 'api'");
      await checkAndAddColumn('packages', 'is_isolir', 'TINYINT(1) DEFAULT 0');
      await checkAndAddColumn('customers', 'original_package_id', 'INT DEFAULT NULL');
      await checkAndAddColumn('vouchers', 'created_by', 'VARCHAR(50) DEFAULT NULL');

      // Unique Index migration for hioso_onus
      try {
        await pool.query("DELETE t1 FROM hioso_onus t1 INNER JOIN hioso_onus t2 WHERE t1.id < t2.id AND t1.olt_id = t2.olt_id AND t1.onu_index = t2.onu_index");
        const [idx] = await pool.query(
          "SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hioso_onus' AND INDEX_NAME = 'olt_onu_idx'"
        );
        if (idx.length === 0) {
          await pool.query("ALTER TABLE hioso_onus ADD UNIQUE KEY olt_onu_idx (olt_id, onu_index)");
          console.log("[DB Migration] Added unique key olt_onu_idx to hioso_onus");
        }
      } catch (e) {
        // ignore
      }

      // 5. Automatic High-Performance Indexes for MariaDB / MySQL
      const addIndexIfNotExist = async (table, indexName, columns) => {
        try {
          const [idx] = await pool.query(
            "SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?",
            [table, indexName]
          );
          if (idx.length === 0) {
            await pool.query(`CREATE INDEX ${indexName} ON ${table} (${columns})`);
            console.log(`[DB Migration] Created index ${indexName} on ${table}(${columns})`);
          }
        } catch (e) {
          // ignore
        }
      };

      await addIndexIfNotExist('customers', 'idx_cust_status', 'status');
      await addIndexIfNotExist('customers', 'idx_cust_pppoe', 'pppoe_username');
      await addIndexIfNotExist('customers', 'idx_cust_package', 'package_id');
      await addIndexIfNotExist('customers', 'idx_cust_router', 'router_id');
      await addIndexIfNotExist('customers', 'idx_cust_created', 'created_at');
      await addIndexIfNotExist('invoices', 'idx_inv_cust', 'customer_id');
      await addIndexIfNotExist('invoices', 'idx_inv_status', 'status');
      await addIndexIfNotExist('invoices', 'idx_inv_due', 'due_date');
      await addIndexIfNotExist('invoices', 'idx_inv_paid', 'paid_at');
      await addIndexIfNotExist('pppoe_session_state', 'idx_pppoe_user', 'pppoe_username');
      await addIndexIfNotExist('pppoe_session_state', 'idx_pppoe_online', 'is_online');

    } catch (e) {
      console.error("[DB Init Error]", e);
    }
  };

  // In-memory cache for settings & plugins (avoid DB hit on every request)
  let _settingsCache = null;
  let _pluginsCache = null;
  let _settingsCacheTime = 0;
  let _pluginsCacheTime = 0;
  const CACHE_TTL = 60 * 1000; // 60 seconds

  // Global Settings & Plugins Middleware
  app.use(async (req, res, next) => {
    try {
      const now = Date.now();

      // Load Settings (cached)
      if (!_settingsCache || (now - _settingsCacheTime) > CACHE_TTL) {
        const [settingRows] = await pool.query('SELECT setting_key, setting_value FROM settings');
        _settingsCache = {};
        settingRows.forEach(r => _settingsCache[r.setting_key] = r.setting_value);
        _settingsCacheTime = now;
      }
      res.locals.settings = _settingsCache;

      // Load Plugins (cached)
      if (!_pluginsCache || (now - _pluginsCacheTime) > CACHE_TTL) {
        const [pluginRows] = await pool.query('SELECT * FROM plugins');
        _pluginsCache = {};
        pluginRows.forEach(p => _pluginsCache[p.plugin_key] = p);
        _pluginsCacheTime = now;
      }
      res.locals.plugins = _pluginsCache;

      next();
    } catch (err) {
      console.error("Global Middleware Error:", err);
      res.locals.settings = _settingsCache || {};
      res.locals.plugins = _pluginsCache || {};
      next();
    }
  });

  // Helper to invalidate cache when settings are saved
  app.locals.invalidateSettingsCache = () => {
    _settingsCache = null;
    _pluginsCache = null;
    _settingsCacheTime = 0;
    _pluginsCacheTime = 0;
  };

  // PPPoE online/offline monitor → Telegram (setiap 3 menit)
  cron.schedule('*/3 * * * *', async () => {
    try {
      const { runPppoeMonitor } = require('./helpers/pppoe_monitor');
      await runPppoeMonitor(pool);
    } catch (e) {
      console.error('[CRON] PPPoE Monitor Error:', e.message);
    }
  });

  // Auto Sync OLT every 2 hours (optimized for STB to save CPU and Disk Writes)
  cron.schedule('0 */2 * * *', async () => {
    console.log('[CRON] Auto-Sync OLT started...');
    try {
      const [olts] = await pool.query('SELECT * FROM hioso_olts WHERE status = "active"');
      if (olts.length === 0) return;

      const HiosoOLT = require('./helpers/olt');

      for (const olt of olts) {
        try {
          const helper = new HiosoOLT(olt.host, olt.community, olt.port);
          const brand = (olt.brand || 'HIOSO').toUpperCase().trim();
          let onus, detectedProfile;

          if (brand === 'CDATA' || brand === 'C-DATA') {
            ({ onus, detectedProfile } = await helper.getCdataOnuList());
          } else {
            const profile = brand === 'HIOSO' ? (olt.last_profile || 'HIOSO_C') : olt.brand;
            ({ onus, detectedProfile } = await helper.getOnuList(profile));
          }

          if (detectedProfile && detectedProfile !== olt.last_profile && brand !== 'CDATA' && brand !== 'C-DATA') {
            await pool.query('UPDATE hioso_olts SET last_profile = ? WHERE id = ?', [detectedProfile, olt.id]);
          }

          await pool.query('DELETE FROM hioso_onus WHERE olt_id = ?', [olt.id]);
          if (onus.length > 0) {
            const values = onus.map(o => [olt.id, o.index, o.name, o.sn || 'Unknown', o.mac || '', o.tx_power, o.rx_power, o.status]);
            await pool.query(`INSERT INTO hioso_onus (olt_id, onu_index, name, sn, mac, tx_power, rx_power, status) VALUES ?`, [values]);
          }
        } catch (err) {
          console.error(`[CRON OLT SYNC] Error for ${olt.name}:`, err.message);
        }
      }
    } catch (e) {
      console.error('[CRON OLT SYNC] Fatal Error:', e.message);
    }
  });

  // Daily Admin Report Cron (Run at 08:30 AM)
  cron.schedule('30 8 * * *', async () => {
    try {
      console.log('[CRON] Sending Daily Admin Report...');
      const [[stats]] = await pool.query(`
        SELECT 
          (SELECT COUNT(*) FROM customers) as total_cust,
          (SELECT COUNT(*) FROM customers WHERE status='active') as active_cust,
          (SELECT COUNT(*) FROM customers WHERE status='isolated') as isolated_cust,
          (SELECT COUNT(*) FROM trouble_tickets WHERE status='open') as open_tickets,
          (SELECT COALESCE(SUM(amount),0) FROM invoices WHERE status='paid' AND MONTH(paid_at)=MONTH(NOW()) AND YEAR(paid_at)=YEAR(NOW())) as revenue_month
        FROM (SELECT 1) as t
      `);

      const { sendWhatsApp, sendTelegram } = require('./helpers/notification');
      const [adminRows] = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'wa_admin'");
      const adminPhone = adminRows[0] ? adminRows[0].setting_value : null;

      const reportMsg = `📊 *Laporan Harian Dino-Bill*\n\n` +
        `👥 Pelanggan: ${stats.total_cust} (${stats.active_cust} Aktif, ${stats.isolated_cust} Isolir)\n` +
        `🎫 Tiket Terbuka: ${stats.open_tickets}\n` +
        `💰 Omset Bln Ini: Rp ${parseFloat(stats.revenue_month).toLocaleString('id-ID')}\n\n` +
        `Sistem berjalan normal. ✅`;

      if (adminPhone) await sendWhatsApp(pool, adminPhone, reportMsg).catch(() => { });
      await sendTelegram(pool, reportMsg).catch(() => { });
    } catch (e) {
      console.error('[CRON] Admin Report Error:', e.message);
    }
  });


  // Auth Middleware
  const requireAuth = (req, res, next) => {
    if (!req.session.userId) {
      return res.redirect('/login');
    }
    next();
  };

  const requireAdmin = (req, res, next) => {
    if (!req.session.userId) {
      return res.redirect('/login');
    }
    if (req.session.role !== 'admin') {
      if (req.session.role === 'technician') {
        return res.redirect('/technician');
      }
      if (req.session.role === 'sales') {
        return res.redirect('/sales');
      }
      return res.status(403).send("Forbidden: Anda tidak memiliki akses ke portal admin.");
    }
    next();
  };

  const requireRole = (role) => {
    return (req, res, next) => {
      if (!req.session.userId) return res.redirect('/login');
      if (req.session.role !== 'admin' && req.session.role !== role) {
        return res.status(403).send("Forbidden: Anda tidak memiliki akses ke halaman ini.");
      }
      next();
    };
  };

  const acsRoutes = require('./routes/acs');
  acsRoutes.setPool(pool);
  app.use('/acs', requireAdmin, acsRoutes);

  const pluginRoutes = require('./routes/plugins');
  pluginRoutes.setPool(pool);
  app.use('/plugins', requireAdmin, pluginRoutes);

  const oltRoutes = require('./routes/olt');
  oltRoutes.setPool(pool);
  app.use('/olt', requireAdmin, oltRoutes);

  app.get('/technician', requireRole('technician'), async (req, res) => {
    try {
      const search = req.query.search || '';
      let tickets = [];
      let searchResults = [];

      // 1. Get Open Tickets
      [tickets] = await pool.query(`
            SELECT t.*, c.name as customer_name, c.address as customer_address, c.phone as customer_phone, c.pppoe_username, c.lat, c.lng 
            FROM trouble_tickets t 
            JOIN customers c ON t.customer_id = c.id 
            WHERE t.status = "open" 
            ORDER BY t.priority DESC, t.created_at ASC`);

      // 1.5 Get Pending Installations for this technician
      const [installations] = await pool.query(`
            SELECT * FROM customers 
            WHERE technician_id = ? AND installation_status = 'pending'
            ORDER BY created_at DESC
        `, [req.session.userId]);

      // 2. Handle Search if provided
      if (search) {
        [searchResults] = await pool.query(`
                SELECT c.*, p.name as package_name, 
                       u.rx_power, u.status as onu_status, u.onu_index, u.olt_id, o.name as olt_name
                FROM customers c
                LEFT JOIN packages p ON c.package_id = p.id
                LEFT JOIN hioso_onus u ON u.id = (
                    SELECT id FROM hioso_onus 
                    WHERE (name = c.pppoe_username OR name = c.name) AND name IS NOT NULL AND name != ''
                    ORDER BY status DESC, last_updated DESC 
                    LIMIT 1
                )
                LEFT JOIN hioso_olts o ON u.olt_id = o.id
                WHERE c.phone LIKE ? OR c.pppoe_username LIKE ? OR c.name LIKE ?
                LIMIT 10
            `, [`%${search}%`, `%${search}%`, `%${search}%`]);
      }

      // 3. Get all customers with coordinates for the map
      const [customerMarkers] = await pool.query(`
            SELECT c.id, c.name, c.lat, c.lng, c.status, c.address, c.pppoe_username,
                   p.name as package_name, c.phone,
                   o.name as odp_name, o.lat as odp_lat, o.lng as odp_lng
            FROM customers c
            LEFT JOIN packages p ON c.package_id = p.id
            LEFT JOIN map_objects o ON c.odp_id = o.id
            WHERE c.lat IS NOT NULL AND c.lng IS NOT NULL
        `);

      // Map ONU Data (Redaman)
      try {
        const [onus] = await pool.query('SELECT name, rx_power, status, olt_id, onu_index FROM hioso_onus');
        const onuMap = {};
        onus.forEach(o => {
          if (o.name) onuMap[o.name.toLowerCase()] = o;
        });

        customerMarkers.forEach(c => {
          const onu = (c.pppoe_username && onuMap[c.pppoe_username.toLowerCase()]) ||
            (c.name && onuMap[c.name.toLowerCase()]);
          c.redaman = onu ? onu.rx_power : 'N/A';
          c.onu_status = onu ? onu.status : 'N/A';
          c.olt_id = onu ? onu.olt_id : null;
          c.onu_index = onu ? onu.onu_index : null;
        });
      } catch (e) {
        console.error("Failed to load ONU data for technician map:", e.message);
      }

      // 4. Get map objects and cables
      const [mapObjects] = await pool.query('SELECT * FROM map_objects');
      const [mapCables] = await pool.query('SELECT * FROM map_cables');

      res.render('technician_portal', {
        user: req.session,
        tickets,
        installations,
        searchResults,
        customerMarkers,
        mapObjects,
        mapCables: mapCables.map(c => ({ ...c, path: JSON.parse(c.path) })),
        search,
        currentPage: 'technician'
      });
    } catch (e) {
      console.error(e);
      res.status(500).send("Portal error: " + e.message);
    }
  });

  // API to fetch real-time Wifi SSID from GenieACS
  app.get('/technician/api/wifi-info', requireRole('technician'), async (req, res) => {
    const { pppoe } = req.query;
    if (!pppoe) return res.json({ success: false, message: 'PPPoE user required' });

    try {
      const [settingsRows] = await pool.query("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('acs_url', 'acs_user', 'acs_pass')");
      const s = {}; settingsRows.forEach(r => s[r.setting_key] = r.setting_value);

      if (!s.acs_url) return res.json({ success: false, message: 'ACS not configured' });

      const axios = require('axios');
      const auth = s.acs_user ? { username: s.acs_user, password: s.acs_pass } : undefined;

      // Find device by PPPoE username
      const query = {
        "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.Username": pppoe
      };
      const projection = "InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID,InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase";

      const response = await axios.get(`${s.acs_url}/devices`, {
        params: { query: JSON.stringify(query), projection },
        auth,
        timeout: 15000
      });

      if (response.data && response.data.length > 0) {
        const dev = response.data[0];
        const getVal = (p) => {
          const parts = p.split('.');
          let v = dev;
          for (const pt of parts) {
            v = (v && v[pt]) ? v[pt] : undefined;
          }
          return (v && v._value) ? v._value : v;
        };
        const ssid = getVal('InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID');
        const pass = getVal('InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase');
        res.json({ success: true, ssid: ssid || 'Unknown', password: pass || 'Unknown' });
      } else {
        res.json({ success: false, message: 'Device not found in ACS' });
      }
    } catch (e) {
      res.json({ success: false, message: e.message });
    }
  });

  // API to fetch real-time ONU Signal (RX Power) from OLT
  app.get('/api/onu-info', requireAuth, async (req, res) => {
    const { olt_id, index } = req.query;
    if (!olt_id || !index) return res.json({ success: false, message: 'OLT ID and Index required' });

    try {
      const [[onu]] = await pool.query('SELECT rx_power, status FROM hioso_onus WHERE olt_id = ? AND onu_index = ?', [olt_id, index]);
      if (!onu) return res.json({ success: false, message: 'ONU tidak ditemukan di database' });

      res.json({ success: true, rx_power: onu.rx_power, status: onu.status });
    } catch (e) {
      res.json({ success: false, message: e.message });
    }
  });

  app.post('/technician/api/installation-done/:id', requireRole('technician'), async (req, res) => {
    try {
      await pool.query("UPDATE customers SET installation_status = 'completed' WHERE id = ? AND technician_id = ?", [req.params.id, req.session.userId]);
      res.json({ success: true, message: 'Instalasi ditandai sebagai selesai' });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // API to fetch active PPPoE connections from all routers that are NOT in the database
  app.get('/api/mikrotik/active-pppoe-unlinked', requireAdmin, async (req, res) => {
    try {
      const [routers] = await pool.query("SELECT * FROM routers WHERE status = 'active'");
      if (routers.length === 0) return res.json({ success: false, message: 'No active routers' });

      const [existingCustomers] = await pool.query("SELECT pppoe_username FROM customers WHERE pppoe_username IS NOT NULL AND pppoe_username != ''");
      const existingNames = new Set(existingCustomers.map(c => c.pppoe_username));

      const MikroTik = require('./helpers/mikrotik');
      let allActive = [];

      for (const router of routers) {
        const result = await MikroTik.getActiveConnections(router);
        if (result.success) {
          // Filter ones not in database
          const unlinked = result.data.filter(c => !existingNames.has(c.name));
          allActive = allActive.concat(unlinked.map(c => ({
            username: c.name,
            address: c.address,
            uptime: c.uptime,
            router_id: router.id,
            router_name: router.name
          })));
        }
      }

      res.json({ success: true, data: allActive });
    } catch (e) {
      res.json({ success: false, message: e.message });
    }
  });


  app.get('/sales', requireRole('sales'), async (req, res) => {
    try {
      const [leads] = await pool.query("SELECT * FROM customers WHERE status = 'active' ORDER BY created_at DESC LIMIT 10");
      const [packages] = await pool.query("SELECT * FROM packages");
      const pppoePackages = packages.filter(p => p.type !== 'hotspot');
      const hotspotPackages = packages.filter(p => p.type === 'hotspot');
      const [[commissionRow]] = await pool.query("SELECT COALESCE(SUM(amount),0) as commission FROM invoices WHERE status = 'paid' AND MONTH(created_at) = MONTH(CURRENT_DATE())");

      res.render('sales_portal', {
        user: req.session,
        leads,
        packages: pppoePackages,
        hotspotPackages,
        totalLeads: leads.length,
        closingMonth: leads.length,
        commission: (commissionRow.commission * 0.1) || 0, // 10% komisi contoh
        currentPage: 'sales'
      });
    } catch (err) {
      res.status(500).send("Database error: " + err.message);
    }
  });

  // POST /sales/generate-voucher
  app.post('/sales/generate-voucher', requireRole('sales'), async (req, res) => {
    try {
      const { package_id } = req.body;
      const [pkgRows] = await pool.query('SELECT * FROM packages WHERE id = ? AND type = "hotspot"', [package_id]);
      if (pkgRows.length === 0) return res.json({ success: false, message: 'Paket Hotspot tidak valid' });
      const pkg = pkgRows[0];

      // 1. Generate code
      const code = Math.random().toString(36).substring(2, 8).toUpperCase();

      // 2. Add to MikroTik (use first router)
      const [routers] = await pool.query('SELECT * FROM routers LIMIT 1');
      if (routers.length > 0) {
        const routerData = routers[0];
        const mikrotikHelper = require('./helpers/mikrotik');
        // speed_limit in package acts as the profile name for hotspot
        await mikrotikHelper.addHotspotUser(routerData, code, code, pkg.speed_limit || 'default', pkg.duration || null);
      }

      // 3. Save to DB
      const createdBy = req.session.user ? req.session.user.username : 'sales';
      await pool.query('INSERT INTO vouchers (code, price, profile, created_by) VALUES (?, ?, ?, ?)',
        [code, pkg.price, pkg.speed_limit || 'default', createdBy]);

      res.json({ success: true, data: { code, price: pkg.price, profile: pkg.speed_limit || 'default', duration: pkg.duration || '' } });
    } catch (e) {
      res.json({ success: false, message: e.message });
    }
  });

  const mapRouter = require('./routes/map');
  mapRouter.setPool(pool);
  app.use('/map', requireAdmin, mapRouter);

  app.get('/map', requireAdmin, async (req, res) => {
    const [customers] = await pool.query(`
        SELECT c.*, o.lat as odp_lat, o.lng as odp_lng, o.name as odp_name,
               p.name as package_name, p.price as package_price
        FROM customers c 
        LEFT JOIN map_objects o ON c.odp_id = o.id 
        LEFT JOIN packages p ON c.package_id = p.id
        WHERE c.lat IS NOT NULL AND c.lng IS NOT NULL
    `);
    const [objects] = await pool.query('SELECT * FROM map_objects');
    const [cables] = await pool.query('SELECT * FROM map_cables');

    // Map ONU Data (Redaman)
    try {
      const [onus] = await pool.query('SELECT name, rx_power, status, olt_id, onu_index FROM hioso_onus');
      const onuMap = {};
      onus.forEach(o => {
        if (o.name) onuMap[o.name.toLowerCase()] = o;
      });

      customers.forEach(c => {
        const onu = (c.pppoe_username && onuMap[c.pppoe_username.toLowerCase()]) ||
          (c.name && onuMap[c.name.toLowerCase()]);
        c.redaman = onu ? onu.rx_power : 'N/A';
        c.onu_status = onu ? onu.status : 'N/A';
        c.olt_id = onu ? onu.olt_id : null;
        c.onu_index = onu ? onu.onu_index : null;
      });
    } catch (e) {
      console.error("Failed to load ONU data for map:", e.message);
    }

    res.render('map', {
      user: req.session,
      customers,
      objects,
      cables: cables.map(c => ({ ...c, path: JSON.parse(c.path) })),
      currentPage: 'map'
    });
  });

  let _trafficCache = null;
  let _trafficCacheTime = 0;

  app.get('/api/mikrotik/traffic', requireAdmin, async (req, res) => {
    try {
      const now = Date.now();
      const { interface: iface, router: routerId } = req.query;
      const targetIface = iface || 'ether1';
      const cacheKey = `${targetIface}_${routerId || 'all'}`;

      if (_trafficCache && _trafficCache.key === cacheKey && (now - _trafficCacheTime) < 2000) {
        return res.json(_trafficCache.data);
      }

      let routers;
      if (routerId) {
        const [rows] = await pool.query("SELECT * FROM routers WHERE id = ? AND status = 'active'", [routerId]);
        routers = rows;
      } else {
        const [rows] = await pool.query("SELECT * FROM routers WHERE status = 'active'");
        routers = rows;
      }

      const trafficData = [];
      const mikrotik = require('./helpers/mikrotik');

      for (const r of routers) {
        try {
          const result = await Promise.race([
            mikrotik.getInterfaceTraffic(r, targetIface),
            new Promise(resolve => setTimeout(() => resolve({ success: false, message: 'timeout' }), 1500))
          ]);
          if (result && result.success && result.data) {
            trafficData.push({
              router_id: r.id,
              router_name: r.name,
              rx: parseInt(result.data.rx) || 0,
              tx: parseInt(result.data.tx) || 0
            });
          }
        } catch (e) { }
      }

      const responsePayload = { success: true, data: trafficData };
      _trafficCache = { key: cacheKey, data: responsePayload };
      _trafficCacheTime = now;

      res.json(responsePayload);
    } catch (e) {
      res.json({ success: false, message: e.message });
    }
  });

  app.get('/api/mikrotik/interfaces', requireAdmin, async (req, res) => {
    try {
      const { router: routerId } = req.query;
      if (!routerId) return res.status(400).json({ success: false, message: 'Router ID required' });

      const [[router]] = await pool.query("SELECT * FROM routers WHERE id = ?", [routerId]);
      if (!router) return res.status(404).json({ success: false, message: 'Router tidak ditemukan' });

      const mikrotik = require('./helpers/mikrotik');
      const interfaces = await mikrotik.getInterfaces(router);
      
      res.json({ success: true, data: interfaces || [] });
    } catch (e) {
      res.json({ success: false, message: e.message });
    }
  });

  app.get('/api/mikrotik/monitor/system', requireAdmin, async (req, res) => {
    try {
      const { router: routerId } = req.query;
      if (!routerId) return res.status(400).json({ success: false, message: 'Router ID required' });

      const [[router]] = await pool.query("SELECT * FROM routers WHERE id = ?", [routerId]);
      if (!router) return res.status(404).json({ success: false, message: 'Router tidak ditemukan' });

      const mikrotik = require('./helpers/mikrotik');
      
      const sysResult = await mikrotik.getSystemResource(router);
      if (!sysResult.success) {
        return res.json({ success: false, message: sysResult.message || 'Gagal menghubungi router' });
      }

      const pppoeResult = await mikrotik.getActiveConnections(router);
      const hotspotResult = await mikrotik.getHotspotActive(router);

      const pppoeActiveCount = (pppoeResult.success && pppoeResult.data) ? pppoeResult.data.length : 0;
      const hotspotActiveCount = (hotspotResult.success && hotspotResult.data) ? hotspotResult.data.length : 0;

      res.json({
        success: true,
        data: {
          resource: sysResult.data,
          pppoeActive: pppoeActiveCount,
          hotspotActive: hotspotActiveCount
        }
      });
    } catch (e) {
      res.json({ success: false, message: e.message });
    }
  });

  const hotspotRoutes = require('./routes/hotspot');
  hotspotRoutes.setPool(pool);
  app.use('/hotspot', requireAdmin, hotspotRoutes);
  app.use('/vouchers', (req, res) => res.redirect('/hotspot/vouchers'));

  app.get('/login', (req, res) => {
    if (req.session.userId) return res.redirect('/');
    res.render('login', { error: null });
  });

  app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
      const [rows] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
      if (rows.length > 0) {
        const user = rows[0];
        const match = await bcrypt.compare(password, user.password);
        if (match) {
          req.session.userId = user.id;
          req.session.role = user.role;
          req.session.username = user.username;

          await logActivity(pool, user.role, user.id, user.username, 'Login', req.ip, 'User logged in successfully');

          if (user.role === 'technician') return res.redirect('/technician');
          if (user.role === 'sales') return res.redirect('/sales');
          return res.redirect('/');
        }
      }
      res.render('login', { error: 'invalid_credentials' });
    } catch (err) {
      res.render('login', { error: 'database_error' });
    }
  });

  app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
  });

  app.get('/', requireAdmin, async (req, res) => {
    try {
      const [
        [[cStats]],
        [[iStats]],
        [[tRow]],
        [revRows],
        [custRows],
        [recentInvoices],
        [recentCustomers],
        [[oltStats]],
        [[routerStats]]
      ] = await Promise.all([
        pool.query(`SELECT COUNT(*) as totalCustomers, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) as activeCustomers, SUM(CASE WHEN status='isolated' THEN 1 ELSE 0 END) as isolatedCustomers FROM customers`),
        pool.query(`SELECT SUM(CASE WHEN status='unpaid' THEN 1 ELSE 0 END) as unpaidInvoices, SUM(CASE WHEN status='unpaid' AND due_date < CURDATE() THEN 1 ELSE 0 END) as overdueInvoices, COALESCE(SUM(CASE WHEN status='paid' AND MONTH(paid_at)=MONTH(NOW()) AND YEAR(paid_at)=YEAR(NOW()) THEN amount ELSE 0 END), 0) as totalRevenue FROM invoices`),
        pool.query("SELECT COUNT(*) as openTickets FROM trouble_tickets WHERE status='open'"),
        pool.query(`SELECT YEAR(paid_at) as y, MONTH(paid_at) as m, COALESCE(SUM(amount), 0) as rev FROM invoices WHERE status='paid' AND paid_at >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH) GROUP BY YEAR(paid_at), MONTH(paid_at) ORDER BY YEAR(paid_at) ASC, MONTH(paid_at) ASC`),
        pool.query(`SELECT YEAR(created_at) as y, MONTH(created_at) as m, COUNT(*) as cnt FROM customers WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH) GROUP BY YEAR(created_at), MONTH(created_at) ORDER BY YEAR(created_at) ASC, MONTH(created_at) ASC`),
        pool.query(`SELECT i.*, c.name as customer_name FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id ORDER BY i.created_at DESC LIMIT 10`),
        pool.query(`SELECT c.*, p.name as package_name FROM customers c LEFT JOIN packages p ON c.package_id = p.id ORDER BY c.created_at DESC LIMIT 5`),
        pool.query('SELECT COUNT(*) as total, SUM(CASE WHEN status="Up" THEN 1 ELSE 0 END) as online FROM hioso_onus'),
        pool.query('SELECT COUNT(*) as total, SUM(CASE WHEN status="active" THEN 1 ELSE 0 END) as online FROM routers')
      ]);

      const openTickets = tRow?.openTickets || 0;
      const totalCustomers = cStats?.totalCustomers || 0;
      const activeCustomers = cStats?.activeCustomers || 0;
      const isolatedCustomers = cStats?.isolatedCustomers || 0;
      const unpaidInvoices = iStats?.unpaidInvoices || 0;
      const overdueInvoices = iStats?.overdueInvoices || 0;
      const totalRevenue = iStats?.totalRevenue || 0;

      const monthlyRevenue = revRows.map(row => ({
        month: `${row.y}-${String(row.m).padStart(2, '0')}`,
        revenue: parseFloat(row.rev || 0)
      }));

      const monthlyCustomers = custRows.map(row => ({
        month: `${row.y}-${String(row.m).padStart(2, '0')}`,
        count: parseInt(row.cnt || 0, 10)
      }));

      res.render('dashboard', {
        user: req.session,
        stats: { totalCustomers, activeCustomers, isolatedCustomers, unpaidInvoices, overdueInvoices, totalRevenue, openTickets },
        monthlyRevenue, monthlyCustomers, recentInvoices, recentCustomers,
        oltStats: oltStats || { total: 0, online: 0 },
        routerStats: routerStats || { total: 0, online: 0 },
        currentPage: 'dashboard'
      });
    } catch (err) {
      console.error(err);
      res.render('dashboard', {
        user: req.session,
        stats: {},
        monthlyRevenue: [],
        monthlyCustomers: [],
        recentInvoices: [],
        recentCustomers: [],
        oltStats: { total: 0, online: 0 },
        routerStats: { total: 0, online: 0 },
        currentPage: 'dashboard'
      });
    }
  });

  // Register Routes
  const customersRouter = require('./routes/customers');
  customersRouter.setPool(pool);
  app.use('/customers', requireAuth, customersRouter);

  const billingRouter = require('./routes/billing');
  billingRouter.setPool(pool);
  app.use('/billing', requireAdmin, billingRouter);

  const mikrotikRouter = require('./routes/mikrotik');
  mikrotikRouter.setPool(pool);
  app.use('/mikrotik', requireAdmin, mikrotikRouter);

  const settingsRouter = require('./routes/settings');
  settingsRouter.setPool(pool);
  app.use('/settings', requireAdmin, settingsRouter);

  // Isolir Public Route
  app.get('/isolir', async (req, res) => {
    try {
      let ipCustomer = null;
      const clientIp = req.ip || req.connection.remoteAddress;

      // Attempt to find customer by IP from PPPoE active sessions or router if we tracked it
      // For now, we will pass null, and let the customer input their ID
      const [settingsRows] = await pool.query("SELECT * FROM settings");
      const settings = {};
      settingsRows.forEach(r => settings[r.setting_key] = r.setting_value);

      res.render('isolir_page', { settings, ipCustomer });
    } catch (e) {
      res.status(500).send("Terjadi kesalahan.");
    }
  });

  app.get('/api/check-bill', async (req, res) => {
    try {
      const cid = req.query.id;
      if (!cid) return res.json({ success: false, message: 'ID pelanggan tidak boleh kosong.' });

      // Search by pppoe_username, phone, or id
      const [[customer]] = await pool.query(
        'SELECT * FROM customers WHERE pppoe_username = ? OR phone = ? OR id = ?',
        [cid, cid, cid]
      );

      if (!customer) return res.json({ success: false, message: 'Data pelanggan tidak ditemukan.' });

      // Get unpaid invoices
      const [invoices] = await pool.query(
        'SELECT * FROM invoices WHERE customer_id = ? AND status = "unpaid" ORDER BY created_at DESC LIMIT 1',
        [customer.id]
      );

      if (invoices.length === 0) {
        return res.json({ success: false, message: 'Pelanggan tidak memiliki tunggakan.' });
      }

      const invoice = invoices[0];
      res.json({
        success: true,
        customer: {
          id: customer.id,
          name: customer.name,
          invoice_no: invoice.invoice_number || invoice.id,
          amount: invoice.amount
        }
      });
    } catch (e) {
      res.json({ success: false, message: e.message });
    }
  });

  const portalRoutes = require('./routes/portal');
  portalRoutes.setPool(pool);
  app.use('/portal', portalRoutes);

  const logsRouter = require('./routes/logs');
  logsRouter.setPool(pool);
  app.use('/logs', requireAdmin, logsRouter);

  const packagesRouter = require('./routes/packages');
  packagesRouter.setPool(pool);
  app.use('/packages', requireAdmin, packagesRouter);

  const ticketsRouter = require('./routes/tickets');
  ticketsRouter.setPool(pool);
  app.use('/tickets', requireAuth, ticketsRouter);

  const inventoryRouter = require('./routes/inventory');
  inventoryRouter.setPool(pool);
  app.use('/inventory', requireAdmin, inventoryRouter);

  // --- DYNAMIC PLUGIN LOADER ---
  const pluginDir = path.resolve(__dirname, 'plugins');
  if (fs.existsSync(pluginDir)) {
    const pluginFiles = fs.readdirSync(pluginDir).filter(f => f.endsWith('.js'));
    pluginFiles.forEach(file => {
      try {
        const pluginPath = path.resolve(pluginDir, file);
        delete require.cache[require.resolve(pluginPath)];
        const plugin = require(pluginPath);
        if (typeof plugin === 'function') {
          plugin(app, pool, { requireAuth: requireAdmin, requireRole });
          console.log(`[System] Plugin loaded successfully: ${file}`);
        }
      } catch (err) {
        console.error(`[System] Failed to load plugin ${file}:`, err.message);
      }
    });
  }

  // --- LICENSE SYNCHRONIZATION (ANTI-TAMPER) ---
  const syncLicenses = async () => {
    try {
      const [plugins] = await pool.query("SELECT * FROM plugins WHERE is_active = 1");
      if (plugins.length === 0) return;

      const axios = require('axios');
      const os = require('os');
      const [[{ server_url }]] = await pool.query("SELECT setting_value as server_url FROM settings WHERE setting_key = 'license_server_url'");

      console.log(`[License] Syncing ${plugins.length} active licenses...`);

      for (const p of plugins) {
        try {
          const response = await axios.post(`${server_url}/validate-license`, {
            license_key: p.license_key,
            plugin_key: p.plugin_key,
            client_identity: os.hostname(),
            app_name: 'Dino-Bill'
          });

          console.log(`[License Debug] Checking ${p.plugin_key}:`, response.data);

          if (!response.data.success) {
            console.warn(`[License] Feature ${p.plugin_key} is no longer valid. Reason: ${response.data.message || 'Unknown'}. Disabling...`);
            await pool.query("UPDATE plugins SET is_active = 0 WHERE plugin_key = ?", [p.plugin_key]);
          } else {
            console.log(`[License] Feature ${p.plugin_key} validated successfully.`);
          }
        } catch (err) {
          console.error(`[License] Failed to sync ${p.plugin_key}: Server unreachable.`);
        }
      }
    } catch (e) {
      console.error('[License] Sync Error:', e.message);
    }
  };

  // Run sync every 24 hours at 01:00 AM
  cron.schedule('0 1 * * *', syncLicenses);

  // Run sync once on startup
  syncLicenses();

  // Daily at midnight: auto-isolate overdue customers + MikroTik + WA
  cron.schedule('0 0 * * *', async () => {
    try {
      console.log('[CRON] Running daily auto-isolir...');
      const [overdueRows] = await pool.query(
        `SELECT DISTINCT i.customer_id FROM invoices i
         WHERE i.status = 'unpaid' AND i.due_date < CURDATE()`
      );
      const { getSettings } = require('./helpers/notification');
      const s = await getSettings(pool, ['wa_delay', 'wa_limit']);
      const waLimit = parseInt(s.wa_limit) || 50;
      const waDelay = (parseInt(s.wa_delay) || 5) * 1000;
      let sentCount = 0;
      let count = 0;

      for (const row of overdueRows) {
        // Check if active before isolating to avoid double-isolating
        const [[checkCust]] = await pool.query("SELECT status FROM customers WHERE id = ?", [row.customer_id]);
        if (checkCust && checkCust.status === 'active') {
          try {
            await isolateCustomer(pool, row.customer_id, app.locals);
            count++;
            const [[cust]] = await pool.query("SELECT * FROM customers WHERE id=?", [row.customer_id]);
            if (cust) {
              const canSendWA = sentCount < waLimit;
              await notifyIsolation(pool, cust, { wa: canSendWA, tg: true });
              if (canSendWA) {
                sentCount++;
                await new Promise(r => setTimeout(r, waDelay));
              } else {
                await new Promise(r => setTimeout(r, 500)); // Delay to avoid Telegram API rate limit
              }
            }
          } catch (err) {
            console.error(`[CRON Auto-Isolir] Gagal isolir pelanggan #${row.customer_id}:`, err.message);
          }
        }
      }
      console.log(`[CRON] Auto-isolir done. ${count} customers isolated and notified.`);
      await logActivity(pool, 'system', null, 'System', 'Cron: Auto-Isolir', null, `${count} customers isolated`);
    } catch (e) {
      console.error('[CRON] Auto-isolir error:', e.message);
    }
  });


  // Daily at 8 AM: send WA reminder for invoices due in 3 days
  cron.schedule('0 8 * * *', async () => {
    try {
      console.log('[CRON] Sending payment reminders...');
      const [upcoming] = await pool.query(
        `SELECT i.*, c.name, c.phone FROM invoices i
         JOIN customers c ON i.customer_id = c.id
         WHERE i.status = 'unpaid' AND i.due_date = DATE_ADD(CURDATE(), INTERVAL 3 DAY)
         AND c.phone IS NOT NULL AND c.phone != ''`
      );
      const { getSettings } = require('./helpers/notification');
      const s = await getSettings(pool, ['wa_delay', 'wa_limit']);
      const waLimit = parseInt(s.wa_limit) || 50;
      const waDelay = (parseInt(s.wa_delay) || 5) * 1000;
      let sentCount = 0;

      for (const inv of upcoming) {
        if (sentCount >= waLimit) break;
        const dueStr = new Date(inv.due_date).toLocaleDateString('id-ID');
        await notifyReminder(pool, inv, inv.amount, dueStr);
        sentCount++;
        await new Promise(r => setTimeout(r, waDelay));
      }
      console.log(`[CRON] Reminders sent: ${sentCount}`);
    } catch (e) {
      console.error('[CRON] Reminder error:', e.message);
    }
  });

  // Monthly on 1st: generate invoices for all active customers + send WA
  cron.schedule('0 6 1 * *', async () => {
    try {
      console.log('[CRON] Generating monthly invoices...');
      const [customers] = await pool.query(
        `SELECT c.*, p.price as package_price FROM customers c 
         LEFT JOIN packages p ON c.package_id = p.id WHERE c.status = 'active' AND (c.billing_method IS NULL OR c.billing_method = 'fixed')`
      );
      const month = new Date().getMonth() + 1;
      const year = new Date().getFullYear();
      let created = 0;
      const { getSettings } = require('./helpers/notification');
      const s = await getSettings(pool, ['wa_delay', 'wa_limit']);
      const waLimit = parseInt(s.wa_limit) || 50;
      const waDelay = (parseInt(s.wa_delay) || 5) * 1000;
      let sentCount = 0;

      for (const c of customers) {
        const [[exists]] = await pool.query(
          'SELECT id FROM invoices WHERE customer_id=? AND MONTH(due_date)=? AND YEAR(due_date)=?',
          [c.id, month, year]
        );
        if (!exists) {
          const day = c.isolation_date || 20;
          const dueDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          await pool.query(
            'INSERT INTO invoices (customer_id, package_id, amount, due_date, status) VALUES (?,?,?,?,?)',
            [c.id, c.package_id, c.package_price || 0, dueDate, 'unpaid']
          );
          created++;
          // Send WA notification only if within limit, but always notify Telegram
          const canSendWA = sentCount < waLimit;
          await notifyInvoiceCreated(pool, c, c.package_price || 0, dueDate, { wa: canSendWA, tg: true });
          if (canSendWA) {
            sentCount++;
            if (sentCount < waLimit) {
              await new Promise(r => setTimeout(r, waDelay));
            } else {
              await new Promise(r => setTimeout(r, 500)); // Delay to avoid Telegram API rate limit
            }
          } else {
            await new Promise(r => setTimeout(r, 500)); // Delay to avoid Telegram API rate limit
          }
        }
      }
      console.log(`[CRON] Monthly invoices: ${created} created and notified.`);
      await logActivity(pool, 'system', null, 'System', 'Cron: Monthly Invoice', null, `${created} invoices created`);
    } catch (e) {
      console.error('[CRON] Invoice generation error:', e.message);
    }
  });

  // Export CSV - Customers
  app.get('/export/customers', requireAdmin, async (req, res) => {
    try {
      const [customers] = await pool.query(
        `SELECT c.id, c.name, c.phone, c.address, p.name as package_name, p.price as package_price,
                c.pppoe_username, c.billing_method, c.isolation_date, c.status, c.created_at
         FROM customers c LEFT JOIN packages p ON c.package_id = p.id ORDER BY c.name ASC`
      );
      let csv = 'ID,Nama,Telepon,Alamat,Paket,Harga,PPPoE,Metode,Tgl Isolir,Status,Tgl Daftar\n';
      for (const c of customers) {
        csv += `${c.id},"${c.name}","${c.phone || ''}","${c.address || ''}","${c.package_name || ''}",${c.package_price || 0},"${c.pppoe_username || ''}","${c.billing_method || 'fixed'}",${c.isolation_date || 20},${c.status},"${new Date(c.created_at).toLocaleDateString('id-ID')}"\n`;
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="pelanggan-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send('\uFEFF' + csv); // BOM for Excel UTF-8
    } catch (e) {
      res.status(500).send(e.message);
    }
  });

  // Export CSV - Invoices
  app.get('/export/invoices', requireAdmin, async (req, res) => {
    try {
      const [invoices] = await pool.query(
        `SELECT i.id, c.name as customer_name, c.pppoe_username, i.amount, i.status, i.due_date, i.paid_at, i.created_at
         FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id ORDER BY i.created_at DESC`
      );
      let csv = 'ID,Pelanggan,PPPoE,Nominal,Status,Jatuh Tempo,Tanggal Bayar,Dibuat\n';
      for (const i of invoices) {
        csv += `${i.id},"${i.customer_name || ''}","${i.pppoe_username || ''}",${i.amount},${i.status},"${i.due_date || ''}","${i.paid_at ? new Date(i.paid_at).toLocaleDateString('id-ID') : ''}","${new Date(i.created_at).toLocaleDateString('id-ID')}"\n`;
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="invoice-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send('\uFEFF' + csv);
    } catch (e) {
      res.status(500).send(e.message);
    }
  });

  // Export Database Backup
  app.get('/export/database', requireAdmin, async (req, res) => {
    try {
      const mysqldump = require('mysqldump');
      const os = require('os');
      const backupFilename = `backup-${process.env.DB_NAME}-${new Date().toISOString().slice(0, 10)}.sql`;
      const backupPath = path.join(os.tmpdir(), backupFilename);

      await mysqldump({
        connection: {
          host: process.env.DB_HOST || 'localhost',
          user: process.env.DB_USER || 'root',
          password: process.env.DB_PASS || '',
          database: process.env.DB_NAME || 'dino_db',
        },
        dumpToFile: backupPath,
      });

      await logActivity(pool, 'system', req.session.userId, req.session.username || 'System', 'Export Database', req.ip, `Downloaded backup: ${backupFilename}`);
      res.download(backupPath, backupFilename, (err) => {
        if (err) console.error("Error downloading backup file:", err);
        const fs = require('fs');
        if (fs.existsSync(backupPath)) {
          fs.unlink(backupPath, (err) => {
            if (err) console.error("Error deleting temp backup file:", err);
          });
        }
      });
    } catch (e) {
      console.error(e);
      res.status(500).send("Database backup failed: " + e.message);
    }
  });

  // Import Database Backup
  const multer = require('multer');
  const os = require('os');
  const uploadSql = multer({ dest: os.tmpdir() });

  app.post('/import/database', requireAdmin, uploadSql.single('sql_file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'File SQL tidak ditemukan' });

    try {
      const fs = require('fs');

      // Sanitize the SQL file to prevent foreign key errors and force importing into current database
      let sqlContent = fs.readFileSync(req.file.path, 'utf8');

      // Disable foreign key checks at top, re-enable at bottom
      sqlContent = 'SET FOREIGN_KEY_CHECKS = 0;\n' + sqlContent + '\nSET FOREIGN_KEY_CHECKS = 1;';

      // Remove CREATE DATABASE statements
      sqlContent = sqlContent.replace(/CREATE DATABASE[^;]*;/gi, '-- Removed CREATE DATABASE');

      // Remove USE statements
      sqlContent = sqlContent.replace(/USE `?[a-zA-Z0-9_\-]+`?;/gi, '-- Removed USE statement');

      // Remove DEFINER statements to avoid permission errors
      sqlContent = sqlContent.replace(/DEFINER\s*=\s*`?[a-zA-Z0-9_\-]+`?@`?[a-zA-Z0-9_\-\.%]+`?/gi, '');

      fs.writeFileSync(req.file.path, sqlContent, 'utf8');

      const Importer = require('mysql-import');
      const importer = new Importer({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASS || '',
        database: process.env.DB_NAME || 'dino_db',
      });

      await importer.import(req.file.path);

      if (fs.existsSync(req.file.path)) {
        fs.unlink(req.file.path, () => { });
      }

      // Run database migrations to upgrade the imported database to the latest version schema
      await initDB();

      // Clear settings and plugins caches so they are reloaded from the database on next request
      _settingsCache = null;
      _pluginsCache = null;

      await logActivity(pool, 'system', req.session.userId, req.session.username || 'System', 'Restore Database', req.ip, 'Database restored and migrated successfully');
      res.json({ success: true, message: 'Database berhasil dipulihkan dan disesuaikan ke versi terbaru (Restore & Migrasi Sukses)' });
    } catch (e) {
      console.error(e);
      res.status(500).json({ success: false, message: "Gagal memulihkan database: " + e.message });
    }
  });

  // Admin Profile - GET
  app.get('/profile', requireAuth, async (req, res) => {
    try {
      const [[user]] = await pool.query('SELECT id, username, role, created_at FROM users WHERE id=?', [req.session.userId]);
      res.render('profile', { user: req.session, profile: user, currentPage: 'profile' });
    } catch (e) {
      res.status(500).send(e.message);
    }
  });

  // Admin Profile - Change Password
  app.post('/profile/change-password', requireAuth, async (req, res) => {
    const { current_password, new_password } = req.body;
    try {
      const [[user]] = await pool.query('SELECT * FROM users WHERE id=?', [req.session.userId]);
      const match = await bcrypt.compare(current_password, user.password);
      if (!match) return res.json({ success: false, message: 'Password lama salah' });
      const hashed = await bcrypt.hash(new_password, 10);
      await pool.query('UPDATE users SET password=? WHERE id=?', [hashed, req.session.userId]);
      await logActivity(pool, user.role, user.id, user.username, 'Change Password', req.ip, 'User changed their password');
      res.json({ success: true, message: 'Password berhasil diperbarui' });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // Tripay Callback Webhook (no auth - called by Tripay server)
  app.post('/api/tripay/callback', async (req, res) => {
    try {
      const crypto = require('crypto');
      const [settingsRows] = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'tripay_private_key'");
      if (!settingsRows.length) return res.status(400).json({ success: false });

      const privateKey = settingsRows[0].setting_value;
      const callbackSignature = req.headers['x-callback-signature'] || '';
      const json = JSON.stringify(req.body);
      const signature = crypto.createHmac('sha256', privateKey).update(json).digest('hex');

      if (callbackSignature !== signature) {
        return res.status(400).json({ success: false, message: 'Invalid signature' });
      }

      const { merchant_ref, status } = req.body;
      if (status === 'PAID') {
        const invId = merchant_ref.split('-')[1];
        if (invId) {
          await handlePaymentSuccess(pool, invId, 'Tripay', app.locals);
          console.log(`[Tripay] Payment received & Service activated for invoice #${invId}`);
        }
      }
      res.json({ success: true });
    } catch (e) {
      console.error('[Tripay] Callback error:', e.message);
      res.status(500).json({ success: false });
    }
  });

  // Midtrans Callback Webhook
  app.post('/api/midtrans/callback', async (req, res) => {
    try {
      const crypto = require('crypto');
      const { order_id, status_code, gross_amount, transaction_status, signature_key, fraud_status } = req.body;

      const [settingsRows] = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'midtrans_server_key'");
      if (!settingsRows.length) return res.status(400).json({ success: false, message: 'Server Key not found' });
      const serverKey = settingsRows[0].setting_value;

      // Signature verification: SHA512(order_id + status_code + gross_amount + serverKey)
      const input = order_id + status_code + gross_amount + serverKey;
      const signature = crypto.createHash('sha512').update(input).digest('hex');

      if (signature_key !== signature) {
        console.warn('[Midtrans Callback] Signature mismatch!');
        return res.status(400).json({ success: false, message: 'Invalid signature' });
      }

      const isPaid = transaction_status === 'settlement' || (transaction_status === 'capture' && fraud_status === 'accept');
      if (isPaid) {
        const invId = order_id.split('-')[1];
        if (invId) {
          await handlePaymentSuccess(pool, invId, 'Midtrans', app.locals);
          console.log(`[Midtrans] Payment received & Service activated for invoice #${invId}`);
        }
      }
      res.json({ success: true });
    } catch (e) {
      console.error('[Midtrans] Callback error:', e.message);
      res.status(500).json({ success: false });
    }
  });

  // Flip Callback Webhook
  app.post('/api/flip/callback', async (req, res) => {
    try {
      const { token, data } = req.body;
      const parsedData = typeof data === 'string' ? JSON.parse(data) : data;

      const [settingsRows] = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'flip_validation_token'");
      if (!settingsRows.length) return res.status(400).json({ success: false, message: 'Validation Token not found' });
      const dbToken = settingsRows[0].setting_value;

      if (token !== dbToken) {
        console.warn('[Flip Callback] Token mismatch!');
        return res.status(400).json({ success: false, message: 'Invalid token' });
      }

      if (parsedData && parsedData.status === 'SUCCESSFUL') {
        const referenceId = parsedData.reference_id;
        const invId = referenceId ? referenceId.split('-')[1] : null;

        // If reference_id parsing failed, try parsing invoice ID from bill title
        let actualInvId = invId;
        if (!actualInvId && parsedData.bill_title) {
          const match = parsedData.bill_title.match(/#(\d+)/);
          if (match) actualInvId = match[1];
        }

        if (actualInvId) {
          await handlePaymentSuccess(pool, actualInvId, 'Flip', app.locals);
          console.log(`[Flip] Payment received & Service activated for invoice #${actualInvId}`);
        }
      }
      res.json({ success: true });
    } catch (e) {
      console.error('[Flip] Callback error:', e.message);
      res.status(500).json({ success: false });
    }
  });

  // Xendit Callback Webhook
  app.post('/api/xendit/callback', async (req, res) => {
    try {
      const xCallbackToken = req.headers['x-callback-token'] || '';
      const { external_id, status } = req.body;

      const [settingsRows] = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'xendit_callback_token'");
      if (!settingsRows.length) return res.status(400).json({ success: false, message: 'Callback Token not found' });
      const dbToken = settingsRows[0].setting_value;

      if (xCallbackToken !== dbToken) {
        console.warn('[Xendit Callback] Token mismatch!');
        return res.status(400).json({ success: false, message: 'Invalid token' });
      }

      if (status === 'PAID' || status === 'SETTLED') {
        const invId = external_id.split('-')[1];
        if (invId) {
          await handlePaymentSuccess(pool, invId, 'Xendit', app.locals);
          console.log(`[Xendit] Payment received & Service activated for invoice #${invId}`);
        }
      }
      res.json({ success: true });
    } catch (e) {
      console.error('[Xendit] Callback error:', e.message);
      res.status(500).json({ success: false });
    }
  });

  // Duitku Callback Webhook
  app.post('/api/duitku/callback', async (req, res) => {
    try {
      const crypto = require('crypto');
      const { merchantCode, amount, merchantOrderId, signature, resultCode } = req.body;

      const [settingsRows] = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'duitku_api_key'");
      if (!settingsRows.length) return res.status(400).json({ success: false, message: 'API Key not found' });
      const apiKey = settingsRows[0].setting_value;

      // Verification Signature: MD5(merchantCode + amount + merchantOrderId + apiKey)
      const input = merchantCode + amount + merchantOrderId + apiKey;
      const calculatedSignature = crypto.createHash('md5').update(input).digest('hex');

      if (signature !== calculatedSignature) {
        console.warn('[Duitku Callback] Signature mismatch!');
        return res.status(400).json({ success: false, message: 'Invalid signature' });
      }

      // resultCode '00' indicates success
      if (resultCode === '00') {
        const invId = merchantOrderId.split('-')[1];
        if (invId) {
          await handlePaymentSuccess(pool, invId, 'Duitku', app.locals);
          console.log(`[Duitku] Payment received & Service activated for invoice #${invId}`);
        }
      }
      res.send('OK');
    } catch (e) {
      console.error('[Duitku] Callback error:', e.message);
      res.status(500).json({ success: false });
    }
  });

  // Print Invoice
  app.get('/print/invoice', requireAdmin, async (req, res) => {
    try {
      const ids = (req.query.ids || '').split(',').map(Number).filter(Boolean);
      if (!ids.length) return res.redirect('/billing');
      const placeholders = ids.map(() => '?').join(',');
      const [invoices] = await pool.query(
        `SELECT i.*, c.name as customer_name, c.address as customer_address, c.pppoe_username,
                p.name as package_name
         FROM invoices i
         LEFT JOIN customers c ON i.customer_id = c.id
         LEFT JOIN packages p ON c.package_id = p.id
         WHERE i.id IN (${placeholders})`, ids
      );
      const [rows] = await pool.query('SELECT * FROM settings');
      const settings = {};
      rows.forEach(r => settings[r.setting_key] = r.setting_value);
      res.render('print_invoice', { user: req.session, invoices, settings });
    } catch (e) {
      res.status(500).send(e.message);
    }
  });

  // Import Customers CSV
  app.post('/import/customers', requireAdmin, async (req, res) => {
    try {
      const csv = req.body.csv_data || '';
      const lines = csv.split('\n').filter(l => l.trim());
      if (lines.length < 2) return res.json({ success: false, message: 'File CSV kosong atau tidak valid' });
      let imported = 0, skipped = 0;
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',').map(c => c.replace(/^"|"$/g, '').trim());
        const [, name, phone, address, , , pppoe, method, isolDate, status] = cols;
        if (!name) { skipped++; continue; }
        try {
          await pool.query(
            'INSERT INTO customers (name, phone, address, pppoe_username, billing_method, isolation_date, status) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE phone=VALUES(phone)',
            [name, phone || '', address || '', pppoe || '', method || 'fixed', parseInt(isolDate) || 20, status || 'active']
          );
          imported++;
        } catch { skipped++; }
      }
      res.json({ success: true, message: `Import selesai: ${imported} berhasil, ${skipped} dilewati` });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // Github Auto-Updater Endpoint (secured with auth)
  app.post('/api/system/update', requireAdmin, async (req, res) => {
    const simpleGit = require('simple-git');
    const git = simpleGit(__dirname);
    try {
      // Force reset local changes if any, then pull (to ensure smooth update on server)
      // await git.reset('hard'); 
      await git.pull('origin', 'main');

      const { exec } = require('child_process');
      exec('npm install', (error, stdout, stderr) => {
        if (error) {
          console.error(`npm install error: ${error}`);
          return res.status(500).json({ success: false, message: "Update pulled, but npm install failed. Please run manually." });
        }
        res.json({ success: true, message: "Aplikasi berhasil diperbarui. Server akan restart dalam 3 detik." });

        // Use PM2 to restart if available, otherwise just exit and let nodemon/pm2 handle it
        setTimeout(() => {
          console.log("Restarting for update...");
          process.exit(0);
        }, 3000);
      });
    } catch (e) {
      console.error('Update Error:', e.message);
      res.status(500).json({ success: false, message: "Gagal menarik update: " + e.message });
    }
  });

  initDB().then(() => startServer());
}


const startServer = () => {
  const server = app.listen(PORT, () => {
    console.log(`Dino-Bill running on http://localhost:${PORT}`);
    if (isInstalled && pool) {
      const { logActivity } = require('./helpers/logger');
      logActivity(pool, 'system', null, 'System', 'Server Started', null, `Server started on port ${PORT}`).catch(() => { });
      pool.query("SELECT setting_value FROM settings WHERE setting_key = 'wa_provider'").then(([rows]) => {
        const provider = rows[0] ? rows[0].setting_value : 'local';
        if (provider === 'local') {
          const { initWhatsApp } = require('./helpers/whatsapp');
          initWhatsApp(pool).catch(err => console.error('[WA-INIT] Error:', err));
        }
      }).catch(() => { });
    }
  });
  server.setTimeout(300000);
};

if (!isInstalled) {
  startServer();
}

