const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..");
let connection = null;
let connectionFile = "";
let activeAdapter = null;

function resolveDbFile() {
  return path.resolve(process.env.DATABASE_PATH || process.env.DB_PATH || process.env.DELIVERA_DB_FILE || path.join(ROOT, "delivera.sqlite"));
}

function clientName() {
  return String(process.env.DATABASE_CLIENT || process.env.DB_CLIENT || process.env.DB_ADAPTER || process.env.DATABASE_ADAPTER || "sqlite").toLowerCase();
}

function adapterName() {
  return clientName();
}

function createSqliteAdapter() {
  return {
    name: "sqlite",
    getDb(options = {}) {
      const filename = path.resolve(options.filename || resolveDbFile());
      if (connection && connectionFile === filename) {
        return connection;
      }
      if (connection) {
        close();
      }

      fs.mkdirSync(path.dirname(filename), { recursive: true });
      connection = new DatabaseSync(filename);
      connectionFile = filename;
      connection.exec("PRAGMA foreign_keys = ON");
      return connection;
    },
    run(sql, params = []) {
      return this.getDb().prepare(sql).run(...params);
    },
    get(sql, params = []) {
      return this.getDb().prepare(sql).get(...params);
    },
    all(sql, params = []) {
      return this.getDb().prepare(sql).all(...params);
    },
    transaction(callback) {
      const db = this.getDb();
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = callback(db);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw error;
      }
    },
    close,
  };
}

function createPostgresAdapter() {
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
  return {
    name: "postgres",
    connectionStringConfigured: Boolean(connectionString),
    getDb() {
      try {
        require("pg");
      } catch {
        throw new Error("PostgreSQL adapter hazirligi icin 'pg' dependency yuklu olmali.");
      }
      throw new Error("PostgreSQL adapter hazir, ancak runtime cutover bu surumde aktif degil. DATABASE_CLIENT=sqlite kullanin.");
    },
    run() {
      return this.getDb();
    },
    get() {
      return this.getDb();
    },
    all() {
      return this.getDb();
    },
    transaction() {
      return this.getDb();
    },
    close() {},
  };
}

function createAdapter() {
  const client = clientName();
  if (client === "sqlite") {
    return createSqliteAdapter();
  }
  if (client === "postgres" || client === "postgresql") {
    return createPostgresAdapter();
  }
  throw new Error(`DATABASE_CLIENT '${client}' desteklenmiyor. Gecerli degerler: sqlite, postgres.`);
}

function adapter() {
  const client = clientName();
  const normalizedClient = client === "postgresql" ? "postgres" : client;
  if (!activeAdapter || activeAdapter.name !== normalizedClient) {
    activeAdapter = createAdapter();
  }
  return activeAdapter;
}

function getDb(options = {}) {
  return adapter().getDb(options);
}

function run(sql, params = []) {
  return adapter().run(sql, params);
}

function get(sql, params = []) {
  return adapter().get(sql, params);
}

function all(sql, params = []) {
  return adapter().all(sql, params);
}

function transaction(callback) {
  return adapter().transaction(callback);
}

function close() {
  if (!connection) {
    return;
  }
  connection.close();
  connection = null;
  connectionFile = "";
  activeAdapter = null;
}

module.exports = {
  adapterName,
  all,
  clientName,
  close,
  get,
  getDb,
  resolveDbFile,
  run,
  transaction,
};
