module.exports = {
  name: "stabilization_indexes_and_retry_columns",
  up({ db, helpers }) {
    if (helpers.tableExists(db, "webhook_logs")) {
      helpers.addColumnIfMissing(db, "webhook_logs", "retry_count", "INTEGER NOT NULL DEFAULT 0");
      helpers.addColumnIfMissing(db, "webhook_logs", "next_retry_at", "TEXT");
      helpers.addColumnIfMissing(db, "webhook_logs", "dead_lettered_at", "TEXT");
      helpers.addColumnIfMissing(db, "webhook_logs", "last_error", "TEXT");
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_schema_migrations_applied_at
      ON schema_migrations (applied_at);

      CREATE INDEX IF NOT EXISTS idx_packages_assigned_created
      ON packages (assigned_courier_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_packages_restaurant_status_created
      ON packages (restaurant_id, status, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_packages_source_external
      ON packages (restaurant_id, source, external_order_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_packages_tracking_search
      ON packages (tracking_no, external_order_no);

      CREATE INDEX IF NOT EXISTS idx_webhook_logs_retry
      ON webhook_logs (retry_count, next_retry_at, dead_lettered_at);

      CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin_created
      ON admin_sessions (admin_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_restaurant_sessions_restaurant_created
      ON restaurant_sessions (restaurant_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_courier_sessions_courier_created
      ON courier_sessions (courier_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_actor_expires
      ON refresh_tokens (actor_role, actor_id, expires_at);
    `);
  },
};
