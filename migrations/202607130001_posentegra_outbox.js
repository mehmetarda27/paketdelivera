module.exports = {
  name: "posentegra_durable_outbox",
  up({ db }) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS posentegra_outbox (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_error TEXT,
        locked_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_posentegra_outbox_due
      ON posentegra_outbox (status, next_attempt_at, created_at);
    `);
  },
};
