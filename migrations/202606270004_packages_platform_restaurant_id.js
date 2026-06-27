module.exports = {
  name: "packages_platform_restaurant_id",
  up({ db, helpers }) {
    if (!helpers.tableExists(db, "packages")) {
      return;
    }

    helpers.addColumnIfMissing(db, "packages", "platform_restaurant_id", "TEXT");

    db.exec(`
      UPDATE packages
      SET platform_restaurant_id = external_restaurant_id
      WHERE (platform_restaurant_id IS NULL OR platform_restaurant_id = '')
        AND external_restaurant_id IS NOT NULL
        AND external_restaurant_id != '';

      UPDATE packages
      SET platform_restaurant_id = (
        SELECT po.platform_restaurant_id
        FROM platform_orders po
        WHERE po.platform_restaurant_id IS NOT NULL
          AND po.platform_restaurant_id != ''
          AND (
            po.package_id = packages.id
            OR po.platform_order_id = packages.external_order_id
            OR po.platform_order_id = packages.external_order_no
            OR (
              po.posentegra_id IS NOT NULL
              AND po.posentegra_id != ''
              AND po.posentegra_id = packages.posentegra_id
            )
          )
        ORDER BY datetime(po.updated_at) DESC
        LIMIT 1
      )
      WHERE (platform_restaurant_id IS NULL OR platform_restaurant_id = '')
        AND EXISTS (
          SELECT 1
          FROM platform_orders po
          WHERE po.platform_restaurant_id IS NOT NULL
            AND po.platform_restaurant_id != ''
            AND (
              po.package_id = packages.id
              OR po.platform_order_id = packages.external_order_id
              OR po.platform_order_id = packages.external_order_no
              OR (
                po.posentegra_id IS NOT NULL
                AND po.posentegra_id != ''
                AND po.posentegra_id = packages.posentegra_id
              )
            )
        );

      CREATE INDEX IF NOT EXISTS idx_packages_platform_restaurant_id
      ON packages (platform_restaurant_id)
      WHERE platform_restaurant_id IS NOT NULL AND platform_restaurant_id != '';
    `);
  },
};
