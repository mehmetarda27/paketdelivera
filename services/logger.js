const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const configuredLevel = String(process.env.LOG_LEVEL || "info").toLowerCase();
const activeLevel = LEVELS[configuredLevel] || LEVELS.info;

function shouldLog(level) {
  return (LEVELS[level] || LEVELS.info) >= activeLevel;
}

function serializeError(error) {
  if (!error) {
    return undefined;
  }
  return {
    name: error.name,
    message: error.message,
    stack: process.env.NODE_ENV === "production" ? undefined : error.stack,
  };
}

function write(level, message, meta = {}) {
  if (!shouldLog(level)) {
    return;
  }

  const payload = {
    ts: new Date().toISOString(),
    level,
    message,
    service: "delivera-express",
    ...meta,
  };

  if (payload.error instanceof Error) {
    payload.error = serializeError(payload.error);
  }

  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}

module.exports = {
  debug(message, meta) {
    write("debug", message, meta);
  },
  info(message, meta) {
    write("info", message, meta);
  },
  warn(message, meta) {
    write("warn", message, meta);
  },
  error(message, meta) {
    write("error", message, meta);
  },
  child(defaultMeta = {}) {
    return {
      debug(message, meta = {}) {
        write("debug", message, { ...defaultMeta, ...meta });
      },
      info(message, meta = {}) {
        write("info", message, { ...defaultMeta, ...meta });
      },
      warn(message, meta = {}) {
        write("warn", message, { ...defaultMeta, ...meta });
      },
      error(message, meta = {}) {
        write("error", message, { ...defaultMeta, ...meta });
      },
    };
  },
};
