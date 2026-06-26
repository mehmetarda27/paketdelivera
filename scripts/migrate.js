const fs = require("fs");
const path = require("path");
const { getDb, close, adapterName, resolveDbFile, transaction } = require("../db");

try {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
} catch {}

const ROOT = path.resolve(__dirname, "..");
const MIGRATIONS_DIR = path.join(ROOT, "migrations");
const DESTRUCTIVE_SQL_PATTERN = /\b(DROP\s+TABLE|DROP\s+SCHEMA|TRUNCATE\s+TABLE|DELETE\s+FROM\s+\w+\s*(;|$)|ALTER\s+TABLE\s+\w+\s+DROP\s+COLUMN)\b/i;

function ensureMigrationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
}

function checksum(content) {
  return require("crypto").createHash("sha256").update(content).digest("hex");
}

function migrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    return [];
  }
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^\d+_.+\.js$/.test(file))
    .sort((left, right) => left.localeCompare(right))
    .map((file) => path.join(MIGRATIONS_DIR, file));
}

function assertSafeMigration(fileName, content) {
  if (process.env.DELIVERA_ALLOW_DESTRUCTIVE_MIGRATION === "1") {
    return;
  }
  if (DESTRUCTIVE_SQL_PATTERN.test(content)) {
    throw new Error(`${fileName} destructive SQL iceriyor. Canli veri guvenligi icin DELIVERA_ALLOW_DESTRUCTIVE_MIGRATION=1 olmadan calistirilmaz.`);
  }
}

function columnExists(db, tableName, columnName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().some((column) => column.name === columnName);
}

function addColumnIfMissing(db, tableName, columnName, definition) {
  if (!columnExists(db, tableName, columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    return true;
  }
  return false;
}

function tableExists(db, tableName) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

function runMigrations() {
  const db = getDb();
  ensureMigrationTable(db);

  const files = migrationFiles();
  const applied = [];
  const skipped = [];
  const helpers = {
    addColumnIfMissing,
    columnExists,
    tableExists,
  };

  files.forEach((filePath) => {
    const fileName = path.basename(filePath);
    const id = fileName.replace(/\.js$/, "");
    const content = fs.readFileSync(filePath, "utf8");
    assertSafeMigration(fileName, content);
    const fileChecksum = checksum(content);
    const existing = db.prepare("SELECT * FROM schema_migrations WHERE id = ?").get(id);

    if (existing) {
      skipped.push({ id, name: existing.name });
      return;
    }

    const migration = require(filePath);
    if (!migration || typeof migration.up !== "function") {
      throw new Error(`${fileName} migration dosyasi up({ db, helpers }) export etmeli.`);
    }

    try {
      if (adapterName() === "postgres" && process.env.DELIVERA_SKIP_MIGRATION_BACKUP_WARNING !== "1") {
        console.warn(`Migration uygulanmadan once PostgreSQL backup alinmis olmalidir: ${id}`);
      }
      transaction((txDb) => {
        const migrationDb = txDb || db;
        migration.up({ db: migrationDb, helpers, adapter: adapterName() });
        migrationDb.prepare(`
          INSERT INTO schema_migrations (id, name, checksum, applied_at)
          VALUES (?, ?, ?, ?)
        `).run(id, migration.name || id, fileChecksum, new Date().toISOString());
      });
      applied.push({ id, name: migration.name || id });
    } catch (error) {
      throw error;
    }
  });

  return {
    ok: true,
    adapter: adapterName(),
    database: adapterName() === "postgres" ? "postgresql" : resolveDbFile(),
    migrationsDir: MIGRATIONS_DIR,
    applied,
    skipped,
    totalKnown: files.length,
    finishedAt: new Date().toISOString(),
  };
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(runMigrations(), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    close();
  }
}

module.exports = {
  runMigrations,
};
