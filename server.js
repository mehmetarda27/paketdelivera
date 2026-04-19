const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.PORT || 3000);
const DB_FILE = path.join(__dirname, "delivera.sqlite");
const LOG_DIR = path.join(__dirname, "logs");
const WEBHOOK_LOG_FILE = path.join(LOG_DIR, "webhooks.log");
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMITS = {
  integrations: { limit: 60, windowMs: RATE_LIMIT_WINDOW_MS },
  courierLogin: { limit: 12, windowMs: RATE_LIMIT_WINDOW_MS },
  adminWrites: { limit: 120, windowMs: RATE_LIMIT_WINDOW_MS },
  general: { limit: 240, windowMs: RATE_LIMIT_WINDOW_MS },
};

const DEFAULT_ZONES = ["Akdeniz", "Yenisehir", "Mezitli", "Toroslar", "Tarsus", "Erdemli"];
const SUPPORTED_PLATFORMS = ["Trendyol Go", "GetirYemek", "Yemeksepeti", "Migros Yemek"];
const PLATFORM_SLUGS = {
  "Trendyol Go": "trendyol-go",
  GetirYemek: "getiryemek",
  Yemeksepeti: "yemeksepeti",
  "Migros Yemek": "migros-yemek",
};
const PLATFORM_WEBHOOK_AUTH_TYPES = {
  API_KEY: "api_key",
  BASIC_AUTH: "basic_auth",
  STATIC_TOKEN: "static_token",
};
const WAITING_STATUS = "waiting";
const ASSIGNED_STATUS = "assigned";
const PICKED_UP_STATUS = "picked_up";
const DELIVERED_STATUS = "delivered";
const CANCELED_STATUS = "cancelled";
const MAX_ASSIGNMENT_DISTANCE_KM = 5;
const STATUS_TRANSITIONS = {
  [WAITING_STATUS]: [ASSIGNED_STATUS, CANCELED_STATUS],
  [ASSIGNED_STATUS]: [WAITING_STATUS, PICKED_UP_STATUS, CANCELED_STATUS],
  [PICKED_UP_STATUS]: [DELIVERED_STATUS, CANCELED_STATUS],
  [DELIVERED_STATUS]: [],
  [CANCELED_STATUS]: [],
};
const COURIER_ALLOWED_STATUSES = new Set([ASSIGNED_STATUS, PICKED_UP_STATUS, DELIVERED_STATUS]);
const LEGACY_STATUS_MAP = {
  "Kurye Bekleniyor": WAITING_STATUS,
  "Kurye Atandi": ASSIGNED_STATUS,
  "Kurye Yolda": PICKED_UP_STATUS,
  "Teslim Edildi": DELIVERED_STATUS,
  "Iptal Edildi": CANCELED_STATUS,
  "Teslim Edilemedi": CANCELED_STATUS,
  waiting: WAITING_STATUS,
  assigned: ASSIGNED_STATUS,
  picked_up: PICKED_UP_STATUS,
  delivered: DELIVERED_STATUS,
  cancelled: CANCELED_STATUS,
};

const STATIC_FILES = {
  "/": "index.html",
  "/index.html": "index.html",
  "/styles.css": "styles.css",
  "/shared.js": "shared.js",
  "/restaurant.html": "restaurant.html",
  "/admin.html": "admin.html",
  "/courier.html": "courier.html",
  "/landing.js": "landing.js",
  "/restaurant.js": "restaurant.js",
  "/admin.js": "admin.js",
  "/courier.js": "courier.js",
};

fs.mkdirSync(LOG_DIR, { recursive: true });

