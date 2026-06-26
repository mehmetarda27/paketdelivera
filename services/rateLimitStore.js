class MemoryRateLimitStore {
  constructor() {
    this.name = "memory";
    this.buckets = new Map();
  }

  async increment(key, rule, now = Date.now()) {
    const current = this.buckets.get(key);
    if (!current || now - current.startedAt >= rule.windowMs) {
      this.buckets.set(key, { count: 1, startedAt: now });
      return { limited: false, retryAfter: null };
    }

    current.count += 1;
    if (current.count > rule.limit) {
      return {
        limited: true,
        retryAfter: Math.max(1, Math.ceil((rule.windowMs - (now - current.startedAt)) / 1000)),
      };
    }

    return { limited: false, retryAfter: null };
  }

  health() {
    return {
      mode: "memory",
      ready: true,
      fallback: false,
      buckets: this.buckets.size,
    };
  }
}

class RedisRateLimitStore {
  constructor(redisUrl, logger) {
    this.name = "redis";
    this.redisUrl = redisUrl;
    this.logger = logger;
    this.client = null;
    this.ready = false;
    this.connecting = null;
    this.memoryFallback = new MemoryRateLimitStore();
  }

  async ensureClient() {
    if (this.ready && this.client) {
      return this.client;
    }
    if (this.connecting) {
      return this.connecting;
    }

    this.connecting = (async () => {
      try {
        const { createClient } = require("redis");
        const client = createClient({ url: this.redisUrl });
        client.on("error", (error) => {
          this.ready = false;
          this.logger?.warn?.("Redis rate-limit store error; memory fallback remains active", { error: error.message });
        });
        await client.connect();
        this.client = client;
        this.ready = true;
        this.logger?.info?.("Redis rate-limit store connected");
        return client;
      } catch (error) {
        this.ready = false;
        this.logger?.warn?.("Redis rate-limit store unavailable; using memory fallback", { error: error.message });
        return null;
      } finally {
        this.connecting = null;
      }
    })();

    return this.connecting;
  }

  async increment(key, rule, now = Date.now()) {
    const client = await this.ensureClient();
    if (!client) {
      return this.memoryFallback.increment(key, rule, now);
    }

    const redisKey = `delivera:rate-limit:${key}`;
    try {
      const count = await client.incr(redisKey);
      if (count === 1) {
        await client.pExpire(redisKey, rule.windowMs);
      }
      if (count > rule.limit) {
        const ttlMs = await client.pTTL(redisKey);
        return {
          limited: true,
          retryAfter: Math.max(1, Math.ceil(Math.max(ttlMs, 1000) / 1000)),
        };
      }
      return { limited: false, retryAfter: null };
    } catch (error) {
      this.ready = false;
      this.logger?.warn?.("Redis rate-limit increment failed; using memory fallback", { error: error.message });
      return this.memoryFallback.increment(key, rule, now);
    }
  }

  health() {
    return {
      mode: "redis",
      ready: this.ready,
      fallback: !this.ready,
      memoryFallbackBuckets: this.memoryFallback.buckets.size,
    };
  }
}

class DatabaseRateLimitStore {
  constructor(db, logger) {
    this.name = "database";
    this.db = db;
    this.logger = logger;
    this.memoryFallback = new MemoryRateLimitStore();
  }

  async increment(key, rule, now = Date.now()) {
    const startedAt = new Date(now).toISOString();
    const expiresAt = new Date(now + rule.windowMs).toISOString();
    try {
      const row = this.db.prepare(`
        INSERT INTO rate_limit_buckets (key, count, started_at, expires_at)
        VALUES (?, 1, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          count = CASE WHEN rate_limit_buckets.expires_at <= ? THEN 1 ELSE rate_limit_buckets.count + 1 END,
          started_at = CASE WHEN rate_limit_buckets.expires_at <= ? THEN ? ELSE rate_limit_buckets.started_at END,
          expires_at = CASE WHEN rate_limit_buckets.expires_at <= ? THEN ? ELSE rate_limit_buckets.expires_at END
        RETURNING count, started_at, expires_at
      `).get(key, startedAt, expiresAt, startedAt, startedAt, startedAt, startedAt, expiresAt);

      const count = Number(row?.count || 0);
      if (count > rule.limit) {
        const retryAfterMs = Math.max(1000, new Date(row.expires_at).getTime() - now);
        return {
          limited: true,
          retryAfter: Math.max(1, Math.ceil(retryAfterMs / 1000)),
        };
      }
      return { limited: false, retryAfter: null };
    } catch (error) {
      this.logger?.warn?.("Database rate-limit store failed; using memory fallback", { error: error.message });
      return this.memoryFallback.increment(key, rule, now);
    }
  }

  health() {
    return {
      mode: "database",
      ready: true,
      fallback: false,
      memoryFallbackBuckets: this.memoryFallback.buckets.size,
    };
  }
}

function createRateLimitStore({ redisUrl, logger, db, dbClient } = {}) {
  if (redisUrl) {
    return new RedisRateLimitStore(redisUrl, logger);
  }
  if (db && dbClient === "postgres") {
    return new DatabaseRateLimitStore(db, logger);
  }
  return new MemoryRateLimitStore();
}

module.exports = {
  DatabaseRateLimitStore,
  createRateLimitStore,
  MemoryRateLimitStore,
  RedisRateLimitStore,
};
