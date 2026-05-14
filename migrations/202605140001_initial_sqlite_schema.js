module.exports = {
  name: "initial_sqlite_schema_and_indexes",
  up({ db, helpers }) {
    db.exec(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS zones (
        name TEXT PRIMARY KEY
      );

      CREATE TABLE IF NOT EXISTS restaurants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        zone TEXT NOT NULL,
        x REAL NOT NULL,
        y REAL NOT NULL,
        username TEXT UNIQUE,
        password_hash TEXT,
        password_salt TEXT,
        platforms_json TEXT NOT NULL,
        api_key TEXT NOT NULL UNIQUE,
        webhook_secret TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS couriers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        zone TEXT NOT NULL,
        x REAL NOT NULL,
        y REAL NOT NULL,
        available INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'offline',
        last_location_at TEXT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS packages (
        id TEXT PRIMARY KEY,
        tracking_no TEXT NOT NULL UNIQUE,
        restaurant_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'restaurant_panel',
        delivery_address TEXT,
        package_type TEXT,
        source_platform TEXT NOT NULL,
        external_order_no TEXT NOT NULL,
        external_order_id TEXT,
        recipient TEXT NOT NULL,
        phone TEXT NOT NULL,
        address TEXT NOT NULL,
        zone TEXT NOT NULL,
        eta TEXT NOT NULL,
        payment_method TEXT NOT NULL,
        order_amount REAL NOT NULL DEFAULT 0,
        payment_status TEXT NOT NULL DEFAULT 'unpaid',
        x REAL NOT NULL,
        y REAL NOT NULL,
        customer_lat REAL,
        customer_lng REAL,
        customer_address TEXT,
        note TEXT NOT NULL,
        status TEXT NOT NULL,
        assignment_status TEXT,
        assigned_courier_id TEXT,
        assigned_courier_name TEXT,
        assigned_at TEXT,
        accepted_at TEXT,
        on_route_at TEXT,
        delivered_at TEXT,
        failed_at TEXT,
        distance_km REAL,
        assignment_reason TEXT NOT NULL,
        failure_reason TEXT,
        last_assignment_attempt_at TEXT,
        last_assignment_error TEXT,
        assignment_tried_courier_ids_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
      );

      CREATE TABLE IF NOT EXISTS courier_sessions (
        token TEXT PRIMARY KEY,
        courier_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (courier_id) REFERENCES couriers(id)
      );

      CREATE TABLE IF NOT EXISTS restaurant_sessions (
        token TEXT PRIMARY KEY,
        restaurant_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
      );

      CREATE TABLE IF NOT EXISTS admins (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS admin_sessions (
        token TEXT PRIMARY KEY,
        admin_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (admin_id) REFERENCES admins(id)
      );

      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id TEXT PRIMARY KEY,
        actor_role TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        ip_address TEXT,
        user_agent TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id TEXT PRIMARY KEY,
        actor_role TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        requested_ip TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      );

      CREATE TABLE IF NOT EXISTS webhook_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        restaurant_id TEXT,
        source_platform TEXT,
        external_order_no TEXT,
        signature_valid INTEGER NOT NULL,
        response_status INTEGER NOT NULL,
        request_body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_role TEXT NOT NULL,
        actor_id TEXT,
        action TEXT NOT NULL,
        package_id TEXT,
        restaurant_id TEXT,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS platform_accounts (
        id TEXT PRIMARY KEY,
        restaurant_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        external_id TEXT,
        external_store_id TEXT NOT NULL,
        external_merchant_id TEXT,
        api_username TEXT,
        api_password TEXT,
        api_key TEXT,
        api_secret TEXT,
        token TEXT,
        store_front_code TEXT,
        chain_id TEXT,
        vendor_id TEXT,
        webhook_auth_type TEXT NOT NULL,
        webhook_api_key TEXT,
        webhook_username TEXT,
        webhook_password TEXT,
        static_token TEXT,
        webhook_secret TEXT,
        integration_reference_code TEXT,
        pos_secret_key TEXT,
        is_active INTEGER,
        last_sync_at TEXT,
        webhook_id TEXT,
        settings_json TEXT NOT NULL,
        verification_status TEXT NOT NULL DEFAULT 'pending',
        verification_note TEXT,
        last_verification_at TEXT,
        verified_at TEXT,
        last_validation_mode TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
      );

      CREATE TABLE IF NOT EXISTS platform_orders (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        platform_order_id TEXT NOT NULL,
        restaurant_id TEXT NOT NULL,
        customer_name TEXT NOT NULL,
        phone TEXT NOT NULL,
        address TEXT NOT NULL,
        total_price REAL NOT NULL DEFAULT 0,
        note TEXT,
        status TEXT NOT NULL DEFAULT 'pending_approval',
        raw_payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(platform, platform_order_id, restaurant_id),
        FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
      );

      CREATE TABLE IF NOT EXISTS courier_daily_reports (
        id TEXT PRIMARY KEY,
        courier_id TEXT NOT NULL,
        courier_name TEXT NOT NULL,
        zone TEXT NOT NULL,
        report_date TEXT NOT NULL,
        delivered_count INTEGER NOT NULL DEFAULT 0,
        total_amount REAL NOT NULL DEFAULT 0,
        paid_online_amount REAL NOT NULL DEFAULT 0,
        cash_collected_amount REAL NOT NULL DEFAULT 0,
        package_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS courier_shifts (
        id TEXT PRIMARY KEY,
        courier_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (courier_id) REFERENCES couriers(id)
      );

      CREATE TABLE IF NOT EXISTS notification_logs (
        id TEXT PRIMARY KEY,
        target_role TEXT NOT NULL,
        target_id TEXT,
        event_type TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS courier_shift_plans (
        id TEXT PRIMARY KEY,
        courier_id TEXT NOT NULL,
        zone TEXT NOT NULL,
        plan_date TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'planned',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (courier_id) REFERENCES couriers(id)
      );

      CREATE TABLE IF NOT EXISTS cash_reconciliations (
        id TEXT PRIMARY KEY,
        courier_id TEXT NOT NULL,
        report_date TEXT NOT NULL,
        expected_cash REAL NOT NULL DEFAULT 0,
        reported_cash REAL NOT NULL DEFAULT 0,
        variance REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        package_ids_json TEXT NOT NULL,
        admin_note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (courier_id) REFERENCES couriers(id)
      );

      CREATE TABLE IF NOT EXISTS announcements (
        id TEXT PRIMARY KEY,
        target_role TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    [
      ["couriers", "last_location_at", "TEXT"],
      ["couriers", "status", "TEXT NOT NULL DEFAULT 'offline'"],
      ["packages", "delivery_address", "TEXT"],
      ["packages", "package_type", "TEXT"],
      ["packages", "source", "TEXT NOT NULL DEFAULT 'restaurant_panel'"],
      ["packages", "external_order_id", "TEXT"],
      ["packages", "payment_status", "TEXT NOT NULL DEFAULT 'unpaid'"],
      ["packages", "order_amount", "REAL NOT NULL DEFAULT 0"],
      ["packages", "assignment_status", "TEXT"],
      ["packages", "assigned_at", "TEXT"],
      ["packages", "accepted_at", "TEXT"],
      ["packages", "on_route_at", "TEXT"],
      ["packages", "delivered_at", "TEXT"],
      ["packages", "failed_at", "TEXT"],
      ["packages", "failure_reason", "TEXT"],
      ["packages", "last_assignment_attempt_at", "TEXT"],
      ["packages", "last_assignment_error", "TEXT"],
      ["packages", "updated_at", "TEXT"],
      ["packages", "customer_note", "TEXT"],
      ["packages", "items_json", "TEXT"],
      ["packages", "raw_payload_json", "TEXT"],
      ["packages", "customer_lat", "REAL"],
      ["packages", "customer_lng", "REAL"],
      ["packages", "customer_address", "TEXT"],
      ["packages", "platform_status_logs_json", "TEXT"],
      ["packages", "assignment_tried_courier_ids_json", "TEXT"],
      ["courier_shift_plans", "offer_expires_at", "TEXT"],
      ["courier_shift_plans", "accepted_at", "TEXT"],
      ["courier_shift_plans", "notified_at", "TEXT"],
      ["restaurants", "username", "TEXT"],
      ["restaurants", "password_hash", "TEXT"],
      ["restaurants", "password_salt", "TEXT"],
      ["platform_accounts", "access_token", "TEXT"],
      ["platform_accounts", "refresh_token", "TEXT"],
      ["platform_accounts", "token_expires_at", "TEXT"],
      ["platform_accounts", "callback_url", "TEXT"],
      ["platform_accounts", "auth_type", "TEXT"],
      ["platform_accounts", "integration_ref_code", "TEXT"],
      ["platform_accounts", "polling_enabled", "INTEGER NOT NULL DEFAULT 0"],
      ["platform_accounts", "webhook_enabled", "INTEGER NOT NULL DEFAULT 1"],
      ["platform_accounts", "last_webhook_at", "TEXT"],
      ["platform_accounts", "last_poll_at", "TEXT"],
      ["platform_accounts", "last_error", "TEXT"],
    ].forEach(([tableName, columnName, definition]) => {
      if (helpers.tableExists(db, tableName)) {
        helpers.addColumnIfMissing(db, tableName, columnName, definition);
      }
    });

    db.exec(`
      UPDATE packages
      SET source = 'external_manual',
          source_platform = CASE
            WHEN TRIM(COALESCE(source_platform, '')) = '' THEN 'Dis Manuel Paket'
            ELSE source_platform
          END
      WHERE source = 'restaurant_panel';

      CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_orders_unique
      ON platform_orders (platform, platform_order_id, restaurant_id);

      CREATE INDEX IF NOT EXISTS idx_packages_restaurant_created
      ON packages (restaurant_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_packages_status_created
      ON packages (status, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_packages_zone_status
      ON packages (zone, status);

      CREATE INDEX IF NOT EXISTS idx_packages_assigned_status
      ON packages (assigned_courier_id, status, assigned_at);

      CREATE INDEX IF NOT EXISTS idx_packages_duplicate_lookup
      ON packages (restaurant_id, source, external_order_id);

      CREATE INDEX IF NOT EXISTS idx_packages_platform_lookup
      ON packages (restaurant_id, source_platform, external_order_id);

      CREATE INDEX IF NOT EXISTS idx_couriers_status_zone
      ON couriers (status, zone);

      CREATE INDEX IF NOT EXISTS idx_couriers_zone_status
      ON couriers (zone, status);

      CREATE INDEX IF NOT EXISTS idx_platform_accounts_lookup
      ON platform_accounts (platform, external_store_id, active, webhook_enabled);

      CREATE INDEX IF NOT EXISTS idx_platform_accounts_restaurant_updated
      ON platform_accounts (restaurant_id, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_platform_orders_restaurant_status_created
      ON platform_orders (restaurant_id, status, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_audit_logs_restaurant_id_desc
      ON audit_logs (restaurant_id, id DESC);

      CREATE INDEX IF NOT EXISTS idx_webhook_logs_restaurant_id_desc
      ON webhook_logs (restaurant_id, id DESC);

      CREATE INDEX IF NOT EXISTS idx_notification_logs_target_created
      ON notification_logs (target_role, target_id, created_at DESC);

      INSERT OR IGNORE INTO zones (name) VALUES
        ('Akdeniz'),
        ('Yenisehir'),
        ('Mezitli'),
        ('Toroslar'),
        ('Tarsus'),
        ('Erdemli');
    `);
  },
};
