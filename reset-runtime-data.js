const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const dbFile = path.resolve(process.env.DELIVERA_DB_FILE || path.join(__dirname, "delivera.sqlite"));
const db = new DatabaseSync(dbFile);

const count = (tableName) => Number(db.prepare(`SELECT COUNT(*) AS total FROM ${tableName}`).get().total || 0);

const before = {
  restaurants: count("restaurants"),
  couriers: count("couriers"),
  packages: count("packages"),
  platformAccounts: count("platform_accounts"),
  webhookLogs: count("webhook_logs"),
  auditLogs: count("audit_logs"),
};

db.exec("BEGIN IMMEDIATE");
try {
  db.prepare("DELETE FROM platform_accounts").run();
  db.prepare("DELETE FROM packages").run();
  db.prepare("DELETE FROM webhook_logs").run();
  db.prepare("DELETE FROM audit_logs").run();
  db.prepare("DELETE FROM courier_sessions").run();
  db.prepare("DELETE FROM restaurant_sessions").run();
  db.prepare("DELETE FROM refresh_tokens WHERE actor_role IN ('courier', 'restaurant')").run();
  db.prepare("DELETE FROM password_reset_tokens WHERE actor_role IN ('courier', 'restaurant')").run();
  db.prepare("DELETE FROM couriers").run();
  db.prepare("DELETE FROM restaurants").run();
  db.exec("COMMIT");
} catch (error) {
  try {
    db.exec("ROLLBACK");
  } catch {
    // ignore rollback issues
  }
  throw error;
}

const after = {
  restaurants: count("restaurants"),
  couriers: count("couriers"),
  packages: count("packages"),
  platformAccounts: count("platform_accounts"),
  webhookLogs: count("webhook_logs"),
  auditLogs: count("audit_logs"),
};

console.log(JSON.stringify({ dbFile, before, after, adminCount: count("admins") }, null, 2));
