function redisConnectionOptions(redisUrl) {
  const value = String(redisUrl || "").trim();
  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value);
    const options = {
      host: parsed.hostname || "127.0.0.1",
      port: Number(parsed.port || 6379),
      db: parsed.pathname ? Number(parsed.pathname.replace("/", "") || 0) : 0,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    };
    if (parsed.username) {
      options.username = decodeURIComponent(parsed.username);
    }
    if (parsed.password) {
      options.password = decodeURIComponent(parsed.password);
    }
    if (parsed.protocol === "rediss:") {
      options.tls = {};
    }
    return options;
  } catch {
    return {
      host: "127.0.0.1",
      port: 6379,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    };
  }
}

module.exports = {
  redisConnectionOptions,
};
