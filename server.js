const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.PORT || 3000);
const DB_FILE = path.resolve(process.env.DELIVERA_DB_FILE || path.join(__dirname, "delivera.sqlite"));
const LOG_DIR = path.join(__dirname, "logs");
const WEBHOOK_LOG_FILE = path.join(LOG_DIR, "webhooks.log");
const ADMIN_BOOTSTRAP_FILE = path.join(LOG_DIR, "admin-bootstrap.txt");
const PASSWORD_RESET_LOG_FILE = path.join(LOG_DIR, "password-resets.log");
const RATE_LIMIT_WINDOW_MS = 60_000;
const ADMIN_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const RESTAURANT_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const COURIER_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const REFRESH_TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const PASSWORD_RESET_MAX_AGE_MS = 20 * 60 * 1000;
const PLATFORM_VERIFY_TIMEOUT_MS = 8_000;
const NODE_ENV = String(process.env.NODE_ENV || "development").toLowerCase();
const PUBLIC_BASE_URL = trimmed(process.env.PUBLIC_BASE_URL).replace(/\/+$/, "");
const TRUST_PROXY = ["1", "true", "yes"].includes(String(process.env.TRUST_PROXY || "").toLowerCase());
const FORCE_HTTPS = ["1", "true", "yes"].includes(String(process.env.FORCE_HTTPS || "").toLowerCase());
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
const PLATFORM_VERIFICATION_STATUS = {
  PENDING: "pending",
  VERIFIED: "verified",
  FAILED: "failed",
};
const ASSIGNMENT_RETRY_INTERVAL_MS = Number(process.env.DELIVERA_ASSIGNMENT_RETRY_MS || 15_000);
const PENDING_STATUS = "pending";
const AWAITING_ASSIGNMENT_STATUS = "awaiting_assignment";
const ASSIGNED_STATUS = "assigned";
const ACCEPTED_BY_COURIER_STATUS = "accepted_by_courier";
const ON_ROUTE_STATUS = "on_route";
const DELIVERED_STATUS = "delivered";
const FAILED_STATUS = "failed";
const CANCELED_STATUS = "cancelled";
const UNPAID_PAYMENT_STATUS = "unpaid";
const PAID_ONLINE_PAYMENT_STATUS = "paid_online";
const CASH_EXPECTED_PAYMENT_STATUS = "cash_expected";
const CASH_COLLECTED_PAYMENT_STATUS = "cash_collected";
const PAYMENT_ISSUE_STATUS = "payment_issue";
const COURIER_OFFLINE_STATUS = "offline";
const COURIER_ONLINE_STATUS = "online";
const COURIER_BUSY_STATUS = "busy";
const COURIER_FAILURE_REASONS = new Set([
  "musteri_yok",
  "adres_bulunamadi",
  "restoran_hazir_degil",
  "teknik_sorun",
  "diger",
]);
const MAX_ASSIGNMENT_DISTANCE_KM = 5;
const LIVE_STREAM_HEARTBEAT_MS = 20_000;
const STATUS_TRANSITIONS = {
  [PENDING_STATUS]: [AWAITING_ASSIGNMENT_STATUS, CANCELED_STATUS],
  [AWAITING_ASSIGNMENT_STATUS]: [ASSIGNED_STATUS, FAILED_STATUS, CANCELED_STATUS],
  [ASSIGNED_STATUS]: [AWAITING_ASSIGNMENT_STATUS, ACCEPTED_BY_COURIER_STATUS, FAILED_STATUS, CANCELED_STATUS],
  [ACCEPTED_BY_COURIER_STATUS]: [ON_ROUTE_STATUS, FAILED_STATUS, CANCELED_STATUS],
  [ON_ROUTE_STATUS]: [DELIVERED_STATUS, FAILED_STATUS, CANCELED_STATUS],
  [DELIVERED_STATUS]: [],
  [FAILED_STATUS]: [AWAITING_ASSIGNMENT_STATUS, CANCELED_STATUS],
  [CANCELED_STATUS]: [],
};
const COURIER_ALLOWED_STATUSES = new Set([ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS, DELIVERED_STATUS, FAILED_STATUS]);
const LEGACY_STATUS_MAP = {
  "Kurye Bekleniyor": AWAITING_ASSIGNMENT_STATUS,
  "Kurye Atandi": ASSIGNED_STATUS,
  "Kurye Yolda": ON_ROUTE_STATUS,
  "Teslim Edildi": DELIVERED_STATUS,
  "Teslim Edilemedi": FAILED_STATUS,
  "Iptal Edildi": CANCELED_STATUS,
  waiting: AWAITING_ASSIGNMENT_STATUS,
  pending: PENDING_STATUS,
  awaiting_assignment: AWAITING_ASSIGNMENT_STATUS,
  assigned: ASSIGNED_STATUS,
  accepted_by_courier: ACCEPTED_BY_COURIER_STATUS,
  picked_up: ON_ROUTE_STATUS,
  on_route: ON_ROUTE_STATUS,
  delivered: DELIVERED_STATUS,
  failed: FAILED_STATUS,
  cancelled: CANCELED_STATUS,
};

const STATIC_FILES = {
  "/": "index.html",
  "/index.html": "index.html",
  "/styles.css": "styles.css",
  "/manifest.webmanifest": "manifest.webmanifest",
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
const liveStreams = new Map();
let assignmentSweepRunning = false;
let assignmentSweepQueued = false;
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
    status TEXT NOT NULL DEFAULT 'offline',
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
    source TEXT NOT NULL DEFAULT 'restaurant_panel',
    delivery_address TEXT,
    package_type TEXT,
    source_platform TEXT NOT NULL,
    external_order_no TEXT NOT NULL,
    external_order_id TEXT,
    recipient TEXT NOT NULL,
    phone TEXT NOT NULL,
    address TEXT NOT NULL,
    zone TEXT NOT NULL,
    eta TEXT NOT NULL,
    payment_method TEXT NOT NULL,
    order_amount REAL NOT NULL DEFAULT 0,
    payment_status TEXT NOT NULL DEFAULT 'unpaid',
    x REAL NOT NULL,
    y REAL NOT NULL,
    note TEXT NOT NULL,
    status TEXT NOT NULL,
    assignment_status TEXT,
    assigned_courier_id TEXT,
    assigned_courier_name TEXT,
    assigned_at TEXT,
    accepted_at TEXT,
    on_route_at TEXT,
    delivered_at TEXT,
    failed_at TEXT,
    distance_km REAL,
    assignment_reason TEXT NOT NULL,
    failure_reason TEXT,
    last_assignment_attempt_at TEXT,
    last_assignment_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
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

  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id TEXT PRIMARY KEY,
    actor_role TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    ip_address TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id TEXT PRIMARY KEY,
    actor_role TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    requested_ip TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
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
    verification_status TEXT NOT NULL DEFAULT 'pending',
    verification_note TEXT,
    last_verification_at TEXT,
    verified_at TEXT,
    last_validation_mode TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
  );

  CREATE TABLE IF NOT EXISTS courier_daily_reports (
    id TEXT PRIMARY KEY,
    courier_id TEXT NOT NULL,
    courier_name TEXT NOT NULL,
    zone TEXT NOT NULL,
    report_date TEXT NOT NULL,
    delivered_count INTEGER NOT NULL DEFAULT 0,
    total_amount REAL NOT NULL DEFAULT 0,
    paid_online_amount REAL NOT NULL DEFAULT 0,
    cash_collected_amount REAL NOT NULL DEFAULT 0,
    package_ids_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS courier_shifts (
    id TEXT PRIMARY KEY,
    courier_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (courier_id) REFERENCES couriers(id)
  );
`);

const courierColumns = db.prepare("PRAGMA table_info(couriers)").all().map((row) => row.name);
if (!courierColumns.includes("last_location_at")) {
  db.exec("ALTER TABLE couriers ADD COLUMN last_location_at TEXT");
}
if (!courierColumns.includes("status")) {
  db.exec(`ALTER TABLE couriers ADD COLUMN status TEXT NOT NULL DEFAULT '${COURIER_OFFLINE_STATUS}'`);
}

const packageColumns = db.prepare("PRAGMA table_info(packages)").all().map((row) => row.name);
if (!packageColumns.includes("delivery_address")) {
  db.exec("ALTER TABLE packages ADD COLUMN delivery_address TEXT");
}
if (!packageColumns.includes("package_type")) {
  db.exec("ALTER TABLE packages ADD COLUMN package_type TEXT");
}
if (!packageColumns.includes("source")) {
  db.exec("ALTER TABLE packages ADD COLUMN source TEXT NOT NULL DEFAULT 'restaurant_panel'");
}
if (!packageColumns.includes("external_order_id")) {
  db.exec("ALTER TABLE packages ADD COLUMN external_order_id TEXT");
}
if (!packageColumns.includes("payment_status")) {
  db.exec(`ALTER TABLE packages ADD COLUMN payment_status TEXT NOT NULL DEFAULT '${UNPAID_PAYMENT_STATUS}'`);
}
if (!packageColumns.includes("order_amount")) {
  db.exec("ALTER TABLE packages ADD COLUMN order_amount REAL NOT NULL DEFAULT 0");
}
if (!packageColumns.includes("assignment_status")) {
  db.exec("ALTER TABLE packages ADD COLUMN assignment_status TEXT");
}
if (!packageColumns.includes("assigned_at")) {
  db.exec("ALTER TABLE packages ADD COLUMN assigned_at TEXT");
}
if (!packageColumns.includes("accepted_at")) {
  db.exec("ALTER TABLE packages ADD COLUMN accepted_at TEXT");
}
if (!packageColumns.includes("on_route_at")) {
  db.exec("ALTER TABLE packages ADD COLUMN on_route_at TEXT");
}
if (!packageColumns.includes("delivered_at")) {
  db.exec("ALTER TABLE packages ADD COLUMN delivered_at TEXT");
}
if (!packageColumns.includes("failed_at")) {
  db.exec("ALTER TABLE packages ADD COLUMN failed_at TEXT");
}
if (!packageColumns.includes("failure_reason")) {
  db.exec("ALTER TABLE packages ADD COLUMN failure_reason TEXT");
}
if (!packageColumns.includes("last_assignment_attempt_at")) {
  db.exec("ALTER TABLE packages ADD COLUMN last_assignment_attempt_at TEXT");
}
if (!packageColumns.includes("last_assignment_error")) {
  db.exec("ALTER TABLE packages ADD COLUMN last_assignment_error TEXT");
}
if (!packageColumns.includes("updated_at")) {
  db.exec("ALTER TABLE packages ADD COLUMN updated_at TEXT");
}

db.prepare(`
  UPDATE packages
  SET source = 'external_manual',
      source_platform = CASE
        WHEN TRIM(COALESCE(source_platform, '')) = '' THEN 'Dis Manuel Paket'
        ELSE source_platform
      END
  WHERE source = 'restaurant_panel'
`).run();

const courierReportColumns = db.prepare("PRAGMA table_info(courier_daily_reports)").all().map((column) => column.name);
if (courierReportColumns.length === 0) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS courier_daily_reports (
      id TEXT PRIMARY KEY,
      courier_id TEXT NOT NULL,
      courier_name TEXT NOT NULL,
      zone TEXT NOT NULL,
      report_date TEXT NOT NULL,
      delivered_count INTEGER NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL DEFAULT 0,
      paid_online_amount REAL NOT NULL DEFAULT 0,
      cash_collected_amount REAL NOT NULL DEFAULT 0,
      package_ids_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

const courierShiftColumns = db.prepare("PRAGMA table_info(courier_shifts)").all().map((column) => column.name);
if (courierShiftColumns.length === 0) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS courier_shifts (
      id TEXT PRIMARY KEY,
      courier_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (courier_id) REFERENCES couriers(id)
    )
  `);
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

