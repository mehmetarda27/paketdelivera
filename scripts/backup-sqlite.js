const fs = require("fs");
const path = require("path");

try {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
} catch {}

const { getDb, close, resolveDbFile } = require("../db");

const ROOT = path.resolve(__dirname, "..");
const DB_FILE = resolveDbFile();
const BACKUP_DIR = path.resolve(process.env.DELIVERA_BACKUP_DIR || path.join(ROOT, "backups"));

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function main() {
  if (!fs.existsSync(DB_FILE)) {
    throw new Error(`Database bulunamadi: ${DB_FILE}`);
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const target = path.join(BACKUP_DIR, `delivera-${stamp()}.sqlite`);
  const db = getDb({ filename: DB_FILE });
  try {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    close();
  }

  const stats = fs.statSync(target);
  console.log(JSON.stringify({
    ok: true,
    source: DB_FILE,
    backup: target,
    sizeBytes: stats.size,
    createdAt: new Date().toISOString(),
  }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
