module.exports = {
  name: "courier_earnings",
  up({ db, helpers }) {
    if (helpers.tableExists(db, "couriers")) {
      helpers.addColumnIfMissing(db, "couriers", "per_package_fee", "REAL");
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS courier_earnings (
        id TEXT PRIMARY KEY,
        courier_id TEXT NOT NULL,
        report_date TEXT NOT NULL,
        delivered_package_count INTEGER NOT NULL DEFAULT 0,
        per_package_fee REAL NOT NULL DEFAULT 0,
        bonus_amount REAL NOT NULL DEFAULT 0,
        deduction_amount REAL NOT NULL DEFAULT 0,
        total_payable REAL NOT NULL DEFAULT 0,
        payment_status TEXT NOT NULL DEFAULT 'unpaid',
        paid_at TEXT,
        admin_note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(courier_id, report_date)
      );

      CREATE TABLE IF NOT EXISTS courier_earning_items (
        id TEXT PRIMARY KEY,
        courier_earning_id TEXT NOT NULL,
        package_id TEXT NOT NULL,
        restaurant_id TEXT NOT NULL,
        delivered_at TEXT NOT NULL,
        package_fee REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE(courier_earning_id, package_id)
      );

      CREATE INDEX IF NOT EXISTS idx_courier_earnings_date_status
      ON courier_earnings (report_date, payment_status);

      CREATE INDEX IF NOT EXISTS idx_courier_earning_items_earning
      ON courier_earning_items (courier_earning_id);

      CREATE INDEX IF NOT EXISTS idx_courier_earning_items_package
      ON courier_earning_items (package_id);
    `);
  },
};