const db = new DatabaseSync(DB_FILE);
const rateBuckets = new Map();
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS zones (
    name TEXT PRIMARY KEY
  );

  CREATE TABLE IF NOT EXISTS restaurants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    zone TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    username TEXT UNIQUE,
    password_hash TEXT,
    password_salt TEXT,
    platforms_json TEXT NOT NULL,
    api_key TEXT NOT NULL UNIQUE,
    webhook_secret TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS couriers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    zone TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    available INTEGER NOT NULL,
    last_location_at TEXT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS packages (
    id TEXT PRIMARY KEY,
    tracking_no TEXT NOT NULL UNIQUE,
    restaurant_id TEXT NOT NULL,
    delivery_address TEXT,
    package_type TEXT,
    source_platform TEXT NOT NULL,
    external_order_no TEXT NOT NULL,
    recipient TEXT NOT NULL,
    phone TEXT NOT NULL,
    address TEXT NOT NULL,
    zone TEXT NOT NULL,
    eta TEXT NOT NULL,
    payment_method TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    note TEXT NOT NULL,
    status TEXT NOT NULL,
    assigned_courier_id TEXT,
    assigned_courier_name TEXT,
    distance_km REAL,
    assignment_reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
  );

  CREATE TABLE IF NOT EXISTS courier_sessions (
    token TEXT PRIMARY KEY,
    courier_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (courier_id) REFERENCES couriers(id)
  );

  CREATE TABLE IF NOT EXISTS restaurant_sessions (
    token TEXT PRIMARY KEY,
    restaurant_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
  );

  CREATE TABLE IF NOT EXISTS admins (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS admin_sessions (
    token TEXT PRIMARY KEY,
    admin_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (admin_id) REFERENCES admins(id)
  );

  CREATE TABLE IF NOT EXISTS webhook_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    restaurant_id TEXT,
    source_platform TEXT,
    external_order_no TEXT,
    signature_valid INTEGER NOT NULL,
    response_status INTEGER NOT NULL,
    request_body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_role TEXT NOT NULL,
    actor_id TEXT,
    action TEXT NOT NULL,
    package_id TEXT,
    restaurant_id TEXT,
    details_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS platform_accounts (
    id TEXT PRIMARY KEY,
    restaurant_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    external_store_id TEXT NOT NULL,
    external_merchant_id TEXT,
    api_username TEXT,
    api_password TEXT,
    api_key TEXT,
    api_secret TEXT,
    store_front_code TEXT,
    chain_id TEXT,
    vendor_id TEXT,
    webhook_auth_type TEXT NOT NULL,
    webhook_api_key TEXT,
    webhook_username TEXT,
    webhook_password TEXT,
    static_token TEXT,
    webhook_id TEXT,
    settings_json TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
  );
`);

const courierColumns = db.prepare("PRAGMA table_info(couriers)").all().map((row) => row.name);
if (!courierColumns.includes("last_location_at")) {
  db.exec("ALTER TABLE couriers ADD COLUMN last_location_at TEXT");
}

const packageColumns = db.prepare("PRAGMA table_info(packages)").all().map((row) => row.name);
if (!packageColumns.includes("delivery_address")) {
  db.exec("ALTER TABLE packages ADD COLUMN delivery_address TEXT");
}
if (!packageColumns.includes("package_type")) {
  db.exec("ALTER TABLE packages ADD COLUMN package_type TEXT");
}

const restaurantColumns = db.prepare("PRAGMA table_info(restaurants)").all().map((row) => row.name);
if (!restaurantColumns.includes("username")) {
  db.exec("ALTER TABLE restaurants ADD COLUMN username TEXT");
}
if (!restaurantColumns.includes("password_hash")) {
  db.exec("ALTER TABLE restaurants ADD COLUMN password_hash TEXT");
}
if (!restaurantColumns.includes("password_salt")) {
  db.exec("ALTER TABLE restaurants ADD COLUMN password_salt TEXT");
}

const zoneInsert = db.prepare("INSERT OR IGNORE INTO zones (name) VALUES (?)");
DEFAULT_ZONES.forEach((zone) => zoneInsert.run(zone));

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function json(value) {
  return JSON.stringify(value);
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function trimmed(value) {
  return String(value || "").trim();
}

function normalizePlatformName(value) {
  const incoming = trimmed(value).toLowerCase();
  return SUPPORTED_PLATFORMS.find((platform) => platform.toLowerCase() === incoming) || "";
}

function platformSlug(platform) {
  return PLATFORM_SLUGS[platform] || trimmed(platform).toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function normalizePlatformFromSlug(value) {
  const incoming = trimmed(value).toLowerCase();
  return SUPPORTED_PLATFORMS.find((platform) => platformSlug(platform) === incoming) || "";
}

function parseBasicAuthHeader(req) {
  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Basic ")) {
    return null;
  }

  try {
    const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
    const separatorIndex = decoded.indexOf(":");
    if (separatorIndex < 0) {
      return null;
    }

    return {
      username: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1),
    };
  } catch {
    return null;
  }
}

function candidateHeaderValues(req, names) {
  return names
    .map((name) => String(req.headers[name] || "").trim())
    .filter(Boolean);
}

function pickFirstValue(...values) {
  return values.find((value) => trimmed(value)) || "";
}

function joinAddress(parts) {
  return parts.map((part) => trimmed(part)).filter(Boolean).join(", ");
}

function extractDistrict(address) {
  const lowered = trimmed(address);
  if (!lowered) {
    return "";
  }

  const matched = DEFAULT_ZONES.find((zone) => lowered.toLowerCase().includes(zone.toLowerCase()));
  return matched || "";
}

function validatePackageDraft(payload) {
  const errors = [];

  if (!trimmed(payload.restaurantId)) {
    errors.push("restaurant_id zorunludur.");
  }

  if (!trimmed(payload.deliveryAddress) || trimmed(payload.deliveryAddress).length < 8) {
    errors.push("Teslimat adresi en az 8 karakter olmali.");
  }

  if (!trimmed(payload.packageType) || trimmed(payload.packageType).length < 2) {
    errors.push("Paket tipi en az 2 karakter olmali.");
  }

  if (trimmed(payload.packageType).length > 60) {
    errors.push("Paket tipi en fazla 60 karakter olabilir.");
  }

  return errors;
}

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function parseLatitudeLongitude(body, latitudeKey = "latitude", longitudeKey = "longitude") {
  return {
    latitude: Number(body[latitudeKey] ?? body.x),
    longitude: Number(body[longitudeKey] ?? body.y),
  };
}

function validateRestaurantDraft(body) {
  const { latitude, longitude } = parseLatitudeLongitude(body);
  const portalUsername = trimmed(body.portalUsername || body.username);
  const portalPassword = String(body.portalPassword || body.password || "");
  const draft = {
    name: trimmed(body.name),
    zone: trimmed(body.zone),
    latitude,
    longitude,
    portalUsername,
    portalPassword,
    platforms: Array.isArray(body.platforms) ? body.platforms.map((item) => trimmed(item)).filter(Boolean) : [],
  };

  if (!draft.name || !draft.zone || Number.isNaN(draft.latitude) || Number.isNaN(draft.longitude)) {
    throw validationError("Restoran bilgileri eksik.");
  }

  return draft;
}

function validatePlatformAccountDraft(body) {
  const restaurantId = trimmed(body.restaurantId ?? body.restaurant_id);
  const platform = normalizePlatformName(body.platform);
  const externalStoreId = trimmed(body.externalStoreId ?? body.external_store_id);
  const externalMerchantId = trimmed(body.externalMerchantId ?? body.external_merchant_id);
  const webhookAuthType = trimmed(body.webhookAuthType || PLATFORM_WEBHOOK_AUTH_TYPES.API_KEY).toLowerCase();

  if (!restaurantId) {
    throw validationError("restaurant_id zorunludur.");
  }

  if (!platform) {
    throw validationError("Desteklenen bir platform secmelisin.");
  }

  if (!externalStoreId) {
    throw validationError("Platform store/vendor kimligi zorunludur.");
  }

  if (!Object.values(PLATFORM_WEBHOOK_AUTH_TYPES).includes(webhookAuthType)) {
    throw validationError("Gecersiz webhook auth tipi secildi.");
  }

  const settings = typeof body.settings === "object" && body.settings ? body.settings : {};

  return {
    restaurantId,
    platform,
    externalStoreId,
    externalMerchantId,
    apiUsername: trimmed(body.apiUsername),
    apiPassword: String(body.apiPassword || ""),
    apiKey: trimmed(body.apiKey),
    apiSecret: trimmed(body.apiSecret),
    storeFrontCode: trimmed(body.storeFrontCode),
    chainId: trimmed(body.chainId),
    vendorId: trimmed(body.vendorId),
    webhookAuthType,
    webhookApiKey: trimmed(body.webhookApiKey),
    webhookUsername: trimmed(body.webhookUsername),
    webhookPassword: String(body.webhookPassword || ""),
    staticToken: trimmed(body.staticToken),
    active: body.active !== false,
    settings,
  };
}

function validateAdminLoginDraft(body) {
  const username = trimmed(body.username).toLowerCase();
  const password = String(body.password || "");

  if (!username || !password) {
    throw validationError("Admin kullanici adi ve sifre zorunludur.");
  }

  return { username, password };
}

function validateRestaurantLoginDraft(body) {
  const username = trimmed(body.username).toLowerCase();
  const password = String(body.password || "");
  const restaurantId = trimmed(body.restaurantId);
  const apiKey = trimmed(body.apiKey);

  if (username && password) {
    return { mode: "portal", username, password };
  }

  if (restaurantId && apiKey) {
    return { mode: "integration", restaurantId, apiKey };
  }

  throw validationError("Restoran girisi icin kullanici/sifre veya restoranId/apiKey gerekli.");
}

function validateCourierDraft(body) {
  const { latitude, longitude } = parseLatitudeLongitude(body);
  const draft = {
    username: trimmed(body.username).toLowerCase(),
    password: String(body.password || ""),
    name: trimmed(body.name),
    zone: trimmed(body.zone),
    latitude,
    longitude,
    available: Boolean(body.available),
  };

  if (!draft.name || !draft.zone || !draft.username || !draft.password || Number.isNaN(draft.latitude) || Number.isNaN(draft.longitude)) {
    throw validationError("Kurye bilgileri eksik.");
  }

  if (draft.password.length < 6) {
    throw validationError("Kurye sifresi en az 6 karakter olmali.");
  }

  return draft;
}

function validateRestaurantSessionDraft(body) {
  const restaurantId = trimmed(body.restaurantId);
  const apiKey = trimmed(body.apiKey);

  if (!restaurantId || !apiKey) {
    throw validationError("Restoran kimligi ve API key zorunludur.");
  }

  return { restaurantId, apiKey };
}

function validateCourierLoginDraft(body) {
  const username = trimmed(body.username).toLowerCase();
  const password = String(body.password || "");

  if (!username || !password) {
    throw validationError("Kullanici adi ve sifre zorunludur.");
  }

  return { username, password };
}

function validateIntegrationDraft(body, restaurant) {
  const pkg = {
    id: uid("pkg"),
    trackingNo: `PKT-${Math.floor(1000 + Math.random() * 9000)}`,
    restaurantId: restaurant.id,
    sourcePlatform: trimmed(body.sourcePlatform),
    externalOrderNo: trimmed(body.externalOrderNo),
    recipient: trimmed(body.recipient),
    phone: trimmed(body.phone),
    address: trimmed(body.address),
    zone: trimmed(body.zone || restaurant.zone),
    eta: trimmed(body.eta),
    paymentMethod: trimmed(body.paymentMethod),
    latitude: Number(body.latitude ?? body.x ?? restaurant.latitude),
    longitude: Number(body.longitude ?? body.y ?? restaurant.longitude),
    note: trimmed(body.note),
    status: WAITING_STATUS,
    assignedCourierId: null,
    assignedCourierName: null,
    distanceKm: null,
    assignmentReason: "Atama bekleniyor.",
    createdAt: new Date().toISOString(),
  };

  if (
    !pkg.restaurantId ||
    !pkg.sourcePlatform ||
    !pkg.externalOrderNo ||
    !pkg.recipient ||
    !pkg.phone ||
    !pkg.address ||
    !pkg.zone ||
    !pkg.eta ||
    !pkg.paymentMethod ||
    Number.isNaN(pkg.latitude) ||
    Number.isNaN(pkg.longitude)
  ) {
    throw validationError("Siparis verisi eksik.");
  }

  return pkg;
}

function normalizeStatus(status) {
  return LEGACY_STATUS_MAP[String(status || "").trim()] || WAITING_STATUS;
}

function canTransitionStatus(fromStatus, toStatus) {
  const current = normalizeStatus(fromStatus);
  const next = normalizeStatus(toStatus);
  return current === next || (STATUS_TRANSITIONS[current] || []).includes(next);
}

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket.remoteAddress || "unknown";
}

function applyRateLimit(req, scope, rule) {
  const now = Date.now();
  const key = `${scope}:${clientIp(req)}`;
  const current = rateBuckets.get(key);

  if (!current || now - current.startedAt >= rule.windowMs) {
    rateBuckets.set(key, { count: 1, startedAt: now });
    return null;
  }

  current.count += 1;
  if (current.count > rule.limit) {
    return Math.max(1, Math.ceil((rule.windowMs - (now - current.startedAt)) / 1000));
  }

  return null;
}

function writeSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "geolocation=(self), microphone=(), camera=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  const actual = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expectedHash, "hex"));
}

function signWebhook(rawBody, secret) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

function createApiKey() {
  return `delv_${crypto.randomBytes(12).toString("hex")}`;
}

function createWebhookSecret() {
  return `whsec_${crypto.randomBytes(18).toString("hex")}`;
}

function createSessionToken() {
  return `sess_${crypto.randomBytes(18).toString("hex")}`;
}

function createIntegrationSecret(prefix = "hook") {
  return `${prefix}_${crypto.randomBytes(16).toString("hex")}`;
}

function createPortalUsername(name) {
  const base = trimmed(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 14) || "restaurant";
  return `${base}${Math.floor(100 + Math.random() * 900)}`;
}

function sanitizeCourier(courier) {
  const { passwordHash, passwordSalt, ...safeCourier } = courier;
  return safeCourier;
}

function sanitizeRestaurant(restaurant, includeSecrets = false) {
  const { passwordHash, passwordSalt, ...safeRestaurant } = restaurant;
  if (includeSecrets) {
    return safeRestaurant;
  }

  const { apiKey, webhookSecret, ...publicRestaurant } = safeRestaurant;
  return publicRestaurant;
}

function sanitizePlatformAccount(account, includeSecrets = false) {
  const safeAccount = {
    id: account.id,
    restaurantId: account.restaurantId,
    platform: account.platform,
    platformSlug: platformSlug(account.platform),
    externalStoreId: account.externalStoreId,
    externalMerchantId: account.externalMerchantId,
    apiUsername: account.apiUsername,
    storeFrontCode: account.storeFrontCode,
    chainId: account.chainId,
    vendorId: account.vendorId,
    webhookAuthType: account.webhookAuthType,
    webhookId: account.webhookId,
    settings: account.settings,
    active: account.active,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };

  if (!includeSecrets) {
    return safeAccount;
  }

  return {
    ...safeAccount,
    apiPassword: account.apiPassword,
    apiKey: account.apiKey,
    apiSecret: account.apiSecret,
    webhookApiKey: account.webhookApiKey,
    webhookUsername: account.webhookUsername,
    webhookPassword: account.webhookPassword,
    staticToken: account.staticToken,
  };
}

function getAdminSession(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    return null;
  }
  const token = header.slice(7).trim();
  return db.prepare("SELECT * FROM admin_sessions WHERE token = ?").get(token) || null;
}

function adminActorId(session) {
  return session?.admin_id || null;
}

function getAuditLogs(limit = 30, filter = {}) {
  const rows = filter.restaurantId
    ? db.prepare("SELECT * FROM audit_logs WHERE restaurant_id = ? ORDER BY id DESC LIMIT ?").all(filter.restaurantId, limit)
    : db.prepare("SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?").all(limit);

  return rows.map((row) => ({
    id: row.id,
    actorRole: row.actor_role,
    actorId: row.actor_id,
    action: row.action,
    packageId: row.package_id,
    restaurantId: row.restaurant_id,
    details: parseJson(row.details_json, {}),
    createdAt: row.created_at,
  }));
}

function writeAuditLog(entry) {
  db.prepare(`
    INSERT INTO audit_logs (actor_role, actor_id, action, package_id, restaurant_id, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.actorRole,
    entry.actorId || null,
    entry.action,
    entry.packageId || null,
    entry.restaurantId || null,
    json(entry.details || {}),
    new Date().toISOString()
  );
}

