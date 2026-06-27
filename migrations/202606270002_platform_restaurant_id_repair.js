module.exports = {
  name: "platform_restaurant_id_repair",
  up({ db, helpers }) {
    [
      ["restaurants", "trendyol_restaurant_id", "TEXT"],
      ["restaurants", "yemeksepeti_restaurant_id", "TEXT"],
      ["restaurants", "getir_restaurant_id", "TEXT"],
      ["restaurants", "migros_restaurant_id", "TEXT"],
      ["restaurants", "external_restaurant_ids", "TEXT"],
      ["platform_orders", "platform_restaurant_id", "TEXT"],
      ["platform_orders", "package_id", "TEXT"],
    ].forEach(([tableName, columnName, definition]) => {
      if (helpers.tableExists(db, tableName)) {
        helpers.addColumnIfMissing(db, tableName, columnName, definition);
      }
    });

    db.exec(`
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

      CREATE INDEX IF NOT EXISTS idx_platform_orders_package_id
      ON platform_orders (package_id);

      CREATE INDEX IF NOT EXISTS idx_platform_orders_external_restaurant
      ON platform_orders (platform, platform_restaurant_id, platform_order_id);
    `);
  },
};
