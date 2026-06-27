module.exports = {
  name: "posentegra_id_order_matching",
  up({ db, helpers }) {
    [
      ["restaurants", "posentegra_id", "TEXT"],
      ["packages", "posentegra_id", "TEXT"],
      ["platform_orders", "posentegra_id", "TEXT"],
    ].forEach(([tableName, columnName, definition]) => {
      if (helpers.tableExists(db, tableName)) {
        helpers.addColumnIfMissing(db, tableName, columnName, definition);
      }
    });

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurants_posentegra_external
      ON restaurants (posentegra_id)
      WHERE posentegra_id IS NOT NULL AND posentegra_id != '';

      CREATE INDEX IF NOT EXISTS idx_packages_posentegra_id
      ON packages (posentegra_id)
      WHERE posentegra_id IS NOT NULL AND posentegra_id != '';

      CREATE INDEX IF NOT EXISTS idx_platform_orders_posentegra_id
      ON platform_orders (posentegra_id)
      WHERE posentegra_id IS NOT NULL AND posentegra_id != '';
    `);
  },
};
