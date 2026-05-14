const fs = require("fs");
const path = require("path");

try {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
} catch {}

const { resolveDbFile } = require("../db");

const ROOT = path.resolve(__dirname, "..");
const DB_FILE = resolveDbFile();
const source = process.argv[2] ? path.resolve(process.argv[2]) : "";
const allowOverwrite = process.env.DELIVERA_RESTORE_OVERWRITE === "1";

function main() {
  if (!source) {
    throw new Error("Kullanim: node scripts/restore-sqlite.js <backup-file>. Mevcut DB uzerine yazmak icin DELIVERA_RESTORE_OVERWRITE=1 gerekir.");
  }
  if (!fs.existsSync(source)) {
    throw new Error(`Backup bulunamadi: ${source}`);
  }
  if (fs.existsSync(DB_FILE) && !allowOverwrite) {
    throw new Error(`Mevcut database korunuyor: ${DB_FILE}. Restore icin DELIVERA_RESTORE_OVERWRITE=1 ayarla.`);
  }

  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.copyFileSync(source, DB_FILE);
  console.log(JSON.stringify({
    ok: true,
    restoredFrom: source,
    restoredTo: DB_FILE,
    sizeBytes: fs.statSync(DB_FILE).size,
    restoredAt: new Date().toISOString(),
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
