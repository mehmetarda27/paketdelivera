const { parentPort, workerData } = require("worker_threads");
const { Pool } = require("pg");
const { createClient } = require("redis");
const logger = require("../services/logger");
const { databaseEnvInfo, databaseUrl } = require("../db/config");

const { sab } = workerData;
const sabInts = new Int32Array(sab);
const sabBuffer = new Uint8Array(sab);

const pgUrl = databaseUrl();
const redisUrl = process.env.REDIS_URL || process.env.DELIVERA_REDIS_URL || "";

let pgPool = null;
let pgPoolPromise = null;
let pgTxClient = null;
let redisClient = null;

function pgSslConfig() {
  const value = String(process.env.DATABASE_SSL || process.env.PGSSLMODE || "").toLowerCase();
  if (["0", "false", "disable", "disabled", "off", "no"].includes(value)) {
    return false;
  }
  if (["1", "true", "require", "required", "on", "yes"].includes(value)) {
    return { rejectUnauthorized: false };
  }
  if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

async function getPgPool() {
  if (pgPoolPromise) return pgPoolPromise;

  pgPoolPromise = (async () => {
    if (!pgUrl) {
      const info = databaseEnvInfo();
      throw new Error(
        `PostgreSQL connection string is not configured. Checked env vars: ${info.supportedVariables.join(", ")}. ` +
        `Detected postgres env vars: ${info.detectedVariables.join(", ") || "none"}. ` +
        `Render detected: ${info.renderDetected}. NODE_ENV=${info.nodeEnv || "(empty)"}.`
      );
    }
    logger.info("postgres_connection_string_detected", {
      envName: databaseEnvInfo().variable,
      supportedEnvNames: databaseEnvInfo().supportedVariables,
    });
    const pool = new Pool({
      connectionString: pgUrl,
      ssl: pgSslConfig(),
      max: Math.max(1, Number(process.env.PGPOOL_MAX || process.env.DATABASE_POOL_MAX || 5)),
      idleTimeoutMillis: Math.max(1000, Number(process.env.PGPOOL_IDLE_TIMEOUT_MS || 30000)),
      connectionTimeoutMillis: Math.max(1000, Number(process.env.PGPOOL_CONNECTION_TIMEOUT_MS || 10000)),
    });

    // Run initial schema setups (like datetime functions)
    try {
      const client = await pool.connect();
      try {
        await client.query(`
          CREATE OR REPLACE FUNCTION datetime(val text) RETURNS timestamp AS $$
          BEGIN
            RETURN val::timestamp;
          END;
          $$ LANGUAGE plpgsql IMMUTABLE;
        `);
        await client.query(`
          CREATE OR REPLACE FUNCTION datetime(val timestamp with time zone) RETURNS timestamp AS $$
          BEGIN
            RETURN val::timestamp;
          END;
          $$ LANGUAGE plpgsql IMMUTABLE;
        `);
        await client.query(`
          CREATE OR REPLACE FUNCTION datetime(val timestamp without time zone) RETURNS timestamp AS $$
          BEGIN
            RETURN val;
          END;
          $$ LANGUAGE plpgsql IMMUTABLE;
        `);
        await client.query(`
          CREATE OR REPLACE FUNCTION strftime(format text, val text) RETURNS bigint AS $$
          DECLARE
            ts timestamp;
          BEGIN
            IF val = 'now' THEN
              ts := NOW();
            ELSE
              ts := val::timestamp;
            END IF;
            
            IF format = '%s' THEN
              RETURN EXTRACT(EPOCH FROM ts)::bigint;
            END IF;
            
            RETURN 0;
          END;
          $$ LANGUAGE plpgsql IMMUTABLE;
        `);
        await client.query(`
          CREATE OR REPLACE FUNCTION strftime(format text, val timestamp with time zone) RETURNS bigint AS $$
          BEGIN
            IF format = '%s' THEN
              RETURN EXTRACT(EPOCH FROM val)::bigint;
            END IF;
            RETURN 0;
          END;
          $$ LANGUAGE plpgsql IMMUTABLE;
        `);
        await client.query(`
          CREATE OR REPLACE FUNCTION strftime(format text, val timestamp without time zone) RETURNS bigint AS $$
          BEGIN
            IF format = '%s' THEN
              RETURN EXTRACT(EPOCH FROM val)::bigint;
            END IF;
            RETURN 0;
          END;
          $$ LANGUAGE plpgsql IMMUTABLE;
        `);
      } finally {
        client.release();
      }
    } catch (err) {
      console.error("Failed to initialize PostgreSQL custom helper functions:", err.message);
    }
    
    pgPool = pool;
    return pool;
  })();

  return pgPoolPromise;
}

async function getRedisClient() {
  if (redisClient) return redisClient;
  if (!redisUrl) {
    return null;
  }
  redisClient = createClient({ url: redisUrl });
  redisClient.on("error", () => {
    // Suppress error logs to keep console clean, client will retry
  });
  await redisClient.connect();
  return redisClient;
}

// Convert SQLite placeholders (?) to Postgres placeholders ($1, $2, etc.)
// Ignores question marks inside single or double quotes
function sqliteToPgSql(sql) {
  let paramIndex = 1;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;
  let result = "";

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];

    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      result += char;
      escaped = true;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
    } else if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
    }

    if (char === "?" && !inSingleQuote && !inDoubleQuote) {
      result += `$${paramIndex++}`;
    } else {
      result += char;
    }
  }

  return result;
}

