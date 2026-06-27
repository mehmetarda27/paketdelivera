const fs = require("fs");
const path = require("path");
const { execSync, spawnSync } = require("child_process");

try {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
} catch {}

const { getDb, close, clientName, resolveDbFile, databaseUrl } = require("../db");

const ROOT = path.resolve(__dirname, "..");
const BACKUP_DIR = path.resolve(process.env.DELIVERA_BACKUP_DIR || path.join(ROOT, "backups"));
const UPLOAD_CMD = process.env.DELIVERA_BACKUP_UPLOAD_COMMAND || "";

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function runCommand(cmd) {
  try {
    execSync(cmd, { stdio: "inherit" });
    return true;
  } catch (error) {
    console.error(`Command execution failed: ${cmd}\nError: ${error.message}`);
    return false;
  }
}

function uploadBackup(backupFile) {
  if (!UPLOAD_CMD) {
    return;
  }
  const cmd = UPLOAD_CMD.replace(/\$BACKUP_FILE/g, backupFile).replace(/\$\{BACKUP_FILE\}/g, backupFile);
  console.log(`Running backup upload command: ${cmd}`);
  const ok = runCommand(cmd);
  if (ok) {
    console.log("Backup upload command executed successfully.");
  } else {
    console.error("Backup upload command failed.");
  }
}

function main() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const client = clientName();
  
  let target = "";
  
  if (client === "sqlite") {
    const dbFile = resolveDbFile();
    if (!fs.existsSync(dbFile)) {
      throw new Error(`SQLite database file not found: ${dbFile}`);
    }
    
    target = path.join(BACKUP_DIR, `delivera-${stamp()}.sqlite`);
    const db = getDb({ filename: dbFile });
    try {
      db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    } finally {
      close();
    }
    
  } else if (client === "postgres" || client === "postgresql") {
    const pgUrl = databaseUrl();
    if (!pgUrl) {
      throw new Error("DATABASE_URL or POSTGRES_URL is not set for PostgreSQL backup.");
    }
    
    target = path.join(BACKUP_DIR, `delivera-postgresql-${stamp()}.dump`);
    console.log(`Running pg_dump to create backup...`);

    const result = spawnSync("pg_dump", [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      `--file=${target}`,
      pgUrl,
    ], { stdio: "inherit" });
    if (result.error) {
      throw new Error(`pg_dump calistirilamadi: ${result.error.message}. Render Shell veya local ortamda PostgreSQL client araclari kurulu olmali.`);
    }
    if (result.status !== 0) {
      throw new Error(`pg_dump failed with exit code ${result.status}.`);
    }
    
  } else {
    throw new Error(`Unsupported database client: ${client}`);
  }
  
  const stats = fs.statSync(target);
  const payload = {
    ok: true,
    client,
    backup: target,
    sizeBytes: stats.size,
    createdAt: new Date().toISOString(),
  };
  
  console.log(JSON.stringify(payload, null, 2));
  
  // Upload to S3/External storage if configured
  uploadBackup(target);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
