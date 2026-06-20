const { createClient } = require("redis");

class SessionRevocationService {
  constructor({ redisUrl, logger } = {}) {
    this.redisUrl = redisUrl;
    this.logger = logger;
    this.client = null;
    this.ready = false;
    this.connecting = null;
    this.memoryRevoked = new Map();
  }

  async ensureClient() {
    if (!this.redisUrl || this.ready && this.client) {
      return this.client;
    }
    if (this.connecting) {
      return this.connecting;
    }

    this.connecting = (async () => {
      try {
        const client = createClient({ url: this.redisUrl });
        client.on("error", (error) => {
          this.ready = false;
          this.logger?.warn?.("Redis session revocation store error; memory fallback remains active", { error: error.message });
        });
        await client.connect();
        this.client = client;
        this.ready = true;
        return client;
      } catch (error) {
        this.ready = false;
        this.logger?.warn?.("Redis session revocation store unavailable; memory fallback remains active", { error: error.message });
        return null;
      } finally {
        this.connecting = null;
      }
    })();

    return this.connecting;
  }

  async revokeTokenHash(tokenHash, ttlSeconds) {
    const safeHash = String(tokenHash || "").trim();
    if (!safeHash) {
      return false;
    }

    const ttl = Math.max(60, Number(ttlSeconds || 60));
    const client = await this.ensureClient();
    if (client) {
      await client.set(`delivera:revoked:${safeHash}`, "1", { EX: ttl });
      return true;
    }

    this.memoryRevoked.set(safeHash, Date.now() + ttl * 1000);
    return true;
  }

  async isRevoked(tokenHash) {
    const safeHash = String(tokenHash || "").trim();
    if (!safeHash) {
      return false;
    }

    const client = await this.ensureClient();
    if (client) {
      return Boolean(await client.exists(`delivera:revoked:${safeHash}`));
    }

    const expiresAt = this.memoryRevoked.get(safeHash);
    if (!expiresAt) {
      return false;
    }
    if (expiresAt <= Date.now()) {
      this.memoryRevoked.delete(safeHash);
      return false;
    }
    return true;
  }

  async getSession(tableName, token) {
    const client = await this.ensureClient();
    if (!client) {
      return null;
    }
    try {
      const data = await client.get(`delivera:session:${tableName}:${token}`);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      this.logger?.warn?.("Redis getSession failed", { error: error.message });
      return null;
    }
  }

  async setSession(tableName, token, session, ttlSeconds) {
    const client = await this.ensureClient();
    if (!client) {
      return false;
    }
    try {
      const ttl = Math.max(60, Number(ttlSeconds || 60));
      await client.set(`delivera:session:${tableName}:${token}`, JSON.stringify(session), { EX: ttl });
      return true;
    } catch (error) {
      this.logger?.warn?.("Redis setSession failed", { error: error.message });
      return false;
    }
  }

  async deleteSession(tableName, token) {
    const client = await this.ensureClient();
    if (!client) {
      return false;
    }
    try {
      await client.del(`delivera:session:${tableName}:${token}`);
      return true;
    } catch (error) {
      this.logger?.warn?.("Redis deleteSession failed", { error: error.message });
      return false;
    }
  }

  health() {
    return {
      mode: this.redisUrl ? "redis" : "memory",
      ready: this.redisUrl ? this.ready : true,
      fallback: Boolean(this.redisUrl && !this.ready),
      revokedMemoryCount: this.memoryRevoked.size,
    };
  }
}

function createSessionRevocationService(options = {}) {
  return new SessionRevocationService(options);
}

module.exports = {
  createSessionRevocationService,
  SessionRevocationService,
};