function translateSql(sql) {
  let pgSql = String(sql || "");

  // SQLite-only pragmas are harmless locally but invalid on PostgreSQL.
  pgSql = pgSql
    .replace(/^\s*PRAGMA\s+[^;]+;\s*/gim, "")
    .replace(/\bPRAGMA\s+[^;]+;?/gi, "");

  // INSERT OR IGNORE INTO ... VALUES ... -> PostgreSQL conflict-tolerant insert.
  pgSql = pgSql.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\s+(\w+)\s*\((.*?)\)\s*VALUES\s*([\s\S]*?)(;|$)/gi, "INSERT INTO $1 ($2) VALUES $3 ON CONFLICT DO NOTHING$4");
  pgSql = pgSql.replace(/\bINSERT\s+OR\s+REPLACE\s+INTO\s+(\w+)\s*\((.*?)\)\s*VALUES\s*([\s\S]*?)(;|$)/gi, "INSERT INTO $1 ($2) VALUES $3 ON CONFLICT DO NOTHING$4");

  // Schema compatibility.
  pgSql = pgSql.replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, "SERIAL PRIMARY KEY");
  pgSql = pgSql.replace(/\bAUTOINCREMENT\b/gi, "");

  // Transaction and date/time helpers used by existing SQLite-flavored queries.
  pgSql = pgSql
    .replace(/\bBEGIN\s+IMMEDIATE\b/gi, "BEGIN")
    .replace(/\bdatetime\(current_timestamp\)/gi, "NOW()")
    .replace(/\bdatetime\('now'\)/gi, "NOW()")
    .replace(/\bcurrent_timestamp\b/gi, "NOW()")
    .replace(/\bdate\('now'\s*,\s*'-6 months'\)/gi, "(CURRENT_DATE - INTERVAL '6 months')");

  return sqliteToPgSql(pgSql).trim();
}

function normalizeParams(params = []) {
  return params.map((param) => {
    if (typeof param === "boolean") {
      return param ? 1 : 0;
    }
    return param;
  });
}

