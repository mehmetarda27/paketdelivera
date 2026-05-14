const fs = require("fs");
const path = require("path");
const { getDb, close, adapterName, resolveDbFile } = require("../db");

try {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
} catch {}

const ROOT = path.resolve(__dirname, "..");
const MIGRATIONS_DIR = path.join(ROOT, "migrations");

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

    db.exec("BEGIN IMMEDIATE");
    try {
      migration.up({ db, helpers, adapter: adapterName() });
      db.prepare(`
        INSERT INTO schema_migrations (id, name, checksum, applied_at)
        VALUES (?, ?, ?, ?)
      `).run(id, migration.name || id, fileChecksum, new Date().toISOString());
      db.exec("COMMIT");
      applied.push({ id, name: migration.name || id });
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  });

  return {
    ok: true,
    adapter: adapterName(),
    database: resolveDbFile(),
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
