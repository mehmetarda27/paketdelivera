module.exports = {
  name: "panel_workflow_tables",
  up({ db }) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS restaurant_panel_data (
        restaurant_id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL,
        FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
      );

      CREATE TABLE IF NOT EXISTS courier_breaks (
        id TEXT PRIMARY KEY,
        courier_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (courier_id) REFERENCES couriers(id)
      );

      CREATE INDEX IF NOT EXISTS idx_courier_breaks_courier_started
      ON courier_breaks (courier_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS management_records (
        id TEXT PRIMARY KEY,
        record_type TEXT NOT NULL,
        subject_type TEXT NOT NULL DEFAULT '',
        subject_id TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL,
        amount REAL NOT NULL DEFAULT 0,
        start_date TEXT,
        end_date TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        note TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_management_records_type_subject
      ON management_records (record_type, subject_id, status, start_date);
    `);
  },
};