function getPlatformAccounts(filter = {}) {
  const rows = filter.restaurantId
    ? db.prepare("SELECT * FROM platform_accounts WHERE restaurant_id = ? ORDER BY datetime(updated_at) DESC").all(filter.restaurantId)
    : db.prepare("SELECT * FROM platform_accounts ORDER BY datetime(updated_at) DESC").all();

  return rows.map((row) => ({
    id: row.id,
    restaurantId: row.restaurant_id,
    platform: row.platform,
    externalStoreId: row.external_store_id,
    externalMerchantId: row.external_merchant_id,
    apiUsername: row.api_username,
    apiPassword: row.api_password,
    apiKey: row.api_key,
    apiSecret: row.api_secret,
    storeFrontCode: row.store_front_code,
    chainId: row.chain_id,
    vendorId: row.vendor_id,
    webhookAuthType: row.webhook_auth_type,
    webhookApiKey: row.webhook_api_key,
    webhookUsername: row.webhook_username,
    webhookPassword: row.webhook_password,
    staticToken: row.static_token,
    webhookId: row.webhook_id,
    settings: parseJson(row.settings_json, {}),
    active: Boolean(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk.toString();
      if (raw.length > 1_000_000) {
        reject(httpError(413, "Payload cok buyuk."));
      }
    });

    req.on("end", () => {
      if (!raw) {
        resolve({ raw: "", json: {} });
        return;
      }

      try {
        resolve({ raw, json: JSON.parse(raw) });
      } catch {
        reject(validationError("Gecersiz JSON gonderildi."));
      }
    });

    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  writeSecurityHeaders(res);
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendFile(res, fileName) {
  const filePath = path.join(__dirname, fileName);
  if (!fs.existsSync(filePath)) {
    sendJson(res, 404, { error: "Dosya bulunamadi." });
    return;
  }

  const ext = path.extname(fileName);
  const typeMap = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
  };

  writeSecurityHeaders(res);
  res.writeHead(200, { "Content-Type": typeMap[ext] || "text/plain; charset=utf-8" });
  fs.createReadStream(filePath).pipe(res);
}

function notFound(res) {
  sendJson(res, 404, { error: "Kaynak bulunamadi." });
}

function getZones() {
  return db.prepare("SELECT name FROM zones ORDER BY name").all().map((row) => row.name);
}

function getRestaurants(filter = {}) {
  const rows = filter.restaurantId
    ? db.prepare("SELECT * FROM restaurants WHERE id = ? ORDER BY datetime(created_at) DESC").all(filter.restaurantId)
    : db.prepare("SELECT * FROM restaurants ORDER BY datetime(created_at) DESC").all();

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    zone: row.zone,
    latitude: row.x,
    longitude: row.y,
    username: row.username,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    platforms: parseJson(row.platforms_json, []),
    apiKey: row.api_key,
    webhookSecret: row.webhook_secret,
    createdAt: row.created_at,
  }));
}

function getCouriers() {
  return db.prepare("SELECT * FROM couriers ORDER BY datetime(created_at) DESC").all().map((row) => ({
    id: row.id,
    name: row.name,
    zone: row.zone,
    latitude: row.x,
    longitude: row.y,
    available: Boolean(row.available),
    lastLocationAt: row.last_location_at,
    username: row.username,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    createdAt: row.created_at,
  }));
}

function getPackages(filter = {}) {
  const rows = filter.restaurantId
    ? db.prepare("SELECT * FROM packages WHERE restaurant_id = ? ORDER BY datetime(created_at) DESC").all(filter.restaurantId)
    : db.prepare("SELECT * FROM packages ORDER BY datetime(created_at) DESC").all();

  return rows.map((row) => ({
    id: row.id,
    trackingNo: row.tracking_no,
    restaurantId: row.restaurant_id,
    deliveryAddress: row.delivery_address || row.address,
    packageType: row.package_type || "Standart Paket",
    sourcePlatform: row.source_platform,
    externalOrderNo: row.external_order_no,
    recipient: row.recipient,
    phone: row.phone,
    address: row.address,
    zone: row.zone,
    eta: row.eta,
    paymentMethod: row.payment_method,
    latitude: row.x,
    longitude: row.y,
    note: row.note,
    status: normalizeStatus(row.status),
    assignedCourierId: row.assigned_courier_id,
    assignedCourierName: row.assigned_courier_name,
    distanceKm: row.distance_km,
    assignmentReason: row.assignment_reason,
    createdAt: row.created_at,
  }));
}

function getWebhookLogs(limit = 20, filter = {}) {
  const rows = filter.restaurantId
    ? db.prepare("SELECT * FROM webhook_logs WHERE restaurant_id = ? ORDER BY id DESC LIMIT ?").all(filter.restaurantId, limit)
    : db.prepare("SELECT * FROM webhook_logs ORDER BY id DESC LIMIT ?").all(limit);

  return rows.map((row) => ({
    id: row.id,
    restaurantId: row.restaurant_id,
    sourcePlatform: row.source_platform,
    externalOrderNo: row.external_order_no,
    signatureValid: Boolean(row.signature_valid),
    responseStatus: row.response_status,
    requestBody: row.request_body,
    createdAt: row.created_at,
  }));
}

function currentState(filter = {}) {
  return {
    zones: getZones(),
    restaurants: getRestaurants(filter),
    couriers: getCouriers(),
    packages: getPackages(filter),
    platformAccounts: getPlatformAccounts(filter),
    webhookLogs: getWebhookLogs(20, filter),
  };
}

