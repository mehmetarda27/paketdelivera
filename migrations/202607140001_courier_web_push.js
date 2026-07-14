module.exports = {
  name: "courier_web_push_subscriptions",
  up({ db }) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS courier_push_subscriptions (
        id TEXT PRIMARY KEY,
        courier_id TEXT NOT NULL,
        endpoint TEXT NOT NULL UNIQUE,
        subscription_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (courier_id) REFERENCES couriers(id)
      );
      CREATE INDEX IF NOT EXISTS idx_courier_push_subscriptions_courier
      ON courier_push_subscriptions (courier_id, updated_at DESC);
    `);
  },
};
