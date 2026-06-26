module.exports = {
  name: "external_api_contract",
  up({ db, helpers }) {
    [
      ["platform_orders", "platform_restaurant_id", "TEXT"],
      ["platform_orders", "package_id", "TEXT"],
    ].forEach(([tableName, columnName, definition]) => {
      if (helpers.tableExists(db, tableName)) {
        helpers.addColumnIfMissing(db, tableName, columnName, definition);
      }
    });

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_platform_orders_package_id
      ON platform_orders (package_id);

      CREATE INDEX IF NOT EXISTS idx_platform_orders_external_restaurant
      ON platform_orders (platform, platform_restaurant_id, platform_order_id);
    `);
  },
};
