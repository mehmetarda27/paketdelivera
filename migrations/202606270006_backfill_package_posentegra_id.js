module.exports = {
  name: "backfill_package_posentegra_id",
  up({ db, helpers }) {
    if (!helpers.tableExists(db, "packages")) {
      return;
    }

    helpers.addColumnIfMissing(db, "packages", "posentegra_id", "TEXT");

    db.exec(`
      UPDATE packages
      SET posentegra_id = COALESCE(
        NULLIF(posentegra_id, ''),
        NULLIF(external_order_id, ''),
        NULLIF(external_order_no, ''),
        NULLIF(tracking_no, ''),
        id
      )
      WHERE posentegra_id IS NULL OR posentegra_id = '';

      CREATE INDEX IF NOT EXISTS idx_packages_posentegra_id
      ON packages (posentegra_id)
      WHERE posentegra_id IS NOT NULL AND posentegra_id != '';
    `);
  },
};