const platformAccountColumns = db.prepare("PRAGMA table_info(platform_accounts)").all().map((row) => row.name);
if (!platformAccountColumns.includes("verification_status")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'pending'");
}
if (!platformAccountColumns.includes("verification_note")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN verification_note TEXT");
}
if (!platformAccountColumns.includes("last_verification_at")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN last_verification_at TEXT");
}
if (!platformAccountColumns.includes("verified_at")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN verified_at TEXT");
}
if (!platformAccountColumns.includes("last_validation_mode")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN last_validation_mode TEXT");
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

  const orderAmount = Number(payload.orderAmount);
  if (Number.isNaN(orderAmount) || orderAmount <= 0) {
    errors.push("Paket tutari 0'dan buyuk olmali.");
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

function normalizeMoney(value, fallback = 0) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  const normalized = Number(String(value).replace(",", "."));
  if (Number.isNaN(normalized) || normalized < 0) {
    return fallback;
  }

  return Number(normalized.toFixed(2));
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
  const paymentMethod = trimmed(body.paymentMethod);
  const createdAt = nowIso();
  const pkg = {
    id: uid("pkg"),
    trackingNo: `PKT-${Math.floor(1000 + Math.random() * 9000)}`,
    restaurantId: restaurant.id,
    source: trimmed(body.source) || "platform_webhook",
    sourcePlatform: trimmed(body.sourcePlatform),
    externalOrderNo: trimmed(body.externalOrderNo),
    externalOrderId: trimmed(body.externalOrderId || body.externalOrderNo),
    recipient: trimmed(body.recipient),
    phone: trimmed(body.phone),
    address: trimmed(body.address),
    zone: trimmed(body.zone || restaurant.zone),
    eta: trimmed(body.eta),
    paymentMethod,
    orderAmount: normalizeMoney(body.orderAmount ?? body.amount ?? body.totalAmount ?? body.total_price),
    paymentStatus: normalizePaymentStatus(body.paymentStatus, paymentMethod),
    latitude: Number(body.latitude ?? body.x ?? restaurant.latitude),
    longitude: Number(body.longitude ?? body.y ?? restaurant.longitude),
    note: trimmed(body.note),
    status: trimmed(body.status) ? normalizeStatus(body.status) : AWAITING_ASSIGNMENT_STATUS,
    assignmentStatus: "pending",
    assignedCourierId: null,
    assignedCourierName: null,
    distanceKm: null,
    assignedAt: null,
    acceptedAt: null,
    onRouteAt: null,
    deliveredAt: null,
    failedAt: null,
    failureReason: "",
    lastAssignmentAttemptAt: null,
    lastAssignmentError: "",
    assignmentReason: "Atama bekleniyor.",
    createdAt,
    updatedAt: createdAt,
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
    pkg.orderAmount <= 0 ||
    Number.isNaN(pkg.latitude) ||
    Number.isNaN(pkg.longitude)
  ) {
    throw validationError("Siparis verisi eksik.");
  }

  return pkg;
}

function normalizeStatus(status) {
  return LEGACY_STATUS_MAP[String(status || "").trim()] || PENDING_STATUS;
}

function canTransitionStatus(fromStatus, toStatus) {
  const current = normalizeStatus(fromStatus);
  const next = normalizeStatus(toStatus);
  return current === next || (STATUS_TRANSITIONS[current] || []).includes(next);
}

function normalizePaymentStatus(paymentStatus, paymentMethod = "") {
  const incoming = trimmed(paymentStatus).toLowerCase();
  if ([UNPAID_PAYMENT_STATUS, PAID_ONLINE_PAYMENT_STATUS, CASH_EXPECTED_PAYMENT_STATUS, CASH_COLLECTED_PAYMENT_STATUS, PAYMENT_ISSUE_STATUS].includes(incoming)) {
    return incoming;
  }

  const loweredMethod = trimmed(paymentMethod).toLowerCase();
  if (loweredMethod.includes("nakit")) {
    return CASH_EXPECTED_PAYMENT_STATUS;
  }
  if (loweredMethod.includes("online") || loweredMethod.includes("kart") || loweredMethod.includes("pos")) {
    return PAID_ONLINE_PAYMENT_STATUS;
  }

  return UNPAID_PAYMENT_STATUS;
}

function normalizeCourierStatus(status, available = false) {
  const incoming = trimmed(status).toLowerCase();
  if ([COURIER_OFFLINE_STATUS, COURIER_ONLINE_STATUS, COURIER_BUSY_STATUS].includes(incoming)) {
    return incoming;
  }

  return available ? COURIER_ONLINE_STATUS : COURIER_OFFLINE_STATUS;
}

function normalizeCourierFailureReason(value) {
  const normalized = trimmed(value).toLowerCase().replaceAll(" ", "_");
  return COURIER_FAILURE_REASONS.has(normalized) ? normalized : "";
}

function normalizeOrderSource(source, sourcePlatform = "") {
  const incoming = trimmed(source).toLowerCase();
  if (incoming === "manual" || incoming === "external_manual" || incoming === "restaurant_panel") {
    if (incoming === "restaurant_panel") {
      return "external_manual";
    }
    return incoming;
  }

  if (trimmed(sourcePlatform).toLowerCase() === "restaurant panel") {
    return "external_manual";
  }

  if (incoming === "platform_webhook" || incoming === "platform_api") {
    return incoming;
  }

  return incoming || "platform_api";
}

function isActivePackageStatus(status) {
  return [ASSIGNED_STATUS, ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS].includes(normalizeStatus(status));
}

function assignmentStatusForOrder(status) {
  const normalized = normalizeStatus(status);
  if (normalized === ASSIGNED_STATUS || normalized === ACCEPTED_BY_COURIER_STATUS || normalized === ON_ROUTE_STATUS || normalized === DELIVERED_STATUS) {
    return "assigned";
  }
  if (normalized === FAILED_STATUS) {
    return "failed";
  }
  if (normalized === CANCELED_STATUS) {
    return "cancelled";
  }
  return "pending";
}

function nowIso() {
  return new Date().toISOString();
}

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket.remoteAddress || "unknown";
}

function requestProtocol(req) {
  if (TRUST_PROXY) {
    const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    if (forwardedProto) {
      return forwardedProto;
    }
  }

  return req?.socket?.encrypted ? "https" : "http";
}

function isSecureRequest(req) {
  return requestProtocol(req) === "https";
}

function requestBaseUrl(req) {
  if (PUBLIC_BASE_URL) {
    return PUBLIC_BASE_URL;
  }

  const host = req?.headers?.host || `localhost:${PORT}`;
  return `${requestProtocol(req)}://${host}`;
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
  if (FORCE_HTTPS || NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
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

function createRefreshToken() {
  return `rfs_${crypto.randomBytes(24).toString("hex")}`;
}

function createPasswordResetToken() {
  return `rst_${crypto.randomBytes(24).toString("hex")}`;
}

function hashOpaqueToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
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
    verificationStatus: account.verificationStatus,
    verificationNote: account.verificationNote,
    lastVerificationAt: account.lastVerificationAt,
    verifiedAt: account.verifiedAt,
    lastValidationMode: account.lastValidationMode,
  };
}

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    return "";
  }

  return header.slice(7).trim();
}

function isSessionExpired(createdAt, maxAgeMs) {
  const createdMs = new Date(createdAt).getTime();
  if (Number.isNaN(createdMs)) {
    return true;
  }

  return Date.now() - createdMs > maxAgeMs;
}

function getSessionByToken(tableName, tokenColumn, token, maxAgeMs) {
  if (!token) {
    return null;
  }

  const session = db.prepare(`SELECT * FROM ${tableName} WHERE ${tokenColumn} = ?`).get(token) || null;
  if (!session) {
    return null;
  }

  if (isSessionExpired(session.created_at, maxAgeMs)) {
    db.prepare(`DELETE FROM ${tableName} WHERE ${tokenColumn} = ?`).run(token);
    return null;
  }

  return session;
}

function getAdminSession(req) {
  return getSessionByToken("admin_sessions", "token", getBearerToken(req), ADMIN_SESSION_MAX_AGE_MS);
}

function getSessionFromQueryToken(req, role) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const token = trimmed(requestUrl.searchParams.get("token"));
  if (!token) {
    return null;
  }
  const config = sessionConfigByRole(role);
  return getSessionByToken(config.tableName, "token", token, config.maxAgeMs);
}

function adminActorId(session) {
  return session?.admin_id || null;
}

function sessionConfigByRole(actorRole) {
  if (actorRole === "admin") {
    return { tableName: "admin_sessions", actorColumn: "admin_id", maxAgeMs: ADMIN_SESSION_MAX_AGE_MS };
  }
  if (actorRole === "restaurant") {
    return { tableName: "restaurant_sessions", actorColumn: "restaurant_id", maxAgeMs: RESTAURANT_SESSION_MAX_AGE_MS };
  }
  if (actorRole === "courier") {
    return { tableName: "courier_sessions", actorColumn: "courier_id", maxAgeMs: COURIER_SESSION_MAX_AGE_MS };
  }

  throw httpError(400, "Desteklenmeyen oturum rolu.");
}

function revokeRefreshTokens(actorRole, actorId) {
  db.prepare("DELETE FROM refresh_tokens WHERE actor_role = ? AND actor_id = ?").run(actorRole, actorId);
}

function persistRefreshToken(actorRole, actorId, refreshToken, req) {
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + REFRESH_TOKEN_MAX_AGE_MS);
  db.prepare(`
    INSERT INTO refresh_tokens (id, actor_role, actor_id, token_hash, ip_address, user_agent, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    uid("rft"),
    actorRole,
    actorId,
    hashOpaqueToken(refreshToken),
    clientIp(req),
    String(req.headers["user-agent"] || "").slice(0, 240),
    createdAt.toISOString(),
    expiresAt.toISOString()
  );

  return expiresAt.toISOString();
}

function issueSessionPair(actorRole, actorId, req) {
  const sessionConfig = sessionConfigByRole(actorRole);
  const token = createSessionToken();
  const refreshToken = createRefreshToken();
  const now = new Date().toISOString();

  db.prepare(`DELETE FROM ${sessionConfig.tableName} WHERE ${sessionConfig.actorColumn} = ?`).run(actorId);
  revokeRefreshTokens(actorRole, actorId);
  db.prepare(`INSERT INTO ${sessionConfig.tableName} (token, ${sessionConfig.actorColumn}, created_at) VALUES (?, ?, ?)`).run(
    token,
    actorId,
    now
  );
  const refreshExpiresAt = persistRefreshToken(actorRole, actorId, refreshToken, req);

  return {
    token,
    refreshToken,
    accessExpiresAt: new Date(Date.now() + sessionConfig.maxAgeMs).toISOString(),
    refreshExpiresAt,
  };
}

function refreshSessionPair(actorRole, providedRefreshToken, req) {
  const tokenHash = hashOpaqueToken(providedRefreshToken);
  const refreshRow = db.prepare(`
    SELECT * FROM refresh_tokens
    WHERE actor_role = ? AND token_hash = ?
  `).get(actorRole, tokenHash);

  if (!refreshRow) {
    throw httpError(401, "Refresh token gecersiz.");
  }

  const expiresAtMs = new Date(refreshRow.expires_at).getTime();
  if (Number.isNaN(expiresAtMs) || expiresAtMs <= Date.now()) {
    db.prepare("DELETE FROM refresh_tokens WHERE id = ?").run(refreshRow.id);
    throw httpError(401, "Refresh token suresi dolmus.");
  }

  db.prepare("DELETE FROM refresh_tokens WHERE id = ?").run(refreshRow.id);
  return issueSessionPair(actorRole, refreshRow.actor_id, req);
}

function revokeAccessToken(tableName, token) {
  if (!token) {
    return;
  }

  db.prepare(`DELETE FROM ${tableName} WHERE token = ?`).run(token);
}

function validateRefreshDraft(body) {
  const refreshToken = trimmed(body.refreshToken || body.refresh_token);
  if (!refreshToken) {
    throw validationError("refreshToken zorunludur.");
  }

  return { refreshToken };
}

function validatePasswordResetRequestDraft(body) {
  const username = trimmed(body.username).toLowerCase();
  if (!username) {
    throw validationError("Kullanici adi zorunludur.");
  }

  return { username };
}

function validatePasswordResetDraft(body) {
  const token = trimmed(body.token);
  const password = String(body.password || "");
  if (!token || !password) {
    throw validationError("Reset token ve yeni sifre zorunludur.");
  }
  if (password.length < 8) {
    throw validationError("Yeni sifre en az 8 karakter olmali.");
  }

  return { token, password };
}

function actorLookupByRole(actorRole, username) {
  if (actorRole === "admin") {
    return db.prepare("SELECT * FROM admins WHERE username = ?").get(username) || null;
  }
  if (actorRole === "restaurant") {
    return db.prepare("SELECT * FROM restaurants WHERE username = ?").get(username) || null;
  }
  if (actorRole === "courier") {
    return db.prepare("SELECT * FROM couriers WHERE username = ?").get(username) || null;
  }

  return null;
}

function updateActorPassword(actorRole, actorId, password) {
  const passwordInfo = hashPassword(password);
  if (actorRole === "admin") {
    db.prepare("UPDATE admins SET password_hash = ?, password_salt = ? WHERE id = ?").run(passwordInfo.hash, passwordInfo.salt, actorId);
  } else if (actorRole === "restaurant") {
    db.prepare("UPDATE restaurants SET password_hash = ?, password_salt = ? WHERE id = ?").run(passwordInfo.hash, passwordInfo.salt, actorId);
  } else if (actorRole === "courier") {
    db.prepare("UPDATE couriers SET password_hash = ?, password_salt = ? WHERE id = ?").run(passwordInfo.hash, passwordInfo.salt, actorId);
  } else {
    throw httpError(400, "Desteklenmeyen kullanici rolu.");
  }

  revokeRefreshTokens(actorRole, actorId);
  const sessionConfig = sessionConfigByRole(actorRole);
  db.prepare(`DELETE FROM ${sessionConfig.tableName} WHERE ${sessionConfig.actorColumn} = ?`).run(actorId);
}

function issuePasswordReset(actorRole, actorId, req) {
  const token = createPasswordResetToken();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + PASSWORD_RESET_MAX_AGE_MS);
  db.prepare(`
    INSERT INTO password_reset_tokens (id, actor_role, actor_id, token_hash, requested_ip, created_at, expires_at, used_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    uid("prt"),
    actorRole,
    actorId,
    hashOpaqueToken(token),
    clientIp(req),
    createdAt.toISOString(),
    expiresAt.toISOString()
  );

  return token;
}

