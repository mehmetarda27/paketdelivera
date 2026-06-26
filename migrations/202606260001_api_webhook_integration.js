module.exports = {
  name: "api_webhook_integration",
  up({ db, helpers }) {
    [
      ["restaurants", "trendyol_restaurant_id", "TEXT"],
      ["restaurants", "yemeksepeti_restaurant_id", "TEXT"],
      ["restaurants", "getir_restaurant_id", "TEXT"],
      ["restaurants", "migros_restaurant_id", "TEXT"],
      ["restaurants", "external_restaurant_ids", "TEXT"],
      ["packages", "confirmation_id", "TEXT"],
      ["packages", "external_restaurant_id", "TEXT"],
      ["packages", "restaurant_name_from_payload", "TEXT"],
      ["packages", "platform_slug", "TEXT"],
      ["packages", "provider_id", "TEXT"],
      ["packages", "provider_name", "TEXT"],
      ["packages", "contact_phone", "TEXT"],
      ["packages", "city", "TEXT"],
      ["packages", "district", "TEXT"],
      ["packages", "street", "TEXT"],
      ["packages", "building_no", "TEXT"],
      ["packages", "floor", "TEXT"],
      ["packages", "door_no", "TEXT"],
      ["packages", "address_description", "TEXT"],
      ["packages", "status_text", "TEXT"],
      ["packages", "raw_status", "TEXT"],
      ["packages", "discounted_price", "REAL"],
      ["packages", "total_discount", "REAL"],
      ["packages", "pos_payment_method", "TEXT"],
      ["packages", "pos_ticket", "TEXT"],
      ["packages", "short_code", "TEXT"],
      ["packages", "delivery_type", "TEXT"],
      ["packages", "is_scheduled", "INTEGER NOT NULL DEFAULT 0"],
      ["packages", "scheduled_date", "TEXT"],
      ["webhook_logs", "request_id", "TEXT"],
      ["webhook_logs", "provider", "TEXT"],
      ["webhook_logs", "platform", "TEXT"],
      ["webhook_logs", "external_restaurant_id", "TEXT"],
      ["webhook_logs", "external_order_id", "TEXT"],
      ["webhook_logs", "is_matched", "INTEGER"],
      ["webhook_logs", "status", "TEXT"],
      ["webhook_logs", "http_status", "INTEGER"],
      ["webhook_logs", "error_message", "TEXT"],
      ["webhook_logs", "raw_payload", "TEXT"],
      ["webhook_logs", "headers", "TEXT"],
      ["webhook_logs", "ip_address", "TEXT"],
    ].forEach(([tableName, columnName, definition]) => {
      if (helpers.tableExists(db, tableName)) {
        helpers.addColumnIfMissing(db, tableName, columnName, definition);
      }
    });

    db.exec(`
      CREATE TABLE IF NOT EXISTS order_items (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        external_product_id TEXT,
        product_id TEXT,
        name TEXT,
        quantity REAL NOT NULL DEFAULT 1,
        price REAL NOT NULL DEFAULT 0,
        option_price REAL NOT NULL DEFAULT 0,
        price_with_option REAL NOT NULL DEFAULT 0,
        total_price REAL NOT NULL DEFAULT 0,
        total_option_price REAL NOT NULL DEFAULT 0,
        total_price_with_option REAL NOT NULL DEFAULT 0,
        note TEXT,
        removed_ingredients TEXT,
        extra_ingredients TEXT,
        raw_payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (order_id) REFERENCES packages(id)
      );

      CREATE TABLE IF NOT EXISTS unmatched_orders (
        id TEXT PRIMARY KEY,
        external_order_id TEXT,
        confirmation_id TEXT,
        external_restaurant_id TEXT,
        restaurant_name_from_payload TEXT,
        platform TEXT,
        platform_slug TEXT,
        provider_name TEXT,
        customer_name TEXT,
        customer_phone TEXT,
        total_price REAL NOT NULL DEFAULT 0,
        status TEXT,
        raw_payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        is_resolved INTEGER NOT NULL DEFAULT 0,
        resolved_restaurant_id TEXT,
        resolved_package_id TEXT,
        resolved_at TEXT,
        FOREIGN KEY (resolved_restaurant_id) REFERENCES restaurants(id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurants_trendyol_external
      ON restaurants (trendyol_restaurant_id)
      WHERE trendyol_restaurant_id IS NOT NULL AND trendyol_restaurant_id != '';

      CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurants_yemeksepeti_external
      ON restaurants (yemeksepeti_restaurant_id)
      WHERE yemeksepeti_restaurant_id IS NOT NULL AND yemeksepeti_restaurant_id != '';

      CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurants_getir_external
      ON restaurants (getir_restaurant_id)
      WHERE getir_restaurant_id IS NOT NULL AND getir_restaurant_id != '';

      CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurants_migros_external
      ON restaurants (migros_restaurant_id)
      WHERE migros_restaurant_id IS NOT NULL AND migros_restaurant_id != '';

      CREATE INDEX IF NOT EXISTS idx_order_items_order_id
      ON order_items (order_id);

      CREATE INDEX IF NOT EXISTS idx_unmatched_orders_created
      ON unmatched_orders (is_resolved, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_packages_api_order_lookup
      ON packages (external_order_id, confirmation_id, restaurant_id);
    `);
  },
};
