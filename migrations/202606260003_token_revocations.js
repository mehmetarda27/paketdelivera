module.exports = {
  name: "token_revocations",
  up({ db }) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS token_revocations (
        token_hash TEXT PRIMARY KEY,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_token_revocations_expires
      ON token_revocations (expires_at);
    `);
  },
};