function dmlOperation(sql) {
  const normalized = String(sql || "").replace(/\s+/g, " ").trim().toUpperCase();
  const match = normalized.match(/^(INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?([A-Z_][A-Z0-9_]*)/);
  if (!match) {
    return null;
  }
  return {
    type: match[1].toLowerCase(),
    table: match[2].toLowerCase(),
  };
}

function shouldLogSql(sql) {
  const normalized = String(sql || "").replace(/\s+/g, " ").trim().toUpperCase();
  return normalized === "BEGIN" ||
    normalized === "COMMIT" ||
    normalized === "ROLLBACK" ||
    Boolean(dmlOperation(sql));
}

function compactSql(sql) {
  return String(sql || "").replace(/\s+/g, " ").trim();
}

function summarizeParams(params = []) {
  return params.map((param) => {
    if (param === null || param === undefined) return param;
    const text = String(param);
    return text.length > 120 ? `${text.slice(0, 117)}...` : text;
  });
}

function normalizePgResult(result) {
  if (!Array.isArray(result)) {
    return {
      rows: result?.rows || [],
      rowCount: Number(result?.rowCount || 0),
    };
  }
  return {
    rows: result.flatMap((item) => item?.rows || []),
    rowCount: result.reduce((total, item) => total + Number(item?.rowCount || 0), 0),
  };
}

async function queryPostgres(sql, params = []) {
  const pool = await getPgPool();
  const pgSql = translateSql(sql);
  if (!pgSql) {
    return { rows: [], rowCount: 0 };
  }

  const normalizedParams = normalizeParams(params || []);
  const upperSql = pgSql.toUpperCase();
  const shouldLogQuery = shouldLogSql(pgSql);
  const operation = dmlOperation(pgSql);

  if (upperSql === "BEGIN" || upperSql === "START TRANSACTION") {
    if (!pgTxClient) {
      pgTxClient = await pool.connect();
    }
    const res = await pgTxClient.query("BEGIN");
    logger.info("postgres_transaction_begin", { sql: "BEGIN", rowCount: res.rowCount });
    return { rows: res.rows, rowCount: res.rowCount };
  }

  if (upperSql === "COMMIT") {
    if (!pgTxClient) {
      return { rows: [], rowCount: 0 };
    }
    try {
      const res = await pgTxClient.query("COMMIT");
      logger.info("postgres_transaction_commit", { sql: "COMMIT", rowCount: res.rowCount });
      return { rows: res.rows, rowCount: res.rowCount };
    } finally {
      pgTxClient.release();
      pgTxClient = null;
    }
  }

  if (upperSql === "ROLLBACK") {
    if (!pgTxClient) {
      return { rows: [], rowCount: 0 };
    }
    try {
      const res = await pgTxClient.query("ROLLBACK");
      logger.warn("postgres_transaction_rollback", { sql: "ROLLBACK", rowCount: res.rowCount });
      return { rows: res.rows, rowCount: res.rowCount };
    } finally {
      pgTxClient.release();
      pgTxClient = null;
    }
  }

  const client = pgTxClient || pool;
  if (shouldLogQuery) {
    logger.info("postgres_query_start", {
      operation: operation?.type || "query",
      table: operation?.table || null,
      sql: compactSql(pgSql),
      params: summarizeParams(normalizedParams),
      inTransaction: Boolean(pgTxClient),
    });
  }
  let res;
  try {
    res = await client.query(pgSql, normalizedParams);
  } catch (error) {
    logger.error("postgres_query_failed", {
      operation: operation?.type || "query",
      table: operation?.table || null,
      sql: compactSql(pgSql),
      params: summarizeParams(normalizedParams),
      inTransaction: Boolean(pgTxClient),
      error,
    });
    throw error;
  }
  const normalizedResult = normalizePgResult(res);
  if (shouldLogQuery) {
    logger.info("postgres_query_result", {
      operation: operation?.type || "query",
      table: operation?.table || null,
      sql: compactSql(pgSql),
      rowCount: normalizedResult.rowCount,
      rows: normalizedResult.rows.slice(0, 3),
      inTransaction: Boolean(pgTxClient),
    });
  }
  return normalizedResult;
}

async function handleRequest(req) {
  const { type, sql, params, cmd, key, val, ttl } = req;

  if (type === "db") {
    return queryPostgres(sql, params);
  }

  if (type === "pgPoolStatus") {
    const pool = await getPgPool();
    return {
      max: pool.options.max,
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
    };
  }

  if (type === "redis") {
    const client = await getRedisClient();
    if (!client) {
      return { ok: false, error: "redis_not_configured" };
    }

    if (cmd === "get") {
      const data = await client.get(key);
      return { ok: true, data };
    }
    if (cmd === "set") {
      const options = ttl ? { EX: Number(ttl) } : undefined;
      await client.set(key, val, options);
      return { ok: true };
    }
    if (cmd === "del") {
      await client.del(key);
      return { ok: true };
    }
  }

  throw new Error(`Unsupported request type: ${type}`);
}

parentPort.on("message", async () => {
  try {
    // Read request from buffer
    const reqLength = sabInts[1];
    const reqBytes = Buffer.from(sabBuffer.buffer, sabBuffer.byteOffset + 8, reqLength);
    const req = JSON.parse(reqBytes.toString("utf8"));

    const result = await handleRequest(req);

    // Write response to buffer
    const resStr = JSON.stringify({ ok: true, data: result });
    const resBytes = Buffer.from(resStr, "utf8");
    sabInts[1] = resBytes.length;
    resBytes.copy(sabBuffer, 8);

    // Set status to 2 (Success)
    Atomics.store(sabInts, 0, 2);
  } catch (error) {
    // Write error to buffer
    logger.error("postgres_worker_request_failed", { error });
    const resStr = JSON.stringify({ ok: false, error: error.message, stack: error.stack });
    const resBytes = Buffer.from(resStr, "utf8");
    sabInts[1] = resBytes.length;
    resBytes.copy(sabBuffer, 8);

    // Set status to 3 (Error)
    Atomics.store(sabInts, 0, 3);
  } finally {
    // Notify main thread
    Atomics.notify(sabInts, 0, 1);
  }
});