function consumePasswordReset(actorRole, token) {
  const tokenHash = hashOpaqueToken(token);
  const row = db.prepare(`
    SELECT * FROM password_reset_tokens
    WHERE actor_role = ? AND token_hash = ? AND used_at IS NULL
  `).get(actorRole, tokenHash);

  if (!row) {
    throw httpError(400, "Reset token gecersiz.");
  }

  const expiresAtMs = new Date(row.expires_at).getTime();
  if (Number.isNaN(expiresAtMs) || expiresAtMs <= Date.now()) {
    db.prepare("DELETE FROM password_reset_tokens WHERE id = ?").run(row.id);
    throw httpError(400, "Reset token suresi dolmus.");
  }

  db.prepare("UPDATE password_reset_tokens SET used_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
  return row;
}

function logPasswordReset(actorRole, username, token) {
  const line = `[${new Date().toISOString()}] role=${actorRole} username=${username} token=${token}\n`;
  fs.appendFileSync(PASSWORD_RESET_LOG_FILE, line, "utf8");
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
    verificationStatus: row.verification_status || PLATFORM_VERIFICATION_STATUS.PENDING,
    verificationNote: row.verification_note || "",
    lastVerificationAt: row.last_verification_at,
    verifiedAt: row.verified_at,
    lastValidationMode: row.last_validation_mode,
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

function createLiveStream(audience) {
  const id = uid("stream");
  const stream = {
    id,
    audience,
    res: null,
    heartbeatId: null,
  };
  liveStreams.set(id, stream);
  return stream;
}

function closeLiveStream(streamId) {
  const stream = liveStreams.get(streamId);
  if (!stream) {
    return;
  }
  if (stream.heartbeatId) {
    clearInterval(stream.heartbeatId);
  }
  liveStreams.delete(streamId);
}

function streamMatchesAudience(stream, event) {
  if (stream.audience.role === "admin") {
    return true;
  }
  if (stream.audience.role === "restaurant") {
    return !event.restaurantId || event.restaurantId === stream.audience.restaurantId;
  }
  if (stream.audience.role === "courier") {
    return !event.courierId || event.courierId === stream.audience.courierId;
  }
  return false;
}

function broadcastLiveEvent(event) {
  const payload = `event: ${event.type || "workspace-update"}\ndata: ${JSON.stringify({
    type: event.type || "workspace-update",
    restaurantId: event.restaurantId || null,
    courierId: event.courierId || null,
    message: event.message || "",
    createdAt: nowIso(),
  })}\n\n`;

  liveStreams.forEach((stream) => {
    if (!stream.res || !streamMatchesAudience(stream, event)) {
      return;
    }
    try {
      stream.res.write(payload);
    } catch {
      closeLiveStream(stream.id);
    }
  });
}

function openLiveStream(req, res, audience) {
  const stream = createLiveStream(audience);
  writeSecurityHeaders(res);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  stream.res = res;
  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true, createdAt: nowIso() })}\n\n`);
  stream.heartbeatId = setInterval(() => {
    try {
      res.write(`event: ping\ndata: ${JSON.stringify({ createdAt: nowIso() })}\n\n`);
    } catch {
      closeLiveStream(stream.id);
    }
  }, LIVE_STREAM_HEARTBEAT_MS);
  req.on("close", () => closeLiveStream(stream.id));
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
    status: normalizeCourierStatus(row.status, Boolean(row.available)),
    lastLocationAt: row.last_location_at,
    username: row.username,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    createdAt: row.created_at,
  }));
}

function getCourierById(courierId) {
  const row = db.prepare("SELECT * FROM couriers WHERE id = ?").get(courierId);
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    zone: row.zone,
    latitude: row.x,
    longitude: row.y,
    available: Boolean(row.available),
    status: normalizeCourierStatus(row.status, Boolean(row.available)),
    lastLocationAt: row.last_location_at,
    username: row.username,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    createdAt: row.created_at,
  };
}

function getPackages(filter = {}) {
  const rows = filter.restaurantId
    ? db.prepare("SELECT * FROM packages WHERE restaurant_id = ? ORDER BY datetime(created_at) DESC").all(filter.restaurantId)
    : db.prepare("SELECT * FROM packages ORDER BY datetime(created_at) DESC").all();

  return rows.map((row) => ({
    id: row.id,
    trackingNo: row.tracking_no,
    restaurantId: row.restaurant_id,
    source: normalizeOrderSource(row.source, row.source_platform),
    deliveryAddress: row.delivery_address || row.address,
    packageType: row.package_type || "Standart Paket",
    sourcePlatform: row.source_platform,
    externalOrderNo: row.external_order_no,
    externalOrderId: row.external_order_id || row.external_order_no,
    recipient: row.recipient,
    phone: row.phone,
    address: row.address,
    zone: row.zone,
    eta: row.eta,
    paymentMethod: row.payment_method,
    orderAmount: Number(row.order_amount || 0),
    paymentStatus: normalizePaymentStatus(row.payment_status, row.payment_method),
    latitude: row.x,
    longitude: row.y,
    note: row.note,
    status: normalizeStatus(row.status),
    assignmentStatus: row.assignment_status || assignmentStatusForOrder(row.status),
    assignedCourierId: row.assigned_courier_id,
    assignedCourierName: row.assigned_courier_name,
    assignedAt: row.assigned_at,
    acceptedAt: row.accepted_at,
    onRouteAt: row.on_route_at,
    deliveredAt: row.delivered_at,
    failedAt: row.failed_at,
    distanceKm: row.distance_km,
    assignmentReason: row.assignment_reason,
    failureReason: row.failure_reason || "",
    lastAssignmentAttemptAt: row.last_assignment_attempt_at,
    lastAssignmentError: row.last_assignment_error || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
  }));
}

function mapPackageRow(row, restaurantMap = new Map()) {
  return {
    id: row.id,
    trackingNo: row.tracking_no,
    restaurantId: row.restaurant_id,
    source: normalizeOrderSource(row.source, row.source_platform),
    deliveryAddress: row.delivery_address || row.address,
    packageType: row.package_type || "Standart Paket",
    sourcePlatform: row.source_platform,
    externalOrderNo: row.external_order_no,
    externalOrderId: row.external_order_id || row.external_order_no,
    recipient: row.recipient,
    phone: row.phone,
    address: row.address,
    zone: row.zone,
    eta: row.eta,
    paymentMethod: row.payment_method,
    orderAmount: Number(row.order_amount || 0),
    paymentStatus: normalizePaymentStatus(row.payment_status, row.payment_method),
    latitude: row.x,
    longitude: row.y,
    note: row.note,
    status: normalizeStatus(row.status),
    assignmentStatus: row.assignment_status || assignmentStatusForOrder(row.status),
    assignedCourierId: row.assigned_courier_id,
    assignedCourierName: row.assigned_courier_name,
    assignedAt: row.assigned_at,
    acceptedAt: row.accepted_at,
    onRouteAt: row.on_route_at,
    deliveredAt: row.delivered_at,
    failedAt: row.failed_at,
    distanceKm: row.distance_km,
    assignmentReason: row.assignment_reason,
    failureReason: row.failure_reason || "",
    lastAssignmentAttemptAt: row.last_assignment_attempt_at,
    lastAssignmentError: row.last_assignment_error || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    restaurantName: restaurantMap.get(row.restaurant_id) || "Bilinmeyen Restoran",
  };
}

function getCourierPackages(courierId) {
  const rows = db.prepare("SELECT * FROM packages WHERE assigned_courier_id = ? ORDER BY datetime(created_at) DESC").all(courierId);
  const restaurantIds = [...new Set(rows.map((row) => row.restaurant_id))];
  const restaurantMap = new Map(
    restaurantIds.map((restaurantId) => {
      const restaurant = db.prepare("SELECT name FROM restaurants WHERE id = ?").get(restaurantId);
      return [restaurantId, restaurant?.name || "Bilinmeyen Restoran"];
    })
  );

  return rows.map((row) => mapPackageRow(row, restaurantMap));
}

function rangeStart(daysBack = 0) {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack).toISOString();
}

function rangeEnd(daysForward = 0) {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysForward + 1).toISOString();
}

function isWithinRange(value, start, end) {
  if (!value) {
    return false;
  }
  const stamp = new Date(value).getTime();
  return !Number.isNaN(stamp) && stamp >= new Date(start).getTime() && stamp < new Date(end).getTime();
}

function diffMinutes(startValue, endValue) {
  if (!startValue || !endValue) {
    return null;
  }
  const diff = new Date(endValue).getTime() - new Date(startValue).getTime();
  if (Number.isNaN(diff) || diff < 0) {
    return null;
  }
  return diff / 60000;
}

function averageOf(values) {
  const valid = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (valid.length === 0) {
    return 0;
  }
  return Number((valid.reduce((sum, value) => sum + value, 0) / valid.length).toFixed(1));
}

function getCourierShifts(courierId, limit = 20) {
  return db.prepare(`
    SELECT * FROM courier_shifts
    WHERE courier_id = ?
    ORDER BY datetime(started_at) DESC
    LIMIT ?
  `).all(courierId, limit).map((row) => ({
    id: row.id,
    courierId: row.courier_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function getOpenCourierShift(courierId) {
  const row = db.prepare(`
    SELECT * FROM courier_shifts
    WHERE courier_id = ? AND ended_at IS NULL
    ORDER BY datetime(started_at) DESC
    LIMIT 1
  `).get(courierId);

  return row ? {
    id: row.id,
    courierId: row.courier_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } : null;
}

function ensureCourierShiftOpen(courierId, startedAt = nowIso()) {
  if (!courierId || getOpenCourierShift(courierId)) {
    return;
  }

  db.prepare(`
    INSERT INTO courier_shifts (id, courier_id, started_at, ended_at, created_at, updated_at)
    VALUES (?, ?, ?, NULL, ?, ?)
  `).run(uid("shift"), courierId, startedAt, startedAt, startedAt);
}

function closeCourierShift(courierId, endedAt = nowIso()) {
  const openShift = getOpenCourierShift(courierId);
  if (!openShift) {
    return;
  }

  db.prepare(`
    UPDATE courier_shifts
    SET ended_at = ?, updated_at = ?
    WHERE id = ?
  `).run(endedAt, endedAt, openShift.id);
}

function summarizeCourierPackagesForRange(packages, start, end) {
  return packages
    .filter((pkg) => pkg.status === DELIVERED_STATUS)
    .filter((pkg) => isWithinRange(pkg.deliveredAt || pkg.updatedAt || pkg.createdAt, start, end))
    .reduce((summary, pkg) => {
      const amount = normalizeMoney(pkg.orderAmount);
      summary.deliveredCount += 1;
      summary.totalAmount += amount;
      if (pkg.paymentStatus === PAID_ONLINE_PAYMENT_STATUS) {
        summary.paidOnlineAmount += amount;
      }
      if ([CASH_EXPECTED_PAYMENT_STATUS, CASH_COLLECTED_PAYMENT_STATUS].includes(pkg.paymentStatus)) {
        summary.cashAmount += amount;
      }
      return summary;
    }, {
      deliveredCount: 0,
      totalAmount: 0,
      paidOnlineAmount: 0,
      cashAmount: 0,
    });
}

function buildCourierEarningsSummary(packages) {
  const todayStart = rangeStart(0);
  const yesterdayStart = rangeStart(1);
  const sevenDaysStart = rangeStart(6);
  const tomorrowStart = rangeEnd(0);
  return {
    today: summarizeCourierPackagesForRange(packages, todayStart, tomorrowStart),
    yesterday: summarizeCourierPackagesForRange(packages, yesterdayStart, todayStart),
    last7Days: summarizeCourierPackagesForRange(packages, sevenDaysStart, tomorrowStart),
    total: summarizeCourierPackagesForRange(packages, "1970-01-01T00:00:00.000Z", "2999-12-31T23:59:59.999Z"),
  };
}

function buildCourierShiftSummary(courierId) {
  const shifts = getCourierShifts(courierId, 12);
  return {
    currentShift: shifts.find((shift) => !shift.endedAt) || null,
    recentShifts: shifts,
  };
}

function buildRestaurantPerformance(packages) {
  const todayStart = rangeStart(0);
  const tomorrowStart = rangeEnd(0);
  const todayPackages = packages.filter((pkg) => isWithinRange(pkg.createdAt, todayStart, tomorrowStart));
  const deliveredToday = packages.filter((pkg) => pkg.status === DELIVERED_STATUS && isWithinRange(pkg.deliveredAt || pkg.updatedAt, todayStart, tomorrowStart));
  const failedToday = packages.filter((pkg) => pkg.status === FAILED_STATUS && isWithinRange(pkg.failedAt || pkg.updatedAt, todayStart, tomorrowStart));

  return {
    todayOrderCount: todayPackages.length,
    deliveredTodayCount: deliveredToday.length,
    averageAssignmentMinutes: averageOf(todayPackages.map((pkg) => diffMinutes(pkg.createdAt, pkg.assignedAt))),
    averageDeliveryMinutes: averageOf(deliveredToday.map((pkg) => diffMinutes(pkg.createdAt, pkg.deliveredAt || pkg.updatedAt))),
    failedDeliveryRate: todayPackages.length > 0 ? Number(((failedToday.length / todayPackages.length) * 100).toFixed(1)) : 0,
  };
}

function buildZoneAlerts(zones, packages) {
  return zones.map((zone) => {
    const waiting = packages
      .filter((pkg) => pkg.zone === zone.name && [PENDING_STATUS, AWAITING_ASSIGNMENT_STATUS].includes(pkg.status))
      .sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt));
    const oldestWaitingMinutes = waiting[0]
      ? Math.max(0, Math.round((Date.now() - new Date(waiting[0].createdAt).getTime()) / 60000))
      : 0;
    const severity = waiting.length >= 4 || oldestWaitingMinutes >= 15
      ? "critical"
      : waiting.length >= 2 || oldestWaitingMinutes >= 8
        ? "warning"
        : "stable";
    return {
      zone: zone.name,
      waitingCount: waiting.length,
      oldestWaitingMinutes,
      severity,
      message: severity === "critical"
        ? `${zone.name} bolgesinde yogunluk kritik seviyede.`
        : severity === "warning"
          ? `${zone.name} bolgesinde yogunluk artiyor.`
          : `${zone.name} bolgesi dengeli calisiyor.`,
    };
  }).filter((alert) => alert.severity !== "stable");
}

function buildRestaurantIntegrationWizard(req, restaurant, accounts) {
  const current = accounts[0] || null;
  return {
    currentAccountId: current?.id || "",
    currentPlatform: current?.platform || "",
    verificationStatus: current?.verificationStatus || PLATFORM_VERIFICATION_STATUS.PENDING,
    webhookUrl: current
      ? `${requestBaseUrl(req)}/api/platforms/${current.platformSlug}/webhook`
      : "Platform hesabini kaydedince webhook URL hazir olur.",
    steps: [
      { id: "select_platform", title: "Adim 1", label: "Platform sec", done: Boolean(current?.platform) },
      { id: "credentials", title: "Adim 2", label: "Gerekli bilgileri gir", done: Boolean(current?.externalStoreId) },
      { id: "copy_webhook", title: "Adim 3", label: "Webhook kopyala", done: Boolean(current?.id) },
      { id: "test", title: "Adim 4", label: "Baglantiyi test et", done: current?.verificationStatus === PLATFORM_VERIFICATION_STATUS.VERIFIED },
      { id: "success", title: "Adim 5", label: "Baglanti basarili", done: current?.verificationStatus === PLATFORM_VERIFICATION_STATUS.VERIFIED },
    ],
    helpText: restaurant
      ? `${restaurant.name} icin platform sec, kimlik bilgilerini kaydet, webhook adresini platform paneline gir ve test et.`
      : "Restoran oturumu acildiginda entegrasyon sihirbazi aktif olur.",
  };
}

function buildCourierWorkspace(courierId) {
  const courier = getCourierById(courierId);
  if (!courier) {
    return null;
  }

  const packages = getCourierPackages(courierId);
  const todayPackages = deliveredPackagesForCourierOnDate(courierId, dayKey());
  const daySummary = summarizeCourierDay(todayPackages);
  const dayReport = db.prepare("SELECT * FROM courier_daily_reports WHERE courier_id = ? AND report_date = ?").get(courierId, dayKey());
  return {
    courier: {
      ...sanitizeCourier(courier),
      activeLoad: packages.filter((item) => isActivePackageStatus(item.status)).length,
    },
    packages,
    dayMetrics: {
      reportDate: dayKey(),
      deliveredCount: daySummary.deliveredCount,
      totalAmount: Number(daySummary.totalAmount.toFixed(2)),
      paidOnlineAmount: Number(daySummary.paidOnlineAmount.toFixed(2)),
      cashCollectedAmount: Number(daySummary.cashCollectedAmount.toFixed(2)),
      hasClosedDay: Boolean(dayReport),
      closedAt: dayReport?.updated_at || null,
    },
    earningsSummary: buildCourierEarningsSummary(packages),
    shiftSummary: buildCourierShiftSummary(courierId),
  };
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

function dayKey(value = nowIso()) {
  return String(value).slice(0, 10);
}

function deliveredPackagesForCourierOnDate(courierId, reportDate = dayKey()) {
  const rows = db.prepare(`
    SELECT * FROM packages
    WHERE assigned_courier_id = ?
      AND status = ?
      AND substr(COALESCE(delivered_at, updated_at, created_at), 1, 10) = ?
    ORDER BY datetime(COALESCE(delivered_at, updated_at, created_at)) DESC
  `).all(courierId, DELIVERED_STATUS, reportDate);
  const restaurantIds = [...new Set(rows.map((row) => row.restaurant_id))];
  const restaurantMap = new Map(
    restaurantIds.map((restaurantId) => {
      const restaurant = db.prepare("SELECT name FROM restaurants WHERE id = ?").get(restaurantId);
      return [restaurantId, restaurant?.name || "Bilinmeyen Restoran"];
    })
  );
  return rows.map((row) => mapPackageRow(row, restaurantMap));
}

function summarizeCourierDay(packages) {
  return packages.reduce((summary, pkg) => {
    const amount = normalizeMoney(pkg.orderAmount);
    summary.deliveredCount += 1;
    summary.totalAmount += amount;
    if (pkg.paymentStatus === PAID_ONLINE_PAYMENT_STATUS) {
      summary.paidOnlineAmount += amount;
    }
    if (pkg.paymentStatus === CASH_COLLECTED_PAYMENT_STATUS || pkg.paymentStatus === CASH_EXPECTED_PAYMENT_STATUS) {
      summary.cashCollectedAmount += amount;
    }
    summary.packageIds.push(pkg.id);
    return summary;
  }, {
    deliveredCount: 0,
    totalAmount: 0,
    paidOnlineAmount: 0,
    cashCollectedAmount: 0,
    packageIds: [],
  });
}

function getCourierDailyReports(limit = 50) {
  return db.prepare("SELECT * FROM courier_daily_reports ORDER BY datetime(updated_at) DESC LIMIT ?").all(limit).map((row) => ({
    id: row.id,
    courierId: row.courier_id,
    courierName: row.courier_name,
    zone: row.zone,
    reportDate: row.report_date,
    deliveredCount: Number(row.delivered_count || 0),
    totalAmount: Number(row.total_amount || 0),
    paidOnlineAmount: Number(row.paid_online_amount || 0),
    cashCollectedAmount: Number(row.cash_collected_amount || 0),
    packageIds: parseJson(row.package_ids_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function upsertCourierDailyReport(courierId, reportDate = dayKey()) {
  const courier = getCourierById(courierId);
  if (!courier) {
    throw httpError(404, "Kurye bulunamadi.");
  }

  const packages = deliveredPackagesForCourierOnDate(courierId, reportDate);
  const summary = summarizeCourierDay(packages);
  const existing = db.prepare("SELECT * FROM courier_daily_reports WHERE courier_id = ? AND report_date = ?").get(courierId, reportDate);
  const stamp = nowIso();

  if (existing) {
    db.prepare(`
      UPDATE courier_daily_reports
      SET courier_name = ?, zone = ?, delivered_count = ?, total_amount = ?, paid_online_amount = ?, cash_collected_amount = ?,
          package_ids_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      courier.name,
      courier.zone,
      summary.deliveredCount,
      Number(summary.totalAmount.toFixed(2)),
      Number(summary.paidOnlineAmount.toFixed(2)),
      Number(summary.cashCollectedAmount.toFixed(2)),
      json(summary.packageIds),
      stamp,
      existing.id
    );
  } else {
    db.prepare(`
      INSERT INTO courier_daily_reports (
        id, courier_id, courier_name, zone, report_date, delivered_count, total_amount, paid_online_amount,
        cash_collected_amount, package_ids_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uid("cdr"),
      courierId,
      courier.name,
      courier.zone,
      reportDate,
      summary.deliveredCount,
      Number(summary.totalAmount.toFixed(2)),
      Number(summary.paidOnlineAmount.toFixed(2)),
      Number(summary.cashCollectedAmount.toFixed(2)),
      json(summary.packageIds),
      stamp,
      stamp
    );
  }

  return {
    reportDate,
    ...summary,
    totalAmount: Number(summary.totalAmount.toFixed(2)),
    paidOnlineAmount: Number(summary.paidOnlineAmount.toFixed(2)),
    cashCollectedAmount: Number(summary.cashCollectedAmount.toFixed(2)),
  };
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
    isActivePackageStatus(item.status)
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

function withImmediateTransaction(work) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback errors.
    }
    throw error;
  }
}

function isAssignableOrderStatus(status) {
  return [PENDING_STATUS, AWAITING_ASSIGNMENT_STATUS, ASSIGNED_STATUS].includes(normalizeStatus(status));
}

function buildAssignmentFailure(pkg, reason, note) {
  return {
    ...pkg,
    assignedCourierId: null,
    assignedCourierName: null,
    assignedAt: null,
    distanceKm: null,
    status: AWAITING_ASSIGNMENT_STATUS,
    assignmentStatus: "pending",
    lastAssignmentAttemptAt: nowIso(),
    lastAssignmentError: reason,
    assignmentReason: note,
  };
}

function evaluateAssignmentFailure(state, pkg) {
  if (!pkg.restaurantId || !pkg.zone || Number.isNaN(Number(pkg.latitude)) || Number.isNaN(Number(pkg.longitude))) {
    return {
      reason: "veri eksik",
      note: "Siparis verisi eksik oldugu icin atama denemesi yapilamadi.",
    };
  }

  const restaurantExists = state.restaurants.some((restaurant) => restaurant.id === pkg.restaurantId);
  if (!restaurantExists) {
    return {
      reason: "tenant uyusmuyor",
      note: "Siparisin restoran kaydi bulunamadigi icin tenant dogrulamasi gecemedi.",
    };
  }

  const zoneCouriers = state.couriers.filter((courier) => courier.zone === pkg.zone);
  if (zoneCouriers.length === 0) {
    return {
      reason: "uygun kurye yok",
      note: `${pkg.zone} bolgesinde kayitli kurye bulunamadi.`,
    };
  }

  const onlineCouriers = zoneCouriers.filter((courier) => normalizeCourierStatus(courier.status, courier.available) === COURIER_ONLINE_STATUS);
  if (onlineCouriers.length === 0) {
    return {
      reason: "uygun kurye yok",
      note: `${pkg.zone} bolgesinde online kurye bulunamadi.`,
    };
  }

  const freeOnlineCouriers = onlineCouriers.filter((courier) => activeAssignmentsForCourier(state.packages, courier.id, pkg.id) < 1);
  if (freeOnlineCouriers.length === 0) {
    return {
      reason: "tum kuryeler busy",
      note: `${pkg.zone} bolgesindeki online kuryelerin hepsi aktif gorevde.`,
    };
  }

  return {
    reason: "uygun kurye yok",
    note: `${pkg.zone} bolgesinde ${MAX_ASSIGNMENT_DISTANCE_KM} km icinde uygun aktif kurye yok.`,
  };
}

function rankEligibleCouriers(state, pkg, occupiedCourierLoads = new Map()) {
  return state.couriers
    .filter((courier) => normalizeCourierStatus(courier.status, courier.available) === COURIER_ONLINE_STATUS && courier.zone === pkg.zone)
    .map((courier) => ({
      courier,
      distance: distance(courier.latitude, courier.longitude, pkg.latitude, pkg.longitude),
      load: Math.max(
        occupiedCourierLoads.get(courier.id) || 0,
        activeAssignmentsForCourier(state.packages, courier.id, pkg.id)
      ),
    }))
    .filter(({ distance: courierDistance, load }) => courierDistance <= MAX_ASSIGNMENT_DISTANCE_KM && load < 1)
    .sort((left, right) => left.distance - right.distance || left.load - right.load);
}

function assignPackage(state, pkg, occupiedCourierLoads = new Map()) {
  const packageStatus = normalizeStatus(pkg.status);
  if ([ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS, DELIVERED_STATUS, CANCELED_STATUS].includes(packageStatus)) {
    return {
      ...pkg,
      status: packageStatus,
      assignmentStatus: assignmentStatusForOrder(packageStatus),
    };
  }

  const ranked = rankEligibleCouriers(state, pkg, occupiedCourierLoads);
  if (ranked.length === 0) {
    const failure = evaluateAssignmentFailure(state, pkg);
    return buildAssignmentFailure(pkg, failure.reason, failure.note);
  }

  const assignmentAttemptAt = nowIso();
  const best = ranked[0];
  return {
    ...pkg,
    assignedCourierId: best.courier.id,
    assignedCourierName: best.courier.name,
    assignedAt: assignmentAttemptAt,
    distanceKm: Number(best.distance.toFixed(2)),
    status: ASSIGNED_STATUS,
    assignmentStatus: "assigned",
    lastAssignmentAttemptAt: assignmentAttemptAt,
    lastAssignmentError: "",
    assignmentReason: `${pkg.zone} bolgesinde ${MAX_ASSIGNMENT_DISTANCE_KM} km icinde en uygun aktif kurye secildi.`,
  };
}

function persistPackageAssignment(pkg) {
  db.prepare(`
    UPDATE packages
    SET status = ?, assignment_status = ?, assigned_courier_id = ?, assigned_courier_name = ?, assigned_at = ?,
        distance_km = ?, assignment_reason = ?, last_assignment_attempt_at = ?, last_assignment_error = ?, updated_at = ?
    WHERE id = ?
  `).run(
    pkg.status,
    pkg.assignmentStatus || assignmentStatusForOrder(pkg.status),
    pkg.assignedCourierId,
    pkg.assignedCourierName,
    pkg.assignedAt || null,
    pkg.distanceKm,
    pkg.assignmentReason,
    pkg.lastAssignmentAttemptAt || null,
    pkg.lastAssignmentError || null,
    nowIso(),
    pkg.id
  );
}

function updatePackageAssignmentFailure(packageId, reason, note) {
  db.prepare(`
    UPDATE packages
    SET status = ?, assignment_status = ?, assigned_courier_id = NULL, assigned_courier_name = NULL, assigned_at = NULL,
        distance_km = NULL, assignment_reason = ?, last_assignment_attempt_at = ?, last_assignment_error = ?, updated_at = ?
    WHERE id = ?
  `).run(
    AWAITING_ASSIGNMENT_STATUS,
    "pending",
    note,
    nowIso(),
    reason,
    nowIso(),
    packageId
  );
}

function tryAssignPackageAtomically(pkg, candidate) {
  return withImmediateTransaction(() => {
    const freshPackage = db.prepare("SELECT * FROM packages WHERE id = ?").get(pkg.id);
    if (!freshPackage) {
      return { ok: false, reason: "veri eksik", note: "Siparis kaydi bulunamadi." };
    }

    const freshStatus = normalizeStatus(freshPackage.status);
    if (!isAssignableOrderStatus(freshStatus)) {
      return { ok: false, reason: "sistemsel hata", note: "Siparis bu durumda otomatik atamaya uygun degil." };
    }

    const targetCourier = db.prepare("SELECT * FROM couriers WHERE id = ?").get(candidate.courier.id);
    if (!targetCourier) {
      updatePackageAssignmentFailure(pkg.id, "uygun kurye yok", "Secilen kurye kaydi bulunamadi.");
      return { ok: false, reason: "uygun kurye yok", note: "Secilen kurye kaydi bulunamadi." };
    }

    if (targetCourier.zone !== freshPackage.zone) {
      updatePackageAssignmentFailure(pkg.id, "tenant uyusmuyor", "Kurye zone bilgisi siparisle uyusmuyor.");
      return { ok: false, reason: "tenant uyusmuyor", note: "Kurye zone bilgisi siparisle uyusmuyor." };
    }

    const courierStatus = normalizeCourierStatus(targetCourier.status, Boolean(targetCourier.available));
    if (courierStatus !== COURIER_ONLINE_STATUS) {
      updatePackageAssignmentFailure(pkg.id, "uygun kurye yok", "Kurye online olmadigi icin atama yapilamadi.");
      return { ok: false, reason: "uygun kurye yok", note: "Kurye online olmadigi icin atama yapilamadi." };
    }

    const activeLoad = Number(
      db.prepare(`
        SELECT COUNT(*) AS total
        FROM packages
        WHERE assigned_courier_id = ?
          AND id != ?
          AND status IN (?, ?, ?)
      `).get(targetCourier.id, pkg.id, ASSIGNED_STATUS, ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS)?.total || 0
    );

    if (activeLoad >= 1) {
      updatePackageAssignmentFailure(pkg.id, "tum kuryeler busy", "Secilen kurye zaten aktif bir pakete sahip.");
      return { ok: false, reason: "tum kuryeler busy", note: "Secilen kurye zaten aktif bir pakete sahip." };
    }

    const assignmentAttemptAt = nowIso();
    const update = db.prepare(`
      UPDATE packages
      SET status = ?, assignment_status = ?, assigned_courier_id = ?, assigned_courier_name = ?, assigned_at = ?,
          distance_km = ?, assignment_reason = ?, last_assignment_attempt_at = ?, last_assignment_error = '', updated_at = ?
      WHERE id = ?
        AND status IN (?, ?, ?, ?)
    `).run(
      ASSIGNED_STATUS,
      "assigned",
      targetCourier.id,
      targetCourier.name,
      assignmentAttemptAt,
      Number(candidate.distance.toFixed(2)),
      `${freshPackage.zone} bolgesinde ${MAX_ASSIGNMENT_DISTANCE_KM} km icinde en uygun aktif kurye secildi.`,
      assignmentAttemptAt,
      assignmentAttemptAt,
      pkg.id,
      PENDING_STATUS,
      AWAITING_ASSIGNMENT_STATUS,
      ASSIGNED_STATUS,
      FAILED_STATUS
    );

    if (update.changes !== 1) {
      return { ok: false, reason: "sistemsel hata", note: "Siparis bu arada baska bir islem tarafindan degisti." };
    }

    db.prepare("UPDATE couriers SET status = ? WHERE id = ?").run(COURIER_BUSY_STATUS, targetCourier.id);
    return { ok: true, courierId: targetCourier.id };
  });
}

function attemptPackageAssignment(state, pkg, occupiedCourierLoads) {
  const packageStatus = normalizeStatus(pkg.status);
  if (!isAssignableOrderStatus(packageStatus)) {
    return false;
  }

  const ranked = rankEligibleCouriers(state, pkg, occupiedCourierLoads);
  if (ranked.length === 0) {
    const failure = evaluateAssignmentFailure(state, pkg);
    persistPackageAssignment(buildAssignmentFailure(pkg, failure.reason, failure.note));
    return false;
  }

  for (const candidate of ranked) {
    const result = tryAssignPackageAtomically(pkg, candidate);
    if (result.ok) {
      reserveCourier(occupiedCourierLoads, candidate.courier.id, 1);
      const packageIndex = state.packages.findIndex((item) => item.id === pkg.id);
      if (packageIndex >= 0) {
        state.packages[packageIndex] = {
          ...state.packages[packageIndex],
          status: ASSIGNED_STATUS,
          assignmentStatus: "assigned",
          assignedCourierId: candidate.courier.id,
          assignedCourierName: candidate.courier.name,
          assignedAt: nowIso(),
          distanceKm: Number(candidate.distance.toFixed(2)),
          lastAssignmentAttemptAt: nowIso(),
          lastAssignmentError: "",
        };
      }
      const courierIndex = state.couriers.findIndex((item) => item.id === candidate.courier.id);
      if (courierIndex >= 0) {
        state.couriers[courierIndex] = {
          ...state.couriers[courierIndex],
          status: COURIER_BUSY_STATUS,
        };
      }
      broadcastLiveEvent({
        type: "package-assigned",
        restaurantId: pkg.restaurantId,
        courierId: candidate.courier.id,
        message: `${pkg.trackingNo || pkg.id} paketi ${candidate.courier.name} kuryesine atandi.`,
      });
      return true;
    }
  }

  const failure = evaluateAssignmentFailure(currentState(), pkg);
  persistPackageAssignment(buildAssignmentFailure(pkg, failure.reason, failure.note));
  broadcastLiveEvent({
    type: "assignment-waiting",
    restaurantId: pkg.restaurantId,
    message: `${pkg.trackingNo || pkg.id} paketi hala uygun kurye bekliyor.`,
  });
  return false;
}

function adminAssignPackageToCourier(packageId, courierId) {
  return withImmediateTransaction(() => {
    const target = db.prepare("SELECT * FROM packages WHERE id = ?").get(packageId);
    if (!target) {
      throw httpError(404, "Paket bulunamadi.");
    }

    const targetStatus = normalizeStatus(target.status);
    if ([ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS, DELIVERED_STATUS, CANCELED_STATUS].includes(targetStatus)) {
      throw httpError(400, "Bu durumdaki paket manuel override ile atanamaz.");
    }

    const courier = db.prepare("SELECT * FROM couriers WHERE id = ?").get(courierId);
    if (!courier) {
      throw httpError(404, "Kurye bulunamadi.");
    }

    if (courier.zone !== target.zone) {
      throw httpError(400, "Kurye ve siparis bolgesi uyusmuyor.");
    }

    if (normalizeCourierStatus(courier.status, Boolean(courier.available)) !== COURIER_ONLINE_STATUS) {
      throw httpError(400, "Secilen kurye online veya musait degil.");
    }

    const activeLoad = Number(
      db.prepare(`
        SELECT COUNT(*) AS total
        FROM packages
        WHERE assigned_courier_id = ?
          AND id != ?
          AND status IN (?, ?, ?)
      `).get(courier.id, packageId, ASSIGNED_STATUS, ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS)?.total || 0
    );
    if (activeLoad >= 1) {
      throw httpError(400, "Secilen kurye zaten aktif bir pakete sahip.");
    }

    const assignedAt = nowIso();
    db.prepare(`
      UPDATE packages
      SET status = ?, assignment_status = ?, assigned_courier_id = ?, assigned_courier_name = ?, assigned_at = ?,
          assignment_reason = ?, last_assignment_attempt_at = ?, last_assignment_error = '', updated_at = ?
      WHERE id = ?
    `).run(
      ASSIGNED_STATUS,
      "assigned",
      courier.id,
      courier.name,
      assignedAt,
      "Admin override ile belirli kuryeye atandi.",
      assignedAt,
      assignedAt,
      packageId
    );
    db.prepare("UPDATE couriers SET status = ? WHERE id = ?").run(COURIER_BUSY_STATUS, courier.id);
    return { packageId, courierId: courier.id, courierName: courier.name };
  });
}

function adminUnassignPackage(packageId) {
  return withImmediateTransaction(() => {
    const target = db.prepare("SELECT * FROM packages WHERE id = ?").get(packageId);
    if (!target) {
      throw httpError(404, "Paket bulunamadi.");
    }

    const targetStatus = normalizeStatus(target.status);
    if ([ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS, DELIVERED_STATUS, CANCELED_STATUS].includes(targetStatus)) {
      throw httpError(400, "Bu durumdaki paketin atamasi kaldirilamaz.");
    }

    db.prepare(`
      UPDATE packages
      SET status = ?, assignment_status = ?, assigned_courier_id = NULL, assigned_courier_name = NULL, assigned_at = NULL,
          assignment_reason = ?, last_assignment_attempt_at = ?, last_assignment_error = ?, updated_at = ?
      WHERE id = ?
    `).run(
      AWAITING_ASSIGNMENT_STATUS,
      "pending",
      "Admin mevcut atamayi kaldirdi ve siparisi havuza geri aldi.",
      nowIso(),
      "admin override ile atama kaldirildi",
      nowIso(),
      packageId
    );
    return { packageId };
  });
}

function syncCourierOperationalStatuses(state = currentState()) {
  state.couriers.forEach((courier) => {
    const load = activeAssignmentsForCourier(state.packages, courier.id);
    const nextStatus = !courier.available
      ? COURIER_OFFLINE_STATUS
      : load > 0
        ? COURIER_BUSY_STATUS
        : COURIER_ONLINE_STATUS;
    db.prepare("UPDATE couriers SET status = ? WHERE id = ?").run(nextStatus, courier.id);
    courier.status = nextStatus;
  });
}

function rebalancePackages() {
  if (assignmentSweepRunning) {
    assignmentSweepQueued = true;
    return;
  }

  assignmentSweepRunning = true;
  try {
  const state = currentState();
  const occupiedCourierLoads = new Map();
  state.packages
    .filter((pkg) => isActivePackageStatus(pkg.status))
    .forEach((pkg) => reserveCourier(occupiedCourierLoads, pkg.assignedCourierId, 1));

  const candidatePackages = state.packages
    .filter((pkg) => [PENDING_STATUS, AWAITING_ASSIGNMENT_STATUS, FAILED_STATUS].includes(normalizeStatus(pkg.status)))
    .sort((left, right) => waitingPackagePriority(left) - waitingPackagePriority(right));

  candidatePackages.forEach((pkg) => {
    attemptPackageAssignment(state, pkg, occupiedCourierLoads);
  });

  syncCourierOperationalStatuses(state);
  } finally {
    assignmentSweepRunning = false;
    if (assignmentSweepQueued) {
      assignmentSweepQueued = false;
      setImmediate(() => rebalancePackages());
    }
  }
}

function retryAwaitingAssignmentPackages() {
  rebalancePackages();
}

function stats(state) {
  return {
    totalRestaurants: state.restaurants.length,
    totalCouriers: state.couriers.length,
    totalPlatformAccounts: state.platformAccounts.length,
    activeCouriers: state.couriers.filter((item) => item.status === COURIER_ONLINE_STATUS || item.status === COURIER_BUSY_STATUS).length,
    totalPackages: state.packages.length,
    waitingPackages: state.packages.filter((item) => [PENDING_STATUS, AWAITING_ASSIGNMENT_STATUS].includes(item.status)).length,
    assignedPackages: state.packages.filter((item) => item.assignedCourierId).length,
    inTransitPackages: state.packages.filter((item) => [ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS].includes(item.status)).length,
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
    activeCourierCount: couriers.filter((item) => item.zone === zone && (item.status === COURIER_ONLINE_STATUS || item.status === COURIER_BUSY_STATUS)).length,
    packageCount: packages.filter((item) => item.zone === zone).length,
    waitingCount: packages.filter((item) => item.zone === zone && [PENDING_STATUS, AWAITING_ASSIGNMENT_STATUS].includes(item.status)).length,
  }));
  const sanitizedPlatformAccounts = state.platformAccounts.map((account) => sanitizePlatformAccount(account, Boolean(filter.includePlatformSecrets || filter.includeRestaurantSecrets)));

  return {
    zones,
    zoneAlerts: buildZoneAlerts(zones, packages),
    restaurants: state.restaurants.map((restaurant) => sanitizeRestaurant(restaurant, Boolean(filter.includeRestaurantSecrets))),
    platformAccounts: sanitizedPlatformAccounts,
    couriers,
    packages,
    courierDailyReports: getCourierDailyReports(50),
    webhookLogs: state.webhookLogs,
    stats: stats(state),
    restaurantPerformance: filter.restaurantId ? buildRestaurantPerformance(packages) : null,
    integrationWizard: filter.restaurantId ? buildRestaurantIntegrationWizard(filter.req || { headers: {}, url: "/" }, state.restaurants[0] || null, sanitizedPlatformAccounts) : null,
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
    endpoint: `${requestBaseUrl(req)}/api/integrations/orders`,
    platformWebhookBase: `${requestBaseUrl(req)}/api/platforms`,
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

function platformVerifyEnvKey(platform) {
  return `DELIVERA_VERIFY_URL_${platformSlug(platform).toUpperCase().replace(/-/g, "_")}`;
}

async function verifyGenericPlatformCredentials(platform, draft) {
  const verifyUrl = trimmed(process.env[platformVerifyEnvKey(platform)]);
  if (!verifyUrl) {
    return {
      status: PLATFORM_VERIFICATION_STATUS.PENDING,
      mode: "deferred_webhook",
      note: `${platform} icin canli partner verify URL tanimli degil. Ilk basarili webhook veya ozel verify URL sonrasi dogrulama tamamlanir.`,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PLATFORM_VERIFY_TIMEOUT_MS);

  try {
    const response = await fetch(verifyUrl, {
      method: "GET",
      headers: {
        Authorization: draft.apiKey ? `Bearer ${draft.apiKey}` : "",
        "x-api-key": draft.apiKey || "",
        "x-api-secret": draft.apiSecret || "",
        "x-external-store-id": draft.externalStoreId || "",
        "x-external-merchant-id": draft.externalMerchantId || "",
      },
      signal: controller.signal,
    });

    if (response.ok) {
      return {
        status: PLATFORM_VERIFICATION_STATUS.VERIFIED,
        mode: "remote_partner_api",
        note: `${platform} merchant credentials uzaktan dogrulandi.`,
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        status: PLATFORM_VERIFICATION_STATUS.FAILED,
        mode: "remote_partner_api",
        note: `${platform} merchant credentials reddedildi (${response.status}).`,
      };
    }

    return {
      status: PLATFORM_VERIFICATION_STATUS.PENDING,
      mode: "remote_partner_api",
      note: `${platform} partner verify istegi ${response.status} dondu. Manuel kontrol gerekebilir.`,
    };
  } catch (error) {
    return {
      status: PLATFORM_VERIFICATION_STATUS.PENDING,
      mode: "remote_partner_api",
      note: `${platform} verify istegi tamamlanamadi: ${error.message}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyTrendyolMerchantCredentials(draft) {
  if (!draft.apiKey || !draft.apiSecret || !draft.externalStoreId) {
    return {
      status: PLATFORM_VERIFICATION_STATUS.FAILED,
      mode: "remote_partner_api",
      note: "Trendyol merchant dogrulamasi icin seller/store id, api key ve api secret zorunludur.",
    };
  }

  const isStage = ["1", "true", "yes"].includes(String(process.env.TRENDYOL_STAGE_MODE || "").toLowerCase());
  const sellerId = draft.externalStoreId;
  const targetUrl = `${isStage ? "https://stageapigw.trendyol.com" : "https://apigw.trendyol.com"}/integration/webhook/sellers/${encodeURIComponent(sellerId)}/webhooks`;
  const authValue = Buffer.from(`${draft.apiKey}:${draft.apiSecret}`).toString("base64");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PLATFORM_VERIFY_TIMEOUT_MS);

  try {
    const response = await fetch(targetUrl, {
      method: "GET",
      headers: {
        Authorization: `Basic ${authValue}`,
        "User-Agent": `${sellerId} - DeliveraExpress`,
        ...(draft.storeFrontCode ? { storeFrontCode: draft.storeFrontCode } : {}),
      },
      signal: controller.signal,
    });

    if (response.ok) {
      return {
        status: PLATFORM_VERIFICATION_STATUS.VERIFIED,
        mode: "trendyol_webhook_api",
        note: "Trendyol merchant credentials resmi webhook servisi ile dogrulandi.",
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        status: PLATFORM_VERIFICATION_STATUS.FAILED,
        mode: "trendyol_webhook_api",
        note: `Trendyol merchant credentials reddedildi (${response.status}).`,
      };
    }

    return {
      status: PLATFORM_VERIFICATION_STATUS.PENDING,
      mode: "trendyol_webhook_api",
      note: `Trendyol verify cevabi ${response.status}. StoreFrontCode veya panel yetkisi kontrol edilmeli.`,
    };
  } catch (error) {
    return {
      status: PLATFORM_VERIFICATION_STATUS.PENDING,
      mode: "trendyol_webhook_api",
      note: `Trendyol verify istegi tamamlanamadi: ${error.message}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyPlatformMerchantCredentials(draft) {
  if (draft.platform === "Trendyol Go") {
    return verifyTrendyolMerchantCredentials(draft);
  }

  return verifyGenericPlatformCredentials(draft.platform, draft);
}

function markPlatformAccountVerification(accountId, verification) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE platform_accounts
    SET verification_status = ?, verification_note = ?, last_verification_at = ?, verified_at = ?, last_validation_mode = ?, updated_at = ?
    WHERE id = ?
  `).run(
    verification.status,
    verification.note,
    now,
    verification.status === PLATFORM_VERIFICATION_STATUS.VERIFIED ? now : null,
    verification.mode || null,
    now,
    accountId
  );
}

function markPlatformAccountVerifiedFromWebhook(accountId, platform) {
  markPlatformAccountVerification(accountId, {
    status: PLATFORM_VERIFICATION_STATUS.VERIFIED,
    mode: "live_webhook",
    note: `${platform} hesabindan basarili canli webhook alindi.`,
  });
}

function createRestaurantRecord(body) {
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
    throw validationError("Bu restoran kullanici adi zaten kullaniliyor.");
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

  return {
    restaurant,
    restaurantPassword,
  };
}

function createPackageRecord(pkg, packageType = "Platform Siparisi") {
  db.prepare(`
    INSERT INTO packages (
      id, tracking_no, restaurant_id, source, delivery_address, package_type, source_platform, external_order_no, external_order_id,
      recipient, phone, address, zone, eta, payment_method, order_amount, payment_status, x, y, note, status, assignment_status,
      assigned_courier_id, assigned_courier_name, assigned_at, accepted_at, on_route_at, delivered_at, failed_at,
      distance_km, assignment_reason, failure_reason, last_assignment_attempt_at, last_assignment_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    pkg.id,
    pkg.trackingNo,
    pkg.restaurantId,
    pkg.source,
    pkg.deliveryAddress || pkg.address,
    packageType,
    pkg.sourcePlatform,
    pkg.externalOrderNo,
    pkg.externalOrderId || pkg.externalOrderNo,
    pkg.recipient,
    pkg.phone,
    pkg.address,
    pkg.zone,
    pkg.eta,
    pkg.paymentMethod,
    normalizeMoney(pkg.orderAmount),
    pkg.paymentStatus,
    pkg.latitude,
    pkg.longitude,
    pkg.note,
    pkg.status,
    pkg.assignmentStatus || assignmentStatusForOrder(pkg.status),
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    pkg.assignmentReason,
    pkg.failureReason || null,
    pkg.lastAssignmentAttemptAt || null,
    pkg.lastAssignmentError || null,
    pkg.createdAt,
    pkg.updatedAt || pkg.createdAt
  );
}

function findDuplicatePackage(restaurantId, source, externalOrderId) {
  if (!restaurantId || !source || !externalOrderId) {
    return null;
  }

  return db.prepare(`
    SELECT * FROM packages
    WHERE restaurant_id = ? AND source = ? AND external_order_id = ?
  `).get(restaurantId, source, externalOrderId) || null;
}

function lifecycleColumnsForStatus(status, current = {}) {
  const normalized = normalizeStatus(status);
  const stamp = nowIso();
  return {
    assignmentStatus: assignmentStatusForOrder(normalized),
    assignedAt: normalized === ASSIGNED_STATUS ? (current.assignedAt || stamp) : current.assignedAt || null,
    acceptedAt: normalized === ACCEPTED_BY_COURIER_STATUS ? (current.acceptedAt || stamp) : current.acceptedAt || null,
    onRouteAt: normalized === ON_ROUTE_STATUS ? (current.onRouteAt || stamp) : current.onRouteAt || null,
    deliveredAt: normalized === DELIVERED_STATUS ? (current.deliveredAt || stamp) : current.deliveredAt || null,
    failedAt: normalized === FAILED_STATUS ? (current.failedAt || stamp) : current.failedAt || null,
  };
}

function updatePackageLifecycle(packageId, updates, current = {}) {
  const status = normalizeStatus(updates.status || current.status);
  const lifecycle = lifecycleColumnsForStatus(status, current);
  db.prepare(`
    UPDATE packages
    SET status = ?, assignment_status = ?, payment_status = ?, failure_reason = ?, assigned_courier_id = ?, assigned_courier_name = ?,
        assigned_at = ?, accepted_at = ?, on_route_at = ?, delivered_at = ?, failed_at = ?, last_assignment_attempt_at = ?,
        last_assignment_error = ?, updated_at = ?
    WHERE id = ?
  `).run(
    status,
    updates.assignmentStatus || lifecycle.assignmentStatus,
    normalizePaymentStatus(updates.paymentStatus || current.paymentStatus, updates.paymentMethod || current.paymentMethod),
    updates.failureReason ?? current.failureReason ?? null,
    updates.assignedCourierId ?? current.assignedCourierId ?? null,
    updates.assignedCourierName ?? current.assignedCourierName ?? null,
    updates.assignedAt ?? lifecycle.assignedAt,
    updates.acceptedAt ?? lifecycle.acceptedAt,
    updates.onRouteAt ?? lifecycle.onRouteAt,
    updates.deliveredAt ?? lifecycle.deliveredAt,
    updates.failedAt ?? lifecycle.failedAt,
    updates.lastAssignmentAttemptAt ?? current.lastAssignmentAttemptAt ?? null,
    updates.lastAssignmentError ?? current.lastAssignmentError ?? null,
    nowIso(),
    packageId
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
    return AWAITING_ASSIGNMENT_STATUS;
  }

  if (["CREATED", "RECEIVED", "NEW", "PREPARING"].includes(incoming)) {
    return AWAITING_ASSIGNMENT_STATUS;
  }

  if (["ASSIGNED", "COURIER_ASSIGNED"].includes(incoming)) {
    return ASSIGNED_STATUS;
  }

  if (["ACCEPTED", "ACCEPTED_BY_COURIER"].includes(incoming)) {
    return ACCEPTED_BY_COURIER_STATUS;
  }

  if (["PICKED_UP", "ON_WAY", "ON_ROUTE", "IN_DELIVERY", "OUT_FOR_DELIVERY"].includes(incoming)) {
    return ON_ROUTE_STATUS;
  }

  if (["DELIVERED", "COMPLETED"].includes(incoming)) {
    return DELIVERED_STATUS;
  }

  if (["FAILED", "UNDELIVERED", "RETURNED", "UNSUPPLIED"].includes(incoming)) {
    return FAILED_STATUS;
  }

  if (["CANCELLED", "CANCELED"].includes(incoming)) {
    return CANCELED_STATUS;
  }

  return AWAITING_ASSIGNMENT_STATUS;
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
  const orderAmount = normalizeMoney(
    shipment.orderAmount ??
    shipment.amount ??
    shipment.totalAmount ??
    shipment.total_amount ??
    shipment.totalPrice ??
    shipment.total_price ??
    payment.amount ??
    payment.total ??
    payment.totalAmount
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
    source: "platform_webhook",
    sourcePlatform: platform,
    externalOrderNo,
    externalOrderId: externalOrderNo,
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
    orderAmount,
    paymentStatus: normalizePaymentStatus("", paymentMethod),
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
  const existing = findDuplicatePackage(restaurant.id, "platform_webhook", payload.externalOrderId || payload.externalOrderNo);

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
  const incomingPaymentStatus = normalizePaymentStatus(payload.paymentStatus, payload.paymentMethod);
  if (incomingStatus !== currentStatus && canTransitionStatus(currentStatus, incomingStatus)) {
    updatePackageLifecycle(existing.id, {
      status: incomingStatus,
      paymentStatus: incomingPaymentStatus,
      failureReason: payload.failureReason || existing.failure_reason || "",
    }, {
      status: existing.status,
      paymentStatus: existing.payment_status,
      failureReason: existing.failure_reason,
      assignedCourierId: existing.assigned_courier_id,
      assignedCourierName: existing.assigned_courier_name,
      assignedAt: existing.assigned_at,
      acceptedAt: existing.accepted_at,
      onRouteAt: existing.on_route_at,
      deliveredAt: existing.delivered_at,
      failedAt: existing.failed_at,
      lastAssignmentAttemptAt: existing.last_assignment_attempt_at,
      lastAssignmentError: existing.last_assignment_error,
      paymentMethod: existing.payment_method,
    });
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
  return getSessionByToken("courier_sessions", "token", getBearerToken(req), COURIER_SESSION_MAX_AGE_MS);
}

function getRestaurantSession(req) {
  return getSessionByToken("restaurant_sessions", "token", getBearerToken(req), RESTAURANT_SESSION_MAX_AGE_MS);
}

const defaultAdminUsername = trimmed(process.env.DELIVERA_ADMIN_USERNAME || "admin").toLowerCase();
const defaultAdminPassword = process.env.DELIVERA_ADMIN_PASSWORD || `Adm${crypto.randomBytes(6).toString("hex")}!`;
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

  fs.writeFileSync(
    ADMIN_BOOTSTRAP_FILE,
    `Delivera Express ilk admin hesabi olusturuldu.\nKullanici adi: ${defaultAdminUsername}\nSifre: ${defaultAdminPassword}\n`,
    "utf8"
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
    const payload = decorateState({ restaurantId: restaurantId || undefined, req });
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

    const auth = issueSessionPair("admin", admin.id, req);

    writeAuditLog({
      actorRole: "admin",
      actorId: admin.id,
      action: "admin_logged_in",
      details: {
        username: admin.username,
      },
    });

    sendJson(res, 200, { ...auth, username: admin.username });
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
    const payload = decorateState({ restaurantId: restaurantId || undefined, req });
    payload.restaurants = getRestaurants().map((restaurant) => sanitizeRestaurant(restaurant));
    payload.auditLogs = getAuditLogs(20, { restaurantId: restaurantId || undefined });
    sendJson(res, 200, payload);
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/stream") {
    const adminSession = getSessionFromQueryToken(req, "admin");
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    openLiveStream(req, res, { role: "admin", adminId: adminSession.admin_id });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/refresh") {
    const { json: body } = await readRequestBody(req);
    const { refreshToken } = validateRefreshDraft(body);
    sendJson(res, 200, refreshSessionPair("admin", refreshToken, req));
    return;
  }

  if (req.method === "POST" && pathname === "/api/restaurant/refresh") {
    const { json: body } = await readRequestBody(req);
    const { refreshToken } = validateRefreshDraft(body);
    sendJson(res, 200, refreshSessionPair("restaurant", refreshToken, req));
    return;
  }

  if (req.method === "POST" && pathname === "/api/courier/refresh") {
    const { json: body } = await readRequestBody(req);
    const { refreshToken } = validateRefreshDraft(body);
    sendJson(res, 200, refreshSessionPair("courier", refreshToken, req));
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/logout") {
    const { json: body } = await readRequestBody(req);
    const { refreshToken } = validateRefreshDraft(body);
    revokeAccessToken("admin_sessions", getBearerToken(req));
    db.prepare("DELETE FROM refresh_tokens WHERE actor_role = ? AND token_hash = ?").run("admin", hashOpaqueToken(refreshToken));
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/api/restaurant/logout") {
    const { json: body } = await readRequestBody(req);
    const { refreshToken } = validateRefreshDraft(body);
    revokeAccessToken("restaurant_sessions", getBearerToken(req));
    db.prepare("DELETE FROM refresh_tokens WHERE actor_role = ? AND token_hash = ?").run("restaurant", hashOpaqueToken(refreshToken));
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/api/courier/logout") {
    const session = getCourierSession(req);
    if (session) {
      closeCourierShift(session.courier_id);
      broadcastLiveEvent({
        type: "courier-shift-ended",
        courierId: session.courier_id,
        message: "Kurye vardiyasi kapatildi.",
      });
    }
    const { json: body } = await readRequestBody(req);
    const { refreshToken } = validateRefreshDraft(body);
    revokeAccessToken("courier_sessions", getBearerToken(req));
    db.prepare("DELETE FROM refresh_tokens WHERE actor_role = ? AND token_hash = ?").run("courier", hashOpaqueToken(refreshToken));
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/forgot-password") {
    const { json: body } = await readRequestBody(req);
    const { username } = validatePasswordResetRequestDraft(body);
    const actor = actorLookupByRole("admin", username);
    if (actor) {
      const token = issuePasswordReset("admin", actor.id, req);
      logPasswordReset("admin", username, token);
      writeAuditLog({
        actorRole: "admin",
        actorId: actor.id,
        action: "password_reset_requested",
        details: { username },
      });
      sendJson(res, 200, {
        message: "Parola yenileme talebi olusturuldu.",
        ...(NODE_ENV === "production" ? {} : { resetToken: token }),
      });
      return;
    }

    sendJson(res, 200, { message: "Parola yenileme talebi olusturuldu." });
    return;
  }

  if (req.method === "POST" && pathname === "/api/restaurant/forgot-password") {
    const { json: body } = await readRequestBody(req);
    const { username } = validatePasswordResetRequestDraft(body);
    const actor = actorLookupByRole("restaurant", username);
    if (actor) {
      const token = issuePasswordReset("restaurant", actor.id, req);
      logPasswordReset("restaurant", username, token);
      writeAuditLog({
        actorRole: "restaurant",
        actorId: actor.id,
        restaurantId: actor.id,
        action: "password_reset_requested",
        details: { username },
      });
      sendJson(res, 200, {
        message: "Parola yenileme talebi olusturuldu.",
        ...(NODE_ENV === "production" ? {} : { resetToken: token }),
      });
      return;
    }

    sendJson(res, 200, { message: "Parola yenileme talebi olusturuldu." });
    return;
  }

  if (req.method === "POST" && pathname === "/api/courier/forgot-password") {
    const { json: body } = await readRequestBody(req);
    const { username } = validatePasswordResetRequestDraft(body);
    const actor = actorLookupByRole("courier", username);
    if (actor) {
      const token = issuePasswordReset("courier", actor.id, req);
      logPasswordReset("courier", username, token);
      writeAuditLog({
        actorRole: "courier",
        actorId: actor.id,
        action: "password_reset_requested",
        details: { username },
      });
      sendJson(res, 200, {
        message: "Parola yenileme talebi olusturuldu.",
        ...(NODE_ENV === "production" ? {} : { resetToken: token }),
      });
      return;
    }

    sendJson(res, 200, { message: "Parola yenileme talebi olusturuldu." });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/reset-password") {
    const { json: body } = await readRequestBody(req);
    const { token, password } = validatePasswordResetDraft(body);
    const resetRow = consumePasswordReset("admin", token);
    updateActorPassword("admin", resetRow.actor_id, password);
    sendJson(res, 200, { message: "Admin parolasi guncellendi." });
    return;
  }

  if (req.method === "POST" && pathname === "/api/restaurant/reset-password") {
    const { json: body } = await readRequestBody(req);
    const { token, password } = validatePasswordResetDraft(body);
    const resetRow = consumePasswordReset("restaurant", token);
    updateActorPassword("restaurant", resetRow.actor_id, password);
    sendJson(res, 200, { message: "Restoran parolasi guncellendi." });
    return;
  }

  if (req.method === "POST" && pathname === "/api/courier/reset-password") {
    const { json: body } = await readRequestBody(req);
    const { token, password } = validatePasswordResetDraft(body);
    const resetRow = consumePasswordReset("courier", token);
    updateActorPassword("courier", resetRow.actor_id, password);
    sendJson(res, 200, { message: "Kurye parolasi guncellendi." });
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

    const auth = issueSessionPair("restaurant", restaurant.id, req);

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
      ...auth,
      state: decorateState({
        restaurantId: restaurant.id,
        includeRestaurantSecrets: true,
        req,
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
      req,
    }));
    return;
  }

  if (req.method === "GET" && pathname === "/api/restaurant/stream") {
    const session = getSessionFromQueryToken(req, "restaurant");
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }
    openLiveStream(req, res, { role: "restaurant", restaurantId: session.restaurant_id });
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
    const verification = await verifyPlatformMerchantCredentials({
      ...draft,
      webhookApiKey,
      webhookUsername,
      webhookPassword,
      staticToken,
    });
    const existing = db.prepare(`
      SELECT * FROM platform_accounts
      WHERE restaurant_id = ? AND platform = ? AND external_store_id = ?
    `).get(session.restaurant_id, draft.platform, draft.externalStoreId);

    if (existing) {
      db.prepare(`
        UPDATE platform_accounts
        SET external_merchant_id = ?, api_username = ?, api_password = ?, api_key = ?, api_secret = ?,
            store_front_code = ?, chain_id = ?, vendor_id = ?, webhook_auth_type = ?, webhook_api_key = ?,
            webhook_username = ?, webhook_password = ?, static_token = ?, settings_json = ?, verification_status = ?,
            verification_note = ?, last_verification_at = ?, verified_at = ?, last_validation_mode = ?, active = ?, updated_at = ?
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
        verification.status,
        verification.note,
        now,
        verification.status === PLATFORM_VERIFICATION_STATUS.VERIFIED ? now : null,
        verification.mode,
        draft.active ? 1 : 0,
        now,
        existing.id
      );
    } else {
      db.prepare(`
        INSERT INTO platform_accounts (
          id, restaurant_id, platform, external_store_id, external_merchant_id, api_username, api_password,
          api_key, api_secret, store_front_code, chain_id, vendor_id, webhook_auth_type, webhook_api_key,
          webhook_username, webhook_password, static_token, webhook_id, settings_json, verification_status,
          verification_note, last_verification_at, verified_at, last_validation_mode, active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        verification.status,
        verification.note,
        now,
        verification.status === PLATFORM_VERIFICATION_STATUS.VERIFIED ? now : null,
        verification.mode,
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
        verificationStatus: verification.status,
      },
    });
    broadcastLiveEvent({
      type: "platform-account-saved",
      restaurantId: session.restaurant_id,
      message: `${draft.platform} platform hesabi kaydedildi.`,
    });

    sendJson(res, 200, decorateState({
      restaurantId: session.restaurant_id,
      includeRestaurantSecrets: true,
      includePlatformSecrets: true,
      req,
    }));
    return;
  }

  if (req.method === "POST" && pathname === "/api/restaurant/platform-accounts/test") {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }

    const { json: body } = await readRequestBody(req);
    const accountId = trimmed(body.accountId || body.account_id);
    if (!accountId) {
      sendJson(res, 400, { error: "accountId zorunludur." });
      return;
    }

    const account = getPlatformAccounts({ restaurantId: session.restaurant_id }).find((item) => item.id === accountId);
    if (!account) {
      sendJson(res, 404, { error: "Platform hesabi bulunamadi." });
      return;
    }

    const verification = await verifyPlatformMerchantCredentials(account);
    const now = nowIso();
    db.prepare(`
      UPDATE platform_accounts
      SET verification_status = ?, verification_note = ?, last_verification_at = ?, verified_at = ?, last_validation_mode = ?, updated_at = ?
      WHERE id = ?
    `).run(
      verification.status,
      verification.note,
      now,
      verification.status === PLATFORM_VERIFICATION_STATUS.VERIFIED ? now : null,
      verification.mode,
      now,
      accountId
    );

    broadcastLiveEvent({
      type: "platform-test",
      restaurantId: session.restaurant_id,
      message: `${account.platform} baglanti testi tamamlandi.`,
    });
    sendJson(res, 200, {
      verification,
      state: decorateState({
        restaurantId: session.restaurant_id,
        includeRestaurantSecrets: true,
        includePlatformSecrets: true,
        req,
      }),
    });
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
      restaurantId: trimmed(body.restaurant_id ?? body.restaurantId) || session.restaurant_id,
      deliveryAddress: trimmed(body.delivery_address ?? body.deliveryAddress),
      packageType: trimmed(body.package_type ?? body.packageType),
      orderAmount: normalizeMoney(body.order_amount ?? body.orderAmount),
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

    const createdAt = nowIso();
    const externalOrderId = `MANUAL-${Date.now()}`;
    const pkg = {
      id: uid("pkg"),
      trackingNo: `PKT-${Math.floor(1000 + Math.random() * 9000)}`,
      restaurantId: restaurantRow.id,
      source: "external_manual",
      deliveryAddress: draft.deliveryAddress,
      packageType: draft.packageType,
      sourcePlatform: "Dis Manuel Paket",
      externalOrderNo: externalOrderId,
      externalOrderId,
      recipient: restaurantRow.name,
      phone: "-",
      address: draft.deliveryAddress,
      zone: restaurantRow.zone,
      eta: "Planlanacak",
      paymentMethod: "Panel Kaydi",
      orderAmount: draft.orderAmount,
      paymentStatus: UNPAID_PAYMENT_STATUS,
      latitude: restaurantRow.x,
      longitude: restaurantRow.y,
      note: `${draft.packageType} restoran panelinden olusturuldu.`,
      status: AWAITING_ASSIGNMENT_STATUS,
      assignmentStatus: "pending",
      assignedCourierId: null,
      assignedCourierName: null,
      assignedAt: null,
      acceptedAt: null,
      onRouteAt: null,
      deliveredAt: null,
      failedAt: null,
      distanceKm: null,
      failureReason: "",
      lastAssignmentAttemptAt: null,
      lastAssignmentError: "",
      assignmentReason: "Yeni manuel paket kaydi alindi.",
      createdAt,
      updatedAt: createdAt,
    };
    createPackageRecord(pkg, pkg.packageType);

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
        orderAmount: pkg.orderAmount,
      },
    });
    broadcastLiveEvent({
      type: "package-created",
      restaurantId: session.restaurant_id,
      message: "Manuel paket operasyon havuzuna alindi.",
    });
    sendJson(res, 201, decorateState({
      restaurantId: session.restaurant_id,
      includeRestaurantSecrets: true,
      req,
    }));
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/restaurants") {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }

    const retryAfter = applyRateLimit(req, "adminWrites", RATE_LIMITS.adminWrites);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Restoran olusturma limiti asildi." });
      return;
    }

    const { json: body } = await readRequestBody(req);
    const { restaurant } = createRestaurantRecord(body);

    writeAuditLog({
      actorRole: "admin",
      actorId: adminActorId(adminSession),
      action: "restaurant_created",
      restaurantId: restaurant.id,
      details: {
        name: restaurant.name,
        username: restaurant.username,
      },
    });
    broadcastLiveEvent({
      type: "restaurant-created",
      restaurantId: restaurant.id,
      message: `${restaurant.name} restorani eklendi.`,
    });

    sendJson(res, 201, {
      ...decorateState(),
      auditLogs: getAuditLogs(20),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/restaurants") {
    sendJson(res, 403, { error: "Restoran olusturma yalnizca admin panelinden yapilabilir." });
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
      INSERT INTO couriers (id, name, zone, x, y, available, status, username, password_hash, password_salt, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uid("cr"),
      name,
      zone,
      latitude,
      longitude,
      available ? 1 : 0,
      available ? COURIER_ONLINE_STATUS : COURIER_OFFLINE_STATUS,
      username,
      passwordInfo.hash,
      passwordInfo.salt,
      nowIso()
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
    broadcastLiveEvent({
      type: "courier-created",
      message: `${name} isimli kurye eklendi.`,
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

    const duplicate = findDuplicatePackage(body.restaurantId, trimmed(body.source) || "platform_api", trimmed(body.externalOrderId || body.externalOrderNo));

    if (duplicate) {
      logWebhookAttempt({
        restaurantId: restaurant.id,
        sourcePlatform: body.sourcePlatform,
        externalOrderNo: body.externalOrderId || body.externalOrderNo,
        signatureValid: true,
        responseStatus: 200,
        requestBody: raw,
      });
      sendJson(res, 200, { message: "Bu siparis zaten alinmis, yeni kayit acilmadi." });
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

    pkg.source = pkg.source || "platform_api";
    createPackageRecord(pkg, "Platform Siparisi");

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
    broadcastLiveEvent({
      type: "integration-order",
      restaurantId: restaurant.id,
      courierId: created?.assignedCourierId || null,
      message: `${pkg.sourcePlatform} siparisi otomatik akisa alindi.`,
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
      markPlatformAccountVerifiedFromWebhook(account.id, normalizedPlatform);
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
    broadcastLiveEvent({
      type: "platform-order",
      restaurantId: account.restaurantId,
      courierId: created?.assignedCourierId || null,
      message: `${normalizedPlatform} siparisi sisteme dustu.`,
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

    const auth = issueSessionPair("courier", courier.id, req);

    const loginLocationAt = new Date().toISOString();
    ensureCourierShiftOpen(courier.id, loginLocationAt);
    db.prepare("UPDATE couriers SET available = 1, status = ?, last_location_at = COALESCE(last_location_at, ?) WHERE id = ?").run(
      COURIER_ONLINE_STATUS,
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
      ...auth,
      courier: sanitizeCourier({
        id: courier.id,
        name: courier.name,
        zone: courier.zone,
        latitude: courier.x,
        longitude: courier.y,
        available: Boolean(courier.available),
        status: COURIER_ONLINE_STATUS,
        lastLocationAt: courier.last_location_at || loginLocationAt,
        username: courier.username,
        passwordHash: courier.password_hash,
        passwordSalt: courier.password_salt,
      }),
    });
    broadcastLiveEvent({
      type: "courier-online",
      courierId: courier.id,
      message: `${courier.name} online oldu.`,
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/courier/me") {
    const session = getCourierSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Oturum bulunamadi." });
      return;
    }

    const workspace = buildCourierWorkspace(session.courier_id);
    if (!workspace) {
      sendJson(res, 401, { error: "Kurye bulunamadi." });
      return;
    }

    sendJson(res, 200, workspace);
    return;
  }

  if (req.method === "GET" && pathname === "/api/courier/stream") {
    const session = getSessionFromQueryToken(req, "courier");
    if (!session) {
      sendJson(res, 401, { error: "Kurye oturumu bulunamadi." });
      return;
    }
    openLiveStream(req, res, { role: "courier", courierId: session.courier_id });
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
    const availabilityChanged = typeof body.available === "boolean" && Boolean(existing.available) !== Boolean(body.available);

    if (typeof body.available === "boolean") {
      if (body.available) {
        ensureCourierShiftOpen(session.courier_id, locationStamp);
      } else {
        closeCourierShift(session.courier_id, locationStamp);
      }
    }

    db.prepare(`
      UPDATE couriers
      SET x = ?, y = ?, available = ?, status = ?, last_location_at = ?
      WHERE id = ?
    `).run(
      hasCoordinates ? latitude : existing.x,
      hasCoordinates ? longitude : existing.y,
      typeof body.available === "boolean" ? (body.available ? 1 : 0) : existing.available,
      typeof body.available === "boolean"
        ? (body.available ? COURIER_ONLINE_STATUS : COURIER_OFFLINE_STATUS)
        : normalizeCourierStatus(existing.status, Boolean(existing.available)),
      locationStamp,
      session.courier_id
    );

    rebalancePackages();
    const workspace = buildCourierWorkspace(session.courier_id);
    const courier = workspace?.courier;
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
    broadcastLiveEvent({
      type: availabilityChanged ? "courier-availability" : "courier-location",
      courierId: session.courier_id,
      message: availabilityChanged
        ? (body.available ? "Kurye tekrar atamaya acildi." : "Kurye pasife alindi.")
        : "",
    });
    sendJson(res, 200, workspace || { courier: null, packages: [] });
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

    const failureReason = normalizeCourierFailureReason(body.failureReason || body.failure_reason || "");
    if (nextStatus === FAILED_STATUS && !failureReason) {
      sendJson(res, 400, {
        error: "Basarisiz durumuna gecmek icin gecerli bir sorun nedeni secilmelidir.",
        allowedFailureReasons: [...COURIER_FAILURE_REASONS],
      });
      return;
    }

    updatePackageLifecycle(packageId, {
      status: nextStatus,
      failureReason: nextStatus === FAILED_STATUS ? failureReason : "",
    }, {
      status: target.status,
      paymentStatus: target.payment_status,
      failureReason: target.failure_reason,
      assignedCourierId: target.assigned_courier_id,
      assignedCourierName: target.assigned_courier_name,
      assignedAt: target.assigned_at,
      acceptedAt: target.accepted_at,
      onRouteAt: target.on_route_at,
      deliveredAt: target.delivered_at,
      failedAt: target.failed_at,
      lastAssignmentAttemptAt: target.last_assignment_attempt_at,
      lastAssignmentError: target.last_assignment_error,
      paymentMethod: target.payment_method,
    });
    rebalancePackages();

    const workspace = buildCourierWorkspace(session.courier_id);
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
    broadcastLiveEvent({
      type: "package-status",
      courierId: session.courier_id,
      restaurantId: target.restaurant_id,
      message: `Paket durumu ${nextStatus} oldu.`,
    });
    sendJson(res, 200, workspace || { courier: null, packages: [] });
    return;
  }

  if (req.method === "POST" && pathname === "/api/courier/day-close") {
    const session = getCourierSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Oturum bulunamadi." });
      return;
    }

    const summary = upsertCourierDailyReport(session.courier_id, dayKey());
    closeCourierShift(session.courier_id);
    const workspace = buildCourierWorkspace(session.courier_id);
    writeAuditLog({
      actorRole: "courier",
      actorId: session.courier_id,
      action: "courier_day_closed",
      details: {
        reportDate: dayKey(),
        deliveredCount: summary.deliveredCount,
        totalAmount: summary.totalAmount,
      },
    });
    broadcastLiveEvent({
      type: "courier-day-close",
      courierId: session.courier_id,
      message: "Kurye gun sonu raporu olustu.",
    });
    sendJson(res, 200, {
      ...(workspace || { courier: null, packages: [], dayMetrics: null }),
      dayCloseReport: summary,
      courierDailyReports: getCourierDailyReports(50),
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
    if (body.available) {
      ensureCourierShiftOpen(availabilityMatch[1]);
    } else {
      closeCourierShift(availabilityMatch[1]);
    }
    db.prepare("UPDATE couriers SET available = ?, status = ? WHERE id = ?").run(
      body.available ? 1 : 0,
      body.available ? COURIER_ONLINE_STATUS : COURIER_OFFLINE_STATUS,
      availabilityMatch[1]
    );
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
    broadcastLiveEvent({
      type: "courier-availability",
      courierId: availabilityMatch[1],
      message: body.available ? "Kurye admin tarafindan aktif edildi." : "Kurye admin tarafindan pasife alindi.",
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
    const nextStatus = normalizeStatus(body.status || AWAITING_ASSIGNMENT_STATUS);
    if (!canTransitionStatus(currentStatus, nextStatus)) {
      sendJson(res, 400, { error: `Gecersiz durum gecisi: ${currentStatus} -> ${nextStatus}` });
      return;
    }

    updatePackageLifecycle(statusMatch[1], {
      status: nextStatus,
      paymentStatus: body.paymentStatus || target.payment_status,
      failureReason: trimmed(body.failureReason || body.failure_reason || ""),
    }, {
      status: target.status,
      paymentStatus: target.payment_status,
      failureReason: target.failure_reason,
      assignedCourierId: target.assigned_courier_id,
      assignedCourierName: target.assigned_courier_name,
      assignedAt: target.assigned_at,
      acceptedAt: target.accepted_at,
      onRouteAt: target.on_route_at,
      deliveredAt: target.delivered_at,
      failedAt: target.failed_at,
      lastAssignmentAttemptAt: target.last_assignment_attempt_at,
      lastAssignmentError: target.last_assignment_error,
      paymentMethod: target.payment_method,
    });
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
    broadcastLiveEvent({
      type: "package-status",
      restaurantId: target.restaurant_id,
      courierId: target.assigned_courier_id || null,
      message: `Paket durumu ${nextStatus} olarak guncellendi.`,
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

    if ([ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS, DELIVERED_STATUS, CANCELED_STATUS].includes(normalizeStatus(target.status))) {
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
    broadcastLiveEvent({
      type: "package-reassign",
      restaurantId: target.restaurantId,
      courierId: target.assignedCourierId || null,
      message: "Paket yeniden otomatik atama havuzuna alindi.",
    });
    sendJson(res, 200, {
      ...decorateState(),
      auditLogs: getAuditLogs(20),
    });
    return;
  }

  const overrideMatch = pathname.match(/^\/api\/admin\/packages\/([^/]+)\/override$/);
  if (req.method === "POST" && overrideMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }

    const { json: body } = await readRequestBody(req);
    const courierId = trimmed(body.courierId || body.courier_id);
    if (!courierId) {
      sendJson(res, 400, { error: "courierId zorunludur." });
      return;
    }

    const result = adminAssignPackageToCourier(overrideMatch[1], courierId);
    rebalancePackages();
    writeAuditLog({
      actorRole: "admin",
      actorId: adminActorId(adminSession),
      action: "package_override_assigned",
      packageId: overrideMatch[1],
      details: result,
    });
    broadcastLiveEvent({
      type: "package-override",
      courierId: result.courierId,
      message: "Admin belirli paketi kuriyeye atadi.",
    });
    sendJson(res, 200, {
      ...decorateState(),
      auditLogs: getAuditLogs(20),
    });
    return;
  }

  const unassignMatch = pathname.match(/^\/api\/admin\/packages\/([^/]+)\/unassign$/);
  if (req.method === "POST" && unassignMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }

    const result = adminUnassignPackage(unassignMatch[1]);
    rebalancePackages();
    writeAuditLog({
      actorRole: "admin",
      actorId: adminActorId(adminSession),
      action: "package_unassigned",
      packageId: unassignMatch[1],
      details: result,
    });
    broadcastLiveEvent({
      type: "package-unassign",
      message: "Paketin kurye atamasi kaldirildi.",
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

    if (req.method === "GET" && pathname === "/health") {
      const state = currentState();
      sendJson(res, 200, {
        ok: true,
        app: "Delivera Express",
        env: NODE_ENV,
        secure: isSecureRequest(req),
        dbMode: "sqlite",
        dbFile: DB_FILE,
        assignmentRetryMs: ASSIGNMENT_RETRY_INTERVAL_MS,
        operations: {
          totalPackages: state.packages.length,
          waitingPackages: state.packages.filter((item) => [PENDING_STATUS, AWAITING_ASSIGNMENT_STATUS].includes(item.status)).length,
          activeCouriers: state.couriers.filter((item) => item.status === COURIER_ONLINE_STATUS || item.status === COURIER_BUSY_STATUS).length,
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (FORCE_HTTPS && !isSecureRequest(req) && req.headers.host) {
      res.writeHead(308, {
        Location: `${PUBLIC_BASE_URL || `https://${req.headers.host}`}${pathname}${requestUrl.search}`,
      });
      res.end();
      return;
    }

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

setInterval(() => {
  try {
    retryAwaitingAssignmentPackages();
  } catch {
    // Retry sweep should not crash the server loop.
  }
}, ASSIGNMENT_RETRY_INTERVAL_MS).unref();

server.listen(PORT, () => {
  console.log(`Delivera Express hazir: http://localhost:${PORT}`);
});
