module.exports = {
  name: "restaurant_web_push_subscriptions",
  up({ db }) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS restaurant_push_subscriptions (
        id TEXT PRIMARY KEY,
        restaurant_id TEXT NOT NULL,
        endpoint TEXT NOT NULL UNIQUE,
        subscription_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
      );
      CREATE INDEX IF NOT EXISTS idx_restaurant_push_subscriptions_restaurant
      ON restaurant_push_subscriptions (restaurant_id, updated_at DESC);
    `);
  },
};
