module.exports = {
  name: "platform_connection_health",
  up({ db, helpers }) {
    if (helpers.tableExists(db, "platform_accounts")) {
      [
        ["connection_status", "TEXT NOT NULL DEFAULT 'unknown'"],
        ["last_check_at", "TEXT"],
        ["last_success_at", "TEXT"],
        ["last_error_at", "TEXT"],
        ["last_error_code", "TEXT"],
        ["last_error_message", "TEXT"],
        ["last_http_status", "INTEGER"],
        ["last_latency_ms", "INTEGER"],
        ["consecutive_failures", "INTEGER NOT NULL DEFAULT 0"],
        ["last_callback_at", "TEXT"],
      ].forEach(([columnName, definition]) => {
        helpers.addColumnIfMissing(db, "platform_accounts", columnName, definition);
      });
      helpers.addColumnIfMissing(db, "platform_accounts", "last_webhook_at", "TEXT");
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS platform_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT,
        restaurant_id TEXT,
        platform_account_id TEXT,
        event_type TEXT NOT NULL,
        request_id TEXT,
        status TEXT NOT NULL,
        http_status INTEGER,
        error_code TEXT,
        error_message TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at TEXT,
        dead_lettered_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_platform_events_account_created
      ON platform_events (platform_account_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_platform_events_restaurant_created
      ON platform_events (restaurant_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_platform_events_type_status_created
      ON platform_events (event_type, status, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_platform_accounts_connection_status
      ON platform_accounts (connection_status, updated_at DESC);
    `);
  },
};
