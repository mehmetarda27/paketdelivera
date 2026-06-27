const fs = require("fs");
const path = require("path");

const DATABASE_URL_SECRET_FILE = "/etc/secrets/DATABASE_URL";
const DATABASE_URL_SOURCE_ENV = "env:DATABASE_URL";
const DATABASE_URL_SOURCE_SECRET_FILE = `file:${DATABASE_URL_SECRET_FILE}`;

const POSTGRES_URL_ENV_KEYS = [
  "DATABASE_URL",
  "POSTGRES_URL",
  "DATABASE_PRIVATE_URL",
  "POSTGRES_PRIVATE_URL",
  "INTERNAL_DATABASE_URL",
  "DATABASE_INTERNAL_URL",
  "RENDER_DATABASE_URL",
  "RENDER_POSTGRES_URL",
  "POSTGRES_DATABASE_URL",
  "PGDATABASE_URL",
  "DATABASE_CONNECTION_STRING",
  "POSTGRES_CONNECTION_STRING",
];

const RENDER_ENV_KEYS = [
  "RENDER",
  "RENDER_SERVICE_ID",
  "RENDER_SERVICE_NAME",
  "RENDER_EXTERNAL_URL",
  "RENDER_GIT_COMMIT",
  "RENDER_INSTANCE_ID",
];

function trimmed(value) {
  return String(value || "").trim();
}

function loadDatabaseUrlFromSecretFile() {
  if (trimmed(process.env.DATABASE_URL)) {
    process.env.DELIVERA_DATABASE_URL_SOURCE = DATABASE_URL_SOURCE_ENV;
    console.info("[database_init] DATABASE_URL found in env");
    return;
  }

  try {
    if (!fs.existsSync(DATABASE_URL_SECRET_FILE)) {
      return;
    }
    const fileValue = trimmed(fs.readFileSync(DATABASE_URL_SECRET_FILE, "utf8"));
    if (!fileValue) {
      console.warn(`[database_init] ${DATABASE_URL_SECRET_FILE} exists but is empty`);
      return;
    }
    process.env.DATABASE_URL = fileValue;
    process.env.DELIVERA_DATABASE_URL_SOURCE = DATABASE_URL_SOURCE_SECRET_FILE;
    console.info(`[database_init] DATABASE_URL loaded from ${DATABASE_URL_SECRET_FILE}`);
  } catch (error) {
    console.error(`[database_init] Failed to read ${DATABASE_URL_SECRET_FILE}`, error);
  }
}

loadDatabaseUrlFromSecretFile();

function configuredEnv(keys) {
  return keys
    .map((name) => ({ name, value: trimmed(process.env[name]) }))
    .filter((item) => item.value);
}

function firstConfiguredEnv(keys) {
  return configuredEnv(keys)[0] || null;
}

function databaseUrl() {
  return firstConfiguredEnv(POSTGRES_URL_ENV_KEYS)?.value || "";
}

function maskValue(value) {
  const text = trimmed(value);
  if (!text) return "";
  try {
    const url = new URL(text);
    if (url.password) url.password = "***";
    if (url.username) url.username = url.username ? "***" : "";
    return url.toString();
  } catch {
    return `${text.slice(0, 8)}***${text.slice(-6)}`;
  }
}

function runtimePathLooksManaged() {
  const cwd = process.cwd().replace(/\\/g, "/");
  return cwd.startsWith("/opt/render/") || cwd === "/app" || cwd.startsWith("/app/");
}

function renderRuntimeDetected() {
  return configuredEnv(RENDER_ENV_KEYS).length > 0 || runtimePathLooksManaged();
}

function postgresRequired() {
  return String(process.env.NODE_ENV || "").toLowerCase() === "production" ||
    renderRuntimeDetected() ||
    ["1", "true", "yes"].includes(String(process.env.DELIVERA_REQUIRE_POSTGRES || "").toLowerCase());
}

function databaseEnvInfo() {
  const postgresEnv = firstConfiguredEnv(POSTGRES_URL_ENV_KEYS);
  const renderEnv = configuredEnv(RENDER_ENV_KEYS).map((item) => item.name);
  const configuredPostgresEnv = configuredEnv(POSTGRES_URL_ENV_KEYS).map((item) => item.name);
  const required = postgresRequired();
  return {
    configured: Boolean(postgresEnv),
    variable: postgresEnv?.name || null,
    source: process.env.DELIVERA_DATABASE_URL_SOURCE || (postgresEnv ? `env:${postgresEnv.name}` : null),
    maskedValue: postgresEnv ? maskValue(postgresEnv.value) : null,
    detectedVariables: configuredPostgresEnv,
    supportedVariables: POSTGRES_URL_ENV_KEYS,
    postgresRequired: required,
    nodeEnv: String(process.env.NODE_ENV || ""),
    renderDetected: renderRuntimeDetected(),
    renderVariables: renderEnv,
    cwd: process.cwd(),
    skipReason: postgresEnv
      ? null
      : required
        ? "postgres_required_but_no_supported_connection_string_env_found"
        : "no_supported_connection_string_env_found_local_sqlite_allowed",
  };
}

module.exports = {
  DATABASE_URL_SECRET_FILE,
  POSTGRES_URL_ENV_KEYS,
  databaseEnvInfo,
  databaseUrl,
  postgresRequired,
  renderRuntimeDetected,
};
