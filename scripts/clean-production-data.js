const path = require("path");

try {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
} catch {}

const { adapterName, close, getDb, transaction } = require("../db");

const REQUIRED_CONFIRMATION = "production-clean-start";
const CONFIRMATION = String(process.env.DELIVERA_CLEAN_START_CONFIRM || "");
const ALLOW_SQLITE = ["1", "true", "yes"].includes(String(process.env.DELIVERA_CLEAN_START_ALLOW_SQLITE || "").toLowerCase());
const DRY_RUN = process.argv.includes("--dry-run");

const TARGET_COUNTS = ["restaurants", "couriers", "packages"];
const PRESERVED_TABLES = [
  "admins",
  "admin_sessions",
  "system_settings",
  "schema_migrations",
  "webhook_logs",
  "audit_logs",
];

const DELETE_STEPS = [
  "order_items",
  "platform_orders",
  "platform_events",
  "platform_accounts",
  "unmatched_orders",
  "courier_daily_reports",
  "cash_reconciliations",
  "courier_shift_plans",
  "courier_shifts",
  "courier_sessions",
  "restaurant_sessions",
  {
    table: "refresh_tokens",
    sql: "DELETE FROM refresh_tokens WHERE actor_role IN ('courier', 'restaurant')",
  },
  {
    table: "password_reset_tokens",
    sql: "DELETE FROM password_reset_tokens WHERE actor_role IN ('courier', 'restaurant')",
  },
  {
    table: "notification_logs",
    sql: "DELETE FROM notification_logs WHERE target_role IN ('courier', 'restaurant')",
  },
  "packages",
  "couriers",
  "restaurants",
];

function tableExists(db, tableName) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

function countTable(db, tableName) {
  if (!tableExists(db, tableName)) {
    return null;
  }
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get()?.count || 0);
}

function collectCounts(db, tableNames) {
  return Object.fromEntries(tableNames.map((tableName) => [tableName, countTable(db, tableName)]));
}

function assertSafeRuntime() {
  const adapter = adapterName();
  if (adapter !== "postgres" && !ALLOW_SQLITE) {
    throw new Error("Bu temizlik varsayilan olarak sadece PostgreSQL icin calisir. Lokal SQLite denemesi icin DELIVERA_CLEAN_START_ALLOW_SQLITE=1 kullan.");
  }
  if (CONFIRMATION !== REQUIRED_CONFIRMATION) {
    throw new Error(`Canli data temizligi icin DELIVERA_CLEAN_START_CONFIRM=${REQUIRED_CONFIRMATION} ayarlanmalidir.`);
  }
}

function runDeleteStep(db, step) {
  const table = typeof step === "string" ? step : step.table;
  if (!tableExists(db, table)) {
    return { table, skipped: true, reason: "table_missing", changes: 0 };
  }

  const sql = typeof step === "string" ? `DELETE FROM ${step}` : step.sql;
  const result = db.prepare(sql).run();
  return { table, skipped: false, changes: Number(result?.changes || 0) };
}

function assertClean(db) {
  const counts = collectCounts(db, TARGET_COUNTS);
  const dirty = Object.entries(counts).filter(([, count]) => count !== 0);
  if (dirty.length) {
    throw new Error(`Temizlik dogrulamasi basarisiz: ${dirty.map(([table, count]) => `${table}=${count}`).join(", ")}`);
  }
  return counts;
}

function main() {
  assertSafeRuntime();
  const adapter = adapterName();
  const db = getDb();
  const before = collectCounts(db, [
    ...TARGET_COUNTS,
    "order_items",
    "platform_orders",
    "platform_accounts",
    "platform_events",
    "unmatched_orders",
    "courier_daily_reports",
    "cash_reconciliations",
    "courier_shift_plans",
    "courier_shifts",
    "courier_sessions",
    "restaurant_sessions",
    "refresh_tokens",
    "password_reset_tokens",
    "notification_logs",
    ...PRESERVED_TABLES,
  ]);

  if (DRY_RUN) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      adapter,
      confirmationRequired: REQUIRED_CONFIRMATION,
      targetCounts: collectCounts(db, TARGET_COUNTS),
      before,
      deleteOrder: DELETE_STEPS.map((step) => typeof step === "string" ? step : step.table),
      preservedTables: PRESERVED_TABLES,
    }, null, 2));
    return;
  }

  let deleted = [];
  transaction((txDb) => {
    const activeDb = txDb || db;
    deleted = DELETE_STEPS.map((step) => runDeleteStep(activeDb, step));
    assertClean(activeDb);
  });

  const after = collectCounts(db, Object.keys(before));
  const targetCounts = assertClean(db);
  console.log(JSON.stringify({
    ok: true,
    adapter,
    deleted,
    before,
    after,
    targetCounts,
    preservedTables: PRESERVED_TABLES,
    finishedAt: new Date().toISOString(),
  }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    close();
  }
}

module.exports = {
  DELETE_STEPS,
  REQUIRED_CONFIRMATION,
  TARGET_COUNTS,
  main,
};
