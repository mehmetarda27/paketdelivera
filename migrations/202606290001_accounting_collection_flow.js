module.exports = {
  name: "accounting_collection_flow",
  up({ db, helpers }) {
    if (helpers.tableExists(db, "packages")) {
      helpers.addColumnIfMissing(db, "packages", "payment_collected_by", "TEXT");
      helpers.addColumnIfMissing(db, "packages", "collected_amount", "REAL NOT NULL DEFAULT 0");
      helpers.addColumnIfMissing(db, "packages", "courier_collection_note", "TEXT");
      helpers.addColumnIfMissing(db, "packages", "restaurant_customer_id", "TEXT");
      helpers.addColumnIfMissing(db, "packages", "customer_id", "TEXT");
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY,
        restaurant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        address TEXT NOT NULL,
        note TEXT,
        order_count INTEGER NOT NULL DEFAULT 0,
        last_order_at TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(restaurant_id, phone)
      );

      CREATE TABLE IF NOT EXISTS restaurant_settlements (
        id TEXT PRIMARY KEY,
        restaurant_id TEXT NOT NULL,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        total_packages INTEGER NOT NULL DEFAULT 0,
        total_cash REAL NOT NULL DEFAULT 0,
        total_card REAL NOT NULL DEFAULT 0,
        total_online REAL NOT NULL DEFAULT 0,
        total_restaurant_collected REAL NOT NULL DEFAULT 0,
        total_courier_collected REAL NOT NULL DEFAULT 0,
        service_fee REAL NOT NULL DEFAULT 0,
        net_payable REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'unpaid',
        paid_at TEXT,
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(restaurant_id, start_date, end_date)
      );

      CREATE INDEX IF NOT EXISTS idx_customers_restaurant_phone
      ON customers (restaurant_id, phone);

      CREATE INDEX IF NOT EXISTS idx_restaurant_settlements_restaurant_range
      ON restaurant_settlements (restaurant_id, start_date, end_date);
    `);

    if (helpers.tableExists(db, "customers")) {
      helpers.addColumnIfMissing(db, "customers", "note", "TEXT");
      helpers.addColumnIfMissing(db, "customers", "order_count", "INTEGER NOT NULL DEFAULT 0");
      helpers.addColumnIfMissing(db, "customers", "last_order_at", "TEXT");
      helpers.addColumnIfMissing(db, "customers", "is_active", "INTEGER NOT NULL DEFAULT 1");
    }

    if (helpers.tableExists(db, "courier_daily_reports")) {
      helpers.addColumnIfMissing(db, "courier_daily_reports", "collected_total", "REAL NOT NULL DEFAULT 0");
      helpers.addColumnIfMissing(db, "courier_daily_reports", "failed_collection_total", "REAL NOT NULL DEFAULT 0");
      helpers.addColumnIfMissing(db, "courier_daily_reports", "restaurant_collected_amount", "REAL NOT NULL DEFAULT 0");
      helpers.addColumnIfMissing(db, "courier_daily_reports", "courier_note", "TEXT");
      helpers.addColumnIfMissing(db, "courier_daily_reports", "admin_note", "TEXT");
      helpers.addColumnIfMissing(db, "courier_daily_reports", "approved_at", "TEXT");
    }
  },
};
