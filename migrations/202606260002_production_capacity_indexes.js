module.exports = {
  name: "production_capacity_indexes",
  up({ db }) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS rate_limit_buckets (
        key TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_expires
      ON rate_limit_buckets (expires_at);

      CREATE INDEX IF NOT EXISTS idx_restaurants_username
      ON restaurants (username);

      CREATE INDEX IF NOT EXISTS idx_restaurants_zone_created
      ON restaurants (zone, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_couriers_username
      ON couriers (username);

      CREATE INDEX IF NOT EXISTS idx_couriers_available_status_zone
      ON couriers (available, status, zone);

      CREATE INDEX IF NOT EXISTS idx_courier_sessions_token_created
      ON courier_sessions (token, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_restaurant_sessions_token_created
      ON restaurant_sessions (token, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_admin_sessions_token_created
      ON admin_sessions (token, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash_role
      ON refresh_tokens (token_hash, actor_role);

      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires
      ON refresh_tokens (expires_at);

      CREATE INDEX IF NOT EXISTS idx_packages_restaurant_status_updated
      ON packages (restaurant_id, status, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_packages_courier_status_created
      ON packages (assigned_courier_id, status, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_packages_status_assigned_at
      ON packages (status, assigned_at);

      CREATE INDEX IF NOT EXISTS idx_packages_source_platform_created
      ON packages (source_platform, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_packages_external_order_id
      ON packages (external_order_id);

      CREATE INDEX IF NOT EXISTS idx_platform_accounts_external_lookup
      ON platform_accounts (platform, external_store_id, webhook_enabled, active);

      CREATE INDEX IF NOT EXISTS idx_platform_accounts_restaurant_platform
      ON platform_accounts (restaurant_id, platform, active);

      CREATE INDEX IF NOT EXISTS idx_platform_events_created
      ON platform_events (created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_webhook_logs_created
      ON webhook_logs (created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_unmatched_orders_external
      ON unmatched_orders (external_order_id, confirmation_id, is_resolved);
    `);
  },
};