function activeAssignmentsForCourier(packages, courierId, excludePackageId = null) {
  return packages.filter((item) =>
    item.assignedCourierId === courierId &&
    item.id !== excludePackageId &&
    item.status !== DELIVERED_STATUS &&
    item.status !== CANCELED_STATUS
  ).length;
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function distance(aLat, aLng, bLat, bLng) {
  const earthRadiusKm = 6371;
  const dLat = toRadians(bLat - aLat);
  const dLng = toRadians(bLng - aLng);
  const lat1 = toRadians(aLat);
  const lat2 = toRadians(bLat);
  const haversine =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * earthRadiusKm * Math.asin(Math.sqrt(haversine));
}

function waitingPackagePriority(pkg) {
  return new Date(pkg.createdAt).getTime();
}

function reserveCourier(loadMap, courierId, delta) {
  if (!courierId) {
    return;
  }

  const nextValue = (loadMap.get(courierId) || 0) + delta;
  if (nextValue <= 0) {
    loadMap.delete(courierId);
    return;
  }

  loadMap.set(courierId, nextValue);
}

function assignPackage(state, pkg, occupiedCourierLoads = new Map()) {
  const packageStatus = normalizeStatus(pkg.status);
  if (packageStatus === PICKED_UP_STATUS || packageStatus === DELIVERED_STATUS || packageStatus === CANCELED_STATUS) {
    return {
      ...pkg,
      status: packageStatus,
    };
  }

  const eligibleCouriers = state.couriers
    .filter((courier) => courier.available && courier.zone === pkg.zone)
    .map((courier) => ({
      courier,
      distance: distance(courier.latitude, courier.longitude, pkg.latitude, pkg.longitude),
    }))
    .filter(({ courier, distance: courierDistance }) =>
      courierDistance <= MAX_ASSIGNMENT_DISTANCE_KM &&
      (!occupiedCourierLoads.has(courier.id) || courier.id === pkg.assignedCourierId)
    );

  if (eligibleCouriers.length === 0) {
    return {
      ...pkg,
      assignedCourierId: null,
      assignedCourierName: null,
      distanceKm: null,
      status: WAITING_STATUS,
      assignmentReason: `${pkg.zone} bolgesinde ${MAX_ASSIGNMENT_DISTANCE_KM} km icinde uygun aktif kurye yok.`,
    };
  }

  const ranked = eligibleCouriers
    .map(({ courier, distance: courierDistance }) => ({
      courier,
      distance: courierDistance,
      load: activeAssignmentsForCourier(state.packages, courier.id, pkg.id),
    }))
    .sort((left, right) => left.distance - right.distance || left.load - right.load);

  const best = ranked[0];

  return {
    ...pkg,
    assignedCourierId: best.courier.id,
    assignedCourierName: best.courier.name,
    distanceKm: Number(best.distance.toFixed(2)),
    status: ASSIGNED_STATUS,
    assignmentReason: `${pkg.zone} bolgesinde ${MAX_ASSIGNMENT_DISTANCE_KM} km icinde en uygun aktif kurye secildi.`,
  };
}

function persistPackageAssignment(pkg) {
  db.prepare(`
    UPDATE packages
    SET status = ?, assigned_courier_id = ?, assigned_courier_name = ?, distance_km = ?, assignment_reason = ?
    WHERE id = ?
  `).run(
    pkg.status,
    pkg.assignedCourierId,
    pkg.assignedCourierName,
    pkg.distanceKm,
    pkg.assignmentReason,
    pkg.id
  );
}

function rebalancePackages() {
  const state = currentState();
  const occupiedCourierLoads = new Map();
  state.packages
    .filter((pkg) => pkg.status === ASSIGNED_STATUS || pkg.status === PICKED_UP_STATUS)
    .forEach((pkg) => reserveCourier(occupiedCourierLoads, pkg.assignedCourierId, 1));

  const candidatePackages = state.packages
    .filter((pkg) => pkg.status === WAITING_STATUS || pkg.status === ASSIGNED_STATUS)
    .sort((left, right) => waitingPackagePriority(left) - waitingPackagePriority(right));

  candidatePackages.forEach((pkg) => {
    if (pkg.assignedCourierId && pkg.status === ASSIGNED_STATUS) {
      reserveCourier(occupiedCourierLoads, pkg.assignedCourierId, -1);
    }

    const assigned = assignPackage(state, pkg, occupiedCourierLoads);
    persistPackageAssignment(assigned);

    if (assigned.assignedCourierId && assigned.status === ASSIGNED_STATUS) {
      reserveCourier(occupiedCourierLoads, assigned.assignedCourierId, 1);
    }

    const packageIndex = state.packages.findIndex((item) => item.id === pkg.id);
    if (packageIndex >= 0) {
      state.packages[packageIndex] = assigned;
    }
  });
}

function stats(state) {
  return {
    totalRestaurants: state.restaurants.length,
    totalCouriers: state.couriers.length,
    totalPlatformAccounts: state.platformAccounts.length,
    activeCouriers: state.couriers.filter((item) => item.available).length,
    totalPackages: state.packages.length,
    waitingPackages: state.packages.filter((item) => item.status === WAITING_STATUS).length,
    assignedPackages: state.packages.filter((item) => item.assignedCourierId).length,
    inTransitPackages: state.packages.filter((item) => item.status === PICKED_UP_STATUS).length,
    deliveredPackages: state.packages.filter((item) => item.status === DELIVERED_STATUS).length,
  };
}

function decorateState(filter = {}) {
  const state = currentState(filter);
  const restaurantMap = new Map(state.restaurants.map((item) => [item.id, item.name]));

  const couriers = state.couriers.map((courier) => ({
    ...sanitizeCourier(courier),
    activeLoad: activeAssignmentsForCourier(state.packages, courier.id),
  }));

  const packages = state.packages.map((pkg) => ({
    ...pkg,
    restaurantName: restaurantMap.get(pkg.restaurantId) || "Bilinmeyen Restoran",
  }));

  const zones = state.zones.map((zone) => ({
    name: zone,
    courierCount: couriers.filter((item) => item.zone === zone).length,
    activeCourierCount: couriers.filter((item) => item.zone === zone && item.available).length,
    packageCount: packages.filter((item) => item.zone === zone).length,
    waitingCount: packages.filter((item) => item.zone === zone && item.status === WAITING_STATUS).length,
  }));

  return {
    zones,
    restaurants: state.restaurants.map((restaurant) => sanitizeRestaurant(restaurant, Boolean(filter.includeRestaurantSecrets))),
    platformAccounts: state.platformAccounts.map((account) => sanitizePlatformAccount(account, Boolean(filter.includePlatformSecrets || filter.includeRestaurantSecrets))),
    couriers,
    packages,
    webhookLogs: state.webhookLogs,
    stats: stats(state),
  };
}

function logWebhookAttempt(entry) {
  db.prepare(`
    INSERT INTO webhook_logs (
      restaurant_id, source_platform, external_order_no, signature_valid, response_status, request_body, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.restaurantId || null,
    entry.sourcePlatform || null,
    entry.externalOrderNo || null,
    entry.signatureValid ? 1 : 0,
    entry.responseStatus,
    entry.requestBody,
    new Date().toISOString()
  );

  const line = `[${new Date().toISOString()}] status=${entry.responseStatus} signature=${entry.signatureValid ? "valid" : "invalid"} restaurant=${entry.restaurantId || "-"} platform=${entry.sourcePlatform || "-"} order=${entry.externalOrderNo || "-"}${"\n"}`;
  fs.appendFileSync(WEBHOOK_LOG_FILE, line);
}

function buildIntegrationInfo(req, restaurant) {
  return {
    restaurantId: restaurant.id,
    restaurantName: restaurant.name,
    portalUsername: restaurant.username,
    apiKey: restaurant.apiKey,
    webhookSecret: restaurant.webhookSecret,
    endpoint: `http://${req.headers.host}/api/integrations/orders`,
    platformWebhookBase: `http://${req.headers.host}/api/platforms`,
    signatureHeader: "x-delivera-signature",
    samplePayload: {
      restaurantId: restaurant.id,
      sourcePlatform: restaurant.platforms[0] || "Trendyol Go",
      externalOrderNo: "ORDER-10001",
      recipient: "Ayse Demir",
      phone: "5551234567",
      address: "Mersin teslimat adresi",
      zone: restaurant.zone,
      eta: "12:45",
      paymentMethod: "Online Odeme",
      latitude: restaurant.latitude,
      longitude: restaurant.longitude,
      note: "Kapidan ara",
    },
  };
}

function createPackageRecord(pkg, packageType = "Platform Siparisi") {
  db.prepare(`
    INSERT INTO packages (
      id, tracking_no, restaurant_id, delivery_address, package_type, source_platform, external_order_no, recipient, phone, address,
      zone, eta, payment_method, x, y, note, status, assigned_courier_id, assigned_courier_name,
      distance_km, assignment_reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    pkg.id,
    pkg.trackingNo,
    pkg.restaurantId,
    pkg.deliveryAddress || pkg.address,
    packageType,
    pkg.sourcePlatform,
    pkg.externalOrderNo,
    pkg.recipient,
    pkg.phone,
    pkg.address,
    pkg.zone,
    pkg.eta,
    pkg.paymentMethod,
    pkg.latitude,
    pkg.longitude,
    pkg.note,
    pkg.status,
    null,
    null,
    null,
    pkg.assignmentReason,
    pkg.createdAt
  );
}

function extractPlatformIdentifiers(body) {
  const shipment = body?.content?.[0] || body;
  const client = shipment?.client || {};
  const store = shipment?.store || {};
  return [
    trimmed(body.restaurantId),
    trimmed(body.storeId),
    trimmed(body.vendorId),
    trimmed(body.chainId),
    trimmed(body.sellerId),
    trimmed(body.supplierId),
    trimmed(shipment?.storeId),
    trimmed(shipment?.sellerId),
    trimmed(shipment?.supplierId),
    trimmed(shipment?.vendorId),
    trimmed(shipment?.merchantId),
    trimmed(client.id),
    trimmed(client.vendor_id),
    trimmed(client.vendorId),
    trimmed(client.chain_id),
    trimmed(client.chainId),
    trimmed(store.id),
  ].filter(Boolean);
}

function verifyPlatformWebhookAuth(account, req) {
  if (account.webhookAuthType === PLATFORM_WEBHOOK_AUTH_TYPES.BASIC_AUTH) {
    const basic = parseBasicAuthHeader(req);
    return Boolean(
      basic &&
      basic.username === account.webhookUsername &&
      basic.password === account.webhookPassword
    );
  }

  if (account.webhookAuthType === PLATFORM_WEBHOOK_AUTH_TYPES.STATIC_TOKEN) {
    const authorization = String(req.headers.authorization || "");
    const bearerToken = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    const tokens = candidateHeaderValues(req, ["x-webhook-token", "x-static-token", "x-partner-token", "x-yemeksepeti-token"]);
    return [bearerToken, ...tokens].includes(account.staticToken);
  }

  const apiKeys = candidateHeaderValues(req, ["x-api-key", "api-key", "x-platform-api-key"]);
  return apiKeys.includes(account.webhookApiKey);
}

function mapExternalStatusToInternal(status) {
  const incoming = trimmed(status).toUpperCase();

  if (!incoming) {
    return WAITING_STATUS;
  }

  if (["CANCELLED", "CANCELED", "UNDELIVERED", "RETURNED", "UNSUPPLIED"].includes(incoming)) {
    return CANCELED_STATUS;
  }

  if (["DELIVERED", "COMPLETED"].includes(incoming)) {
    return DELIVERED_STATUS;
  }

  return WAITING_STATUS;
}

function normalizeIncomingPlatformPayload(platform, body, account, restaurant) {
  const shipment = body?.content?.[0] || body;
  const shipmentAddress = shipment?.shipmentAddress || shipment?.deliveryAddress || shipment?.address || {};
  const customer = shipment?.customer || {};
  const payment = shipment?.payment || {};
  const recipientName = joinAddress([
    shipmentAddress.firstName || customer.first_name || customer.name || shipment.recipient,
    shipmentAddress.lastName || customer.last_name || "",
  ]) || trimmed(customer.name) || trimmed(shipment.recipient) || "Musteri";
  const address = joinAddress([
    shipmentAddress.address1,
    shipmentAddress.address2,
    shipmentAddress.district || shipmentAddress.town || shipmentAddress.area,
    shipmentAddress.city,
    shipment.address,
  ]) || trimmed(shipment.address);
  const zone = pickFirstValue(
    shipment.zone,
    shipmentAddress.district,
    shipmentAddress.town,
    extractDistrict(address),
    restaurant.zone
  );
  const rawLatitude = Number(
    shipment.latitude ??
    shipment.lat ??
    shipment.geo_lat ??
    shipmentAddress.latitude ??
    shipmentAddress.lat ??
    restaurant.latitude
  );
  const rawLongitude = Number(
    shipment.longitude ??
    shipment.lng ??
    shipment.lon ??
    shipment.geo_lng ??
    shipmentAddress.longitude ??
    shipmentAddress.lng ??
    restaurant.longitude
  );
  const latitude = Number.isNaN(rawLatitude) ? Number(restaurant.latitude) : rawLatitude;
  const longitude = Number.isNaN(rawLongitude) ? Number(restaurant.longitude) : rawLongitude;
  const externalOrderNo = pickFirstValue(
    shipment.externalOrderNo,
    shipment.external_order_no,
    shipment.orderNumber,
    shipment.order_number,
    shipment.order_id,
    shipment.orderId,
    shipment.shipmentPackageId,
    shipment.packageId,
    shipment.order_code,
    `${platformSlug(platform)}-${Date.now()}`
  );
  const paymentMethod = pickFirstValue(
    shipment.paymentMethod,
    shipment.payment_method,
    payment.method,
    payment.payment_method,
    payment.type,
    "Online Odeme"
  );
  const safeAddress = trimmed(address) || `${restaurant.name} teslimat adresi`;
  const safeZone = pickFirstValue(zone, restaurant.zone);
  const eta = pickFirstValue(
    shipment.eta,
    shipment.promised_for,
    shipment.accepted_for,
    "Platform Akisi"
  );

  return {
    restaurantId: restaurant.id,
    sourcePlatform: platform,
    externalOrderNo,
    recipient: trimmed(recipientName) || "Musteri",
    phone: pickFirstValue(
      shipment.phone,
      shipment.phoneNumber,
      shipmentAddress.phone,
      customer.phone,
      customer.phone_number,
      "Gizli Numara"
    ),
    address: safeAddress,
    zone: safeZone,
    eta,
    paymentMethod,
    latitude,
    longitude,
    note: pickFirstValue(
      shipment.note,
      shipment.comment,
      shipment.customerNote,
      shipment.customer_note
    ),
    status: mapExternalStatusToInternal(shipment.status),
  };
}

function upsertPlatformPackage(platform, restaurant, payload) {
  const existing = db.prepare(`
    SELECT * FROM packages
    WHERE restaurant_id = ? AND source_platform = ? AND external_order_no = ?
  `).get(restaurant.id, platform, payload.externalOrderNo);

  if (!existing) {
    const pkg = validateIntegrationDraft(payload, restaurant);
    createPackageRecord(pkg, "Platform Siparisi");
    rebalancePackages();
    writeAuditLog({
      actorRole: "integration",
      actorId: restaurant.id,
      action: "package_created_integration",
      packageId: pkg.id,
      restaurantId: restaurant.id,
      details: {
        sourcePlatform: pkg.sourcePlatform,
        externalOrderNo: pkg.externalOrderNo,
      },
    });
    return decorateState({ restaurantId: restaurant.id }).packages.find((item) => item.id === pkg.id);
  }

  const currentStatus = normalizeStatus(existing.status);
  const incomingStatus = normalizeStatus(payload.status || currentStatus);
  if (incomingStatus !== currentStatus && canTransitionStatus(currentStatus, incomingStatus)) {
    db.prepare("UPDATE packages SET status = ? WHERE id = ?").run(incomingStatus, existing.id);
    rebalancePackages();
    writeAuditLog({
      actorRole: "integration",
      actorId: restaurant.id,
      action: "package_updated_integration",
      packageId: existing.id,
      restaurantId: restaurant.id,
      details: {
        sourcePlatform: platform,
        externalOrderNo: payload.externalOrderNo,
        from: currentStatus,
        to: incomingStatus,
      },
    });
  }

  return decorateState({ restaurantId: restaurant.id }).packages.find((item) => item.id === existing.id);
}

function resolvePlatformAccountForWebhook(platform, req, body) {
  const normalizedPlatform = normalizePlatformName(platform);
  const identifiers = new Set([
    ...extractPlatformIdentifiers(body),
    ...candidateHeaderValues(req, ["x-store-id", "x-vendor-id", "x-merchant-id", "x-seller-id", "x-chain-id"]),
  ]);

  const accounts = getPlatformAccounts().filter((account) => account.platform === normalizedPlatform && account.active);
  if (accounts.length === 1) {
    return accounts[0];
  }

  return accounts.find((account) =>
    identifiers.has(account.externalStoreId) ||
    (account.externalMerchantId && identifiers.has(account.externalMerchantId)) ||
    (account.chainId && identifiers.has(account.chainId)) ||
    (account.vendorId && identifiers.has(account.vendorId))
  ) || null;
}

function getCourierSession(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    return null;
  }
  const token = header.slice(7).trim();
  return db.prepare("SELECT * FROM courier_sessions WHERE token = ?").get(token) || null;
}

function getRestaurantSession(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    return null;
  }
  const token = header.slice(7).trim();
  return db.prepare("SELECT * FROM restaurant_sessions WHERE token = ?").get(token) || null;
}

const defaultAdminUsername = trimmed(process.env.DELIVERA_ADMIN_USERNAME || "admin").toLowerCase();
const defaultAdminPassword = process.env.DELIVERA_ADMIN_PASSWORD || "Delivera123!";
const existingAdmin = db.prepare("SELECT id FROM admins LIMIT 1").get();
if (!existingAdmin) {
  const passwordInfo = hashPassword(defaultAdminPassword);
  db.prepare("INSERT INTO admins (id, username, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)").run(
    uid("adm"),
    defaultAdminUsername,
    passwordInfo.hash,
    passwordInfo.salt,
    new Date().toISOString()
  );
}

async function handleApi(req, res, pathname) {
  const generalRetry = applyRateLimit(req, "general", RATE_LIMITS.general);
  if (generalRetry !== null) {
    res.setHeader("Retry-After", String(generalRetry));
    sendJson(res, 429, { error: "Cok fazla istek gonderildi. Lutfen biraz bekleyip tekrar dene." });
    return;
  }

  if (req.method === "GET" && pathname === "/api/bootstrap") {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const restaurantId = String(requestUrl.searchParams.get("restaurantId") || "").trim();
    const payload = decorateState({ restaurantId: restaurantId || undefined });
    payload.restaurants = getRestaurants().map((restaurant) => sanitizeRestaurant(restaurant));
    sendJson(res, 200, payload);
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/login") {
    const retryAfter = applyRateLimit(req, "adminWrites", RATE_LIMITS.adminWrites);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Admin giris limiti asildi." });
      return;
    }

    const { json: body } = await readRequestBody(req);
    const { username, password } = validateAdminLoginDraft(body);
    const admin = db.prepare("SELECT * FROM admins WHERE username = ?").get(username);
    if (!admin || !verifyPassword(password, admin.password_salt, admin.password_hash)) {
      sendJson(res, 401, { error: "Admin kullanici adi veya sifre hatali." });
      return;
    }

    db.prepare("DELETE FROM admin_sessions WHERE admin_id = ?").run(admin.id);
    const token = createSessionToken();
    db.prepare("INSERT INTO admin_sessions (token, admin_id, created_at) VALUES (?, ?, ?)").run(
      token,
      admin.id,
      new Date().toISOString()
    );

    writeAuditLog({
      actorRole: "admin",
      actorId: admin.id,
      action: "admin_logged_in",
      details: {
        username: admin.username,
      },
    });

    sendJson(res, 200, { token, username: admin.username });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/bootstrap") {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }

    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const restaurantId = trimmed(requestUrl.searchParams.get("restaurantId"));
    const payload = decorateState({ restaurantId: restaurantId || undefined });
    payload.restaurants = getRestaurants().map((restaurant) => sanitizeRestaurant(restaurant));
    payload.auditLogs = getAuditLogs(20, { restaurantId: restaurantId || undefined });
    sendJson(res, 200, payload);
    return;
  }

  if (req.method === "POST" && pathname === "/api/restaurant/session") {
    const retryAfter = applyRateLimit(req, "integrations", RATE_LIMITS.integrations);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Restoran giris limiti asildi." });
      return;
    }

    const { json: body } = await readRequestBody(req);
    const access = validateRestaurantLoginDraft(body);
    const restaurant = access.mode === "portal"
      ? db.prepare("SELECT * FROM restaurants WHERE username = ?").get(access.username)
      : db.prepare("SELECT * FROM restaurants WHERE id = ? AND api_key = ?").get(access.restaurantId, access.apiKey);

    if (!restaurant || (access.mode === "portal" && (!restaurant.password_salt || !verifyPassword(access.password, restaurant.password_salt, restaurant.password_hash)))) {
      sendJson(res, 401, { error: "Restoran kimligi veya API key hatali." });
      return;
    }

    db.prepare("DELETE FROM restaurant_sessions WHERE restaurant_id = ?").run(restaurant.id);
    const token = createSessionToken();
    db.prepare("INSERT INTO restaurant_sessions (token, restaurant_id, created_at) VALUES (?, ?, ?)").run(
      token,
      restaurant.id,
      new Date().toISOString()
    );

    writeAuditLog({
      actorRole: "restaurant",
      actorId: restaurant.id,
      action: "restaurant_logged_in",
      restaurantId: restaurant.id,
      details: {
        mode: access.mode,
        username: restaurant.username || null,
      },
    });

    sendJson(res, 200, {
      token,
      state: decorateState({
        restaurantId: restaurant.id,
        includeRestaurantSecrets: true,
      }),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/restaurant/bootstrap") {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }

    sendJson(res, 200, decorateState({
      restaurantId: session.restaurant_id,
      includeRestaurantSecrets: true,
    }));
    return;
  }

  if (req.method === "POST" && pathname === "/api/restaurant/platform-accounts") {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }

    const retryAfter = applyRateLimit(req, "integrations", RATE_LIMITS.integrations);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Platform entegrasyon limiti asildi." });
      return;
    }

    const { json: body } = await readRequestBody(req);
    const draft = validatePlatformAccountDraft(body);

    if (draft.restaurantId !== session.restaurant_id) {
      sendJson(res, 403, { error: "Bu restoran baska tenant icin entegrasyon kaydedemez." });
      return;
    }

    const webhookAuthType = draft.webhookAuthType;
    const webhookApiKey = webhookAuthType === PLATFORM_WEBHOOK_AUTH_TYPES.API_KEY
      ? (draft.webhookApiKey || createIntegrationSecret("api"))
      : "";
    const webhookUsername = webhookAuthType === PLATFORM_WEBHOOK_AUTH_TYPES.BASIC_AUTH
      ? (draft.webhookUsername || `${platformSlug(draft.platform)}_${draft.restaurantId.slice(-6)}`)
      : "";
    const webhookPassword = webhookAuthType === PLATFORM_WEBHOOK_AUTH_TYPES.BASIC_AUTH
      ? (draft.webhookPassword || createIntegrationSecret("pwd"))
      : "";
    const staticToken = webhookAuthType === PLATFORM_WEBHOOK_AUTH_TYPES.STATIC_TOKEN
      ? (draft.staticToken || createIntegrationSecret("token"))
      : "";
    const now = new Date().toISOString();
    const existing = db.prepare(`
      SELECT * FROM platform_accounts
      WHERE restaurant_id = ? AND platform = ? AND external_store_id = ?
    `).get(session.restaurant_id, draft.platform, draft.externalStoreId);

    if (existing) {
      db.prepare(`
        UPDATE platform_accounts
        SET external_merchant_id = ?, api_username = ?, api_password = ?, api_key = ?, api_secret = ?,
            store_front_code = ?, chain_id = ?, vendor_id = ?, webhook_auth_type = ?, webhook_api_key = ?,
            webhook_username = ?, webhook_password = ?, static_token = ?, settings_json = ?, active = ?, updated_at = ?
        WHERE id = ?
      `).run(
        draft.externalMerchantId || null,
        draft.apiUsername || null,
        draft.apiPassword || null,
        draft.apiKey || null,
        draft.apiSecret || null,
        draft.storeFrontCode || null,
        draft.chainId || null,
        draft.vendorId || null,
        webhookAuthType,
        webhookApiKey || null,
        webhookUsername || null,
        webhookPassword || null,
        staticToken || null,
        json(draft.settings),
        draft.active ? 1 : 0,
        now,
        existing.id
      );
    } else {
      db.prepare(`
        INSERT INTO platform_accounts (
          id, restaurant_id, platform, external_store_id, external_merchant_id, api_username, api_password,
          api_key, api_secret, store_front_code, chain_id, vendor_id, webhook_auth_type, webhook_api_key,
          webhook_username, webhook_password, static_token, webhook_id, settings_json, active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uid("pla"),
        session.restaurant_id,
        draft.platform,
        draft.externalStoreId,
        draft.externalMerchantId || null,
        draft.apiUsername || null,
        draft.apiPassword || null,
        draft.apiKey || null,
        draft.apiSecret || null,
        draft.storeFrontCode || null,
        draft.chainId || null,
        draft.vendorId || null,
        webhookAuthType,
        webhookApiKey || null,
        webhookUsername || null,
        webhookPassword || null,
        staticToken || null,
        null,
        json(draft.settings),
        draft.active ? 1 : 0,
        now,
        now
      );
    }

    writeAuditLog({
      actorRole: "restaurant",
      actorId: session.restaurant_id,
      action: "platform_account_saved",
      restaurantId: session.restaurant_id,
      details: {
        platform: draft.platform,
        externalStoreId: draft.externalStoreId,
      },
    });

    sendJson(res, 200, decorateState({
      restaurantId: session.restaurant_id,
      includeRestaurantSecrets: true,
      includePlatformSecrets: true,
    }));
    return;
  }

  if (req.method === "POST" && pathname === "/api/restaurant/packages") {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }

    const retryAfter = applyRateLimit(req, "integrations", RATE_LIMITS.integrations);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Paket olusturma limiti asildi." });
      return;
    }

    const restaurantRow = db.prepare("SELECT * FROM restaurants WHERE id = ?").get(session.restaurant_id);
    if (!restaurantRow) {
      sendJson(res, 404, { error: "Restoran bulunamadi." });
      return;
    }

    const { json: body } = await readRequestBody(req);
    const draft = {
      restaurantId: trimmed(body.restaurant_id ?? body.restaurantId),
      deliveryAddress: trimmed(body.delivery_address ?? body.deliveryAddress),
      packageType: trimmed(body.package_type ?? body.packageType),
    };
    const errors = validatePackageDraft(draft);

    if (errors.length > 0) {
      sendJson(res, 400, { error: errors.join(" ") });
      return;
    }

    if (draft.restaurantId !== session.restaurant_id) {
      sendJson(res, 403, { error: "restaurant_id oturumdaki restoran ile eslesmiyor." });
      return;
    }

    const createdAt = new Date().toISOString();
    const pkg = {
      id: uid("pkg"),
      trackingNo: `PKT-${Math.floor(1000 + Math.random() * 9000)}`,
      restaurantId: restaurantRow.id,
      deliveryAddress: draft.deliveryAddress,
      packageType: draft.packageType,
      sourcePlatform: "Restaurant Panel",
      externalOrderNo: `MANUAL-${Date.now()}`,
      recipient: restaurantRow.name,
      phone: "-",
      address: draft.deliveryAddress,
      zone: restaurantRow.zone,
      eta: "Planlanacak",
      paymentMethod: "Panel Kaydi",
      latitude: restaurantRow.x,
      longitude: restaurantRow.y,
      note: `${draft.packageType} restoran panelinden olusturuldu.`,
      status: WAITING_STATUS,
      assignedCourierId: null,
      assignedCourierName: null,
      distanceKm: null,
      assignmentReason: "Yeni manuel paket kaydi alindi.",
      createdAt,
    };

    db.prepare(`
      INSERT INTO packages (
        id, tracking_no, restaurant_id, delivery_address, package_type, source_platform, external_order_no,
        recipient, phone, address, zone, eta, payment_method, x, y, note, status, assigned_courier_id,
        assigned_courier_name, distance_km, assignment_reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      pkg.id,
      pkg.trackingNo,
      pkg.restaurantId,
      pkg.deliveryAddress,
      pkg.packageType,
      pkg.sourcePlatform,
      pkg.externalOrderNo,
      pkg.recipient,
      pkg.phone,
      pkg.address,
      pkg.zone,
      pkg.eta,
      pkg.paymentMethod,
      pkg.latitude,
      pkg.longitude,
      pkg.note,
      pkg.status,
      null,
      null,
      null,
      pkg.assignmentReason,
      pkg.createdAt
    );

    rebalancePackages();
    writeAuditLog({
      actorRole: "restaurant",
      actorId: session.restaurant_id,
      action: "package_created_manual",
      packageId: pkg.id,
      restaurantId: session.restaurant_id,
      details: {
        externalOrderNo: pkg.externalOrderNo,
        packageType: pkg.packageType,
      },
    });
    sendJson(res, 201, decorateState({
      restaurantId: session.restaurant_id,
      includeRestaurantSecrets: true,
    }));
    return;
  }

  if (req.method === "POST" && pathname === "/api/restaurants") {
    const retryAfter = applyRateLimit(req, "adminWrites", RATE_LIMITS.adminWrites);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Restoran olusturma limiti asildi." });
      return;
    }

    const { json: body } = await readRequestBody(req);
    const restaurant = {
      id: uid("rst"),
      ...validateRestaurantDraft(body),
      username: trimmed(body.portalUsername || body.username).toLowerCase() || createPortalUsername(body.name),
      apiKey: createApiKey(),
      webhookSecret: createWebhookSecret(),
    };
    const restaurantPassword = restaurant.portalPassword || String(body.portalPassword || body.password || `Rest${Math.floor(1000 + Math.random() * 9000)}!`);
    const restaurantPasswordInfo = hashPassword(restaurantPassword);

    if (db.prepare("SELECT id FROM restaurants WHERE username = ?").get(restaurant.username)) {
      sendJson(res, 400, { error: "Bu restoran kullanici adi zaten kullaniliyor." });
      return;
    }

    db.prepare(`
      INSERT INTO restaurants (id, name, zone, x, y, username, password_hash, password_salt, platforms_json, api_key, webhook_secret, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      restaurant.id,
      restaurant.name,
      restaurant.zone,
      restaurant.latitude,
      restaurant.longitude,
      restaurant.username,
      restaurantPasswordInfo.hash,
      restaurantPasswordInfo.salt,
      json(restaurant.platforms),
      restaurant.apiKey,
      restaurant.webhookSecret,
      new Date().toISOString()
    );

    writeAuditLog({
      actorRole: "system",
      actorId: "seed",
      action: "restaurant_created",
      restaurantId: restaurant.id,
      details: {
        name: restaurant.name,
        username: restaurant.username,
      },
    });

    sendJson(res, 201, {
      ...decorateState(),
      integration: {
        ...buildIntegrationInfo(req, restaurant),
        portalPassword: restaurantPassword,
      },
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/couriers") {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }

    const retryAfter = applyRateLimit(req, "adminWrites", RATE_LIMITS.adminWrites);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Kurye olusturma limiti asildi." });
      return;
    }

    const { json: body } = await readRequestBody(req);
    const { username, password, name, zone, latitude, longitude, available } = validateCourierDraft(body);

    if (db.prepare("SELECT id FROM couriers WHERE username = ?").get(username)) {
      sendJson(res, 400, { error: "Bu kullanici adi zaten kullaniliyor." });
      return;
    }

    const passwordInfo = hashPassword(password);
    db.prepare(`
      INSERT INTO couriers (id, name, zone, x, y, available, username, password_hash, password_salt, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uid("cr"),
      name,
      zone,
      latitude,
      longitude,
      available ? 1 : 0,
      username,
      passwordInfo.hash,
      passwordInfo.salt,
      new Date().toISOString()
    );

    rebalancePackages();
    writeAuditLog({
      actorRole: "admin",
      actorId: adminActorId(adminSession),
      action: "courier_created",
      details: {
        username,
        zone,
      },
    });
    sendJson(res, 201, {
      ...decorateState(),
      auditLogs: getAuditLogs(20),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/integrations/orders") {
    const retryAfter = applyRateLimit(req, "integrations", RATE_LIMITS.integrations);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Entegrasyon istek limiti asildi." });
      return;
    }

    const { raw, json: body } = await readRequestBody(req);
    const apiKey = String(req.headers["x-api-key"] || "").trim();
    const signature = String(req.headers["x-delivera-signature"] || "").trim();
    const restaurantRow = db.prepare("SELECT * FROM restaurants WHERE id = ? AND api_key = ?").get(body.restaurantId, apiKey);

    if (!restaurantRow) {
      logWebhookAttempt({
        restaurantId: body.restaurantId,
        sourcePlatform: body.sourcePlatform,
        externalOrderNo: body.externalOrderNo,
        signatureValid: false,
        responseStatus: 401,
        requestBody: raw,
      });
      sendJson(res, 401, { error: "Gecersiz restoran kimligi veya API key." });
      return;
    }

    const restaurant = {
      id: restaurantRow.id,
      name: restaurantRow.name,
      zone: restaurantRow.zone,
      latitude: restaurantRow.x,
      longitude: restaurantRow.y,
      platforms: parseJson(restaurantRow.platforms_json, []),
      apiKey: restaurantRow.api_key,
      webhookSecret: restaurantRow.webhook_secret,
    };

    const expectedSignature = signWebhook(raw, restaurant.webhookSecret);
    const signatureValid =
      Boolean(signature) &&
      signature.length === expectedSignature.length &&
      crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));

    if (!signatureValid) {
      logWebhookAttempt({
        restaurantId: restaurant.id,
        sourcePlatform: body.sourcePlatform,
        externalOrderNo: body.externalOrderNo,
        signatureValid: false,
        responseStatus: 401,
        requestBody: raw,
      });
      sendJson(res, 401, { error: "Webhook imzasi dogrulanamadi." });
      return;
    }

    if (restaurant.platforms.length > 0 && !restaurant.platforms.includes(body.sourcePlatform)) {
      logWebhookAttempt({
        restaurantId: restaurant.id,
        sourcePlatform: body.sourcePlatform,
        externalOrderNo: body.externalOrderNo,
        signatureValid: true,
        responseStatus: 400,
        requestBody: raw,
      });
      sendJson(res, 400, { error: "Bu restoran icin platform tanimli degil." });
      return;
    }

    const duplicate = db.prepare(`
      SELECT id FROM packages
      WHERE restaurant_id = ? AND source_platform = ? AND external_order_no = ?
    `).get(body.restaurantId, body.sourcePlatform, body.externalOrderNo);

    if (duplicate) {
      logWebhookAttempt({
        restaurantId: restaurant.id,
        sourcePlatform: body.sourcePlatform,
        externalOrderNo: body.externalOrderNo,
        signatureValid: true,
        responseStatus: 409,
        requestBody: raw,
      });
      sendJson(res, 409, { error: "Bu siparis zaten alinmis." });
      return;
    }

    let pkg;
    try {
      pkg = validateIntegrationDraft(body, restaurant);
    } catch (error) {
      logWebhookAttempt({
        restaurantId: restaurant.id,
        sourcePlatform: body.sourcePlatform,
        externalOrderNo: body.externalOrderNo,
        signatureValid: true,
        responseStatus: 400,
        requestBody: raw,
      });
      sendJson(res, 400, { error: error.message });
      return;
    }

    db.prepare(`
      INSERT INTO packages (
        id, tracking_no, restaurant_id, delivery_address, package_type, source_platform, external_order_no, recipient, phone, address,
        zone, eta, payment_method, x, y, note, status, assigned_courier_id, assigned_courier_name,
        distance_km, assignment_reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      pkg.id,
      pkg.trackingNo,
      pkg.restaurantId,
      pkg.address,
      "Platform Siparisi",
      pkg.sourcePlatform,
      pkg.externalOrderNo,
      pkg.recipient,
      pkg.phone,
      pkg.address,
      pkg.zone,
      pkg.eta,
      pkg.paymentMethod,
      pkg.latitude,
      pkg.longitude,
      pkg.note,
      pkg.status,
      null,
      null,
      null,
      pkg.assignmentReason,
      pkg.createdAt
    );

    rebalancePackages();
    const created = decorateState().packages.find((item) => item.id === pkg.id);

    writeAuditLog({
      actorRole: "integration",
      actorId: restaurant.id,
      action: "package_created_integration",
      packageId: pkg.id,
      restaurantId: restaurant.id,
      details: {
        sourcePlatform: pkg.sourcePlatform,
        externalOrderNo: pkg.externalOrderNo,
      },
    });

    logWebhookAttempt({
      restaurantId: restaurant.id,
      sourcePlatform: body.sourcePlatform,
      externalOrderNo: body.externalOrderNo,
      signatureValid: true,
      responseStatus: 201,
      requestBody: raw,
    });

    sendJson(res, 201, {
      message: "Siparis alindi ve otomatik atama calisti.",
      package: created,
    });
    return;
  }

  const platformWebhookMatch = pathname.match(/^\/api\/platforms\/([^/]+)\/webhook$/);
  if (req.method === "POST" && platformWebhookMatch) {
    const retryAfter = applyRateLimit(req, "integrations", RATE_LIMITS.integrations);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Platform webhook limiti asildi." });
      return;
    }

    const normalizedPlatform = normalizePlatformFromSlug(platformWebhookMatch[1]);
    if (!normalizedPlatform) {
      sendJson(res, 404, { error: "Platform endpoint bulunamadi." });
      return;
    }

    const { raw, json: body } = await readRequestBody(req);
    const account = resolvePlatformAccountForWebhook(normalizedPlatform, req, body);
    if (!account) {
      logWebhookAttempt({
        restaurantId: body.restaurantId,
        sourcePlatform: normalizedPlatform,
        externalOrderNo: body.externalOrderNo || body.external_order_no || body.order_id || body.orderNumber,
        signatureValid: false,
        responseStatus: 401,
        requestBody: raw,
      });
      sendJson(res, 401, { error: "Platform hesabi veya store/vendor eslesmesi bulunamadi." });
      return;
    }

    if (!verifyPlatformWebhookAuth(account, req)) {
      logWebhookAttempt({
        restaurantId: account.restaurantId,
        sourcePlatform: normalizedPlatform,
        externalOrderNo: body.externalOrderNo || body.external_order_no || body.order_id || body.orderNumber,
        signatureValid: false,
        responseStatus: 401,
        requestBody: raw,
      });
      sendJson(res, 401, { error: "Platform webhook yetkilendirmesi dogrulanamadi." });
      return;
    }

    const restaurant = getRestaurants({ restaurantId: account.restaurantId })[0];
    if (!restaurant) {
      sendJson(res, 404, { error: "Restoran bulunamadi." });
      return;
    }

    let created;
    try {
      const normalizedPayload = normalizeIncomingPlatformPayload(normalizedPlatform, body, account, restaurant);
      created = upsertPlatformPackage(normalizedPlatform, restaurant, normalizedPayload);
    } catch (error) {
      logWebhookAttempt({
        restaurantId: account.restaurantId,
        sourcePlatform: normalizedPlatform,
        externalOrderNo: body.externalOrderNo || body.external_order_no || body.order_id || body.orderNumber,
        signatureValid: true,
        responseStatus: 400,
        requestBody: raw,
      });
      sendJson(res, 400, { error: error.message });
      return;
    }

    logWebhookAttempt({
      restaurantId: account.restaurantId,
      sourcePlatform: normalizedPlatform,
      externalOrderNo: created?.externalOrderNo,
      signatureValid: true,
      responseStatus: 201,
      requestBody: raw,
    });

    sendJson(res, 201, {
      message: `${normalizedPlatform} siparisi alindi.`,
      package: created,
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/courier/login") {
    const retryAfter = applyRateLimit(req, "courierLogin", RATE_LIMITS.courierLogin);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Cok fazla giris denemesi yapildi." });
      return;
    }

    const { json: body } = await readRequestBody(req);
    const { username, password } = validateCourierLoginDraft(body);
    const courier = db.prepare("SELECT * FROM couriers WHERE username = ?").get(username);

    if (!courier || !verifyPassword(password, courier.password_salt, courier.password_hash)) {
      sendJson(res, 401, { error: "Kullanici adi veya sifre hatali." });
      return;
    }

    db.prepare("DELETE FROM courier_sessions WHERE courier_id = ?").run(courier.id);
    const token = createSessionToken();
    db.prepare("INSERT INTO courier_sessions (token, courier_id, created_at) VALUES (?, ?, ?)").run(
      token,
      courier.id,
      new Date().toISOString()
    );

    const loginLocationAt = new Date().toISOString();
    db.prepare("UPDATE couriers SET available = 1, last_location_at = COALESCE(last_location_at, ?) WHERE id = ?").run(
      loginLocationAt,
      courier.id
    );

    writeAuditLog({
      actorRole: "courier",
      actorId: courier.id,
      action: "courier_logged_in",
      details: {
        username: courier.username,
      },
    });

    sendJson(res, 200, {
      token,
      courier: sanitizeCourier({
        id: courier.id,
        name: courier.name,
        zone: courier.zone,
        latitude: courier.x,
        longitude: courier.y,
        available: Boolean(courier.available),
        lastLocationAt: courier.last_location_at || loginLocationAt,
        username: courier.username,
        passwordHash: courier.password_hash,
        passwordSalt: courier.password_salt,
      }),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/courier/me") {
    const session = getCourierSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Oturum bulunamadi." });
      return;
    }

    const data = decorateState();
    const courier = data.couriers.find((item) => item.id === session.courier_id);
    if (!courier) {
      sendJson(res, 401, { error: "Kurye bulunamadi." });
      return;
    }

    sendJson(res, 200, {
      courier,
      packages: data.packages.filter((item) => item.assignedCourierId === courier.id),
    });
    return;
  }

  if (req.method === "PATCH" && pathname === "/api/courier/location") {
    const session = getCourierSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Oturum bulunamadi." });
      return;
    }

    const { json: body } = await readRequestBody(req);
    const latitude = Number(body.latitude);
    const longitude = Number(body.longitude);
    const hasCoordinates = !Number.isNaN(latitude) && !Number.isNaN(longitude);
    const locationStamp = new Date().toISOString();

    if (!hasCoordinates && typeof body.available !== "boolean") {
      sendJson(res, 400, { error: "Konum veya durum bilgisi gonderilmedi." });
      return;
    }

    const existing = db.prepare("SELECT * FROM couriers WHERE id = ?").get(session.courier_id);
    if (!existing) {
      sendJson(res, 404, { error: "Kurye bulunamadi." });
      return;
    }

    db.prepare(`
      UPDATE couriers
      SET x = ?, y = ?, available = ?, last_location_at = ?
      WHERE id = ?
    `).run(
      hasCoordinates ? latitude : existing.x,
      hasCoordinates ? longitude : existing.y,
      typeof body.available === "boolean" ? (body.available ? 1 : 0) : existing.available,
      locationStamp,
      session.courier_id
    );

    rebalancePackages();
    const data = decorateState();
    const courier = data.couriers.find((item) => item.id === session.courier_id);
    writeAuditLog({
      actorRole: "courier",
      actorId: session.courier_id,
      action: "courier_location_updated",
      details: {
        available: courier?.available ?? Boolean(body.available),
        latitude: hasCoordinates ? latitude : existing.x,
        longitude: hasCoordinates ? longitude : existing.y,
      },
    });
    sendJson(res, 200, {
      courier,
      packages: data.packages.filter((item) => item.assignedCourierId === session.courier_id),
    });
    return;
  }

  const courierPackageMatch = pathname.match(/^\/api\/courier\/packages\/([^/]+)\/status$/);
  if (req.method === "PATCH" && courierPackageMatch) {
    const session = getCourierSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Oturum bulunamadi." });
      return;
    }

    const { json: body } = await readRequestBody(req);
    const packageId = courierPackageMatch[1];
    const target = db.prepare("SELECT * FROM packages WHERE id = ? AND assigned_courier_id = ?").get(packageId, session.courier_id);

    if (!target) {
      sendJson(res, 404, { error: "Paket bulunamadi." });
      return;
    }

    const nextStatus = normalizeStatus(body.status || target.status);
    const currentStatus = normalizeStatus(target.status);

    if (!COURIER_ALLOWED_STATUSES.has(nextStatus)) {
      sendJson(res, 400, { error: "Kurye bu duruma gecis yapamaz." });
      return;
    }

    if (!canTransitionStatus(currentStatus, nextStatus)) {
      sendJson(res, 400, { error: `Gecersiz durum gecisi: ${currentStatus} -> ${nextStatus}` });
      return;
    }

    db.prepare("UPDATE packages SET status = ? WHERE id = ?").run(nextStatus, packageId);
    rebalancePackages();

    const data = decorateState();
    const courier = data.couriers.find((item) => item.id === session.courier_id);
    writeAuditLog({
      actorRole: "courier",
      actorId: session.courier_id,
      action: "courier_package_status_changed",
      packageId,
      restaurantId: target.restaurant_id,
      details: {
        from: currentStatus,
        to: nextStatus,
      },
    });
    sendJson(res, 200, {
      courier,
      packages: data.packages.filter((item) => item.assignedCourierId === session.courier_id),
    });
    return;
  }

  const availabilityMatch = pathname.match(/^\/api\/admin\/couriers\/([^/]+)\/availability$/);
  if (req.method === "PATCH" && availabilityMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }

    const retryAfter = applyRateLimit(req, "adminWrites", RATE_LIMITS.adminWrites);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Kurye guncelleme limiti asildi." });
      return;
    }

    const { json: body } = await readRequestBody(req);
    db.prepare("UPDATE couriers SET available = ? WHERE id = ?").run(body.available ? 1 : 0, availabilityMatch[1]);
    rebalancePackages();
    writeAuditLog({
      actorRole: "admin",
      actorId: adminActorId(adminSession),
      action: "courier_availability_changed",
      details: {
        courierId: availabilityMatch[1],
        available: Boolean(body.available),
      },
    });
    sendJson(res, 200, {
      ...decorateState(),
      auditLogs: getAuditLogs(20),
    });
    return;
  }

  const statusMatch = pathname.match(/^\/api\/admin\/packages\/([^/]+)\/status$/);
  if (req.method === "PATCH" && statusMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }

    const retryAfter = applyRateLimit(req, "adminWrites", RATE_LIMITS.adminWrites);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Paket guncelleme limiti asildi." });
      return;
    }

    const { json: body } = await readRequestBody(req);
    const target = db.prepare("SELECT * FROM packages WHERE id = ?").get(statusMatch[1]);
    if (!target) {
      sendJson(res, 404, { error: "Paket bulunamadi." });
      return;
    }

    const currentStatus = normalizeStatus(target.status);
    const nextStatus = normalizeStatus(body.status || WAITING_STATUS);
    if (!canTransitionStatus(currentStatus, nextStatus)) {
      sendJson(res, 400, { error: `Gecersiz durum gecisi: ${currentStatus} -> ${nextStatus}` });
      return;
    }

    db.prepare("UPDATE packages SET status = ? WHERE id = ?").run(nextStatus, statusMatch[1]);
    rebalancePackages();
    writeAuditLog({
      actorRole: "admin",
      actorId: adminActorId(adminSession),
      action: "package_status_changed",
      packageId: statusMatch[1],
      restaurantId: target.restaurant_id,
      details: {
        from: currentStatus,
        to: nextStatus,
      },
    });
    sendJson(res, 200, {
      ...decorateState(),
      auditLogs: getAuditLogs(20),
    });
    return;
  }

  const reassignMatch = pathname.match(/^\/api\/admin\/packages\/([^/]+)\/reassign$/);
  if (req.method === "POST" && reassignMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }

    const retryAfter = applyRateLimit(req, "adminWrites", RATE_LIMITS.adminWrites);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Yeniden atama limiti asildi." });
      return;
    }

    const state = currentState();
    const target = state.packages.find((item) => item.id === reassignMatch[1]);
    if (!target) {
      sendJson(res, 404, { error: "Paket bulunamadi." });
      return;
    }

    if (target.status === PICKED_UP_STATUS || target.status === DELIVERED_STATUS || target.status === CANCELED_STATUS) {
      sendJson(res, 400, { error: "Bu durumdaki paket yeniden havuza alinamaz." });
      return;
    }

    persistPackageAssignment(assignPackage(state, target));
    writeAuditLog({
      actorRole: "admin",
      actorId: adminActorId(adminSession),
      action: "package_reassigned",
      packageId: target.id,
      restaurantId: target.restaurantId,
      details: {
        status: target.status,
      },
    });
    sendJson(res, 200, {
      ...decorateState(),
      auditLogs: getAuditLogs(20),
    });
    return;
  }

  notFound(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const { pathname } = requestUrl;

    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, pathname);
      return;
    }

    if (STATIC_FILES[pathname]) {
      sendFile(res, STATIC_FILES[pathname]);
      return;
    }

    notFound(res);
  } catch (error) {
    sendJson(res, error.statusCode || 500, { error: error.message || "Bilinmeyen sunucu hatasi." });
  }
});

server.listen(PORT, () => {
  console.log(`Delivera Express hazir: http://localhost:${PORT}`);
});
