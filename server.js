try {
  require("dotenv").config({ path: "./.env" });
} catch {
  try {
    const envFs = require("fs");
    const envPath = require("path").resolve(process.cwd(), ".env");
    if (envFs.existsSync(envPath)) {
      envFs.readFileSync(envPath, "utf8").split(/\r?\n/).forEach((line) => {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!match || match[1].startsWith("#") || process.env[match[1]] !== undefined) {
          return;
        }
        process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
      });
    }
  } catch {}
}
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const uploadsDir = path.resolve(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}
const { URL } = require("url");
const dbFacade = require("./db");
const { getDb, resolveDbFile, redisSync } = dbFacade;
const { runMigrations } = require("./scripts/migrate");
const { getPlatformAdapter, normalizePlatformKey } = require("./platform-adapters");
const platformConnectors = require("./connectors");
const logger = require("./services/logger");
const { createPlatformService } = require("./services/platformService");
const { createRateLimitStore } = require("./services/rateLimitStore");
const { createQueueService, JOB_TYPES } = require("./services/queueService");
const { createSessionRevocationService } = require("./services/sessionRevocationService");
const { sendPlatformStatusCallback } = require("./services/platformCallbackService");
const {
  createConnectionHealthService,
  HEALTH_STATUS,
  HEALTH_ERROR_CODES,
  buildHealthPayload,
  normalizeErrorCode,
} = require("./services/connectionHealthService");
const { verifyPlatformSignature } = require("./services/platformSignature");

const PORT = Number(process.env.PORT || 3000);
const DB_FILE = resolveDbFile();
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
const IS_PRODUCTION = NODE_ENV === "production";
const PUBLIC_BASE_URL = trimmed(process.env.PUBLIC_BASE_URL).replace(/\/+$/, "");
const CORS_ALLOWED_ORIGINS = String(process.env.DELIVERA_CORS_ORIGINS || process.env.CORS_ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => {
    const trimmedOrigin = origin.trim().replace(/\/+$/, "");
    if (!trimmedOrigin) return null;
    try {
      const url = new URL(trimmedOrigin.startsWith("http") ? trimmedOrigin : `https://${trimmedOrigin}`);
      return url.origin;
    } catch {
      logger.warn("Invalid CORS origin configured", { origin: trimmedOrigin });
      return null;
    }
  })
  .filter(Boolean);
const TRUST_PROXY = ["1", "true", "yes"].includes(String(process.env.TRUST_PROXY || "").toLowerCase());
const FORCE_HTTPS = ["1", "true", "yes"].includes(String(process.env.FORCE_HTTPS || "").toLowerCase());
const REDIS_URL = trimmed(process.env.REDIS_URL || process.env.DELIVERA_REDIS_URL);
const RATE_LIMITS = {
  integrations: { limit: 100, windowMs: RATE_LIMIT_WINDOW_MS },
  courierLogin: { limit: 10, windowMs: RATE_LIMIT_WINDOW_MS },
  adminLogin: { limit: 5, windowMs: RATE_LIMIT_WINDOW_MS },
  restaurantLogin: { limit: 20, windowMs: RATE_LIMIT_WINDOW_MS },
  platformOrder: { limit: 1000, windowMs: RATE_LIMIT_WINDOW_MS },
  quickPaste: { limit: 50, windowMs: RATE_LIMIT_WINDOW_MS },
  adminWrites: { limit: 500, windowMs: RATE_LIMIT_WINDOW_MS },
  courierStatus: { limit: 100, windowMs: RATE_LIMIT_WINDOW_MS },
  general: { limit: 1000, windowMs: RATE_LIMIT_WINDOW_MS },
};
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 200;

const DEFAULT_ZONES = ["Akdeniz", "Yenisehir", "Mezitli", "Toroslar", "Tarsus", "Erdemli"];
const SUPPORTED_PLATFORMS = ["Trendyol Yemek", "Yemeksepeti", "Getir Yemek", "Migros Yemek", "POS"];
const PLATFORM_SLUGS = {
  "Trendyol Yemek": "trendyol-yemek",
  Yemeksepeti: "yemeksepeti",
  "Getir Yemek": "getir-yemek",
  "Migros Yemek": "migros-yemek",
  POS: "pos",
};
const PLATFORM_ALIASES = {
  "trendyol go": "Trendyol Yemek",
  "trendyol yemek": "Trendyol Yemek",
  trendyol: "Trendyol Yemek",
  "getiryemek": "Getir Yemek",
  "getir yemek": "Getir Yemek",
  getir: "Getir Yemek",
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
const PLATFORM_CONFIGS = {
  "Trendyol Yemek": {
    platform: "Trendyol Yemek",
    mode: "polling",
    requiredFields: ["externalStoreId", "apiKey", "apiSecret"],
    optionalFields: ["token", "webhookSecret"],
    testStrategy: "polling",
    userFriendlyErrors: {
      missingCredentials: "Supplier ID, API Key ve API Secret girilmeli.",
    },
  },
  "Getir Yemek": {
    platform: "Getir Yemek",
    mode: "webhook",
    requiredFields: ["externalStoreId", "webhookSecret"],
    optionalFields: ["apiSecret"],
    testStrategy: "local_webhook",
    userFriendlyErrors: {
      missingCredentials: "Store/Restaurant ID ve Webhook Secret girilmeli.",
    },
  },
  Yemeksepeti: {
    platform: "Yemeksepeti",
    mode: "hybrid",
    requiredFields: ["externalStoreId", "webhookSecret"],
    optionalFields: ["apiKey", "apiSecret", "token"],
    testStrategy: "auto",
    userFriendlyErrors: {
      missingCredentials: "Vendor ID ve Webhook Secret girilmeli.",
    },
  },
};
const ASSIGNMENT_RETRY_INTERVAL_MS = Number(process.env.DELIVERA_ASSIGNMENT_RETRY_MS || 15_000);
const COURIER_OFFER_TIMEOUT_MS = Number(process.env.DELIVERA_COURIER_OFFER_TIMEOUT_MS || 45_000);
const PENDING_APPROVAL_STATUS = "pending_approval";
const PENDING_STATUS = "pending";
const PREPARING_STATUS = "preparing";
const AWAITING_ASSIGNMENT_STATUS = "awaiting_assignment";
const ASSIGNED_STATUS = "assigned";
const ACCEPTED_BY_COURIER_STATUS = "accepted_by_courier";
const ON_ROUTE_STATUS = "on_route";
const DELIVERED_STATUS = "delivered";
const FAILED_STATUS = "failed";
const REJECTED_STATUS = "rejected";
const CANCELED_STATUS = "cancelled";
const UNPAID_PAYMENT_STATUS = "unpaid";
const PAID_ONLINE_PAYMENT_STATUS = "paid_online";
const CASH_EXPECTED_PAYMENT_STATUS = "cash_expected";
const CASH_COLLECTED_PAYMENT_STATUS = "cash_collected";
const PAYMENT_ISSUE_STATUS = "payment_issue";
const CREDIT_CARD_PAYMENT_STATUS = "credit_card";
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
  [PENDING_APPROVAL_STATUS]: [PREPARING_STATUS, REJECTED_STATUS, CANCELED_STATUS],
  [PENDING_STATUS]: [AWAITING_ASSIGNMENT_STATUS, CANCELED_STATUS],
  [PREPARING_STATUS]: [ASSIGNED_STATUS, FAILED_STATUS, CANCELED_STATUS],
  [AWAITING_ASSIGNMENT_STATUS]: [ASSIGNED_STATUS, FAILED_STATUS, CANCELED_STATUS],
  [ASSIGNED_STATUS]: [AWAITING_ASSIGNMENT_STATUS, ACCEPTED_BY_COURIER_STATUS, FAILED_STATUS, CANCELED_STATUS],
  [ACCEPTED_BY_COURIER_STATUS]: [ON_ROUTE_STATUS, FAILED_STATUS, CANCELED_STATUS],
  [ON_ROUTE_STATUS]: [DELIVERED_STATUS, FAILED_STATUS, CANCELED_STATUS],
  [DELIVERED_STATUS]: [],
  [FAILED_STATUS]: [AWAITING_ASSIGNMENT_STATUS, CANCELED_STATUS],
  [REJECTED_STATUS]: [],
  [CANCELED_STATUS]: [],
};
const PLATFORM_POLL_INTERVAL_MS = Number(process.env.DELIVERA_PLATFORM_POLLING_INTERVAL_MS || process.env.DELIVERA_PLATFORM_POLL_INTERVAL_MS || 30_000);
const PLATFORM_POLLING_ENABLED = ["1", "true", "yes"].includes(String(process.env.DELIVERA_PLATFORM_POLLING_ENABLED || "").toLowerCase());
const ASSIGNMENT_DEBUG_LOGS = ["1", "true", "yes"].includes(String(process.env.DELIVERA_ASSIGNMENT_DEBUG || "").toLowerCase());
const PLATFORM_ORDER_STATUSES = new Set(["pending_approval", "approved", "assigned", "completed", "cancelled"]);
const COURIER_ALLOWED_STATUSES = new Set([ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS, DELIVERED_STATUS, FAILED_STATUS]);
const LEGACY_STATUS_MAP = {
  "Kurye Bekleniyor": AWAITING_ASSIGNMENT_STATUS,
  "Kurye Atandi": ASSIGNED_STATUS,
  "Kurye Yolda": ON_ROUTE_STATUS,
  "Teslim Edildi": DELIVERED_STATUS,
  "Teslim Edilemedi": FAILED_STATUS,
  "Iptal Edildi": CANCELED_STATUS,
  pending_approval: PENDING_APPROVAL_STATUS,
  waiting: AWAITING_ASSIGNMENT_STATUS,
  pending: PENDING_STATUS,
  preparing: PREPARING_STATUS,
  awaiting_assignment: AWAITING_ASSIGNMENT_STATUS,
  assigned: ASSIGNED_STATUS,
  accepted_by_courier: ACCEPTED_BY_COURIER_STATUS,
  picked_up: ON_ROUTE_STATUS,
  on_route: ON_ROUTE_STATUS,
  delivered: DELIVERED_STATUS,
  failed: FAILED_STATUS,
  rejected: REJECTED_STATUS,
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

const migrationSummary = runMigrations();
logger.info("Database migrations checked", {
  database: DB_FILE,
  applied: migrationSummary.applied?.length || 0,
  skipped: migrationSummary.skipped?.length || 0,
});

const db = getDb({ filename: DB_FILE });
const rateLimitStore = createRateLimitStore({ redisUrl: REDIS_URL, logger });
const queueService = createQueueService({ redisUrl: REDIS_URL, logger });
const sessionRevocationService = createSessionRevocationService({ redisUrl: REDIS_URL, logger });
const liveStreams = new Map();
const performanceMetrics = {
  startedAt: Date.now(),
  requestCount: 0,
  totalResponseTimeMs: 0,
  maxResponseTimeMs: 0,
  errorCount: 0,
  statusBuckets: {},
  recentResponseTimes: [],
};
const recentRequestLogs = [];
let assignmentSweepRunning = false;
let assignmentSweepQueued = false;
const assignmentRetryTimers = new Map();
let platformService = null;
let connectionHealthService = null;
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
    customer_lat REAL,
    customer_lng REAL,
    customer_address TEXT,
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
    assignment_tried_courier_ids_json TEXT,
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
    retry_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at TEXT,
    dead_lettered_at TEXT,
    last_error TEXT,
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

  CREATE TABLE IF NOT EXISTS platform_events (
    id TEXT PRIMARY KEY,
    platform_account_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS system_settings (
    id TEXT PRIMARY KEY,
    settings_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS platform_accounts (
    id TEXT PRIMARY KEY,
    restaurant_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    external_id TEXT,
    external_store_id TEXT NOT NULL,
    external_merchant_id TEXT,
    api_username TEXT,
    api_password TEXT,
    api_key TEXT,
    api_secret TEXT,
    token TEXT,
    store_front_code TEXT,
    chain_id TEXT,
    vendor_id TEXT,
    webhook_auth_type TEXT NOT NULL,
    webhook_api_key TEXT,
    webhook_username TEXT,
    webhook_password TEXT,
    static_token TEXT,
    webhook_secret TEXT,
    integration_reference_code TEXT,
    pos_secret_key TEXT,
    is_active INTEGER,
        last_sync_at TEXT,
        connection_status TEXT NOT NULL DEFAULT 'unknown',
        last_check_at TEXT,
        last_success_at TEXT,
        last_error_at TEXT,
        last_error_code TEXT,
        last_error_message TEXT,
        last_http_status INTEGER,
        last_latency_ms INTEGER,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_callback_at TEXT,
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

      CREATE TABLE IF NOT EXISTS platform_orders (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    platform_order_id TEXT NOT NULL,
    restaurant_id TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    address TEXT NOT NULL,
    total_price REAL NOT NULL DEFAULT 0,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'pending_approval',
    raw_payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(platform, platform_order_id, restaurant_id),
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

  CREATE TABLE IF NOT EXISTS notification_logs (
    id TEXT PRIMARY KEY,
    target_role TEXT NOT NULL,
    target_id TEXT,
    event_type TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS courier_shift_plans (
    id TEXT PRIMARY KEY,
    courier_id TEXT NOT NULL,
    zone TEXT NOT NULL,
    plan_date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'planned',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (courier_id) REFERENCES couriers(id)
  );

  CREATE TABLE IF NOT EXISTS cash_reconciliations (
    id TEXT PRIMARY KEY,
    courier_id TEXT NOT NULL,
    report_date TEXT NOT NULL,
    expected_cash REAL NOT NULL DEFAULT 0,
    reported_cash REAL NOT NULL DEFAULT 0,
    variance REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    package_ids_json TEXT NOT NULL,
    admin_note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (courier_id) REFERENCES couriers(id)
  );

  CREATE TABLE IF NOT EXISTS announcements (
    id TEXT PRIMARY KEY,
    target_role TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
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
if (!packageColumns.includes("customer_note")) {
  db.exec("ALTER TABLE packages ADD COLUMN customer_note TEXT");
}
if (!packageColumns.includes("items_json")) {
  db.exec("ALTER TABLE packages ADD COLUMN items_json TEXT");
}
if (!packageColumns.includes("raw_payload_json")) {
  db.exec("ALTER TABLE packages ADD COLUMN raw_payload_json TEXT");
}
if (!packageColumns.includes("customer_lat")) {
  db.exec("ALTER TABLE packages ADD COLUMN customer_lat REAL");
}
if (!packageColumns.includes("customer_lng")) {
  db.exec("ALTER TABLE packages ADD COLUMN customer_lng REAL");
}
if (!packageColumns.includes("customer_address")) {
  db.exec("ALTER TABLE packages ADD COLUMN customer_address TEXT");
}
if (!packageColumns.includes("platform_status_logs_json")) {
  db.exec("ALTER TABLE packages ADD COLUMN platform_status_logs_json TEXT");
}
if (!packageColumns.includes("assignment_tried_courier_ids_json")) {
  db.exec("ALTER TABLE packages ADD COLUMN assignment_tried_courier_ids_json TEXT");
}

const webhookLogColumns = db.prepare("PRAGMA table_info(webhook_logs)").all().map((row) => row.name);
if (!webhookLogColumns.includes("retry_count")) {
  db.exec("ALTER TABLE webhook_logs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0");
}
if (!webhookLogColumns.includes("next_retry_at")) {
  db.exec("ALTER TABLE webhook_logs ADD COLUMN next_retry_at TEXT");
}
if (!webhookLogColumns.includes("dead_lettered_at")) {
  db.exec("ALTER TABLE webhook_logs ADD COLUMN dead_lettered_at TEXT");
}
if (!webhookLogColumns.includes("last_error")) {
  db.exec("ALTER TABLE webhook_logs ADD COLUMN last_error TEXT");
}

const shiftPlanColumns = db.prepare("PRAGMA table_info(courier_shift_plans)").all().map((row) => row.name);
if (!shiftPlanColumns.includes("offer_expires_at")) {
  db.exec("ALTER TABLE courier_shift_plans ADD COLUMN offer_expires_at TEXT");
}
if (!shiftPlanColumns.includes("accepted_at")) {
  db.exec("ALTER TABLE courier_shift_plans ADD COLUMN accepted_at TEXT");
}
if (!shiftPlanColumns.includes("notified_at")) {
  db.exec("ALTER TABLE courier_shift_plans ADD COLUMN notified_at TEXT");
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
if (!platformAccountColumns.includes("external_id")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN external_id TEXT");
}
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
if (!platformAccountColumns.includes("access_token")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN access_token TEXT");
}
if (!platformAccountColumns.includes("refresh_token")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN refresh_token TEXT");
}
if (!platformAccountColumns.includes("token_expires_at")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN token_expires_at TEXT");
}
if (!platformAccountColumns.includes("callback_url")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN callback_url TEXT");
}
if (!platformAccountColumns.includes("auth_type")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN auth_type TEXT");
}
if (!platformAccountColumns.includes("webhook_secret")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN webhook_secret TEXT");
}
if (!platformAccountColumns.includes("token")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN token TEXT");
}
if (!platformAccountColumns.includes("integration_reference_code")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN integration_reference_code TEXT");
}
if (!platformAccountColumns.includes("pos_secret_key")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN pos_secret_key TEXT");
}
if (!platformAccountColumns.includes("is_active")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN is_active INTEGER");
}
if (!platformAccountColumns.includes("last_sync_at")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN last_sync_at TEXT");
}
if (!platformAccountColumns.includes("integration_ref_code")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN integration_ref_code TEXT");
}
if (!platformAccountColumns.includes("polling_enabled")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN polling_enabled INTEGER NOT NULL DEFAULT 0");
}
if (!platformAccountColumns.includes("webhook_enabled")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN webhook_enabled INTEGER NOT NULL DEFAULT 1");
}
if (!platformAccountColumns.includes("last_webhook_at")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN last_webhook_at TEXT");
}
if (!platformAccountColumns.includes("last_poll_at")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN last_poll_at TEXT");
}
if (!platformAccountColumns.includes("last_error")) {
  db.exec("ALTER TABLE platform_accounts ADD COLUMN last_error TEXT");
}
[
  ["connection_status", "TEXT NOT NULL DEFAULT 'unknown'"],
  ["last_check_at", "TEXT"],
  ["last_success_at", "TEXT"],
  ["last_error_at", "TEXT"],
  ["last_error_code", "TEXT"],
  ["last_error_message", "TEXT"],
  ["last_http_status", "INTEGER"],
  ["last_latency_ms", "INTEGER"],
  ["consecutive_failures", "INTEGER NOT NULL DEFAULT 0"],
  ["last_callback_at", "TEXT"],
].forEach(([columnName, definition]) => {
  if (!platformAccountColumns.includes(columnName)) {
    db.exec(`ALTER TABLE platform_accounts ADD COLUMN ${columnName} ${definition}`);
  }
});

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_orders_unique
  ON platform_orders (platform, platform_order_id, restaurant_id);

  CREATE INDEX IF NOT EXISTS idx_packages_restaurant_created
  ON packages (restaurant_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_packages_status_created
  ON packages (status, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_packages_zone_status
  ON packages (zone, status);

  CREATE INDEX IF NOT EXISTS idx_packages_assigned_status
  ON packages (assigned_courier_id, status, assigned_at);

  CREATE INDEX IF NOT EXISTS idx_packages_duplicate_lookup
  ON packages (restaurant_id, source, external_order_id);

  CREATE INDEX IF NOT EXISTS idx_packages_platform_lookup
  ON packages (restaurant_id, source_platform, external_order_id);

  CREATE INDEX IF NOT EXISTS idx_couriers_status_zone
  ON couriers (status, zone);

  CREATE INDEX IF NOT EXISTS idx_couriers_zone_status
  ON couriers (zone, status);

  CREATE INDEX IF NOT EXISTS idx_platform_accounts_lookup
  ON platform_accounts (platform, external_store_id, active, webhook_enabled);

  CREATE INDEX IF NOT EXISTS idx_platform_accounts_restaurant_updated
  ON platform_accounts (restaurant_id, updated_at DESC);

  CREATE INDEX IF NOT EXISTS idx_platform_orders_restaurant_status_created
  ON platform_orders (restaurant_id, status, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_audit_logs_restaurant_id_desc
  ON audit_logs (restaurant_id, id DESC);

  CREATE INDEX IF NOT EXISTS idx_webhook_logs_restaurant_id_desc
  ON webhook_logs (restaurant_id, id DESC);

  CREATE TABLE IF NOT EXISTS platform_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT,
    restaurant_id TEXT,
    platform_account_id TEXT,
    event_type TEXT NOT NULL,
    request_id TEXT,
    status TEXT NOT NULL,
    http_status INTEGER,
    error_code TEXT,
    error_message TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at TEXT,
    dead_lettered_at TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_platform_events_account_created
  ON platform_events (platform_account_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_platform_events_restaurant_created
  ON platform_events (restaurant_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_platform_events_type_status_created
  ON platform_events (event_type, status, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_platform_accounts_connection_status
  ON platform_accounts (connection_status, updated_at DESC);

  CREATE INDEX IF NOT EXISTS idx_notification_logs_target_created
  ON notification_logs (target_role, target_id, created_at DESC);
`);

const zoneInsert = db.prepare("INSERT OR IGNORE INTO zones (name) VALUES (?)");
DEFAULT_ZONES.forEach((zone) => zoneInsert.run(zone));

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function trackingNoExists(trackingNo) {
  return Boolean(db.prepare("SELECT 1 FROM packages WHERE tracking_no = ?").get(trackingNo));
}

function generateTrackingNo() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = `PKT-${Math.floor(100000 + Math.random() * 900000)}`;
    if (!trackingNoExists(candidate)) {
      return candidate;
    }
  }
  return `PKT-${Date.now()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
}

function ensureUniqueTrackingNo(preferred) {
  const incoming = trimmed(preferred);
  if (incoming && !trackingNoExists(incoming)) {
    return incoming;
  }
  return generateTrackingNo();
}

function json(value) {
  return JSON.stringify(value);
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  if (typeof value !== "string") {
    return value;
  }
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
  return PLATFORM_ALIASES[incoming] || SUPPORTED_PLATFORMS.find((platform) => platform.toLowerCase() === incoming) || "";
}

function normalizeIdList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((item) => trimmed(item)).filter(Boolean))];
}

function normalizePlatformInput(value) {
  const incoming = trimmed(value);
  return normalizePlatformName(incoming) || normalizePlatformFromSlug(incoming.replace(/_/g, "-"));
}

function platformSlug(platform) {
  return PLATFORM_SLUGS[platform] || trimmed(platform).toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function normalizePlatformFromSlug(value) {
  const incoming = trimmed(value).toLowerCase();
  return SUPPORTED_PLATFORMS.find((platform) => platformSlug(platform) === incoming) || "";
}

function platformConfig(platform) {
  const normalizedPlatform = normalizePlatformInput(platform);
  return PLATFORM_CONFIGS[normalizedPlatform] || {
    platform: normalizedPlatform || trimmed(platform),
    mode: "webhook",
    requiredFields: ["externalStoreId", "webhookSecret"],
    optionalFields: ["apiKey", "apiSecret", "token"],
    testStrategy: "local_webhook",
    userFriendlyErrors: {},
  };
}

function platformModeFlags(platform) {
  const config = platformConfig(platform);
  return {
    config,
    webhookEnabled: config.mode === "webhook" || config.mode === "hybrid",
    pollingEnabled: config.mode === "polling" || config.mode === "hybrid",
  };
}

function platformFriendlyError(message = "", platform = "") {
  const text = trimmed(message);
  if (!text) {
    return "";
  }
  if (/Restaurant\/platform match failed|Restaurant not found/i.test(text)) {
    return "Restoran ID bu platformla eşleşmedi. Gerçek Store/Restaurant ID girilmeli.";
  }
  if (/Polling endpoint ayarl|Polling endpoint not configured|verify\/polling endpoint tanimli degil|endpoint tanimli degil/i.test(text)) {
    return "Bu platform polling desteklemiyor. Webhook modu kullanılacak.";
  }
  if (/API eri|yetki kapal|403/i.test(text)) {
    return "Bu restoran için API yetkisi kapalı. Platform panelinden API/POS entegrasyon izni açılmalı.";
  }
  if (/Unauthorized|401|API Key veya API Secret hatal/i.test(text)) {
    return "API Key, Secret veya Token hatalı olabilir.";
  }
  if (/API bilgileri eksik|credentials|missing/i.test(text)) {
    return platformConfig(platform).userFriendlyErrors.missingCredentials || "Platform bağlantı bilgileri eksik.";
  }
  return text;
}

function testStrategyForAccount(account) {
  const config = platformConfig(account?.platform);
  if (config.testStrategy === "auto") {
    return account?.pollingEnabled && !platformAccountMissingCredentials(account) ? "polling" : "local_webhook";
  }
  return config.testStrategy;
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

  if (payload.packageType && trimmed(payload.packageType).length > 60) {
    errors.push("Paket tipi en fazla 60 karakter olabilir.");
  }

  const orderAmount = Number(payload.orderAmount);
  if (Number.isNaN(orderAmount) || orderAmount <= 0) {
    errors.push("Paket tutari 0'dan buyuk olmali.");
  }

  if (payload.customerName && trimmed(payload.customerName).length < 2) {
    errors.push("Musteri adi en az 2 karakter olmali.");
  }

  if (payload.phone) {
    const phoneDigits = trimmed(payload.phone).replace(/\D/g, "");
    if (phoneDigits.length > 0 && phoneDigits.length < 10) {
      errors.push("Telefon numarasi en az 10 haneli olmali.");
    }
  }

  return errors;
}

function normalizeQuickPasteText(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .trim();
}

function findQuickPasteLabeledValue(text, labels = []) {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = text.match(new RegExp(`${escaped}\\s*[:\\-]?\\s*(.+)`, "i"));
    if (match?.[1]) {
      const value = match[1].split("\n")[0].trim();
      if (value) {
        return value;
      }
    }
  }
  return "";
}

function parseQuickPasteText(rawText) {
  const text = normalizeQuickPasteText(rawText);
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const phoneMatch = text.match(/(?:\+?90\s*)?(05\d[\d\s-]{8,})/);
  const phone = phoneMatch
    ? phoneMatch[1].replace(/[^\d]/g, "").replace(/^90(?=5)/, "")
    : "";
  const customerName = findQuickPasteLabeledValue(text, ["Musteri", "Müşteri", "Ad Soyad", "Adı Soyadı", "Alici", "Alıcı"]);
  const paymentMethod = (() => {
    const labeled = findQuickPasteLabeledValue(text, ["Odeme", "Ödeme", "Odeme Tipi", "Ödeme Tipi"]);
    if (labeled) {
      return labeled;
    }
    if (/nakit kapida|kapida nakit|nakit/i.test(text)) {
      return "Nakit";
    }
    if (/online|kart|kredi karti|kredi kartı|pos/i.test(text)) {
      return "Online Odeme";
    }
    return "";
  })();
  const customerNote = findQuickPasteLabeledValue(text, ["Not", "Aciklama", "Açıklama", "Kurye Notu", "Musteri Notu", "Müşteri Notu"]);
  const amountMatch = text.match(/(?:toplam|tutar|odeme|ödeme)\s*[:\-]?\s*[₺₸]?\s*([\d\.,]+)/i) || text.match(/[₺₸]\s*([\d\.,]+)/);
  const orderAmount = amountMatch?.[1]
    ? Number(String(amountMatch[1]).replace(/\./g, "").replace(",", "."))
    : 0;
  const packageType = findQuickPasteLabeledValue(text, ["Paket Tipi", "Urun", "Ürün", "Siparis", "Sipariş"]) || "Hizli Platform Siparisi";
  const labeledAddress = findQuickPasteLabeledValue(text, ["Adres", "Teslimat Adresi", "Musteri Adresi", "Müşteri Adresi"]);
  const longAddressLine = lines
    .filter((line) => line.length >= 18 && !/^(telefon|odeme|ödeme|musteri|müşteri|not|aciklama|açıklama|toplam|tutar)\b/i.test(line))
    .sort((left, right) => right.length - left.length)[0] || "";
  const customerAddress = labeledAddress || longAddressLine;

  return {
    customerName,
    phone,
    customerAddress,
    paymentMethod,
    customerNote,
    packageType,
    orderAmount,
  };
}

function buildRestaurantPackageRecord(restaurantRow, draft = {}, options = {}) {
  const createdAt = nowIso();
  const externalOrderId = options.externalOrderId || `MANUAL-${Date.now()}`;
  const normalizedSource = normalizePlatformKey(draft.source);
  const isQuickPasteOrder = ["platform_manual", "platform_extension", "platform_extension_auto"].includes(normalizedSource);
  const targetSourcePlatform = draft.sourcePlatform || (isQuickPasteOrder ? "Hizli Yapistir" : "Dis Manuel Paket");
  const targetPaymentMethod = draft.paymentMethod || "Panel Kaydi";

  return {
    id: uid("pkg"),
    trackingNo: generateTrackingNo(),
    restaurantId: restaurantRow.id,
    source: isQuickPasteOrder
      ? (normalizedSource === "platform_extension_auto"
        ? "platform_extension_auto"
        : normalizedSource === "platform_extension"
          ? "platform_extension"
          : "platform_manual")
      : "external_manual",
    deliveryAddress: draft.deliveryAddress || "-",
    packageType: draft.packageType || "Standart Paket",
    sourcePlatform: targetSourcePlatform,
    externalOrderNo: externalOrderId,
    externalOrderId,
    recipient: draft.customerName || restaurantRow.name,
    phone: draft.phone || "-",
    address: draft.deliveryAddress || "-",
    customerAddress: draft.customerAddress || draft.deliveryAddress || "-",
    customerLatitude: null,
    customerLongitude: null,
    zone: restaurantRow.zone,
    eta: "Planlanacak",
    paymentMethod: targetPaymentMethod,
    orderAmount: draft.orderAmount,
    paymentStatus: normalizePaymentStatus("", targetPaymentMethod),
    latitude: restaurantRow.x,
    longitude: restaurantRow.y,
    note: isQuickPasteOrder
      ? `${draft.packageType} hizli siparis yapistir ile olusturuldu.${draft.rawText ? " Ham metin kaydi var." : ""}`
      : `${draft.packageType} restoran panelinden olusturuldu.`,
    customerNote: draft.customerNote,
    rawPayload: draft.rawText ? { quickPasteText: draft.rawText } : null,
    status: draft.requestedStatus || AWAITING_ASSIGNMENT_STATUS,
    assignmentStatus: "unassigned",
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
    assignmentReason: isQuickPasteOrder
      ? "Hizli siparis kaydi alindi, restoran onayi bekliyor."
      : "Yeni manuel paket kaydi alindi, restoran onayi bekliyor.",
    createdAt,
    updatedAt: createdAt,
  };
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
  const platform = normalizePlatformInput(body.platform);
  const externalStoreId = trimmed(body.externalStoreId ?? body.external_store_id ?? body.platformRestaurantId ?? body.platform_restaurant_id);
  const webhookSecret = trimmed(
    body.webhookSecret ??
    body.webhook_secret ??
    body.staticToken ??
    body.static_token ??
    body.apiKey ??
    body.apiPassword
  );

  if (!restaurantId) {
    throw validationError("restaurant_id zorunludur.");
  }

  if (!platform) {
    throw validationError("Desteklenen bir platform secmelisin.");
  }

  if (!externalStoreId) {
    throw validationError("Platform store/vendor kimligi zorunludur.");
  }

  const config = platformConfig(platform);
  const normalizedWebhookSecret = webhookSecret || createWebhookSecret();
  const normalizedApiSecret = platform === "POS"
    ? trimmed(body.apiSecret ?? body.api_secret ?? body.webhookSecret ?? body.webhook_secret)
    : trimmed(body.apiSecret ?? body.api_secret);
  const flags = platformModeFlags(platform);

  return {
    restaurantId,
    platform,
    platformConfig: config,
    mode: config.mode,
    testStrategy: config.testStrategy,
    externalStoreId,
    externalId: externalStoreId,
    externalMerchantId: trimmed(body.externalMerchantId ?? body.external_merchant_id),
    apiUsername: trimmed(body.apiUsername),
    apiPassword: String(body.apiPassword || ""),
    apiKey: trimmed(body.apiKey),
    apiSecret: normalizedApiSecret,
    accessToken: trimmed(body.accessToken ?? body.token),
    token: trimmed(body.token ?? body.accessToken),
    refreshToken: trimmed(body.refreshToken),
    tokenExpiresAt: trimmed(body.tokenExpiresAt),
    callbackUrl: trimmed(body.callbackUrl),
    integrationReferenceCode: trimmed(body.integrationRefCode ?? body.integration_ref_code ?? body.integrationReferenceCode ?? body.integration_reference_code),
    posSecretKey: trimmed(body.posSecretKey ?? body.pos_secret_key),
    storeFrontCode: trimmed(body.storeFrontCode),
    chainId: trimmed(body.chainId),
    vendorId: trimmed(body.vendorId),
    authType: trimmed(body.authType || body.auth_type || body.webhookAuthType) || PLATFORM_WEBHOOK_AUTH_TYPES.STATIC_TOKEN,
    webhookAuthType: PLATFORM_WEBHOOK_AUTH_TYPES.STATIC_TOKEN,
    webhookApiKey: "",
    webhookUsername: "",
    webhookPassword: "",
    staticToken: normalizedWebhookSecret,
    webhookSecret: normalizedWebhookSecret,
    pollingEnabled: flags.pollingEnabled,
    webhookEnabled: flags.webhookEnabled,
    active: body.active !== false,
    settings: {
      ...(typeof body.settings === "object" && body.settings ? body.settings : {}),
      platformMode: config.mode,
      testStrategy: config.testStrategy,
      requiredFields: config.requiredFields,
    },
  };
}

function normalizeIncomingOrderItems(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item, index) => {
      const name = trimmed(item?.name ?? item?.productName ?? item?.title ?? item?.product);
      const quantity = Number(item?.quantity ?? item?.qty ?? item?.count ?? 1);
      const price = normalizeMoney(item?.price ?? item?.unitPrice ?? item?.totalPrice ?? 0);
      return {
        id: trimmed(item?.id) || `item-${index + 1}`,
        name: name || `Urun ${index + 1}`,
        quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
        price,
      };
    })
    .filter((item) => item.name);
}

function normalizeOrder(platform, rawBody) {
  const normalizedPlatform = normalizePlatformInput(platform);
  const adapter = getPlatformAdapter(normalizePlatformKey(normalizedPlatform || platform));
  const normalized = adapter.normalizeOrder(rawBody || {});
  const canonical = {
    ...normalized,
    platform: normalizedPlatform,
    platformRestaurantId: trimmed(normalized.platformRestaurantId),
    orderId: trimmed(normalized.orderId),
    customerName: trimmed(normalized.customerName),
    phone: trimmed(normalized.phone),
    address: trimmed(normalized.address),
    items: normalizeIncomingOrderItems(normalized.items),
    totalPrice: normalizeMoney(normalized.totalPrice),
    paymentMethod: trimmed(normalized.paymentMethod) || "Online Odeme",
    customerNote: trimmed(normalized.customerNote),
    customerLatitude: Number.isFinite(Number(normalized.customerLatitude)) ? Number(normalized.customerLatitude) : null,
    customerLongitude: Number.isFinite(Number(normalized.customerLongitude)) ? Number(normalized.customerLongitude) : null,
    customerAddress: trimmed(normalized.customerAddress || normalized.address),
    rawPayload: normalized.rawPayload || rawBody || {},
  };

  if (
    !canonical.platform ||
    !canonical.platformRestaurantId ||
    !canonical.orderId ||
    !canonical.customerName ||
    !canonical.phone ||
    !canonical.address ||
    canonical.totalPrice <= 0
  ) {
    throw validationError("Platform siparis verisi eksik.");
  }

  return canonical;
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
  const restaurantId = trimmed(body.restaurantId ?? body.restaurant_id ?? body.headerRestaurantId ?? body.header_restaurant_id);
  const apiKey = trimmed(body.apiKey ?? body.api_key ?? body.headerApiKey ?? body.header_api_key);

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
  const items = Array.isArray(body.items) ? body.items : [];
  const pkg = {
    id: uid("pkg"),
    trackingNo: generateTrackingNo(),
    restaurantId: restaurant.id,
    source: trimmed(body.source) || "platform_webhook",
    sourcePlatform: trimmed(body.sourcePlatform),
    externalOrderNo: trimmed(body.externalOrderNo),
    externalOrderId: trimmed(body.externalOrderId || body.externalOrderNo),
    recipient: trimmed(body.recipient),
    phone: trimmed(body.phone),
    address: trimmed(body.address),
    zone: trimmed(body.zone || restaurant.zone),
    eta: trimmed(body.eta) || `${suggestedRestaurantPrepMinutes(trimmed(body.zone || restaurant.zone))} dk`,
    paymentMethod,
    orderAmount: normalizeMoney(body.orderAmount ?? body.amount ?? body.totalAmount ?? body.total_price),
    paymentStatus: normalizePaymentStatus(body.paymentStatus, paymentMethod),
    latitude: Number(body.latitude ?? body.x ?? restaurant.latitude),
    longitude: Number(body.longitude ?? body.y ?? restaurant.longitude),
    note: trimmed(body.note),
    customerNote: trimmed(body.customerNote ?? body.customer_note),
    customerLatitude: Number.isFinite(Number(body.customerLatitude ?? body.customer_lat ?? body.customerLat))
      ? Number(body.customerLatitude ?? body.customer_lat ?? body.customerLat)
      : null,
    customerLongitude: Number.isFinite(Number(body.customerLongitude ?? body.customer_lng ?? body.customerLng))
      ? Number(body.customerLongitude ?? body.customer_lng ?? body.customerLng)
      : null,
    customerAddress: trimmed(body.customerAddress ?? body.customer_address ?? body.address),
    items,
    rawPayload: body.rawPayload ?? body.raw_payload ?? null,
    status: trimmed(body.status) ? normalizeStatus(body.status) : PENDING_STATUS,
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

function normalizeFeederIntegrationDraft(body) {
  const customer = body?.customer && typeof body.customer === "object" ? body.customer : {};
  const addressValue = body?.address;
  const address =
    typeof addressValue === "object" && addressValue !== null
      ? trimmed(addressValue.full || addressValue.text || addressValue.address || addressValue.line1)
      : trimmed(addressValue);
  const orderId = trimmed(body.orderId ?? body.order_id ?? body.externalOrderId ?? body.external_order_id);
  const platform = normalizePlatformInput(body.platform ?? body.sourcePlatform ?? body.source_platform);
  const customerName = trimmed(body.customerName ?? body.customer_name ?? customer.name ?? customer.fullName ?? customer.full_name);
  const phone = trimmed(body.phone ?? customer.phone ?? customer.phoneNumber ?? customer.phone_number);
  const price = normalizeMoney(body.price ?? body.totalPrice ?? body.total_price ?? body.orderAmount ?? body.amount);

  if (!trimmed(body.restaurantId ?? body.restaurant_id)) {
    throw validationError("restaurantId zorunludur.");
  }
  if (!orderId || !customerName || !phone || !address || price <= 0 || !platform) {
    throw validationError("orderId, customer, address, price ve platform zorunludur.");
  }

  return {
    restaurantId: trimmed(body.restaurantId ?? body.restaurant_id),
    source: "platform_api",
    sourcePlatform: platform,
    externalOrderNo: orderId,
    externalOrderId: orderId,
    recipient: customerName,
    phone,
    address,
    zone: trimmed(body.zone),
    paymentMethod: trimmed(body.paymentMethod ?? body.payment_method) || "Online Odeme",
    orderAmount: price,
    amount: price,
    items: normalizeIncomingOrderItems(body.items),
    note: trimmed(body.note),
    customerNote: trimmed(body.customerNote ?? body.customer_note),
    customerLatitude: body.customerLatitude ?? body.customer_lat ?? body.customerLat,
    customerLongitude: body.customerLongitude ?? body.customer_lng ?? body.customerLng,
    customerAddress: trimmed(body.customerAddress ?? body.customer_address) || address,
    latitude: body.latitude ?? body.x,
    longitude: body.longitude ?? body.y,
    rawPayload: body.rawPayload ?? body.raw_payload ?? body,
  };
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
  if ([UNPAID_PAYMENT_STATUS, PAID_ONLINE_PAYMENT_STATUS, CASH_EXPECTED_PAYMENT_STATUS, CASH_COLLECTED_PAYMENT_STATUS, PAYMENT_ISSUE_STATUS, CREDIT_CARD_PAYMENT_STATUS].includes(incoming)) {
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

function suggestedRestaurantPrepMinutes(zone, state = null) {
  const activeStatuses = [PENDING_APPROVAL_STATUS, PENDING_STATUS, PREPARING_STATUS, AWAITING_ASSIGNMENT_STATUS, ASSIGNED_STATUS, ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS];
  let packageCount = 0;
  let busyCouriers = 0;
  let onlineCouriers = 0;

  if (state) {
    packageCount = state.packages.filter((pkg) => pkg.zone === zone && activeStatuses.includes(normalizeStatus(pkg.status))).length;
    const zoneCouriers = state.couriers.filter((courier) => courier.zone === zone);
    busyCouriers = zoneCouriers.filter((courier) => normalizeCourierStatus(courier.status, courier.available) === COURIER_BUSY_STATUS).length;
    onlineCouriers = zoneCouriers.filter((courier) => normalizeCourierStatus(courier.status, courier.available) === COURIER_ONLINE_STATUS).length;
  } else {
    packageCount = db.prepare(`
      SELECT COUNT(*) AS count FROM packages
      WHERE zone = ? AND status IN (${activeStatuses.map(() => "?").join(",")})
    `).get(zone, ...activeStatuses).count;
    busyCouriers = countTable("couriers", "zone = ? AND status = ?", [zone, COURIER_BUSY_STATUS]);
    onlineCouriers = countTable("couriers", "zone = ? AND status = ?", [zone, COURIER_ONLINE_STATUS]);
  }

  const pressure = packageCount + (busyCouriers * 2) - onlineCouriers;
  return Math.max(5, Math.min(15, 5 + Math.max(0, pressure)));
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
  if (normalized === PENDING_APPROVAL_STATUS) {
    return "pending_approval";
  }
  if (normalized === PREPARING_STATUS) {
    return "waiting_courier";
  }
  if (normalized === ASSIGNED_STATUS || normalized === ACCEPTED_BY_COURIER_STATUS || normalized === ON_ROUTE_STATUS || normalized === DELIVERED_STATUS) {
    return "assigned";
  }
  if (normalized === FAILED_STATUS) {
    return "failed";
  }
  if (normalized === REJECTED_STATUS) {
    return "rejected";
  }
  if (normalized === CANCELED_STATUS) {
    return "cancelled";
  }
  return "pending";
}

function nowIso() {
  return new Date().toISOString();
}

function plusHoursIso(value, hours) {
  const base = new Date(value);
  base.setHours(base.getHours() + hours);
  return base.toISOString();
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

function isLocalHostRequest(req) {
  const hostHeader = String(req?.headers?.host || "").toLowerCase();
  const host = hostHeader.startsWith("[")
    ? hostHeader.slice(1, hostHeader.indexOf("]"))
    : hostHeader.split(":")[0];
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
}

function requestBaseUrl(req) {
  if (PUBLIC_BASE_URL) {
    return PUBLIC_BASE_URL;
  }

  const host = req?.headers?.host || `localhost:${PORT}`;
  return `${requestProtocol(req)}://${host}`;
}

function originForCors(req) {
  const origin = trimmed(req?.headers?.origin).replace(/\/+$/, "");
  if (!origin) {
    return "";
  }

  if (CORS_ALLOWED_ORIGINS.includes("*") || CORS_ALLOWED_ORIGINS.includes(origin)) {
    return origin;
  }

  try {
    const originUrl = new URL(origin);
    if (originUrl.host === req?.headers?.host || originUrl.origin === new URL(requestBaseUrl(req)).origin) {
      return origin;
    }
  } catch {}

  return "";
}

async function applyRateLimit(req, scope, rule) {
  const key = `${scope}:${clientIp(req)}`;
  const result = await rateLimitStore.increment(key, rule);
  if (result.limited) {
    logger.warn("Rate limit exceeded", {
      scope,
      ip: clientIp(req),
      retryAfter: result.retryAfter,
      requestId: req.requestId,
      store: rateLimitStore.health().mode,
    });
  }
  return result.limited ? result.retryAfter : null;
}

function productionDisabled(res) {
  sendJson(res, 404, { error: "Bu islem production ortaminda kullanilamaz." });
}

function sendRateLimited(res, retryAfter) {
  res.setHeader("Retry-After", String(retryAfter));
  sendJson(res, 429, {
    ok: false,
    error: "Too many requests",
    code: "rate_limited",
    retryAfter,
  });
}

function writeSecurityHeaders(res) {
  const req = res._deliveraRequest;
  const corsOrigin = originForCors(req);
  if (corsOrigin) {
    res.setHeader("Access-Control-Allow-Origin", corsOrigin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", req?.headers?.["access-control-request-headers"] || "Content-Type, Authorization, X-API-Key, X-Platform-Secret, X-Webhook-Secret");
  }
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
    return {
      ...safeRestaurant,
      apiKey: restaurant.apiKey ? "Kayitli" : "",
      webhookSecret: restaurant.webhookSecret ? "Kayitli" : "",
      hasApiKey: Boolean(restaurant.apiKey),
      hasWebhookSecret: Boolean(restaurant.webhookSecret),
    };
  }

  const { apiKey, webhookSecret, ...publicRestaurant } = safeRestaurant;
  return {
    ...publicRestaurant,
    hasApiKey: Boolean(apiKey),
    hasWebhookSecret: Boolean(webhookSecret),
  };
}

function maskSecret(value) {
  const secret = trimmed(value);
  if (!secret) {
    return "";
  }
  if (secret.length <= 6) {
    return "****";
  }
  return `${secret.slice(0, 2)}****${secret.slice(-2)}`;
}

function sanitizePlatformAccount(account, includeSecrets = false) {
  const config = platformConfig(account.platform);
  const safeAccount = {
    id: account.id,
    restaurantId: account.restaurantId,
    platform: account.platform,
    platformSlug: platformSlug(account.platform),
    externalId: account.externalId,
    externalStoreId: account.externalStoreId,
    externalMerchantId: account.externalMerchantId,
    apiUsername: account.apiUsername,
    hasApiKey: Boolean(account.apiKey),
    hasApiSecret: Boolean(account.apiSecret),
    hasToken: Boolean(account.token || account.accessToken),
    hasPosSecretKey: Boolean(account.posSecretKey),
    storeFrontCode: account.storeFrontCode,
    chainId: account.chainId,
    vendorId: account.vendorId,
    integrationReferenceCode: account.integrationReferenceCode,
    integrationRefCode: account.integrationRefCode || account.integrationReferenceCode,
    webhookAuthType: account.webhookAuthType,
    authType: account.authType || account.webhookAuthType,
    callbackUrl: account.callbackUrl || "",
    webhookId: account.webhookId,
    settings: account.settings,
    mode: account.settings?.platformMode || config.mode,
    testStrategy: account.settings?.testStrategy || config.testStrategy,
    requiredFields: config.requiredFields,
    optionalFields: config.optionalFields,
    active: account.active,
    lastSyncAt: account.lastSyncAt,
    pollingEnabled: Boolean(account.pollingEnabled),
    webhookEnabled: account.webhookEnabled !== false,
    lastWebhookAt: account.lastWebhookAt || null,
    lastPollAt: account.lastPollAt || account.lastSyncAt || null,
    lastError: account.lastError || "",
    connectionStatus: account.connectionStatus || HEALTH_STATUS.UNKNOWN,
    connectionHealth: buildHealthPayload(account),
    lastCheckAt: account.lastCheckAt || null,
    lastSuccessAt: account.lastSuccessAt || null,
    lastErrorAt: account.lastErrorAt || null,
    lastErrorCode: account.lastErrorCode || "",
    lastErrorMessage: account.lastErrorMessage || "",
    lastHttpStatus: account.lastHttpStatus ?? null,
    lastLatencyMs: account.lastLatencyMs ?? null,
    consecutiveFailures: account.consecutiveFailures || 0,
    lastCallbackAt: account.lastCallbackAt || null,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };

  if (!includeSecrets) {
    return safeAccount;
  }

  return {
    ...safeAccount,
    hasApiPassword: Boolean(account.apiPassword),
    tokenExpiresAt: account.tokenExpiresAt,
    webhookUsername: account.webhookUsername,
    hasWebhookPassword: Boolean(account.webhookPassword),
    hasStaticToken: Boolean(account.staticToken),
    hasWebhookSecret: Boolean(account.webhookSecret),
    hasRefreshToken: Boolean(account.refreshToken),
    verificationStatus: account.verificationStatus,
    verificationNote: account.verificationNote,
    lastVerificationAt: account.lastVerificationAt,
    verifiedAt: account.verifiedAt,
    lastValidationMode: account.lastValidationMode,
    webhookSecret: account.webhookSecret || account.staticToken || "",
  };
}

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) {
    return header.slice(7).trim();
  }

  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader.match(/(?:^|;)\s*delivera_session\s*=\s*([^;]+)/);
  if (match) {
    return decodeURIComponent(match[1]).trim();
  }

  return "";
}

function setSessionCookie(res, token) {
  const secure = FORCE_HTTPS ? "; Secure" : "";
  const maxAge = Math.floor(REFRESH_TOKEN_MAX_AGE_MS / 1000);
  res.setHeader("Set-Cookie", `delivera_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}

function clearSessionCookie(res) {
  const secure = FORCE_HTTPS ? "; Secure" : "";
  res.setHeader("Set-Cookie", `delivera_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure}`);
}

function isSessionExpired(createdAt, maxAgeMs) {
  const createdMs = new Date(createdAt).getTime();
  if (Number.isNaN(createdMs)) {
    return true;
  }

  return Date.now() - createdMs > maxAgeMs;
}

function sessionActorLookup(tableName) {
  if (tableName === "admin_sessions") {
    return { actorColumn: "admin_id", actorTable: "admins" };
  }
  if (tableName === "restaurant_sessions") {
    return { actorColumn: "restaurant_id", actorTable: "restaurants" };
  }
  if (tableName === "courier_sessions") {
    return { actorColumn: "courier_id", actorTable: "couriers" };
  }
  return null;
}

function isSessionActorValid(tableName, session) {
  const lookup = sessionActorLookup(tableName);
  if (!lookup || !session?.[lookup.actorColumn]) {
    return false;
  }
  return Boolean(db.prepare(`SELECT id FROM ${lookup.actorTable} WHERE id = ?`).get(session[lookup.actorColumn]));
}

function purgeSessionRecord(tableName, tokenColumn, token, cacheKey = "") {
  db.prepare(`DELETE FROM ${tableName} WHERE ${tokenColumn} = ?`).run(token);
  if (REDIS_URL && cacheKey) {
    redisSync.del(cacheKey);
  }
}

function getSessionByToken(tableName, tokenColumn, token, maxAgeMs) {
  if (!token) {
    return null;
  }

  const cacheKey = `delivera:session:${tableName}:${token}`;
  if (REDIS_URL) {
    const cached = redisSync.get(cacheKey);
    if (cached) {
      try {
        const session = JSON.parse(cached);
        if (!isSessionExpired(session.created_at, maxAgeMs) && isSessionActorValid(tableName, session)) {
          return session;
        }
        purgeSessionRecord(tableName, tokenColumn, token, cacheKey);
        return null;
      } catch (err) {
        // fallback
      }
    }
  }

  const session = db.prepare(`SELECT * FROM ${tableName} WHERE ${tokenColumn} = ?`).get(token) || null;
  if (!session) {
    return null;
  }

  if (isSessionExpired(session.created_at, maxAgeMs)) {
    purgeSessionRecord(tableName, tokenColumn, token, cacheKey);
    return null;
  }

  if (!isSessionActorValid(tableName, session)) {
    purgeSessionRecord(tableName, tokenColumn, token, cacheKey);
    return null;
  }

  if (REDIS_URL) {
    const ttlSeconds = Math.max(60, Math.floor(maxAgeMs / 1000));
    redisSync.set(cacheKey, JSON.stringify(session), ttlSeconds);
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

  if (REDIS_URL) {
    try {
      const oldSessions = db.prepare(`SELECT token FROM ${sessionConfig.tableName} WHERE ${sessionConfig.actorColumn} = ?`).all(actorId);
      oldSessions.forEach((s) => {
        redisSync.del(`delivera:session:${sessionConfig.tableName}:${s.token}`);
      });
    } catch (err) {}
  }

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

  const sessionConfig = sessionConfigByRole(actorRole);
  const lookup = sessionActorLookup(sessionConfig.tableName);
  const actorExists = lookup
    ? Boolean(db.prepare(`SELECT id FROM ${lookup.actorTable} WHERE id = ?`).get(refreshRow.actor_id))
    : false;
  if (!actorExists) {
    db.prepare("DELETE FROM refresh_tokens WHERE id = ?").run(refreshRow.id);
    throw httpError(401, "Kayit bulunamadi, lutfen tekrar giris yapin.");
  }

  db.prepare("DELETE FROM refresh_tokens WHERE id = ?").run(refreshRow.id);
  return issueSessionPair(actorRole, refreshRow.actor_id, req);
}

function revokeAccessToken(tableName, token) {
  if (!token) {
    return;
  }

  db.prepare(`DELETE FROM ${tableName} WHERE token = ?`).run(token);
  if (REDIS_URL) {
    redisSync.del(`delivera:session:${tableName}:${token}`);
  }
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
  
  const tableMap = { "admin": "admins", "restaurant": "restaurants", "courier": "couriers" };
  const table = tableMap[actorRole];
  
  if (!table) {
    throw httpError(400, "Desteklenmeyen kullanici rolu.");
  }
  
  // 1. Revoke all refresh tokens
  revokeRefreshTokens(actorRole, actorId);
  
  const sessionConfig = sessionConfigByRole(actorRole);
  
  // 2. Delete all active sessions (access tokens)
  if (sessionConfig && sessionConfig.tableName) {
    if (REDIS_URL) {
      try {
        const oldSessions = db.prepare(`SELECT token FROM ${sessionConfig.tableName} WHERE ${sessionConfig.actorColumn} = ?`).all(actorId);
        oldSessions.forEach((s) => {
          redisSync.del(`delivera:session:${sessionConfig.tableName}:${s.token}`);
        });
      } catch (err) {}
    }
    db.prepare(`DELETE FROM ${sessionConfig.tableName} WHERE ${sessionConfig.actorColumn} = ?`).run(actorId);
  }
  
  // 3. Update password hash
  db.prepare(`UPDATE ${table} SET password_hash = ?, password_salt = ? WHERE id = ?`)
    .run(passwordInfo.hash, passwordInfo.salt, actorId);
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
  const startTime = Date.now();
  
  const row = db.prepare(`
    SELECT * FROM password_reset_tokens
    WHERE actor_role = ? AND token_hash = ? AND used_at IS NULL
  `).get(actorRole, tokenHash);

  let isValid = false;
  let errorMsg = "Reset token gecersiz veya suresi dolmus.";

  if (row) {
    const expiresAtMs = new Date(row.expires_at).getTime();
    if (!Number.isNaN(expiresAtMs) && expiresAtMs > Date.now()) {
      isValid = true;
    } else {
      db.prepare("DELETE FROM password_reset_tokens WHERE id = ?").run(row.id);
    }
  }

  if (!isValid) {
    // Timing attack mitigation: add random delay to normalize response time
    const elapsed = Date.now() - startTime;
    // Timing attack mitigation removed to prevent blocking or sync issues
    throw httpError(400, errorMsg);
  }

  db.prepare("UPDATE password_reset_tokens SET used_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
  return row;
}

function logPasswordReset(actorRole, username, token) {
  const line = `[${new Date().toISOString()}] role=${actorRole} username=${username} token=${token}\n`;
  fs.appendFileSync(PASSWORD_RESET_LOG_FILE, line, "utf8");
}

function getAuditLogs(limit = 30, filter = {}) {
  const offset = parsePositiveInteger(filter.offset, 0);
  const rows = filter.restaurantId
    ? db.prepare("SELECT * FROM audit_logs WHERE restaurant_id = ? ORDER BY id DESC LIMIT ? OFFSET ?").all(filter.restaurantId, limit, offset)
    : db.prepare("SELECT * FROM audit_logs ORDER BY id DESC LIMIT ? OFFSET ?").all(limit, offset);

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

function shouldPersistNotification(event) {
  return Boolean(event?.message) && !["courier-location"].includes(event.type || "");
}

function persistNotification(targetRole, targetId, event) {
  db.prepare(`
    INSERT INTO notification_logs (id, target_role, target_id, event_type, message, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    uid("ntf"),
    targetRole,
    targetId || null,
    event.type || "workspace-update",
    event.message,
    nowIso()
  );
}

function persistNotificationsForEvent(event) {
  if (!shouldPersistNotification(event)) {
    return;
  }
  persistNotification("admin", null, event);
  if (event.restaurantId) {
    persistNotification("restaurant", event.restaurantId, event);
  }
  if (event.courierId) {
    persistNotification("courier", event.courierId, event);
  }
}

function getNotifications(targetRole, targetId = null, limit = 20) {
  const offset = 0;
  const rows = targetId
    ? db.prepare(`
      SELECT * FROM notification_logs
      WHERE target_role = ? AND target_id = ?
      ORDER BY datetime(created_at) DESC
      LIMIT ? OFFSET ?
    `).all(targetRole, targetId, limit, offset)
    : db.prepare(`
      SELECT * FROM notification_logs
      WHERE target_role = ? AND target_id IS NULL
      ORDER BY datetime(created_at) DESC
      LIMIT ? OFFSET ?
    `).all(targetRole, limit, offset);

  return rows.map((row) => ({
    id: row.id,
    eventType: row.event_type,
    message: row.message,
    createdAt: row.created_at,
  }));
}

function getAnnouncements(targetRole = null) {
  const rows = targetRole
    ? db.prepare(`
      SELECT * FROM announcements
      WHERE active = 1 AND target_role = ?
      ORDER BY datetime(updated_at) DESC
    `).all(targetRole)
    : db.prepare(`
      SELECT * FROM announcements
      WHERE active = 1
      ORDER BY datetime(updated_at) DESC
    `).all();

  return rows.map((row) => ({
    id: row.id,
    targetRole: row.target_role,
    title: row.title,
    message: row.message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function createAnnouncement(targetRole, title, message) {
  const stamp = nowIso();
  const id = uid("announce");
  db.prepare(`
    INSERT INTO announcements (id, target_role, title, message, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `).run(id, targetRole, title, message, stamp, stamp);
  return id;
}

function deactivateAnnouncement(announcementId) {
  const result = db.prepare(`
    UPDATE announcements
    SET active = 0, updated_at = ?
    WHERE id = ? AND active = 1
  `).run(nowIso(), announcementId);
  return result.changes > 0;
}

function clearAnnouncements(targetRole = "courier") {
  db.prepare(`
    UPDATE announcements
    SET active = 0, updated_at = ?
    WHERE target_role = ? AND active = 1
  `).run(nowIso(), targetRole);
}

function getPlatformAccounts(filter = {}) {
  const rows = filter.restaurantId
    ? db.prepare("SELECT * FROM platform_accounts WHERE restaurant_id = ? ORDER BY datetime(updated_at) DESC").all(filter.restaurantId)
    : db.prepare("SELECT * FROM platform_accounts ORDER BY datetime(updated_at) DESC").all();

  return rows.map((row) => ({
    id: row.id,
    restaurantId: row.restaurant_id,
    platform: row.platform,
    externalId: row.external_id || row.external_store_id,
    externalStoreId: row.external_store_id,
    externalMerchantId: row.external_merchant_id,
    apiUsername: row.api_username,
    apiPassword: row.api_password,
    apiKey: row.api_key,
    apiSecret: row.api_secret,
    token: row.token || row.access_token,
    accessToken: row.access_token || row.token,
    refreshToken: row.refresh_token,
    tokenExpiresAt: row.token_expires_at,
    callbackUrl: row.callback_url,
    integrationReferenceCode: row.integration_ref_code || row.integration_reference_code || "",
    integrationRefCode: row.integration_ref_code || row.integration_reference_code || "",
    posSecretKey: row.pos_secret_key || "",
    authType: row.auth_type || row.webhook_auth_type,
    storeFrontCode: row.store_front_code,
    chainId: row.chain_id,
    vendorId: row.vendor_id,
    webhookAuthType: row.webhook_auth_type,
    webhookApiKey: row.webhook_api_key,
    webhookUsername: row.webhook_username,
    webhookPassword: row.webhook_password,
    staticToken: row.static_token,
    webhookSecret: row.webhook_secret || row.static_token,
    webhookId: row.webhook_id,
    settings: parseJson(row.settings_json, {}),
    verificationStatus: row.verification_status || PLATFORM_VERIFICATION_STATUS.PENDING,
    verificationNote: row.verification_note || "",
    lastVerificationAt: row.last_verification_at,
    verifiedAt: row.verified_at,
    lastValidationMode: row.last_validation_mode,
    active: row.is_active === null || row.is_active === undefined ? Boolean(row.active) : Boolean(row.is_active),
    lastSyncAt: row.last_sync_at || null,
    pollingEnabled: Boolean(row.polling_enabled),
    webhookEnabled: row.webhook_enabled === null || row.webhook_enabled === undefined ? true : Boolean(row.webhook_enabled),
    lastWebhookAt: row.last_webhook_at || null,
    lastPollAt: row.last_poll_at || row.last_sync_at || null,
    lastError: row.last_error || "",
    connectionStatus: row.connection_status || HEALTH_STATUS.UNKNOWN,
    lastCheckAt: row.last_check_at || null,
    lastSuccessAt: row.last_success_at || null,
    lastErrorAt: row.last_error_at || null,
    lastErrorCode: row.last_error_code || "",
    lastErrorMessage: row.last_error_message || "",
    lastHttpStatus: row.last_http_status ?? null,
    lastLatencyMs: row.last_latency_ms ?? null,
    consecutiveFailures: row.consecutive_failures || 0,
    lastCallbackAt: row.last_callback_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function getPlatformOrders(filter = {}) {
  const pagination = filter.pagination || null;
  const limit = pagination ? clampLimit(pagination.limit) : 100;
  const offset = pagination ? parsePositiveInteger(pagination.offset) : 0;
  const rows = filter.restaurantId
    ? db.prepare("SELECT * FROM platform_orders WHERE restaurant_id = ? ORDER BY datetime(created_at) DESC LIMIT ? OFFSET ?").all(filter.restaurantId, limit, offset)
    : db.prepare("SELECT * FROM platform_orders ORDER BY datetime(created_at) DESC LIMIT ? OFFSET ?").all(limit, offset);

  return rows.map((row) => ({
    id: row.id,
    platform: row.platform,
    platformOrderId: row.platform_order_id,
    restaurantId: row.restaurant_id,
    customerName: row.customer_name,
    phone: row.phone,
    address: row.address,
    totalPrice: Number(row.total_price || 0),
    note: row.note || "",
    status: row.status,
    rawPayload: parseJson(row.raw_payload, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function platformOrdersPagination(filter = {}, pagination = { limit: DEFAULT_PAGE_LIMIT, offset: 0 }) {
  const total = filter.restaurantId
    ? countTable("platform_orders", "restaurant_id = ?", [filter.restaurantId])
    : countTable("platform_orders");
  return pageMeta(total, pagination);
}

function normalizePlatformOrderStatus(status) {
  const normalized = trimmed(status) || "pending_approval";
  return PLATFORM_ORDER_STATUSES.has(normalized) ? normalized : "pending_approval";
}

function upsertPlatformOrderRecord(order, restaurantId, status = "pending_approval") {
  const platform = normalizePlatformInput(order.platform) || order.platform;
  const platformOrderId = trimmed(order.orderId || order.platformOrderId || order.externalOrderNo);
  if (!platform || !platformOrderId || !restaurantId) {
    return null;
  }

  const stamp = nowIso();
  const existing = db.prepare(`
    SELECT id FROM platform_orders
    WHERE platform = ? AND platform_order_id = ? AND restaurant_id = ?
  `).get(platform, platformOrderId, restaurantId);

  if (existing) {
    db.prepare(`
      UPDATE platform_orders
      SET customer_name = ?, phone = ?, address = ?, total_price = ?, note = ?, status = ?, raw_payload = ?, updated_at = ?
      WHERE id = ?
    `).run(
      trimmed(order.customerName) || "Musteri",
      trimmed(order.phone) || "Gizli Numara",
      trimmed(order.address || order.customerAddress) || "Adres yok",
      normalizeMoney(order.totalPrice ?? order.orderAmount),
      trimmed(order.customerNote || order.note),
      normalizePlatformOrderStatus(status),
      json(order.rawPayload || order),
      stamp,
      existing.id
    );
    return existing.id;
  }

  const id = uid("po");
  db.prepare(`
    INSERT INTO platform_orders (
      id, platform, platform_order_id, restaurant_id, customer_name, phone, address, total_price, note, status, raw_payload, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    platform,
    platformOrderId,
    restaurantId,
    trimmed(order.customerName) || "Musteri",
    trimmed(order.phone) || "Gizli Numara",
    trimmed(order.address || order.customerAddress) || "Adres yok",
    normalizeMoney(order.totalPrice ?? order.orderAmount),
    trimmed(order.customerNote || order.note),
    normalizePlatformOrderStatus(status),
    json(order.rawPayload || order),
    stamp,
    stamp
  );
  return id;
}

function updatePlatformOrderStatus(platform, platformOrderId, restaurantId, status) {
  if (!platform || !platformOrderId || !restaurantId) {
    return;
  }
  db.prepare(`
    UPDATE platform_orders
    SET status = ?, updated_at = ?
    WHERE platform = ? AND platform_order_id = ? AND restaurant_id = ?
  `).run(normalizePlatformOrderStatus(status), nowIso(), platform, platformOrderId, restaurantId);
}

function updatePlatformOrderStatusByPackage(pkg, status) {
  if (!isPlatformBackedPackage(pkg)) {
    return;
  }
  updatePlatformOrderStatus(
    pkg?.source_platform || pkg?.sourcePlatform,
    pkg?.external_order_id || pkg?.externalOrderId || pkg?.external_order_no || pkg?.externalOrderNo,
    pkg?.restaurant_id || pkg?.restaurantId,
    status
  );
}

function isPlatformBackedPackage(pkg) {
  const source = normalizeOrderSource(pkg?.source, pkg?.source_platform || pkg?.sourcePlatform);
  return source !== "external_manual" && source !== "manual";
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk.toString();
      if (raw.length > 15_000_000) {
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

function getSystemSettings() {
  const row = db.prepare("SELECT settings_json FROM system_settings WHERE id = 'main'").get();
  return row ? parseJson(row.settings_json, {}) : {};
}

function updateSystemSettings(newSettings) {
  const current = getSystemSettings();
  const merged = { ...current, ...newSettings };
  db.prepare(`
    INSERT INTO system_settings (id, settings_json) VALUES ('main', ?)
    ON CONFLICT(id) DO UPDATE SET settings_json = excluded.settings_json
  `).run(json(merged));
  return merged;
}

function sendJson(res, statusCode, payload) {
  writeSecurityHeaders(res);
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  const requestId = res._deliveraRequestId || "";
  const responsePayload = payload && typeof payload === "object" && !Array.isArray(payload) && requestId && payload.requestId === undefined
    ? { ...payload, requestId }
    : payload;
  res.end(JSON.stringify(responsePayload));
}

function sendText(res, statusCode, payload, contentType = "text/plain; charset=utf-8") {
  writeSecurityHeaders(res);
  res.writeHead(statusCode, { "Content-Type": contentType });
  res.end(payload);
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
  persistNotificationsForEvent(event);
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
  const normalizedName = String(fileName || "").replace(/^[/\\]+/, "");
  const filePath = path.resolve(__dirname, normalizedName);
  if (!filePath.startsWith(__dirname)) {
    sendJson(res, 403, { error: "Gecersiz dosya yolu." });
    return;
  }

  if (!fs.existsSync(filePath)) {
    sendJson(res, 404, { error: "Dosya bulunamadi." });
    return;
  }

  const ext = path.extname(normalizedName);
  const typeMap = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml; charset=utf-8",
    ".ico": "image/x-icon",
  };

  writeSecurityHeaders(res);
  res.writeHead(200, { "Content-Type": typeMap[ext] || "text/plain; charset=utf-8" });
  fs.createReadStream(filePath).pipe(res);
}

function recordRequestMetrics(startedAt, statusCode) {
  const elapsed = Date.now() - startedAt;
  performanceMetrics.requestCount += 1;
  performanceMetrics.totalResponseTimeMs += elapsed;
  performanceMetrics.maxResponseTimeMs = Math.max(performanceMetrics.maxResponseTimeMs, elapsed);
  performanceMetrics.statusBuckets[statusCode] = (performanceMetrics.statusBuckets[statusCode] || 0) + 1;
  if (statusCode >= 500) {
    performanceMetrics.errorCount += 1;
  }
  performanceMetrics.recentResponseTimes.push(elapsed);
  if (performanceMetrics.recentResponseTimes.length > 500) {
    performanceMetrics.recentResponseTimes.shift();
  }
}

function recordRequestLog(req, res, startedAt) {
  const statusCode = res.statusCode || 0;
  const elapsedMs = Date.now() - startedAt;
  const entry = {
    requestId: res._deliveraRequestId || "",
    method: req.method,
    path: (() => {
      try {
        return new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
      } catch {
        return req.url || "";
      }
    })(),
    statusCode,
    elapsedMs,
    ip: clientIp(req),
    createdAt: nowIso(),
  };
  recentRequestLogs.push(entry);
  if (recentRequestLogs.length > 50) {
    recentRequestLogs.shift();
  }
  if (statusCode >= 500) {
    logger.error("Request failed", {
      ...entry,
      endpoint: entry.path,
      requestId: entry.requestId,
    });
  } else if (statusCode === 401 || statusCode === 403 || statusCode === 429) {
    logger.warn("Request completed with client error", {
      endpoint: entry.path,
      method: entry.method,
      requestId: entry.requestId,
      statusCode,
      elapsedMs,
    });
  }
}

function countTable(tableName, where = "", params = []) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}${where ? ` WHERE ${where}` : ""}`).get(...params).count;
}

function clampLimit(value, fallback = DEFAULT_PAGE_LIMIT) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.min(MAX_PAGE_LIMIT, Math.floor(parsed)));
}

function parsePositiveInteger(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function paginationFromRequest(req, defaults = {}) {
  let searchParams = new URLSearchParams();
  try {
    searchParams = new URL(req?.url || "/", `http://${req?.headers?.host || "localhost"}`).searchParams;
  } catch {}
  const limit = clampLimit(searchParams.get("limit") ?? defaults.limit, defaults.limit || DEFAULT_PAGE_LIMIT);
  const offset = parsePositiveInteger(searchParams.get("offset") ?? searchParams.get("cursor") ?? defaults.offset, defaults.offset || 0);
  return { limit, offset };
}

function pageMeta(total, pagination) {
  const offset = parsePositiveInteger(pagination?.offset, 0);
  const limit = clampLimit(pagination?.limit, DEFAULT_PAGE_LIMIT);
  const nextOffset = offset + limit;
  return {
    limit,
    offset,
    cursor: String(offset),
    nextCursor: nextOffset < total ? String(nextOffset) : null,
    hasMore: nextOffset < total,
    total,
  };
}

function databaseSizeBytes() {
  try {
    return fs.existsSync(DB_FILE) ? fs.statSync(DB_FILE).size : 0;
  } catch {
    return 0;
  }
}

function tableCountSafe(tableName, where = "", params = []) {
  try {
    return countTable(tableName, where, params);
  } catch {
    return 0;
  }
}

function queueHealthPayload() {
  return {
    assignmentRetryTimers: assignmentRetryTimers.size,
    assignmentSweepRunning,
    assignmentSweepQueued,
    platformPollingEnabled: PLATFORM_POLLING_ENABLED,
    platformPollIntervalMs: PLATFORM_POLL_INTERVAL_MS,
    liveStreams: liveStreams.size,
    queueService: queueService.health(),
  };
}

function cacheHealthPayload() {
  const rateLimitHealth = rateLimitStore.health();
  return {
    mode: rateLimitHealth.mode,
    redisUrlConfigured: Boolean(REDIS_URL),
    rateLimitStore: rateLimitHealth,
    sessionRevocation: sessionRevocationService.health(),
    responseCache: "not_enabled",
  };
}

function platformHealthSummaryPayload() {
  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const rows = db.prepare(`
    SELECT COALESCE(connection_status, 'unknown') AS status, COUNT(*) AS count
    FROM platform_accounts
    GROUP BY COALESCE(connection_status, 'unknown')
  `).all();
  const counts = rows.reduce((acc, row) => {
    acc[row.status] = row.count;
    return acc;
  }, {});
  return {
    total: tableCountSafe("platform_accounts"),
    connected: counts.connected || 0,
    warning: counts.warning || 0,
    error: counts.error || 0,
    disabled: counts.disabled || 0,
    unknown: counts.unknown || 0,
    webhookErrorsLast24h: tableCountSafe("platform_events", "event_type = ? AND status = ? AND created_at >= ?", ["webhook", "error", last24h]),
    callbackErrorsLast24h: tableCountSafe("platform_events", "event_type = ? AND status = ? AND created_at >= ?", ["callback", "error", last24h]),
    lastCheckedAt: db.prepare("SELECT MAX(last_check_at) AS value FROM platform_accounts").get()?.value || null,
  };
}

function systemStatusPayload() {
  const activeStatuses = [PENDING_APPROVAL_STATUS, PENDING_STATUS, PREPARING_STATUS, AWAITING_ASSIGNMENT_STATUS, ASSIGNED_STATUS, ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS];
  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const dbOk = Boolean(db.prepare("SELECT 1 AS ok").get()?.ok);

  return {
    ok: true,
    app: "Delivera Express",
    env: NODE_ENV,
    uptimeSeconds: Math.round(process.uptime()),
    database: {
      ok: dbOk,
      mode: dbFacade.clientName(),
      file: DB_FILE,
      sizeBytes: databaseSizeBytes(),
      postgresUrlConfigured: Boolean(trimmed(process.env.DATABASE_URL || process.env.POSTGRES_URL)),
    },
    totals: {
      restaurants: tableCountSafe("restaurants"),
      couriers: tableCountSafe("couriers"),
      packages: tableCountSafe("packages"),
      activePackages: db.prepare(`SELECT COUNT(*) AS count FROM packages WHERE status IN (${activeStatuses.map(() => "?").join(",")})`).get(...activeStatuses).count,
      packagesLast24h: tableCountSafe("packages", "created_at >= ?", [last24h]),
      platformOrders: tableCountSafe("platform_orders"),
      failedWebhooks: tableCountSafe("webhook_logs", "(response_status >= 400 OR dead_lettered_at IS NOT NULL)"),
      deadLetteredWebhooks: tableCountSafe("webhook_logs", "dead_lettered_at IS NOT NULL"),
    },
    operations: {
      onlineCouriers: tableCountSafe("couriers", "status = ?", [COURIER_ONLINE_STATUS]),
      busyCouriers: tableCountSafe("couriers", "status = ?", [COURIER_BUSY_STATUS]),
      waitingPackages: db.prepare(`
        SELECT COUNT(*) AS count FROM packages
        WHERE status IN (?, ?, ?, ?)
      `).get(PENDING_APPROVAL_STATUS, PENDING_STATUS, PREPARING_STATUS, AWAITING_ASSIGNMENT_STATUS).count,
    },
    queues: queueHealthPayload(),
    cache: cacheHealthPayload(),
    platformHealth: platformHealthSummaryPayload(),
    timestamp: nowIso(),
  };
}

function performanceSummaryPayload() {
  const averageResponseTimeMs = performanceMetrics.requestCount
    ? performanceMetrics.totalResponseTimeMs / performanceMetrics.requestCount
    : 0;
  const recent = [...performanceMetrics.recentResponseTimes].sort((left, right) => left - right);
  const percentile = (value) => {
    if (recent.length === 0) {
      return 0;
    }
    return recent[Math.min(recent.length - 1, Math.ceil((value / 100) * recent.length) - 1)];
  };

  return {
    ok: true,
    uptimeSeconds: Math.round(process.uptime()),
    startedAt: new Date(performanceMetrics.startedAt).toISOString(),
    requestCount: performanceMetrics.requestCount,
    errorCount: performanceMetrics.errorCount,
    averageResponseTimeMs: Number(averageResponseTimeMs.toFixed(2)),
    maxResponseTimeMs: performanceMetrics.maxResponseTimeMs,
    p50ResponseTimeMs: percentile(50),
    p95ResponseTimeMs: percentile(95),
    p99ResponseTimeMs: percentile(99),
    statusBuckets: performanceMetrics.statusBuckets,
    memory: process.memoryUsage(),
    databaseSizeBytes: databaseSizeBytes(),
    queues: queueHealthPayload(),
    cache: cacheHealthPayload(),
    platformHealth: platformHealthSummaryPayload(),
    recentRequests: recentRequestLogs.slice(-10),
    timestamp: nowIso(),
  };
}

function prometheusLine(name, value, labels = {}) {
  const labelEntries = Object.entries(labels).filter(([, labelValue]) => labelValue !== undefined && labelValue !== null);
  const labelText = labelEntries.length
    ? `{${labelEntries.map(([labelName, labelValue]) => `${labelName}="${String(labelValue).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`
    : "";
  const numericValue = Number.isFinite(Number(value)) ? Number(value) : 0;
  return `${name}${labelText} ${numericValue}`;
}

function metricsTextPayload() {
  const status = systemStatusPayload();
  const perf = performanceSummaryPayload();
  const lines = [
    "# HELP delivera_up Application liveness flag.",
    "# TYPE delivera_up gauge",
    prometheusLine("delivera_up", status.ok ? 1 : 0),
    "# HELP delivera_uptime_seconds Process uptime in seconds.",
    "# TYPE delivera_uptime_seconds gauge",
    prometheusLine("delivera_uptime_seconds", status.uptimeSeconds),
    "# HELP delivera_requests_total Total observed HTTP requests.",
    "# TYPE delivera_requests_total counter",
    prometheusLine("delivera_requests_total", perf.requestCount),
    "# HELP delivera_errors_total Total observed HTTP 5xx responses.",
    "# TYPE delivera_errors_total counter",
    prometheusLine("delivera_errors_total", perf.errorCount),
    "# HELP delivera_response_time_ms HTTP response time summary in milliseconds.",
    "# TYPE delivera_response_time_ms gauge",
    prometheusLine("delivera_response_time_ms", perf.averageResponseTimeMs, { quantile: "avg" }),
    prometheusLine("delivera_response_time_ms", perf.p50ResponseTimeMs, { quantile: "p50" }),
    prometheusLine("delivera_response_time_ms", perf.p95ResponseTimeMs, { quantile: "p95" }),
    prometheusLine("delivera_response_time_ms", perf.p99ResponseTimeMs, { quantile: "p99" }),
    "# HELP delivera_database_size_bytes SQLite database file size.",
    "# TYPE delivera_database_size_bytes gauge",
    prometheusLine("delivera_database_size_bytes", status.database.sizeBytes),
    "# HELP delivera_table_rows Current table row counts.",
    "# TYPE delivera_table_rows gauge",
    prometheusLine("delivera_table_rows", status.totals.restaurants, { table: "restaurants" }),
    prometheusLine("delivera_table_rows", status.totals.couriers, { table: "couriers" }),
    prometheusLine("delivera_table_rows", status.totals.packages, { table: "packages" }),
    prometheusLine("delivera_table_rows", status.totals.platformOrders, { table: "platform_orders" }),
    "# HELP delivera_couriers Current courier operational counts.",
    "# TYPE delivera_couriers gauge",
    prometheusLine("delivera_couriers", status.operations.onlineCouriers, { status: "online" }),
    prometheusLine("delivera_couriers", status.operations.busyCouriers, { status: "busy" }),
    "# HELP delivera_queue_depth In-process queue/timer depth.",
    "# TYPE delivera_queue_depth gauge",
    prometheusLine("delivera_queue_depth", status.queues.assignmentRetryTimers, { queue: "assignment_retry_timers" }),
    prometheusLine("delivera_queue_depth", status.queues.liveStreams, { queue: "live_streams" }),
  ];

  Object.entries(perf.statusBuckets || {}).forEach(([statusCode, count]) => {
    lines.push(prometheusLine("delivera_http_status_total", count, { status: statusCode }));
  });

  return `${lines.join("\n")}\n`;
}

function findStaticFile(pathname, method = "GET") {
  if (STATIC_FILES[pathname]) {
    return STATIC_FILES[pathname];
  }

  if (!["GET", "HEAD"].includes(method)) {
    return "";
  }

  let decodedPath = "";
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return "";
  }

  if (!decodedPath || decodedPath.includes("\0") || decodedPath.includes("..")) {
    return "";
  }

  const relativePath = decodedPath.replace(/^\/+/, "");
  if (!relativePath || relativePath.startsWith("api/")) {
    return "";
  }

  const ext = path.extname(relativePath).toLowerCase();
  const allowedExts = new Set([".html", ".css", ".js", ".json", ".webmanifest", ".png", ".jpg", ".jpeg", ".svg", ".ico"]);
  if (!allowedExts.has(ext)) {
    return "";
  }

  const filePath = path.resolve(__dirname, relativePath);
  if (!filePath.startsWith(__dirname) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return "";
  }

  return relativePath;
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
  const whereParts = [];
  const params = [];
  if (filter.restaurantId) {
    whereParts.push("restaurant_id = ?");
    params.push(filter.restaurantId);
  }
  if (filter.courierId) {
    whereParts.push("assigned_courier_id = ?");
    params.push(filter.courierId);
  }
  if (filter.status) {
    whereParts.push("status = ?");
    params.push(normalizeStatus(filter.status));
  }
  if (filter.platform) {
    whereParts.push("source_platform = ?");
    params.push(filter.platform);
  }
  if (filter.dateFrom) {
    whereParts.push("created_at >= ?");
    params.push(filter.dateFrom);
  }
  if (filter.dateTo) {
    whereParts.push("created_at <= ?");
    params.push(filter.dateTo);
  }
  if (filter.search) {
    whereParts.push("(tracking_no LIKE ? OR external_order_no LIKE ? OR recipient LIKE ? OR phone LIKE ? OR address LIKE ? OR delivery_address LIKE ?)");
    const searchValue = `%${filter.search}%`;
    params.push(searchValue, searchValue, searchValue, searchValue, searchValue, searchValue);
  }
  const whereSql = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";
  const pagination = filter.pagination || null;
  const sql = `SELECT * FROM packages ${whereSql} ORDER BY datetime(created_at) DESC`;
  const rows = pagination
    ? db.prepare(`${sql} LIMIT ? OFFSET ?`).all(...params, clampLimit(pagination.limit), parsePositiveInteger(pagination.offset))
    : db.prepare(sql).all(...params);

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
    customerNote: row.customer_note || "",
    customerLat: row.customer_lat,
    customerLng: row.customer_lng,
    customerAddress: row.customer_address || row.delivery_address || row.address,
    restaurantLat: row.x,
    restaurantLng: row.y,
    restaurantAddress: row.zone,
    items: parseJson(row.items_json, []),
    rawPayload: parseJson(row.raw_payload_json, null),
    platformStatusLogs: parseJson(row.platform_status_logs_json, []),
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
    assignmentTriedCourierIds: normalizeIdList(parseJson(row.assignment_tried_courier_ids_json, [])),
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
  }));
}

function packagePagination(filter = {}, pagination = { limit: DEFAULT_PAGE_LIMIT, offset: 0 }) {
  const whereParts = [];
  const params = [];
  if (filter.restaurantId) {
    whereParts.push("restaurant_id = ?");
    params.push(filter.restaurantId);
  }
  if (filter.courierId) {
    whereParts.push("assigned_courier_id = ?");
    params.push(filter.courierId);
  }
  if (filter.status) {
    whereParts.push("status = ?");
    params.push(normalizeStatus(filter.status));
  }
  if (filter.platform) {
    whereParts.push("source_platform = ?");
    params.push(filter.platform);
  }
  if (filter.dateFrom) {
    whereParts.push("created_at >= ?");
    params.push(filter.dateFrom);
  }
  if (filter.dateTo) {
    whereParts.push("created_at <= ?");
    params.push(filter.dateTo);
  }
  if (filter.search) {
    whereParts.push("(tracking_no LIKE ? OR external_order_no LIKE ? OR recipient LIKE ? OR phone LIKE ? OR address LIKE ? OR delivery_address LIKE ?)");
    const searchValue = `%${filter.search}%`;
    params.push(searchValue, searchValue, searchValue, searchValue, searchValue, searchValue);
  }
  const total = db.prepare(`SELECT COUNT(*) AS count FROM packages${whereParts.length ? ` WHERE ${whereParts.join(" AND ")}` : ""}`).get(...params).count;
  return pageMeta(total, pagination);
}

function getCapacityPackagesForAssignment(pkg) {
  const rows = db.prepare(`
    SELECT * FROM packages
    WHERE status IN (?, ?, ?)
      AND id <> ?
  `).all(ASSIGNED_STATUS, ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS, pkg.id);
  return [...rows.map((row) => mapPackageRow(row)), pkg];
}

function assignmentStateForPackage(pkg) {
  return {
    zones: getZones(),
    restaurants: getRestaurants({ restaurantId: pkg.restaurantId }),
    couriers: getCouriers(),
    packages: getCapacityPackagesForAssignment(pkg),
    platformAccounts: [],
    platformOrders: [],
    webhookLogs: [],
  };
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
    customerNote: row.customer_note || "",
    customerLat: row.customer_lat,
    customerLng: row.customer_lng,
    customerAddress: row.customer_address || row.delivery_address || row.address,
    restaurantLat: row.x,
    restaurantLng: row.y,
    restaurantAddress: row.zone,
    items: parseJson(row.items_json, []),
    rawPayload: parseJson(row.raw_payload_json, null),
    platformStatusLogs: parseJson(row.platform_status_logs_json, []),
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
    assignmentTriedCourierIds: normalizeIdList(parseJson(row.assignment_tried_courier_ids_json, [])),
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    restaurantName: restaurantMap.get(row.restaurant_id) || "Bilinmeyen Restoran",
  };
}

function getCourierPackages(courierId, pagination = null) {
  const rows = pagination
    ? db.prepare("SELECT * FROM packages WHERE assigned_courier_id = ? ORDER BY datetime(created_at) DESC LIMIT ? OFFSET ?").all(courierId, clampLimit(pagination.limit), parsePositiveInteger(pagination.offset))
    : db.prepare("SELECT * FROM packages WHERE assigned_courier_id = ? ORDER BY datetime(created_at) DESC").all(courierId);
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
  const result = packages
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
    
  const settings = getSystemSettings();
  const fee = Number(settings.courier_per_package_fee) || 0;
  result.courierEarnings = result.deliveredCount * fee;
  return result;
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
  const plans = getCourierShiftPlans(courierId, 12);
  return {
    currentShift: shifts.find((shift) => !shift.endedAt) || null,
    recentShifts: shifts,
    shiftPlans: plans,
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
      .filter((pkg) => pkg.zone === zone.name && [PENDING_APPROVAL_STATUS, PENDING_STATUS, PREPARING_STATUS, AWAITING_ASSIGNMENT_STATUS].includes(pkg.status))
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
  const webhookUrl = `${requestBaseUrl(req)}/api/platform/order`;
  return {
    currentAccountId: current?.id || "",
    currentPlatform: current?.platform || "",
    verificationStatus: current?.verificationStatus || PLATFORM_VERIFICATION_STATUS.PENDING,
    webhookUrl: current
      ? webhookUrl
      : "Platform hesabini kaydedince webhook URL hazir olur.",
    steps: [
      { id: "select_platform", title: "Adim 1", label: "Platform sec", done: Boolean(current?.platform) },
      { id: "credentials", title: "Adim 2", label: "Gerekli bilgileri gir", done: Boolean(current?.externalStoreId) },
      { id: "webhook_secret", title: "Adim 3", label: "Webhook secret kayitli", done: Boolean(current?.hasWebhookSecret || current?.webhookSecret) },
      { id: "first_order", title: "Adim 4", label: "Ilk gercek siparisle dogrula", done: current?.verificationStatus === PLATFORM_VERIFICATION_STATUS.VERIFIED },
      { id: "success", title: "Adim 5", label: "Webhook modu aktif", done: current?.verificationStatus === PLATFORM_VERIFICATION_STATUS.VERIFIED },
    ],
    helpText: restaurant
      ? `${restaurant.name} icin webhook modu aktif. Polling API kapalı — webhook ile sipariş bekleniyor.`
      : "Restoran oturumu acildiginda entegrasyon sihirbazi aktif olur.",
  };
}

function buildCourierWorkspace(courierId, options = {}) {
  const courier = getCourierById(courierId);
  if (!courier) {
    return null;
  }

  const pagination = options.pagination || { limit: DEFAULT_PAGE_LIMIT, offset: 0 };
  const packages = getCourierPackages(courierId, pagination);
  const packagesPagination = pageMeta(countTable("packages", "assigned_courier_id = ?", [courierId]), pagination);
  const todayPackages = deliveredPackagesForCourierOnDate(courierId, dayKey());
  const daySummary = summarizeCourierDay(todayPackages);
  const dayReport = db.prepare("SELECT * FROM courier_daily_reports WHERE courier_id = ? AND report_date = ?").get(courierId, dayKey());
  return {
    courier: {
      ...sanitizeCourier(courier),
      activeLoad: packages.filter((item) => isCapacityBlockingPackage(item)).length,
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
    notifications: getNotifications("courier", courierId, 20),
    announcements: getAnnouncements("courier"),
    pagination: {
      packages: packagesPagination,
    },
  };
}

function getWebhookLogs(limit = 20, filter = {}) {
  const offset = parsePositiveInteger(filter.offset, 0);
  const rows = filter.restaurantId
    ? db.prepare("SELECT * FROM webhook_logs WHERE restaurant_id = ? ORDER BY id DESC LIMIT ? OFFSET ?").all(filter.restaurantId, limit, offset)
    : db.prepare("SELECT * FROM webhook_logs ORDER BY id DESC LIMIT ? OFFSET ?").all(limit, offset);

  return rows.map((row) => ({
    id: row.id,
    restaurantId: row.restaurant_id,
    sourcePlatform: row.source_platform,
    externalOrderNo: row.external_order_no,
    signatureValid: Boolean(row.signature_valid),
    responseStatus: row.response_status,
    requestBody: row.request_body,
    retryCount: row.retry_count || 0,
    nextRetryAt: row.next_retry_at,
    deadLetteredAt: row.dead_lettered_at,
    lastError: row.last_error,
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
    platformOrders: getPlatformOrders(filter),
    webhookLogs: getWebhookLogs(20, filter),
    platformEvents: getPlatformEvents(20, filter),
  };
}

function activeAssignmentsForCourier(packages, courierId, excludePackageId = null) {
  return packages.filter((item) =>
    item.assignedCourierId === courierId &&
    item.id !== excludePackageId &&
    isCapacityBlockingPackage(item)
  ).length;
}

function buildActiveLoadMap(packages, excludePackageId = null) {
  const loadMap = new Map();
  packages.forEach((item) => {
    if (!item.assignedCourierId || item.id === excludePackageId || !isCapacityBlockingPackage(item)) {
      return;
    }
    loadMap.set(item.assignedCourierId, (loadMap.get(item.assignedCourierId) || 0) + 1);
  });
  return loadMap;
}

function isCourierOfferExpired(pkg, referenceTime = Date.now()) {
  return normalizeStatus(pkg?.status) === ASSIGNED_STATUS &&
    pkg?.assignedAt &&
    referenceTime - new Date(pkg.assignedAt).getTime() >= COURIER_OFFER_TIMEOUT_MS;
}

function isCapacityBlockingPackage(pkg) {
  if (!isActivePackageStatus(pkg?.status)) {
    return false;
  }
  return !isCourierOfferExpired(pkg);
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
  return [PENDING_STATUS, PREPARING_STATUS, AWAITING_ASSIGNMENT_STATUS, ASSIGNED_STATUS].includes(normalizeStatus(status));
}

function clearAssignmentRetry(packageId) {
  const activeTimer = assignmentRetryTimers.get(packageId);
  if (activeTimer) {
    clearTimeout(activeTimer);
    assignmentRetryTimers.delete(packageId);
  }
}

function setPackageTriedCouriers(packageId, courierIds = []) {
  db.prepare("UPDATE packages SET assignment_tried_courier_ids_json = ?, updated_at = ? WHERE id = ?").run(
    json(normalizeIdList(courierIds)),
    nowIso(),
    packageId
  );
}

function appendTriedCourier(packageId, courierId) {
  const target = db.prepare("SELECT assignment_tried_courier_ids_json FROM packages WHERE id = ?").get(packageId);
  const nextIds = normalizeIdList([
    ...normalizeIdList(parseJson(target?.assignment_tried_courier_ids_json, [])),
    courierId,
  ]);
  setPackageTriedCouriers(packageId, nextIds);
  return nextIds;
}

function syncAssignmentRetryForPackage(pkg) {
  if (!pkg?.id) {
    return;
  }
  if (normalizeStatus(pkg.status) !== ASSIGNED_STATUS || !pkg.assignedCourierId) {
    clearAssignmentRetry(pkg.id);
    return;
  }

  clearAssignmentRetry(pkg.id);
  queueService.enqueue(JOB_TYPES.ASSIGNMENT_RETRY, {
    packageId: pkg.id,
    assignedCourierId: pkg.assignedCourierId,
    scheduledAt: nowIso(),
  }, {
    delayMs: COURIER_OFFER_TIMEOUT_MS,
  }).then((result) => {
    if (result.ok) {
      logger.info("Assignment retry queued", { packageId: pkg.id, queueMode: result.mode, jobId: result.jobId });
    }
  });
  const timerId = setTimeout(() => {
    handleAssignmentRetry(pkg.id).catch((error) => {
      logger.error("Assignment retry failed", { packageId: pkg.id, error });
    });
  }, COURIER_OFFER_TIMEOUT_MS);
  assignmentRetryTimers.set(pkg.id, timerId);
}

function buildAssignmentFailure(pkg, reason, note) {
  const currentStatus = normalizeStatus(pkg.status);
  const waitingStatus = currentStatus === PREPARING_STATUS ? PREPARING_STATUS : AWAITING_ASSIGNMENT_STATUS;
  const waitingAssignmentStatus = currentStatus === PREPARING_STATUS ? "waiting_courier" : "pending";
  return {
    ...pkg,
    assignedCourierId: null,
    assignedCourierName: null,
    assignedAt: null,
    distanceKm: null,
    status: waitingStatus,
    assignmentStatus: waitingAssignmentStatus,
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

  const allCouriers = state.couriers;
  if (allCouriers.length === 0) {
    return {
      reason: "uygun kurye yok",
      note: "Uygun kurye bulunamadi: kayitli kurye yok.",
    };
  }

  const onlineCouriers = allCouriers.filter((courier) => normalizeCourierStatus(courier.status, courier.available) === COURIER_ONLINE_STATUS);
  if (onlineCouriers.length === 0) {
    return {
      reason: "online kurye yok",
      note: "Uygun kurye bulunamadi: online kurye yok.",
    };
  }

  const freeOnlineCouriers = onlineCouriers.filter((courier) => activeAssignmentsForCourier(state.packages, courier.id, pkg.id) < 1);
  if (freeOnlineCouriers.length === 0) {
    return {
      reason: "tum kuryeler busy",
      note: "Uygun kurye bulunamadi: tum online kuryeler aktif gorevde.",
    };
  }

  return {
    reason: "mesafe disi",
    note: `Uygun kurye bulunamadi: ${MAX_ASSIGNMENT_DISTANCE_KM} km icinde kurye yok.`,
  };
}

function rankEligibleCouriers(state, pkg, occupiedCourierLoads = new Map(), options = {}) {
  const excludedCourierIds = new Set(options.excludedCourierIds || []);
  const activeLoadMap = buildActiveLoadMap(state.packages, pkg.id);
  const ranked = state.couriers
    .filter((courier) => normalizeCourierStatus(courier.status, courier.available) === COURIER_ONLINE_STATUS)
    .map((courier) => ({
      courier,
      distance: distance(courier.latitude, courier.longitude, pkg.latitude, pkg.longitude),
      load: Math.max(
        occupiedCourierLoads.get(courier.id) || 0,
        activeLoadMap.get(courier.id) || 0
      ),
    }))
    .filter(({ courier, distance: courierDistance, load }) =>
      courierDistance <= MAX_ASSIGNMENT_DISTANCE_KM &&
        load < 1 &&
        !excludedCourierIds.has(courier.id)
    )
    .sort((left, right) => left.distance - right.distance || left.load - right.load);

  if (ASSIGNMENT_DEBUG_LOGS) {
    logger.debug("Assignment courier distance check", {
      packageId: pkg.id,
      packageStatus: pkg.status,
      zone: pkg.zone,
      packageLat: pkg.latitude,
      packageLng: pkg.longitude,
      skippedCourierIds: [...excludedCourierIds],
      courierCount: state.couriers.length,
      eligibleCourierIds: ranked.map((item) => item.courier.id),
    });
  }

  return ranked;
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
  if (pkg.assignedCourierId) {
    updatePlatformOrderStatusByPackage(pkg, "assigned");
    const assignedPackage = getPackageById(pkg.id);
    if (isPlatformBackedPackage(pkg)) {
      notifyPlatformOrderAssigned(
        pkg.sourcePlatform || pkg.source_platform,
        pkg.externalOrderId || pkg.external_order_id || pkg.externalOrderNo || pkg.external_order_no,
        pkg.assignedCourierId,
        assignedPackage
      );
    }
  }
  syncAssignmentRetryForPackage(getPackageById(pkg.id));
}

function updatePackageAssignmentFailure(packageId, reason, note) {
  db.prepare(`
    UPDATE packages
    SET status = ?, assignment_status = ?, assigned_courier_id = NULL, assigned_courier_name = NULL, assigned_at = NULL,
        distance_km = NULL, assignment_reason = ?, last_assignment_attempt_at = ?, last_assignment_error = ?, updated_at = ?
    WHERE id = ?
  `).run(
    PREPARING_STATUS,
    "waiting_courier",
    note,
    nowIso(),
    reason,
    nowIso(),
    packageId
  );
  clearAssignmentRetry(packageId);
}

function tryAssignPackageAtomically(pkg, candidate) {
  return withImmediateTransaction(() => {
    logger.debug("Assignment started", {
      packageId: pkg.id,
      courierId: candidate.courier.id,
    });
    const freshPackage = db.prepare("SELECT * FROM packages WHERE id = ?").get(pkg.id);
    if (!freshPackage) {
      return { ok: false, reason: "veri eksik", note: "Siparis kaydi bulunamadi." };
    }

    const freshStatus = normalizeStatus(freshPackage.status);
    const freshOfferExpired = isCourierOfferExpired(mapPackageRow(freshPackage, new Map()));
    if (!isAssignableOrderStatus(freshStatus) || (freshStatus === ASSIGNED_STATUS && !freshOfferExpired)) {
      return { ok: false, reason: "sistemsel hata", note: "Siparis bu durumda otomatik atamaya uygun degil." };
    }

    const targetCourier = db.prepare("SELECT * FROM couriers WHERE id = ?").get(candidate.courier.id);
    if (!targetCourier) {
      updatePackageAssignmentFailure(pkg.id, "uygun kurye yok", "Secilen kurye kaydi bulunamadi.");
      return { ok: false, reason: "uygun kurye yok", note: "Secilen kurye kaydi bulunamadi." };
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
          AND NOT (
            status = ?
            AND assigned_at IS NOT NULL
            AND (strftime('%s','now') - strftime('%s', assigned_at)) * 1000 >= ?
          )
      `).get(
        targetCourier.id,
        pkg.id,
        ASSIGNED_STATUS,
        ACCEPTED_BY_COURIER_STATUS,
        ON_ROUTE_STATUS,
        ASSIGNED_STATUS,
        COURIER_OFFER_TIMEOUT_MS
      )?.total || 0
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
        AND (
          status IN (?, ?, ?, ?, ?)
          OR (
            status = ?
            AND assigned_at IS NOT NULL
            AND (strftime('%s','now') - strftime('%s', assigned_at)) * 1000 >= ?
          )
        )
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
      PREPARING_STATUS,
      PENDING_STATUS,
      AWAITING_ASSIGNMENT_STATUS,
      ASSIGNED_STATUS,
      FAILED_STATUS,
      ASSIGNED_STATUS,
      COURIER_OFFER_TIMEOUT_MS
    );

    if (update.changes !== 1) {
      logger.warn("Assignment skipped due to concurrent change", {
        packageId: pkg.id,
        courierId: targetCourier.id,
      });
      return { ok: false, reason: "sistemsel hata", note: "Siparis bu arada baska bir islem tarafindan degisti." };
    }

    db.prepare("UPDATE couriers SET status = ? WHERE id = ?").run(COURIER_BUSY_STATUS, targetCourier.id);
    appendTriedCourier(pkg.id, targetCourier.id);
    const assignedPackage = getPackageById(pkg.id);
    syncAssignmentRetryForPackage(assignedPackage);
    logger.info("Assignment success", {
      packageId: pkg.id,
      courierId: targetCourier.id,
      courierStatus,
      distanceKm: Number(candidate.distance.toFixed(3)),
    });
    if (isPlatformBackedPackage(freshPackage)) {
      notifyPlatformOrderAssigned(freshPackage.source_platform, freshPackage.external_order_id || freshPackage.external_order_no, targetCourier.id, assignedPackage);
    }
    return { ok: true, courierId: targetCourier.id };
  });
}

async function handleAssignmentRetry(packageId) {
  clearAssignmentRetry(packageId);
  const target = getPackageById(packageId);
  if (!target || normalizeStatus(target.status) !== ASSIGNED_STATUS || !target.assignedCourierId) {
    return;
  }

  logger.info("Assignment retry triggered", {
    packageId,
    assignedCourierId: target.assignedCourierId,
    triedCourierIds: target.assignmentTriedCourierIds || [],
  });

  const state = currentState();
  syncCourierOperationalStatuses(state);
  const occupiedCourierLoads = new Map();
  state.packages
    .filter((pkg) => isCapacityBlockingPackage(pkg))
    .forEach((pkg) => reserveCourier(occupiedCourierLoads, pkg.assignedCourierId, 1));

  const excludedCourierIds = normalizeIdList([
    ...(target.assignmentTriedCourierIds || []),
    target.assignedCourierId,
  ]);
  excludedCourierIds.forEach((courierId) => {
    logger.debug("Courier skipped because already tried", { packageId, courierId });
  });

  const ranked = rankEligibleCouriers(state, target, occupiedCourierLoads, { excludedCourierIds });
  if (ranked.length === 0) {
    logger.warn("Retry assignment found no suitable courier", { packageId });
    updatePackageAssignmentFailure(packageId, "mesafe disi", "Retry assignment: no suitable courier found");
    setPackageTriedCouriers(packageId, []);
    broadcastLiveEvent({
      type: "assignment-waiting",
      restaurantId: target.restaurantId,
      message: `${target.trackingNo || target.id} paketi yeniden atama sonrasi uygun kurye bulamadi.`,
    });
    return;
  }

  for (const candidate of ranked) {
    const result = tryAssignPackageAtomically(target, candidate);
    if (result.ok) {
      logger.info("Retry assignment selected a new courier", {
        packageId,
        courierId: candidate.courier.id,
      });
      const assignedPackage = getPackageById(packageId);
      syncAssignmentRetryForPackage(assignedPackage);
      broadcastLiveEvent({
        type: "package-reassign",
        restaurantId: target.restaurantId,
        courierId: candidate.courier.id,
        message: `${target.trackingNo || target.id} paketi yeni kuryeye yeniden atandi.`,
      });
      return;
    }
  }

  logger.warn("Retry assignment found no suitable courier", { packageId });
  updatePackageAssignmentFailure(packageId, "mesafe disi", "Retry assignment: no suitable courier found");
  setPackageTriedCouriers(packageId, []);
}

function attemptPackageAssignment(state, pkg, occupiedCourierLoads) {
  const packageStatus = normalizeStatus(pkg.status);
  const offerExpired = isCourierOfferExpired(pkg);
  if (!isAssignableOrderStatus(packageStatus) || (packageStatus === ASSIGNED_STATUS && !offerExpired)) {
    return false;
  }

  const ranked = rankEligibleCouriers(
    state,
    pkg,
    occupiedCourierLoads,
    offerExpired
      ? { excludedCourierIds: normalizeIdList([...(pkg.assignmentTriedCourierIds || []), pkg.assignedCourierId]) }
      : {}
  );
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
          assignmentTriedCourierIds: normalizeIdList([...(state.packages[packageIndex].assignmentTriedCourierIds || []), candidate.courier.id]),
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

function getShiftPlans(planDate = dayKey()) {
  expirePendingShiftPlans();
  return db.prepare(`
    SELECT plans.*, couriers.name AS courier_name, couriers.zone AS courier_zone
    FROM courier_shift_plans plans
    JOIN couriers ON couriers.id = plans.courier_id
    WHERE plans.plan_date = ?
    ORDER BY plans.start_time ASC
  `).all(planDate).map((row) => ({
    id: row.id,
    courierId: row.courier_id,
    courierName: row.courier_name,
    zone: row.zone || row.courier_zone,
    planDate: row.plan_date,
    startTime: row.start_time,
    endTime: row.end_time,
    status: row.status,
    offerExpiresAt: row.offer_expires_at || null,
    acceptedAt: row.accepted_at || null,
    notifiedAt: row.notified_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function getCourierShiftPlans(courierId, limit = 12) {
  expirePendingShiftPlans();
  return db.prepare(`
    SELECT plans.*, couriers.name AS courier_name, couriers.zone AS courier_zone
    FROM courier_shift_plans plans
    JOIN couriers ON couriers.id = plans.courier_id
    WHERE plans.courier_id = ?
    ORDER BY datetime(plans.plan_date || 'T' || plans.start_time) DESC, datetime(plans.updated_at) DESC
    LIMIT ?
  `).all(courierId, limit).map((row) => ({
    id: row.id,
    courierId: row.courier_id,
    courierName: row.courier_name,
    zone: row.zone || row.courier_zone,
    planDate: row.plan_date,
    startTime: row.start_time,
    endTime: row.end_time,
    status: row.status,
    offerExpiresAt: row.offer_expires_at || null,
    acceptedAt: row.accepted_at || null,
    notifiedAt: row.notified_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function summarizeShiftPlans(planDate = dayKey()) {
  const plans = getShiftPlans(planDate);
  return getZones().map((zone) => {
    const zonePlans = plans.filter((plan) => plan.zone === zone);
    const active = zonePlans.length;
    return {
      zone,
      plannedCouriers: active,
      missingCouriers: Math.max(0, 2 - active),
    };
  });
}

function upsertCashReconciliation(courierId, reportDate, summary) {
  const now = nowIso();
  const expectedCash = Number(summary.cashCollectedAmount || 0);
  const variance = 0;
  const existing = db.prepare("SELECT * FROM cash_reconciliations WHERE courier_id = ? AND report_date = ?").get(courierId, reportDate);
  if (existing) {
    db.prepare(`
      UPDATE cash_reconciliations
      SET expected_cash = ?, reported_cash = ?, variance = ?, status = 'pending', admin_note = NULL, package_ids_json = ?, updated_at = ?
      WHERE id = ?
    `).run(expectedCash, expectedCash, variance, json(summary.packageIds || []), now, existing.id);
  } else {
    db.prepare(`
      INSERT INTO cash_reconciliations (id, courier_id, report_date, expected_cash, reported_cash, variance, status, package_ids_json, admin_note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?)
    `).run(uid("cash"), courierId, reportDate, expectedCash, expectedCash, variance, json(summary.packageIds || []), now, now);
  }
}

function getCashReconciliations(limit = 30) {
  return db.prepare(`
    SELECT reconciliations.*, couriers.name AS courier_name, couriers.zone AS courier_zone
    FROM cash_reconciliations reconciliations
    JOIN couriers ON couriers.id = reconciliations.courier_id
    ORDER BY datetime(reconciliations.updated_at) DESC
    LIMIT ?
  `).all(limit).map((row) => ({
    id: row.id,
    courierId: row.courier_id,
    courierName: row.courier_name,
    zone: row.courier_zone,
    reportDate: row.report_date,
    expectedCash: Number(row.expected_cash || 0),
    reportedCash: Number(row.reported_cash || 0),
    variance: Number(row.variance || 0),
    status: row.status,
    packageIds: parseJson(row.package_ids_json, []),
    adminNote: row.admin_note || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function upsertShiftPlan(courierId, planDate, startTime, endTime, zone) {
  const courier = getCourierById(courierId);
  if (!courier) {
    throw httpError(404, "Kurye bulunamadi.");
  }
  const stamp = nowIso();
  const offerExpiresAt = plusHoursIso(stamp, 1);
  const existing = db.prepare("SELECT * FROM courier_shift_plans WHERE courier_id = ? AND plan_date = ?").get(courierId, planDate);
  if (existing) {
    db.prepare(`
      UPDATE courier_shift_plans
      SET zone = ?, start_time = ?, end_time = ?, status = 'awaiting_courier_acceptance', offer_expires_at = ?, accepted_at = NULL, notified_at = ?, updated_at = ?
      WHERE id = ?
    `).run(zone || courier.zone, startTime, endTime, offerExpiresAt, stamp, stamp, existing.id);
    return existing.id;
  }

  const id = uid("shiftplan");
  db.prepare(`
    INSERT INTO courier_shift_plans (id, courier_id, zone, plan_date, start_time, end_time, status, offer_expires_at, accepted_at, notified_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'awaiting_courier_acceptance', ?, NULL, ?, ?, ?)
  `).run(id, courierId, zone || courier.zone, planDate, startTime, endTime, offerExpiresAt, stamp, stamp, stamp);
  return id;
}

function expirePendingShiftPlans() {
  db.prepare(`
    UPDATE courier_shift_plans
    SET status = 'expired', updated_at = ?
    WHERE status = 'awaiting_courier_acceptance'
      AND offer_expires_at IS NOT NULL
      AND datetime(offer_expires_at) <= datetime(?)
  `).run(nowIso(), nowIso());
}

function acceptShiftPlan(courierId, planId) {
  expirePendingShiftPlans();
  const plan = db.prepare("SELECT * FROM courier_shift_plans WHERE id = ? AND courier_id = ?").get(planId, courierId);
  if (!plan) {
    throw httpError(404, "Vardiya plani bulunamadi.");
  }
  if (plan.status === "accepted") {
    return plan.id;
  }
  if (plan.status !== "awaiting_courier_acceptance") {
    throw httpError(400, "Bu vardiya plani artik onaylanamaz.");
  }
  if (plan.offer_expires_at && new Date(plan.offer_expires_at).getTime() <= Date.now()) {
    db.prepare("UPDATE courier_shift_plans SET status = 'expired', updated_at = ? WHERE id = ?").run(nowIso(), plan.id);
    throw httpError(400, "Vardiya onay suresi doldu.");
  }

  const stamp = nowIso();
  db.prepare(`
    UPDATE courier_shift_plans
    SET status = 'accepted', accepted_at = ?, updated_at = ?
    WHERE id = ?
  `).run(stamp, stamp, plan.id);
  return plan.id;
}

function updateCashReconciliationRecord(recordId, payload = {}) {
  const current = db.prepare("SELECT * FROM cash_reconciliations WHERE id = ?").get(recordId);
  if (!current) {
    throw httpError(404, "Nakit mutabakat kaydi bulunamadi.");
  }

  const expectedCash = Number(current.expected_cash || 0);
  const reportedCash = payload.reportedCash === undefined || payload.reportedCash === ""
    ? Number(current.reported_cash || expectedCash)
    : normalizeMoney(payload.reportedCash);
  const status = trimmed(payload.status) || current.status || "pending";
  const adminNote = trimmed(payload.adminNote) || current.admin_note || "";
  const variance = Number((reportedCash - expectedCash).toFixed(2));

  db.prepare(`
    UPDATE cash_reconciliations
    SET reported_cash = ?, variance = ?, status = ?, admin_note = ?, updated_at = ?
    WHERE id = ?
  `).run(reportedCash, variance, status, adminNote, nowIso(), recordId);

  return db.prepare("SELECT * FROM cash_reconciliations WHERE id = ?").get(recordId);
}

function adminAssignPackageToCourier(packageId, courierId) {
  return withImmediateTransaction(() => {
    const target = db.prepare("SELECT * FROM packages WHERE id = ?").get(packageId);
    if (!target) {
      throw httpError(404, "Paket bulunamadi.");
    }

    const targetStatus = normalizeStatus(target.status);
    if ([PENDING_APPROVAL_STATUS, REJECTED_STATUS, ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS, DELIVERED_STATUS, CANCELED_STATUS].includes(targetStatus)) {
      throw httpError(400, "Bu durumdaki paket manuel override ile atanamaz.");
    }

    const courier = db.prepare("SELECT * FROM couriers WHERE id = ?").get(courierId);
    if (!courier) {
      throw httpError(404, "Kurye bulunamadi.");
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
    appendTriedCourier(packageId, courier.id);
    const assignedPackage = getPackageById(packageId);
    syncAssignmentRetryForPackage(assignedPackage);
    if (isPlatformBackedPackage(target)) {
      notifyPlatformOrderAssigned(target.source_platform, target.external_order_id || target.external_order_no, courier.id, assignedPackage);
    }
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
    clearAssignmentRetry(packageId);
    setPackageTriedCouriers(packageId, []);
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
  syncCourierOperationalStatuses(state);
  const occupiedCourierLoads = new Map();
  state.packages
    .filter((pkg) => isCapacityBlockingPackage(pkg))
    .forEach((pkg) => reserveCourier(occupiedCourierLoads, pkg.assignedCourierId, 1));

  const candidatePackages = state.packages
    .filter((pkg) => {
      const status = normalizeStatus(pkg.status);
      return [PENDING_STATUS, PREPARING_STATUS, AWAITING_ASSIGNMENT_STATUS, FAILED_STATUS].includes(status) || isCourierOfferExpired(pkg);
    })
    .sort((left, right) => waitingPackagePriority(left) - waitingPackagePriority(right));

  candidatePackages.forEach((pkg) => {
    attemptPackageAssignment(state, pkg, occupiedCourierLoads);
  });

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
    waitingPackages: state.packages.filter((item) => [PENDING_APPROVAL_STATUS, PENDING_STATUS, PREPARING_STATUS, AWAITING_ASSIGNMENT_STATUS].includes(item.status)).length,
    assignedPackages: state.packages.filter((item) => item.assignedCourierId).length,
    inTransitPackages: state.packages.filter((item) => [ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS].includes(item.status)).length,
    deliveredPackages: state.packages.filter((item) => item.status === DELIVERED_STATUS).length,
  };
}

function statsFromDb(filter = {}) {
  const packageWhere = filter.restaurantId ? "restaurant_id = ?" : "";
  const packageParams = filter.restaurantId ? [filter.restaurantId] : [];
  const activeStatuses = [PENDING_APPROVAL_STATUS, PENDING_STATUS, PREPARING_STATUS, AWAITING_ASSIGNMENT_STATUS];
  const transitStatuses = [ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS];
  const wherePrefix = packageWhere ? `${packageWhere} AND ` : "";
  return {
    totalRestaurants: filter.restaurantId ? 1 : countTable("restaurants"),
    totalCouriers: countTable("couriers"),
    totalPlatformAccounts: filter.restaurantId ? countTable("platform_accounts", "restaurant_id = ?", [filter.restaurantId]) : countTable("platform_accounts"),
    activeCouriers: countTable("couriers", "status IN (?, ?)", [COURIER_ONLINE_STATUS, COURIER_BUSY_STATUS]),
    totalPackages: countTable("packages", packageWhere, packageParams),
    waitingPackages: db.prepare(`SELECT COUNT(*) AS count FROM packages WHERE ${wherePrefix}status IN (${activeStatuses.map(() => "?").join(",")})`).get(...packageParams, ...activeStatuses).count,
    assignedPackages: db.prepare(`SELECT COUNT(*) AS count FROM packages WHERE ${wherePrefix}assigned_courier_id IS NOT NULL`).get(...packageParams).count,
    inTransitPackages: db.prepare(`SELECT COUNT(*) AS count FROM packages WHERE ${wherePrefix}status IN (${transitStatuses.map(() => "?").join(",")})`).get(...packageParams, ...transitStatuses).count,
    deliveredPackages: countTable("packages", packageWhere ? `${packageWhere} AND status = ?` : "status = ?", [...packageParams, DELIVERED_STATUS]),
  };
}

function decorateState(filter = {}) {
  const pagination = filter.pagination || paginationFromRequest(filter.req, { limit: DEFAULT_PAGE_LIMIT, offset: 0 });
  const paginatedFilter = { ...filter, pagination };
  const state = currentState(paginatedFilter);
  const restaurantMap = new Map(state.restaurants.map((item) => [item.id, item.name]));
  const activeLoadMap = buildActiveLoadMap(state.packages);

  const couriers = state.couriers.map((courier) => ({
    ...sanitizeCourier(courier),
    activeLoad: activeLoadMap.get(courier.id) || 0,
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
    waitingCount: packages.filter((item) => item.zone === zone && [PENDING_APPROVAL_STATUS, PENDING_STATUS, PREPARING_STATUS, AWAITING_ASSIGNMENT_STATUS].includes(item.status)).length,
  }));
  const sanitizedPlatformAccounts = state.platformAccounts.map((account) => sanitizePlatformAccount(account, Boolean(filter.includePlatformSecrets || filter.includeRestaurantSecrets)));

  return {
    systemSettings: getSystemSettings(),
    zones,
    zoneAlerts: buildZoneAlerts(zones, packages),
    restaurants: state.restaurants.map((restaurant) => sanitizeRestaurant(restaurant, Boolean(filter.includeRestaurantSecrets))),
    platformAccounts: sanitizedPlatformAccounts,
    platformOrders: state.platformOrders,
    couriers,
    packages,
    courierDailyReports: getCourierDailyReports(50),
    shiftPlans: getShiftPlans(dayKey()),
    shiftPlanSummary: summarizeShiftPlans(dayKey()),
    cashReconciliations: getCashReconciliations(30),
    announcements: filter.courierId ? getAnnouncements("courier") : getAnnouncements(),
    notifications: filter.courierId
      ? getNotifications("courier", filter.courierId, 20)
      : filter.restaurantId
        ? getNotifications("restaurant", filter.restaurantId, 20)
        : getNotifications("admin", null, 20),
    webhookLogs: state.webhookLogs,
    platformEvents: state.platformEvents,
    pagination: {
      packages: packagePagination(filter, pagination),
      platformOrders: platformOrdersPagination(filter, pagination),
      webhookLogs: pageMeta(filter.restaurantId ? countTable("webhook_logs", "restaurant_id = ?", [filter.restaurantId]) : countTable("webhook_logs"), { limit: 20, offset: 0 }),
      auditLogs: pageMeta(filter.restaurantId ? countTable("audit_logs", "restaurant_id = ?", [filter.restaurantId]) : countTable("audit_logs"), { limit: 20, offset: 0 }),
    },
    stats: statsFromDb(filter),
    systemStatus: {
      queues: queueHealthPayload(),
      cache: cacheHealthPayload(),
      totals: {
        failedWebhooks: tableCountSafe("webhook_logs", "(response_status >= 400 OR dead_lettered_at IS NOT NULL)"),
        deadLetteredWebhooks: tableCountSafe("webhook_logs", "dead_lettered_at IS NOT NULL"),
      },
      lastRequestId: recentRequestLogs.at(-1)?.requestId || null,
      platformHealth: platformHealthSummaryPayload(),
    },
    restaurantPerformance: filter.restaurantId ? buildRestaurantPerformance(packages) : null,
    integrationWizard: filter.restaurantId ? buildRestaurantIntegrationWizard(filter.req || { headers: {}, url: "/" }, state.restaurants[0] || null, sanitizedPlatformAccounts) : null,
  };
}

function logWebhookAttempt(entry) {
  const safeRequestBody = redactSecretsFromText(entry.requestBody);
  const result = db.prepare(`
    INSERT INTO webhook_logs (
      restaurant_id, source_platform, external_order_no, signature_valid, response_status, request_body,
      retry_count, next_retry_at, dead_lettered_at, last_error, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.restaurantId || null,
    entry.sourcePlatform || null,
    entry.externalOrderNo || null,
    entry.signatureValid ? 1 : 0,
    entry.responseStatus,
    safeRequestBody,
    Number(entry.retryCount || 0),
    entry.nextRetryAt || null,
    entry.deadLetteredAt || null,
    entry.lastError || null,
    new Date().toISOString()
  );

  const line = `[${new Date().toISOString()}] status=${entry.responseStatus} signature=${entry.signatureValid ? "valid" : "invalid"} restaurant=${entry.restaurantId || "-"} platform=${entry.sourcePlatform || "-"} order=${entry.externalOrderNo || "-"}${"\n"}`;
  fs.appendFileSync(WEBHOOK_LOG_FILE, line);
  return Number(result.lastInsertRowid || 0);
}

function logPlatformEvent(entry = {}) {
  try {
    db.prepare(`
      INSERT INTO platform_events (
        platform, restaurant_id, platform_account_id, event_type, request_id, status, http_status,
        error_code, error_message, retry_count, next_retry_at, dead_lettered_at, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.platform || null,
      entry.restaurantId || null,
      entry.platformAccountId || null,
      entry.eventType || "webhook",
      entry.requestId || null,
      entry.status || "error",
      entry.httpStatus || null,
      entry.errorCode || null,
      entry.errorMessage || null,
      Number(entry.retryCount || 0),
      entry.nextRetryAt || null,
      entry.deadLetteredAt || null,
      json(entry.metadata || {}),
      entry.createdAt || nowIso()
    );
  } catch (error) {
    logger.warn("Platform event log failed", { error: error.message, eventType: entry.eventType });
  }
}

function getPlatformEvents(limit = 20, filter = {}) {
  const offset = parsePositiveInteger(filter.offset, 0);
  const params = [];
  const where = [];
  if (filter.restaurantId) {
    where.push("restaurant_id = ?");
    params.push(filter.restaurantId);
  }
  if (filter.platformAccountId) {
    where.push("platform_account_id = ?");
    params.push(filter.platformAccountId);
  }
  const sql = `
    SELECT * FROM platform_events
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `;
  const rows = db.prepare(sql).all(...params, limit, offset);
  return rows.map((row) => ({
    id: row.id,
    platform: row.platform,
    restaurantId: row.restaurant_id,
    platformAccountId: row.platform_account_id,
    eventType: row.event_type,
    requestId: row.request_id,
    status: row.status,
    httpStatus: row.http_status,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    retryCount: row.retry_count || 0,
    nextRetryAt: row.next_retry_at,
    deadLetteredAt: row.dead_lettered_at,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
  }));
}

function providerHealthUrlForAccount(account) {
  const slugKey = platformSlug(account?.platform).toUpperCase().replace(/-/g, "_");
  return trimmed(
    process.env[`DELIVERA_HEALTH_URL_${slugKey}`] ||
    process.env[`DELIVERA_VERIFY_URL_${slugKey}`] ||
    process.env[platformVerifyEnvKey(account?.platform)] ||
    ""
  );
}

async function checkPlatformAccountConnection(account, req = null) {
  const result = await connectionHealthService.checkAccount(account);
  if (!result.ok) {
    logPlatformEvent({
      platform: account.platform,
      restaurantId: account.restaurantId,
      platformAccountId: account.id,
      eventType: "connection_check",
      requestId: req?.requestId || null,
      status: "error",
      httpStatus: result.httpStatus || null,
      errorCode: result.errorCode || HEALTH_ERROR_CODES.UNKNOWN_ERROR,
      errorMessage: result.errorMessage || "Platform connection check failed",
      metadata: {
        latencyMs: result.latencyMs,
        providerUrlConfigured: Boolean(result.providerUrlConfigured),
      },
    });
  }
  return {
    ok: Boolean(result.ok),
    result,
    account: sanitizePlatformAccount(getPlatformAccounts().find((item) => item.id === account.id) || account, true),
    recentEvents: getPlatformEvents(10, { platformAccountId: account.id }),
  };
}

function logPlatformConnectionTest(account, result) {
  const status = result?.status === "timeout" ? 408 : Number(result?.status || 0) || 500;
  logWebhookAttempt({
    restaurantId: account?.restaurantId,
    sourcePlatform: account?.platform,
    externalOrderNo: "connection-test",
    signatureValid: Boolean(result?.ok),
    responseStatus: status,
    requestBody: json({
      type: "platform_connection_test",
      platform: account?.platform,
      externalStoreId: account?.externalStoreId,
      status: result?.status || null,
      ok: Boolean(result?.ok),
      message: result?.message || "",
    }),
  });
}

function platformConnectionHttpStatus(result) {
  if (result?.ok) return 200;
  if (result?.optional || result?.manualAvailable || result?.status === 200) return 200;
  if (result?.status === 401) return 401;
  if (result?.status === 403) return 403;
  if (result?.status === 404) return 404;
  if (result?.status === "timeout") return 408;
  return 400;
}

function optionalIntegrationResult(message = "Polling kapali veya API bilgileri eksik.") {
  return {
    ok: false,
    optional: true,
    manualAvailable: true,
    status: 200,
    message,
  };
}

function platformAccountMissingCredentials(account) {
  const platform = normalizePlatformInput(account?.platform);
  if (platform === "Trendyol Yemek") {
    return !(account?.apiKey && account?.apiSecret && (account?.externalMerchantId || account?.externalStoreId || account?.externalId));
  }
  if (platform === "POS") {
    return !((account?.token || account?.accessToken) && (account?.apiSecret || account?.webhookSecret));
  }
  return !(account?.apiKey || account?.apiSecret || account?.token || account?.accessToken || account?.apiUsername || account?.apiPassword);
}

function isCreatedPlatformOrder(rawOrder) {
  const order = rawOrder?.order || rawOrder || {};
  const status = trimmed(
    order.status ??
    order.orderStatus ??
    order.order_status ??
    order.packageStatus ??
    order.package_status ??
    rawOrder?.status
  ).toLowerCase();
  return status === "created";
}

function isPollableCreatedPlatformOrder(platform, rawOrder) {
  const normalizedPlatform = normalizePlatformInput(platform);
  if (normalizedPlatform !== "POS") {
    return isCreatedPlatformOrder(rawOrder);
  }

  const order = rawOrder?.order || rawOrder || {};
  const status = trimmed(
    order.status ??
    order.orderStatus ??
    order.order_status ??
    order.packageStatus ??
    order.package_status ??
    rawOrder?.status
  ).toLowerCase();

  return !status || ["created", "new", "pending", "open"].includes(status);
}

function buildIntegrationInfo(req, restaurant) {
  return {
    restaurantId: restaurant.id,
    restaurantName: restaurant.name,
    portalUsername: restaurant.username,
    apiKey: restaurant.apiKey ? "Kayitli" : "",
    webhookSecret: restaurant.webhookSecret ? "Kayitli" : "",
    endpoint: `${requestBaseUrl(req)}/api/platform/order`,
    platformWebhookBase: `${requestBaseUrl(req)}/api/platform/order`,
    signatureHeader: "x-platform-secret",
    samplePayload: {
      platform: platformSlug(restaurant.platforms[0] || "Trendyol Yemek").replace(/-/g, "_"),
      platformRestaurantId: restaurant.id,
      orderId: "PLATFORM-ORDER-ID",
      customerName: "Musteri Adi",
      phone: "5551234567",
      address: "Mersin teslimat adresi",
      totalPrice: 250,
    },
  };
}

function redactSecretsFromText(value) {
  const text = String(value || "");
  if (!text) {
    return "";
  }
  try {
    const data = JSON.parse(text);
    const redact = (item) => {
      if (Array.isArray(item)) {
        return item.map(redact);
      }
      if (item && typeof item === "object") {
        return Object.fromEntries(Object.entries(item).map(([key, val]) => {
          const lower = key.toLowerCase();
          if (lower.includes("secret") || lower.includes("token") || lower.includes("password") || lower.includes("apikey") || lower.includes("api_key")) {
            return [key, "***"];
          }
          return [key, redact(val)];
        }));
      }
      return item;
    };
    return JSON.stringify(redact(data));
  } catch {
    return text.replace(/("(?:api_?key|api_?secret|token|secret|password)"\s*:\s*")[^"]+(")/gi, "$1***$2");
  }
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
  if (draft.platform === "Trendyol Yemek") {
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
      recipient, phone, address, zone, eta, payment_method, order_amount, payment_status, x, y, customer_lat, customer_lng, customer_address, note, customer_note, items_json, raw_payload_json, status, assignment_status,
      assigned_courier_id, assigned_courier_name, assigned_at, accepted_at, on_route_at, delivered_at, failed_at,
      distance_km, assignment_reason, failure_reason, last_assignment_attempt_at, last_assignment_error, assignment_tried_courier_ids_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    pkg.id,
    ensureUniqueTrackingNo(pkg.trackingNo),
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
    pkg.customerLatitude ?? null,
    pkg.customerLongitude ?? null,
    pkg.customerAddress || pkg.deliveryAddress || pkg.address,
    pkg.note,
    pkg.customerNote || null,
    json(Array.isArray(pkg.items) ? pkg.items : []),
    json(pkg.rawPayload || null),
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
    json(normalizeIdList(pkg.assignmentTriedCourierIds || [])),
    pkg.createdAt,
    pkg.updatedAt || pkg.createdAt
  );
}

function findDuplicatePackage(restaurantId, source, externalOrderId) {
  if (!restaurantId || !externalOrderId) {
    return null;
  }

  if (!source || source === "platform_any") {
    return db.prepare(`
      SELECT * FROM packages
      WHERE restaurant_id = ? AND source IN ('platform_webhook', 'platform_polling') AND external_order_id = ?
    `).get(restaurantId, externalOrderId) || null;
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
  syncAssignmentRetryForPackage(getPackageById(packageId));
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

function verifyPlatformWebhookAuth(account, req, rawBody = undefined) {
  const signature = verifyPlatformSignature({ req, account, rawBody });
  if (signature.ok) {
    return true;
  }

  if (account.webhookAuthType === PLATFORM_WEBHOOK_AUTH_TYPES.BASIC_AUTH) {
    const basic = parseBasicAuthHeader(req);
    if (!basic || !basic.username || !basic.password) {
      return false;
    }
    // Use timing-safe comparison for credentials
    try {
      const usernameSafe = crypto.timingSafeEqual(
        Buffer.from(basic.username),
        Buffer.from(account.webhookUsername || "")
      );
      const passwordSafe = crypto.timingSafeEqual(
        Buffer.from(basic.password),
        Buffer.from(account.webhookPassword || "")
      );
      return usernameSafe && passwordSafe;
    } catch {
      return false;
    }
  }

  if (account.webhookAuthType === PLATFORM_WEBHOOK_AUTH_TYPES.STATIC_TOKEN) {
    const authorization = String(req.headers.authorization || "");
    const bearerToken = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    const tokens = candidateHeaderValues(req, ["x-webhook-token", "x-static-token", "x-partner-token", "x-yemeksepeti-token"]);
    
    // Use timing-safe comparison for tokens
    const allTokens = [bearerToken, ...tokens].filter(Boolean);
    const expectedToken = account.staticToken || "";
    
    return allTokens.some((token) => {
      try {
        if (token.length !== expectedToken.length) return false;
        return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expectedToken));
      } catch {
        return false;
      }
    });
  }

  const apiKeys = candidateHeaderValues(req, ["x-api-key", "api-key", "x-platform-api-key"]);
  const expectedApiKey = account.webhookApiKey || "";
  
  // Use timing-safe comparison for API keys
  return apiKeys.some((key) => {
    try {
      if (key.length !== expectedApiKey.length) return false;
      return crypto.timingSafeEqual(Buffer.from(key), Buffer.from(expectedApiKey));
    } catch {
      return false;
    }
  });
}

function verifySimplePlatformSecret(account, restaurant, req) {
  const incomingSecret = candidateHeaderValues(req, ["x-platform-secret", "x-webhook-secret", "x-api-key"])[0] || "";
  if (!incomingSecret) {
    return false;
  }
  const allowedSecrets = [
    account?.webhookSecret,
    account?.staticToken,
    restaurant?.webhookSecret,
  ].map(trimmed).filter(Boolean);
  return allowedSecrets.includes(incomingSecret);
}

function mapExternalStatusToInternal(status) {
  const incoming = trimmed(status).toUpperCase();

  if (!incoming) {
    return PENDING_APPROVAL_STATUS;
  }

  if (["CREATED", "RECEIVED", "NEW", "PREPARING"].includes(incoming)) {
    return PENDING_APPROVAL_STATUS;
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

  if (["REJECTED"].includes(incoming)) {
    return REJECTED_STATUS;
  }

  if (["CANCELLED", "CANCELED"].includes(incoming)) {
    return CANCELED_STATUS;
  }

  return PENDING_APPROVAL_STATUS;
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
    `${suggestedRestaurantPrepMinutes(safeZone)} dk`
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
    customerAddress: safeAddress,
    customerLatitude: latitude,
    customerLongitude: longitude,
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
    customerNote: pickFirstValue(shipment.customerNote, shipment.customer_note, shipment.note, shipment.comment),
    items: normalizeIncomingOrderItems(shipment.items || shipment.products || shipment.lines),
    rawPayload: body,
    status: mapExternalStatusToInternal(shipment.status),
  };
}

function upsertPlatformPackage(platform, restaurant, payload) {
  return withImmediateTransaction(() => {
    const existing = findDuplicatePackage(restaurant.id, "platform_any", payload.externalOrderId || payload.externalOrderNo);
    upsertPlatformOrderRecord({
      platform,
      orderId: payload.externalOrderId || payload.externalOrderNo,
      customerName: payload.recipient,
      phone: payload.phone,
      address: payload.address,
      totalPrice: payload.orderAmount,
      note: payload.customerNote || payload.note,
      rawPayload: payload.rawPayload || payload,
    }, restaurant.id, payload.status === CANCELED_STATUS ? "cancelled" : "pending_approval");

    if (!existing) {
      const pkg = validateIntegrationDraft(payload, restaurant);
      createPackageRecord(pkg, "Platform Siparisi");
      if (normalizeStatus(pkg.status) !== PENDING_APPROVAL_STATUS) {
        rebalancePackages();
      }
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
      return { ...getPackageById(pkg.id), duplicate: false };
    }

    logger.info("Duplicate order skipped", {
      platform,
      restaurantId: restaurant.id,
      externalOrderNo: payload.externalOrderNo,
      packageId: existing.id,
    });

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
      if (incomingStatus !== PENDING_APPROVAL_STATUS && incomingStatus !== REJECTED_STATUS) {
        rebalancePackages();
      }
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

    return { ...getPackageById(existing.id), duplicate: true };
  });
}

function findPlatformRestaurant(platform, platformRestaurantId) {
  const normalizedPlatform = normalizePlatformInput(platform);
  const normalizedStoreId = trimmed(platformRestaurantId);
  if (!normalizedPlatform || !normalizedStoreId) {
    return null;
  }

  const account = getPlatformAccounts().find((item) =>
    item.active &&
    normalizePlatformInput(item.platform) === normalizedPlatform &&
    item.externalStoreId === normalizedStoreId
  );

  if (!account) {
    return null;
  }

  const restaurant = getRestaurants({ restaurantId: account.restaurantId })[0] || null;
  if (!restaurant) {
    return null;
  }

  return { account, restaurant };
}

function createSimplePlatformPayload(order, restaurant) {
  const source = order.source === "platform_polling" ? "platform_polling" : "platform_webhook";
  return {
    source,
    sourcePlatform: order.platform,
    externalOrderNo: order.orderId,
    externalOrderId: order.orderId,
    recipient: order.customerName,
    phone: order.phone,
    address: order.address,
    customerAddress: order.customerAddress || order.address,
    customerLatitude: Number.isFinite(Number(order.customerLatitude)) ? Number(order.customerLatitude) : null,
    customerLongitude: Number.isFinite(Number(order.customerLongitude)) ? Number(order.customerLongitude) : null,
    zone: restaurant.zone,
    eta: `${suggestedRestaurantPrepMinutes(restaurant.zone)} dk`,
    paymentMethod: order.paymentMethod || "Online Odeme",
    orderAmount: order.totalPrice,
    paymentStatus: normalizePaymentStatus("", order.paymentMethod || "Online Odeme"),
    latitude: restaurant.latitude,
    longitude: restaurant.longitude,
    note: order.customerNote || "Platform siparisi",
    customerNote: order.customerNote || "",
    items: Array.isArray(order.items) ? order.items : [],
    rawPayload: order.rawPayload || order,
    status: PENDING_APPROVAL_STATUS,
    assignmentStatus: "pending_approval",
    assignmentReason: "Platform siparisi restoran onayi bekliyor.",
  };
}

function handleSimplePlatformOrder(order, isManual = false) {
  const match = findPlatformRestaurant(order.platform, order.platformRestaurantId);
  if (!match) {
    return { ok: false, error: "Restaurant not found", statusCode: 404 };
  }

  logger.info("Platform matched", {
    platform: match.account.platform,
    restaurantId: match.restaurant.id,
    platformRestaurantId: match.account.externalStoreId,
  });

  const payload = createSimplePlatformPayload({
    ...order,
    platform: match.account.platform,
  }, match.restaurant);
  
  if (isManual) {
    payload.status = AWAITING_ASSIGNMENT_STATUS;
    payload.assignmentStatus = "unassigned";
    payload.assignmentReason = "Manuel platform siparisi onaylanarak havuza alindi.";
  }
  
  upsertPlatformOrderRecord({ ...order, platform: match.account.platform }, match.restaurant.id, isManual ? "accepted" : "pending_approval");
  const created = upsertPlatformPackage(match.account.platform, match.restaurant, payload);
  logger.info("Package created from platform order", {
    platform: match.account.platform,
    restaurantId: match.restaurant.id,
    orderId: order.orderId,
    packageId: created?.id || null,
    trackingNo: created?.trackingNo || null,
    source: payload.source,
  });
  broadcastLiveEvent({
    type: "platform-order-pending",
    restaurantId: match.restaurant.id,
    message: "Yeni platform siparisi geldi.",
  });

  return {
    ok: true,
    restaurant: match.restaurant,
    account: match.account,
    package: created,
  };
}

function connectorForPlatform(platform) {
  return platformConnectors[normalizePlatformInput(platform) || platform] || null;
}

async function testPlatformAccountAutomatically(account) {
  const strategy = testStrategyForAccount(account);
  if (strategy === "local_webhook") {
    if (IS_PRODUCTION) {
      return {
        ok: true,
        status: 200,
        strategy,
        optional: true,
        message: "Webhook bilgileri kaydedildi. Hesap ilk gercek platform siparisi geldiginde otomatik dogrulanacak.",
      };
    }
    const result = handleSimplePlatformOrder({
      platform: account.platform,
      platformRestaurantId: account.externalStoreId,
      orderId: `TEST-${Date.now()}`,
      customerName: "Test Musteri",
      phone: "05555555555",
      address: "Mersin Test Adresi",
      totalPrice: 250,
      paymentMethod: "Online Odeme",
      customerNote: "Entegrasyon Merkezi test siparisi",
      items: [{ id: "test-1", name: "Test Menu", quantity: 1, price: 250 }],
    });
    return result.ok
      ? {
          ok: true,
          status: 200,
          strategy,
          message: "Bağlantı başarılı. Webhook dogrulama siparisi olusturuldu.",
          package: result.package,
        }
      : {
          ok: false,
          status: result.statusCode || 404,
          strategy,
          message: platformFriendlyError(result.error, account.platform),
        };
  }

  const connector = connectorForPlatform(account.platform);
  if (!connector || typeof connector.testConnection !== "function") {
    return optionalIntegrationResult("Bu platform için otomatik bağlantı doğrulaması bulunamadı. Webhook modu kullanılacak.");
  }
  if (platformAccountMissingCredentials(account)) {
    return {
      ...optionalIntegrationResult(platformFriendlyError("API bilgileri eksik", account.platform)),
      strategy,
    };
  }

  try {
    const result = await connector.testConnection(account);
    return {
      ...result,
      strategy,
      message: platformFriendlyError(result.message || `HTTP ${result.status}`, account.platform),
    };
  } catch (error) {
    return {
      ok: false,
      status: "timeout",
      strategy,
      message: platformFriendlyError(error.message, account.platform),
    };
  }
}

const posMissingEndpointLogKeys = new Set();

async function pollPlatformAccount(account, options = {}) {
  if (!account.pollingEnabled) {
    logger.info("Polling skipped", {
      platform: account.platform,
      accountId: account.id,
      reason: "polling_enabled false",
    });
    return {
      ok: false,
      skipped: true,
      optional: true,
      reason: "Polling kapali veya API bilgileri eksik",
    };
  }
  if (!options.manual && !PLATFORM_POLLING_ENABLED) {
    return {
      ok: false,
      skipped: true,
      optional: true,
      reason: "Polling API kapalı — webhook ile sipariş bekleniyor.",
    };
  }
  const connector = connectorForPlatform(account.platform);
  if (!connector || typeof connector.fetchOrders !== "function") {
    return { ok: false, skipped: true, reason: "connector yok" };
  }
  const isPosAccount = normalizePlatformInput(account.platform) === "POS";
  if (platformAccountMissingCredentials(account)) {
    return { ok: false, skipped: true, optional: true, reason: "Polling kapali veya API bilgileri eksik" };
  }
  if (!isPosAccount && account.verificationStatus !== PLATFORM_VERIFICATION_STATUS.VERIFIED) {
    return { ok: false, skipped: true, reason: "API baglanti testi basarili olmadan polling calismaz." };
  }
  if (isPosAccount && !options.manual && typeof connector.endpointConfigured === "function" && !connector.endpointConfigured(account)) {
    const logKey = `${account.id}:missing_endpoint`;
    if (!posMissingEndpointLogKeys.has(logKey)) {
      posMissingEndpointLogKeys.add(logKey);
      logger.warn("POS polling skipped", {
        accountId: account.id,
        platformRestaurantId: account.externalStoreId,
        endpointConfigured: false,
        reason: "API endpoint eksik",
      });
    }
    return {
      ok: false,
      skipped: true,
      optional: true,
      reason: "POS API endpoint eksik. ADISYO_API_BASE_URL veya ADISYO_POLLING_URL tanimlayin.",
    };
  }

  let rawOrders = [];
  try {
    rawOrders = await connector.fetchOrders(account);
  } catch (error) {
    if (error.code === "POS_ENDPOINT_MISSING") {
      const logKey = `${account.id}:missing_endpoint`;
      if (options.manual || !posMissingEndpointLogKeys.has(logKey)) {
        posMissingEndpointLogKeys.add(logKey);
        logger.warn("POS polling skipped", {
          accountId: account.id,
          platformRestaurantId: account.externalStoreId,
          endpointConfigured: false,
          reason: "API endpoint eksik",
        });
      }
      return {
        ok: false,
        skipped: true,
        optional: true,
        reason: "POS API endpoint eksik. ADISYO_API_BASE_URL veya ADISYO_POLLING_URL tanimlayin.",
      };
    }
    logger.error("Platform polling connector failed", {
      platform: account.platform,
      accountId: account.id,
      error,
    });
    return { ok: false, skipped: true, reason: "Platform polling tamamlanamadi, manuel paket sistemi kullanilabilir." };
  }
  const createdOrders = rawOrders.filter((rawOrder) => isPollableCreatedPlatformOrder(account.platform, rawOrder));
  let createdCount = 0;
  for (const rawOrder of createdOrders) {
    const normalized = connector.normalizeOrder({
      ...rawOrder,
      platform: account.platform,
      platformRestaurantId: rawOrder?.platformRestaurantId || rawOrder?.platform_restaurant_id || account.externalStoreId,
    });
    const order = normalizeOrder(account.platform, {
      ...normalized,
      platform: account.platform,
      platformRestaurantId: normalized.platformRestaurantId || account.externalStoreId,
    });
    const existing = db.prepare(`
      SELECT id FROM platform_orders
      WHERE platform = ? AND platform_order_id = ? AND restaurant_id = ?
    `).get(account.platform, order.orderId, account.restaurantId);
    const result = handleSimplePlatformOrder(order);
    if (result.ok && !existing) {
      createdCount += 1;
      logger.info("Platform order saved from polling", {
        platform: account.platform,
        accountId: account.id,
        restaurantId: account.restaurantId,
        platformRestaurantId: order.platformRestaurantId,
        orderId: order.orderId,
        packageId: result.package?.id || null,
        status: result.package?.status || PENDING_APPROVAL_STATUS,
      });
      if (typeof connector.acknowledgeOrder === "function") {
        await connector.acknowledgeOrder(order);
      }
    }
  }

  db.prepare("UPDATE platform_accounts SET last_poll_at = ?, last_sync_at = ?, last_error = NULL, updated_at = ? WHERE id = ?").run(nowIso(), nowIso(), nowIso(), account.id);
  return { ok: true, createdCount, fetchedCount: rawOrders.length, createdStatusCount: createdOrders.length };
}

let platformPollingRunning = false;

async function pollPlatformAccounts() {
  if (platformPollingRunning) {
    return;
  }
  platformPollingRunning = true;
  try {
    const accounts = getPlatformAccounts().filter((account) => account.active);
    for (const account of accounts) {
      try {
        await pollPlatformAccount(account);
      } catch (error) {
        db.prepare(`
          UPDATE platform_accounts
          SET verification_status = ?, verification_note = ?, updated_at = ?
          WHERE id = ?
        `).run(
          PLATFORM_VERIFICATION_STATUS.PENDING,
          `Polling tamamlanamadi: ${error.message}`,
          nowIso(),
          account.id
        );
      }
    }
  } finally {
    platformPollingRunning = false;
  }
}

function getPackageById(packageId) {
  const row = db.prepare("SELECT * FROM packages WHERE id = ?").get(packageId);
  if (!row) {
    return null;
  }
  const restaurant = db.prepare("SELECT name FROM restaurants WHERE id = ?").get(row.restaurant_id);
  return mapPackageRow(row, new Map([[row.restaurant_id, restaurant?.name || "Bilinmeyen Restoran"]]));
}

function appendPlatformStatusLog(packageId, entry) {
  const target = db.prepare("SELECT platform_status_logs_json FROM packages WHERE id = ?").get(packageId);
  if (!target) {
    return [];
  }

  const logs = parseJson(target.platform_status_logs_json, []);
  const nextLogs = logs.concat({
    id: uid("plog"),
    status: entry.status,
    message: entry.message,
    platform: entry.platform,
    createdAt: nowIso(),
    meta: entry.meta || {},
  });
  db.prepare("UPDATE packages SET platform_status_logs_json = ?, updated_at = ? WHERE id = ?").run(
    json(nextLogs),
    nowIso(),
    packageId
  );
  return nextLogs;
}

async function callPlatformStatusCallback(packageRecord, status, meta = {}) {
  if (!packageRecord || !packageRecord.sourcePlatform) {
    return { ok: false };
  }

  const orderData = {
    orderId: packageRecord.externalOrderId || packageRecord.externalOrderNo,
    restaurantId: packageRecord.restaurantId,
    courierId: packageRecord.assignedCourierId || null,
    status,
    meta,
  };
  appendPlatformStatusLog(packageRecord.id, {
    status,
    message: `platform ${status} callback hazirlaniyor`,
    platform: packageRecord.sourcePlatform,
    meta,
  });
  let result;
  try {
    result = await sendPlatformStatusCallback({ db, packageRecord, status, meta });
  } catch (error) {
    result = { ok: false, error: error.message };
  }
  const message = result?.ok
    ? `platforma ${status} bildirildi`
    : `platform ${status} callback basarisiz: ${result?.error || result?.status || "unknown"}`;
  appendPlatformStatusLog(packageRecord.id, {
    status,
    message,
    platform: packageRecord.sourcePlatform,
    meta: { ...meta, callbackMode: result?.mode || null, callbackStatus: result?.status || null },
  });
  writeAuditLog({
    actorRole: "integration",
    actorId: packageRecord.restaurantId,
    action: "platform_status_callback",
    packageId: packageRecord.id,
    restaurantId: packageRecord.restaurantId,
    details: {
      platform: packageRecord.sourcePlatform,
      status,
      meta,
    },
  });
  logger[result?.ok ? "info" : "warn"]("Platform status callback completed", {
    packageId: packageRecord.id,
    platform: packageRecord.sourcePlatform,
    status,
    ok: Boolean(result?.ok),
    mode: result?.mode || null,
    callbackStatus: result?.status || null,
    error: result?.error || null,
  });
  logPlatformEvent({
    platform: packageRecord.sourcePlatform,
    restaurantId: packageRecord.restaurantId,
    platformAccountId: result?.platformAccountId || null,
    eventType: "callback",
    status: result?.ok ? "success" : "error",
    httpStatus: Number(result?.status) || null,
    errorCode: result?.ok ? null : HEALTH_ERROR_CODES.CALLBACK_FAILED,
    errorMessage: result?.ok ? null : (result?.error || "callback_failed"),
    metadata: { packageId: packageRecord.id, callbackMode: result?.mode || null, callbackStatus: result?.status || null },
  });
  if (result?.platformAccountId) {
    db.prepare(`
      UPDATE platform_accounts
      SET last_callback_at = ?,
          connection_status = CASE WHEN ? THEN 'connected' ELSE connection_status END,
          last_success_at = CASE WHEN ? THEN ? ELSE last_success_at END,
          last_error_at = CASE WHEN ? THEN last_error_at ELSE ? END,
          last_error_code = CASE WHEN ? THEN last_error_code ELSE ? END,
          last_error_message = CASE WHEN ? THEN last_error_message ELSE ? END,
          consecutive_failures = CASE WHEN ? THEN 0 ELSE COALESCE(consecutive_failures, 0) + 1 END,
          updated_at = ?
      WHERE id = ?
    `).run(
      nowIso(),
      result.ok ? 1 : 0,
      result.ok ? 1 : 0,
      nowIso(),
      result.ok ? 1 : 0,
      nowIso(),
      result.ok ? 1 : 0,
      HEALTH_ERROR_CODES.CALLBACK_FAILED,
      result.ok ? 1 : 0,
      result?.error || "callback_failed",
      result.ok ? 1 : 0,
      nowIso(),
      result.platformAccountId
    );
  }
  if (!result?.ok) {
    const webhookLogId = logWebhookAttempt({
      restaurantId: packageRecord.restaurantId,
      sourcePlatform: packageRecord.sourcePlatform,
      externalOrderNo: orderData.orderId,
      signatureValid: true,
      responseStatus: Number(result?.status) || 502,
      requestBody: json({ type: "platform_status_callback", status, orderData, result }),
      retryCount: 0,
      nextRetryAt: new Date(Date.now() + 30000).toISOString(),
      lastError: result?.error || "callback_failed",
    });
    queueService.enqueue(JOB_TYPES.WEBHOOK_CALLBACK_RETRY, {
      webhookLogId,
      packageId: packageRecord.id,
      platform: packageRecord.sourcePlatform,
      status,
      meta,
      orderData,
      lastError: result?.error || "callback_failed",
      createdAt: nowIso(),
    }, {
      jobId: webhookLogId ? `webhook-callback-${webhookLogId}` : undefined,
    }).then((queueResult) => {
      if (queueResult.ok) {
        logger.warn("Platform callback retry queued", {
          packageId: packageRecord.id,
          platform: packageRecord.sourcePlatform,
          status,
          jobId: queueResult.jobId,
        });
      } else {
        logger.warn("Platform callback retry inline fallback", {
          packageId: packageRecord.id,
          platform: packageRecord.sourcePlatform,
          status,
          reason: queueResult.reason,
        });
      }
    });
  }
  return result;
}

function notifyPlatformOrderAccepted(platform, orderId, restaurantId, packageRecord = null) {
  logger.info("Platform status callback requested", { platform, status: "accepted", orderId, restaurantId });
  return callPlatformStatusCallback(packageRecord || getPackageById(orderId), "accepted", { orderId, restaurantId });
}

function notifyPlatformOrderRejected(platform, orderId, reason, packageRecord = null) {
  logger.info("Platform status callback requested", { platform, status: "rejected", orderId, reason });
  return callPlatformStatusCallback(packageRecord || getPackageById(orderId), "rejected", { orderId, reason });
}

function notifyPlatformOrderPreparing(platform, orderId, packageRecord = null) {
  logger.info("Platform status callback requested", { platform, status: "preparing", orderId });
  return callPlatformStatusCallback(packageRecord || getPackageById(orderId), "preparing", { orderId });
}

function notifyPlatformOrderAssigned(platform, orderId, courierId, packageRecord = null) {
  logger.info("Platform status callback requested", { platform, status: "assigned", orderId, courierId });
  return callPlatformStatusCallback(packageRecord || getPackageById(orderId), "assigned", { orderId, courierId });
}

function notifyPlatformOrderDelivered(platform, orderId, packageRecord = null) {
  logger.info("Platform status callback requested", { platform, status: "delivered", orderId });
  return callPlatformStatusCallback(packageRecord || getPackageById(orderId), "delivered", { orderId });
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
  const generalRetry = await applyRateLimit(req, "general", RATE_LIMITS.general);
  if (generalRetry !== null) {
    sendRateLimited(res, generalRetry);
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/system-status") {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    sendJson(res, 200, systemStatusPayload());
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/performance-summary") {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    sendJson(res, 200, performanceSummaryPayload());
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/platform-health-summary") {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const restaurantMap = new Map(getRestaurants().map((restaurant) => [restaurant.id, restaurant.name]));
    const accounts = getPlatformAccounts().map((account) => ({
      ...sanitizePlatformAccount(account, true),
      restaurantName: restaurantMap.get(account.restaurantId) || "Bilinmeyen Restoran",
      recentEvents: getPlatformEvents(5, { platformAccountId: account.id }),
    }));
    sendJson(res, 200, {
      ok: true,
      summary: platformHealthSummaryPayload(),
      accounts,
      recentEvents: getPlatformEvents(20),
    });
    return;
  }

  const adminPlatformHealthMatch = pathname.match(/^\/api\/admin\/platform-accounts\/([^/]+)\/health$/);
  if (req.method === "GET" && adminPlatformHealthMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const account = getPlatformAccounts().find((item) => item.id === adminPlatformHealthMatch[1]);
    if (!account) {
      sendJson(res, 404, { error: "Platform hesabi bulunamadi." });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      account: sanitizePlatformAccount(account, true),
      health: buildHealthPayload(account),
      recentEvents: getPlatformEvents(20, { platformAccountId: account.id }),
    });
    return;
  }

  const adminPlatformCheckMatch = pathname.match(/^\/api\/admin\/platform-accounts\/([^/]+)\/check-connection$/);
  if (req.method === "POST" && adminPlatformCheckMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const retryAfter = await applyRateLimit(req, "adminWrites", RATE_LIMITS.adminWrites);
    if (retryAfter !== null) {
      sendRateLimited(res, retryAfter);
      return;
    }
    const account = getPlatformAccounts().find((item) => item.id === adminPlatformCheckMatch[1]);
    if (!account) {
      sendJson(res, 404, { error: "Platform hesabi bulunamadi." });
      return;
    }
    const result = await checkPlatformAccountConnection(account, req);
    sendJson(res, 200, {
      ok: true,
      account: result.account,
      health: result.account.connectionHealth,
      recentEvents: result.recentEvents,
    });
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
    const retryAfter = await applyRateLimit(req, "adminLogin", RATE_LIMITS.adminLogin);
    if (retryAfter !== null) {
      sendRateLimited(res, retryAfter);
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

    setSessionCookie(res, auth.token);
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

  if (req.method === "PUT" && pathname === "/api/admin/settings") {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const { json: body } = await readRequestBody(req);
    updateSystemSettings(body);
    broadcastLiveEvent({ type: "system-settings-update", message: "Sistem ayarlari guncellendi." });
    sendJson(res, 200, { ok: true, state: decorateState() });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/refresh") {
    const { json: body } = await readRequestBody(req);
    const { refreshToken } = validateRefreshDraft(body);
    const auth = refreshSessionPair("admin", refreshToken, req);
    setSessionCookie(res, auth.token);
    sendJson(res, 200, auth);
    return;
  }

  if (req.method === "POST" && pathname === "/api/restaurant/refresh") {
    const { json: body } = await readRequestBody(req);
    const { refreshToken } = validateRefreshDraft(body);
    const auth = refreshSessionPair("restaurant", refreshToken, req);
    setSessionCookie(res, auth.token);
    sendJson(res, 200, auth);
    return;
  }

  if (req.method === "POST" && pathname === "/api/courier/refresh") {
    const { json: body } = await readRequestBody(req);
    const { refreshToken } = validateRefreshDraft(body);
    const auth = refreshSessionPair("courier", refreshToken, req);
    setSessionCookie(res, auth.token);
    sendJson(res, 200, auth);
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/logout") {
    const { json: body } = await readRequestBody(req);
    const { refreshToken } = validateRefreshDraft(body);
    revokeAccessToken("admin_sessions", getBearerToken(req));
    db.prepare("DELETE FROM refresh_tokens WHERE actor_role = ? AND token_hash = ?").run("admin", hashOpaqueToken(refreshToken));
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/api/restaurant/logout") {
    const { json: body } = await readRequestBody(req);
    const { refreshToken } = validateRefreshDraft(body);
    revokeAccessToken("restaurant_sessions", getBearerToken(req));
    db.prepare("DELETE FROM refresh_tokens WHERE actor_role = ? AND token_hash = ?").run("restaurant", hashOpaqueToken(refreshToken));
    clearSessionCookie(res);
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
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/forgot-password") {
    const { json: body } = await readRequestBody(req);
    const { username } = validatePasswordResetRequestDraft(body);
    const startTime = Date.now();
    
    const actor = actorLookupByRole("admin", username);
    let token = null;
    
    if (actor) {
      token = issuePasswordReset("admin", actor.id, req);
      logPasswordReset("admin", username, token);
      writeAuditLog({
        actorRole: "admin",
        actorId: actor.id,
        action: "password_reset_requested",
        details: { username },
      });
    } else {
      // Timing attack mitigation: normalize response time for non-existent users
      const elapsed = Date.now() - startTime;
      const minDelay = 50;
      if (elapsed < minDelay) {
        const delay = minDelay - elapsed;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    sendJson(res, 200, {
      message: "Parola yenileme talebi olusturuldu.",
      ...(NODE_ENV === "production" || !token ? {} : { resetToken: token }),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/restaurant/forgot-password") {
    const { json: body } = await readRequestBody(req);
    const { username } = validatePasswordResetRequestDraft(body);
    const startTime = Date.now();
    
    const actor = actorLookupByRole("restaurant", username);
    let token = null;
    
    if (actor) {
      token = issuePasswordReset("restaurant", actor.id, req);
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
        ...(NODE_ENV === "production" || !token ? {} : { resetToken: token }),
      });
    } else {
      // Timing attack mitigation
      const elapsed = Date.now() - startTime;
      const minDelay = 50;
      if (elapsed < minDelay) {
        const delay = minDelay - elapsed;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      sendJson(res, 200, { message: "Parola yenileme talebi olusturuldu." });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/courier/forgot-password") {
    const { json: body } = await readRequestBody(req);
    const { username } = validatePasswordResetRequestDraft(body);
    const startTime = Date.now();
    
    const actor = actorLookupByRole("courier", username);
    let token = null;
    
    if (actor) {
      token = issuePasswordReset("courier", actor.id, req);
      logPasswordReset("courier", username, token);
      writeAuditLog({
        actorRole: "courier",
        actorId: actor.id,
        action: "password_reset_requested",
        details: { username },
      });
      sendJson(res, 200, {
        message: "Parola yenileme talebi olusturuldu.",
        ...(NODE_ENV === "production" || !token ? {} : { resetToken: token }),
      });
    } else {
      // Timing attack mitigation
      const elapsed = Date.now() - startTime;
      const minDelay = 50;
      if (elapsed < minDelay) {
        const delay = minDelay - elapsed;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      sendJson(res, 200, { message: "Parola yenileme talebi olusturuldu." });
    }
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
    const retryAfter = await applyRateLimit(req, "restaurantLogin", RATE_LIMITS.restaurantLogin);
    if (retryAfter !== null) {
      sendRateLimited(res, retryAfter);
      return;
    }

    const { json: body } = await readRequestBody(req);
    const access = validateRestaurantLoginDraft({
      ...body,
      headerRestaurantId: String(req.headers["x-restaurant-id"] || ""),
      headerApiKey: String(req.headers["x-api-key"] || ""),
    });
    const restaurant = access.mode === "portal"
      ? db.prepare("SELECT * FROM restaurants WHERE username = ?").get(access.username)
      : db.prepare("SELECT * FROM restaurants WHERE id = ? AND api_key = ?").get(access.restaurantId, access.apiKey);

    if (!restaurant) {
      sendJson(res, 401, { error: "Restoran kimligi veya API key hatali." });
      return;
    }

    // Validate password for portal mode
    if (access.mode === "portal") {
      if (!restaurant.password_salt || !verifyPassword(access.password, restaurant.password_salt, restaurant.password_hash)) {
        sendJson(res, 401, { error: "Restoran kimligi veya sifre hatali." });
        return;
      }
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

    setSessionCookie(res, auth.token);
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

  if (req.method === "GET" && pathname === "/api/restaurant/reports/daily") {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }

    // Son 6 ayin gunluk ozetini getir (Yalnizca teslim edilen paketler)
    const sql = `
      SELECT 
        DATE(created_at, 'localtime') as date,
        SUM(order_amount) as total_revenue,
        SUM(CASE WHEN payment_method LIKE '%Nakit%' THEN order_amount ELSE 0 END) as cash_revenue,
        SUM(CASE WHEN payment_method LIKE '%Kart%' OR payment_method LIKE '%Kredi%' THEN order_amount ELSE 0 END) as card_revenue,
        SUM(CASE WHEN payment_method NOT LIKE '%Nakit%' AND payment_method NOT LIKE '%Kart%' AND payment_method NOT LIKE '%Kredi%' THEN order_amount ELSE 0 END) as online_revenue,
        COUNT(id) as package_count
      FROM packages
      WHERE restaurant_id = ? 
        AND status = 'delivered'
        AND created_at >= date('now', '-6 months')
      GROUP BY DATE(created_at, 'localtime')
      ORDER BY date DESC
    `;
    const rows = db.prepare(sql).all(session.restaurant_id);
    sendJson(res, 200, { reports: rows });
    return;
  }

  if (req.method === "GET" && pathname === "/api/restaurant/reports/daily-detail") {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }

    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const dateParam = requestUrl.searchParams.get("date");
    if (!dateParam) {
      sendJson(res, 400, { error: "Tarih parametresi gereklidir. Örnek: ?date=2026-06-19" });
      return;
    }

    // Belirtilen güne ait teslim edilen tüm paketleri getir
    const detailSql = `
      SELECT
        id, tracking_no, recipient, phone, address, delivery_address, customer_address,
        assigned_courier_name,
        payment_method, order_amount, payment_status,
        source_platform, external_order_no,
        created_at, delivered_at,
        distance_km,
        note
      FROM packages
      WHERE restaurant_id = ?
        AND status = 'delivered'
        AND DATE(created_at, 'localtime') = ?
      ORDER BY created_at ASC
    `;
    const packages = db.prepare(detailSql).all(session.restaurant_id, dateParam);

    // Özet hesapla
    let total_revenue = 0;
    let cash_revenue = 0;
    let card_revenue = 0;
    let online_revenue = 0;
    const courierMap = {};

    for (const pkg of packages) {
      const amt = Number(pkg.order_amount) || 0;
      total_revenue += amt;

      if (pkg.payment_method && pkg.payment_method.includes("Nakit")) {
        cash_revenue += amt;
      } else if (pkg.payment_method && (pkg.payment_method.includes("Kart") || pkg.payment_method.includes("Kredi"))) {
        card_revenue += amt;
      } else {
        online_revenue += amt;
      }

      const courierName = pkg.assigned_courier_name || "Bilinmiyor";
      if (!courierMap[courierName]) {
        courierMap[courierName] = { name: courierName, package_count: 0, total_revenue: 0 };
      }
      courierMap[courierName].package_count += 1;
      courierMap[courierName].total_revenue += amt;
    }

    const couriers = Object.values(courierMap).sort((a, b) => b.package_count - a.package_count);

    sendJson(res, 200, {
      ok: true,
      date: dateParam,
      summary: {
        total_packages: packages.length,
        total_revenue,
        cash_revenue,
        card_revenue,
        online_revenue
      },
      couriers,
      packages
    });
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

  if (req.method === "GET" && pathname === "/api/restaurant/platform-accounts") {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      platformAccounts: getPlatformAccounts({ restaurantId: session.restaurant_id })
        .map((account) => sanitizePlatformAccount(account, true)),
    });
    return;
  }

  const restaurantPlatformHealthMatch = pathname.match(/^\/api\/restaurant\/platform-accounts\/([^/]+)\/health$/);
  if (req.method === "GET" && restaurantPlatformHealthMatch) {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }
    const account = getPlatformAccounts({ restaurantId: session.restaurant_id }).find((item) => item.id === restaurantPlatformHealthMatch[1]);
    if (!account) {
      sendJson(res, 404, { error: "Platform hesabi bulunamadi." });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      account: sanitizePlatformAccount(account, true),
      health: buildHealthPayload(account),
      recentEvents: getPlatformEvents(5, { platformAccountId: account.id }).map((event) => ({
        eventType: event.eventType,
        status: event.status,
        errorCode: event.errorCode,
        errorMessage: event.errorMessage,
        createdAt: event.createdAt,
      })),
    });
    return;
  }

  const restaurantPlatformCheckMatch = pathname.match(/^\/api\/restaurant\/platform-accounts\/([^/]+)\/check-connection$/);
  if (req.method === "POST" && restaurantPlatformCheckMatch) {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }
    const retryAfter = await applyRateLimit(req, "integrations", RATE_LIMITS.integrations);
    if (retryAfter !== null) {
      sendRateLimited(res, retryAfter);
      return;
    }
    const account = getPlatformAccounts({ restaurantId: session.restaurant_id }).find((item) => item.id === restaurantPlatformCheckMatch[1]);
    if (!account) {
      sendJson(res, 404, { error: "Platform hesabi bulunamadi." });
      return;
    }
    const result = await checkPlatformAccountConnection(account, req);
    sendJson(res, 200, {
      ok: true,
      account: result.account,
      health: result.account.connectionHealth,
      publicMessage: result.account.connectionHealth.publicMessage,
      recentEvents: result.recentEvents.slice(0, 5),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/restaurant/platform-accounts") {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }

    const retryAfter = await applyRateLimit(req, "integrations", RATE_LIMITS.integrations);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Platform entegrasyon limiti asildi." });
      return;
    }

    const { json: body } = await readRequestBody(req);
    const draft = validatePlatformAccountDraft({
      ...body,
      restaurantId: body.restaurantId || body.restaurant_id || session.restaurant_id,
    });

    if (draft.restaurantId !== session.restaurant_id) {
      sendJson(res, 403, { error: "Bu restoran baska tenant icin entegrasyon kaydedemez." });
      return;
    }

    const now = new Date().toISOString();
    const draftConfig = platformConfig(draft.platform);
    const verification = {
      status: PLATFORM_VERIFICATION_STATUS.PENDING,
      note: "Webhook modu aktif. Polling API kapalı — webhook ile sipariş bekleniyor.",
      mode: `${draftConfig.mode}_auto`,
    };
    verification.note = `${draft.platform} entegrasyonu ${draftConfig.mode} modunda kaydedildi. Ilk gercek siparis bekleniyor.`;
    db.prepare("UPDATE restaurants SET webhook_secret = ? WHERE id = ?").run(draft.webhookSecret, session.restaurant_id);
    const existing = db.prepare(`
      SELECT * FROM platform_accounts
      WHERE restaurant_id = ? AND platform = ? AND external_store_id = ?
    `).get(session.restaurant_id, draft.platform, draft.externalStoreId);

    if (existing) {
      db.prepare(`
        UPDATE platform_accounts
        SET external_id = ?, external_merchant_id = ?, api_username = ?, api_password = ?, api_key = ?, api_secret = ?, token = ?,
            store_front_code = ?, chain_id = ?, vendor_id = ?, webhook_auth_type = ?, webhook_api_key = ?,
            webhook_username = ?, webhook_password = ?, static_token = ?, access_token = ?, refresh_token = ?, token_expires_at = ?,
            callback_url = ?, auth_type = ?, webhook_secret = ?, integration_reference_code = ?, pos_secret_key = ?,
            is_active = ?, settings_json = ?, verification_status = ?, verification_note = ?, last_verification_at = ?,
            verified_at = ?, last_validation_mode = ?, active = ?, updated_at = ?
        WHERE id = ?
      `).run(
        draft.externalId || draft.externalStoreId,
        draft.externalMerchantId || null,
        draft.apiUsername || null,
        draft.apiPassword || null,
        draft.apiKey || null,
        draft.apiSecret || null,
        draft.token || null,
        draft.storeFrontCode || null,
        draft.chainId || null,
        draft.vendorId || null,
        PLATFORM_WEBHOOK_AUTH_TYPES.STATIC_TOKEN,
        null,
        null,
        null,
        draft.webhookSecret,
        draft.accessToken || null,
        draft.refreshToken || null,
        draft.tokenExpiresAt || null,
        draft.callbackUrl || null,
        draft.authType,
        draft.webhookSecret,
        draft.integrationReferenceCode || null,
        draft.posSecretKey || null,
        draft.active ? 1 : 0,
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
          id, restaurant_id, platform, external_id, external_store_id, external_merchant_id, api_username, api_password,
          api_key, api_secret, token, store_front_code, chain_id, vendor_id, webhook_auth_type, webhook_api_key,
          webhook_username, webhook_password, static_token, access_token, refresh_token, token_expires_at,
          callback_url, auth_type, webhook_secret, integration_reference_code, pos_secret_key, is_active, webhook_id,
          settings_json, verification_status, verification_note, last_verification_at, verified_at, last_validation_mode,
          active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uid("pla"),
        session.restaurant_id,
        draft.platform,
        draft.externalId || draft.externalStoreId,
        draft.externalStoreId,
        draft.externalMerchantId || null,
        draft.apiUsername || null,
        draft.apiPassword || null,
        draft.apiKey || null,
        draft.apiSecret || null,
        draft.token || null,
        draft.storeFrontCode || null,
        draft.chainId || null,
        draft.vendorId || null,
        PLATFORM_WEBHOOK_AUTH_TYPES.STATIC_TOKEN,
        null,
        null,
        null,
        draft.webhookSecret,
        draft.accessToken || null,
        draft.refreshToken || null,
        draft.tokenExpiresAt || null,
        draft.callbackUrl || null,
        draft.authType,
        draft.webhookSecret,
        draft.integrationReferenceCode || null,
        draft.posSecretKey || null,
        draft.active ? 1 : 0,
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

    db.prepare(`
      UPDATE platform_accounts
      SET integration_ref_code = ?,
          integration_reference_code = ?,
          polling_enabled = ?,
          webhook_enabled = ?,
          active = ?,
          is_active = ?,
          connection_status = ?,
          last_check_at = NULL,
          last_error_code = NULL,
          last_error_message = NULL,
          consecutive_failures = 0,
          last_error = NULL,
          updated_at = ?
      WHERE restaurant_id = ? AND platform = ? AND external_store_id = ?
    `).run(
      draft.integrationReferenceCode || null,
      draft.integrationReferenceCode || null,
      draft.pollingEnabled ? 1 : 0,
      draft.webhookEnabled ? 1 : 0,
      draft.active ? 1 : 0,
      draft.active ? 1 : 0,
      draft.active ? HEALTH_STATUS.UNKNOWN : HEALTH_STATUS.DISABLED,
      now,
      session.restaurant_id,
      draft.platform,
      draft.externalStoreId
    );

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
    logger.info("Platform account saved", {
      restaurantId: session.restaurant_id,
      platform: draft.platform,
      externalStoreId: draft.externalStoreId,
      active: draft.active,
      webhookEnabled: draft.webhookEnabled,
      pollingEnabled: draft.pollingEnabled,
      secretConfigured: Boolean(draft.webhookSecret),
      mode: "webhook",
    });
    platformService?.savePlatformAccount({
      ...draft,
      restaurantId: session.restaurant_id,
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
    if (IS_PRODUCTION) {
      productionDisabled(res);
      return;
    }
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

    const result = handleSimplePlatformOrder({
      platform: account.platform,
      platformRestaurantId: account.externalStoreId,
      orderId: `TEST-${Date.now()}`,
      customerName: "Test Musteri",
      phone: "05555555555",
      address: "Mersin Test Adresi",
      totalPrice: 250,
      paymentMethod: "Online Odeme",
      customerNote: "Restoran panel test siparisi",
      items: [{ id: "test-1", name: "Test Burger", quantity: 1, price: 250 }],
    });
    if (!result.ok) {
      sendJson(res, result.statusCode || 404, { ok: false, error: result.error });
      return;
    }

    broadcastLiveEvent({
      type: "platform-test",
      restaurantId: session.restaurant_id,
      message: `${account.platform} test siparisi olusturuldu.`,
    });
    sendJson(res, 200, {
      verification: {
        status: "verified",
        note: "Test platform siparisi olusturuldu.",
      },
      package: result.package,
      state: decorateState({
        restaurantId: session.restaurant_id,
        includeRestaurantSecrets: true,
        includePlatformSecrets: true,
        req,
      }),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/restaurant/platform-accounts/test-connection") {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }
    const { json: body } = await readRequestBody(req);
    const account = getPlatformAccounts({ restaurantId: session.restaurant_id }).find((item) => item.id === trimmed(body.accountId || body.account_id));
    if (!account) {
      sendJson(res, 404, { error: "Platform hesabi bulunamadi." });
      return;
    }
    const restaurant = getRestaurants({ restaurantId: session.restaurant_id })[0];
    if (!restaurant) {
      sendJson(res, 404, { error: "Restoran bulunamadi." });
      return;
    }
    const result = await testPlatformAccountAutomatically(account);
    logPlatformConnectionTest(account, result);
    const verificationStatus = result.ok
      ? PLATFORM_VERIFICATION_STATUS.VERIFIED
      : (result.optional || result.manualAvailable)
        ? PLATFORM_VERIFICATION_STATUS.PENDING
        : PLATFORM_VERIFICATION_STATUS.FAILED;
    markPlatformAccountVerification(account.id, {
      status: verificationStatus,
      mode: result.strategy || testStrategyForAccount(account),
      note: platformFriendlyError(result.message || `HTTP ${result.status}`, account.platform),
    });
    sendJson(res, platformConnectionHttpStatus(result), {
      ok: result.ok,
      status: result.status,
      strategy: result.strategy || testStrategyForAccount(account),
      message: platformFriendlyError(result.message || `HTTP ${result.status}`, account.platform),
      error: result.ok ? undefined : platformFriendlyError(result.message || `HTTP ${result.status}`, account.platform),
      verification: {
        status: verificationStatus,
        note: platformFriendlyError(result.message || `HTTP ${result.status}`, account.platform),
      },
      package: result.package,
      state: decorateState({ restaurantId: session.restaurant_id, includeRestaurantSecrets: true, includePlatformSecrets: true, req }),
    });
    return;
  }

  const restaurantPollTestMatch = pathname.match(/^\/api\/restaurant\/platform-accounts\/([^/]+)\/poll-test$/);
  if (req.method === "POST" && restaurantPollTestMatch) {
    if (IS_PRODUCTION) {
      productionDisabled(res);
      return;
    }
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }
    const accountId = decodeURIComponent(restaurantPollTestMatch[1]);
    const account = getPlatformAccounts({ restaurantId: session.restaurant_id }).find((item) => item.id === accountId);
    if (!account) {
      sendJson(res, 404, { error: "Platform hesabi bulunamadi." });
      return;
    }
    const result = await platformService.pollPlatformAccount(account, { manual: true });
    const message = !account.pollingEnabled
      ? "Polling kapalı"
      : platformAccountMissingCredentials(account)
        ? "API bilgileri eksik"
        : result.reason || `${result.fetchedCount || 0} sipariş bulundu`;
    sendJson(res, 200, {
      ok: Boolean(result.ok),
      message: result.ok
        ? `${result.fetchedCount || 0} sipariş bulundu${result.trackingNumbers?.length ? `. Paketler: ${result.trackingNumbers.join(", ")}` : ""}`
        : message,
      result,
      state: decorateState({ restaurantId: session.restaurant_id, includeRestaurantSecrets: true, includePlatformSecrets: true, req }),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/restaurant/platform-accounts/sync") {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }
    const { json: body } = await readRequestBody(req);
    const account = getPlatformAccounts({ restaurantId: session.restaurant_id }).find((item) => item.id === trimmed(body.accountId || body.account_id));
    if (!account) {
      sendJson(res, 404, { error: "Platform hesabi bulunamadi." });
      return;
    }
    const result = await platformService.pollPlatformAccount(account, { manual: true });
    sendJson(res, result.ok || result.optional || result.skipped ? 200 : 400, {
      ok: result.ok,
      error: result.ok ? undefined : result.reason,
      message: result.ok
        ? `${result.fetchedCount || 0} sipariş bulundu${result.trackingNumbers?.length ? `. Paketler: ${result.trackingNumbers.join(", ")}` : ""}`
        : result.reason,
      result,
      state: decorateState({ restaurantId: session.restaurant_id, includeRestaurantSecrets: true, includePlatformSecrets: true, req }),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/restaurant/platform-orders/manual") {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }
    const { json: body } = await readRequestBody(req);
    const restaurant = getRestaurants({ restaurantId: session.restaurant_id })[0];
    if (!restaurant) {
      sendJson(res, 404, { error: "Restoran bulunamadi." });
      return;
    }
    const platform = normalizePlatformInput(body.platform) || "POS";
    const externalStoreId = trimmed(body.platformRestaurantId || body.externalStoreId) ||
      getPlatformAccounts({ restaurantId: session.restaurant_id }).find((item) => item.platform === platform)?.externalStoreId ||
      `manual-${session.restaurant_id}`;
    const order = normalizeOrder(platform, {
      platform,
      platformRestaurantId: externalStoreId,
      orderId: trimmed(body.orderId) || `MANUAL-${Date.now()}`,
      customerName: body.customerName,
      phone: body.phone,
      address: body.address,
      totalPrice: body.totalPrice,
      paymentMethod: body.paymentMethod || "Panel Kaydi",
      customerNote: body.note,
      rawPayload: body,
    });
    let account = findPlatformRestaurant(platform, externalStoreId);
    if (!account) {
      upsertPlatformOrderRecord(order, restaurant.id, "accepted");
      const payload = createSimplePlatformPayload(order, restaurant);
      payload.status = AWAITING_ASSIGNMENT_STATUS;
      payload.assignmentStatus = "unassigned";
      payload.assignmentReason = "Manuel platform siparisi onaylanarak havuza alindi.";
      
      const created = upsertPlatformPackage(platform, restaurant, payload);
      sendJson(res, 201, { ok: true, package: created, state: decorateState({ restaurantId: session.restaurant_id, includeRestaurantSecrets: true, includePlatformSecrets: true, req }) });
      return;
    }
    const result = handleSimplePlatformOrder(order, true);
    sendJson(res, 201, { ok: true, package: result.package, state: decorateState({ restaurantId: session.restaurant_id, includeRestaurantSecrets: true, includePlatformSecrets: true, req }) });
    return;
  }

  if (req.method === "POST" && pathname === "/api/restaurant/packages") {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }

    const retryAfter = await applyRateLimit(req, "integrations", RATE_LIMITS.integrations);
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
      customerName: trimmed(body.customer_name ?? body.customerName),
      phone: trimmed(body.phone),
      customerAddress: trimmed(body.customer_address ?? body.customerAddress ?? body.delivery_address ?? body.deliveryAddress),
      paymentMethod: trimmed(body.payment_method ?? body.paymentMethod),
      customerNote: trimmed(body.customer_note ?? body.customerNote),
      source: trimmed(body.source),
      sourcePlatform: trimmed(body.source_platform ?? body.sourcePlatform),
      rawText: trimmed(body.raw_text ?? body.rawText),
      requestedStatus: trimmed(body.status),
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

    const pkg = buildRestaurantPackageRecord(restaurantRow, draft);
    
    if (body.photoBase64) {
      try {
        const base64Data = body.photoBase64.replace(/^data:image\/\w+;base64,/, "");
        const fileName = `photo_${pkg.trackingNo}.jpg`;
        const filePath = path.resolve(__dirname, "uploads", fileName);
        fs.writeFileSync(filePath, base64Data, "base64");
        pkg.rawPayload = pkg.rawPayload || {};
        pkg.rawPayload.photoUrl = `/uploads/${fileName}`;
      } catch (err) {
        logger.error("Failed to save photoBase64", err);
      }
    }

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

  if (req.method === "POST" && pathname === "/api/restaurant/packages/quick-paste") {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }

    const retryAfter = await applyRateLimit(req, "quickPaste", RATE_LIMITS.quickPaste);
    if (retryAfter !== null) {
      sendRateLimited(res, retryAfter);
      return;
    }

    const restaurantRow = db.prepare("SELECT * FROM restaurants WHERE id = ?").get(session.restaurant_id);
    if (!restaurantRow) {
      sendJson(res, 404, { error: "Restoran bulunamadi." });
      return;
    }

    const { json: body } = await readRequestBody(req);
    const rawText = normalizeQuickPasteText(body.rawText ?? body.raw_text);
    if (!rawText) {
      sendJson(res, 400, { error: "rawText zorunludur." });
      return;
    }

    const parsed = parseQuickPasteText(rawText);
    const draft = {
      restaurantId: session.restaurant_id,
      deliveryAddress: parsed.customerAddress,
      packageType: parsed.packageType,
      orderAmount: normalizeMoney(parsed.orderAmount),
      customerName: parsed.customerName,
      phone: parsed.phone,
      customerAddress: parsed.customerAddress,
      paymentMethod: parsed.paymentMethod || "Panel Kaydi",
      customerNote: parsed.customerNote,
      source: trimmed(body.source) || "platform_extension",
      sourcePlatform: trimmed(body.sourcePlatform ?? body.source_platform) || "Diger",
      rawText,
      requestedStatus: AWAITING_ASSIGNMENT_STATUS,
    };
    const dedupeKey = trimmed(body.dedupeKey ?? body.dedupe_key);

    const errors = validatePackageDraft(draft);
    if (errors.length > 0) {
      sendJson(res, 400, {
        error: errors.join(" "),
        parsed,
      });
      return;
    }

    const duplicate = findDuplicatePackage(session.restaurant_id, draft.source, dedupeKey);
    if (duplicate) {
      sendJson(res, 200, {
        ok: true,
        package: decorateState({ restaurantId: session.restaurant_id }).packages.find((item) => item.id === duplicate.id) || getPackageById(duplicate.id),
        parsed,
        duplicate: true,
        state: decorateState({
          restaurantId: session.restaurant_id,
          includeRestaurantSecrets: true,
          req,
        }),
      });
      return;
    }

    const pkg = buildRestaurantPackageRecord(restaurantRow, draft, {
      externalOrderId: dedupeKey || undefined,
    });
    
    if (body.photoBase64) {
      try {
        const base64Data = body.photoBase64.replace(/^data:image\/\w+;base64,/, "");
        const fileName = `photo_${pkg.trackingNo}.jpg`;
        const filePath = path.resolve(__dirname, "uploads", fileName);
        fs.writeFileSync(filePath, base64Data, "base64");
        pkg.rawPayload = pkg.rawPayload || {};
        pkg.rawPayload.photoUrl = `/uploads/${fileName}`;
      } catch (err) {
        logger.error("Failed to save photoBase64 in quick-paste", err);
      }
    }

    createPackageRecord(pkg, pkg.packageType);
    rebalancePackages();

    writeAuditLog({
      actorRole: "restaurant",
      actorId: session.restaurant_id,
      action: "package_created_quick_paste_extension",
      packageId: pkg.id,
      restaurantId: session.restaurant_id,
      details: {
        externalOrderNo: pkg.externalOrderNo,
        sourcePlatform: pkg.sourcePlatform,
      },
    });
    broadcastLiveEvent({
      type: "package-created",
      restaurantId: session.restaurant_id,
      message: `${pkg.sourcePlatform} uzantisindan hizli siparis alindi.`,
    });

    sendJson(res, 201, {
      ok: true,
      package: getPackageById(pkg.id),
      parsed,
      state: decorateState({
        restaurantId: session.restaurant_id,
        includeRestaurantSecrets: true,
        req,
      }),
    });
    return;
  }

  const restaurantPackageActionMatch = pathname.match(/^\/api\/restaurant\/packages\/([^/]+)\/action$/);
  if (req.method === "POST" && restaurantPackageActionMatch) {
    const session = getRestaurantSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Restoran oturumu bulunamadi." });
      return;
    }

    const { json: body } = await readRequestBody(req);
    const action = trimmed(body.action).toLowerCase();
    const packageId = restaurantPackageActionMatch[1];
    const target = db.prepare("SELECT * FROM packages WHERE id = ? AND restaurant_id = ?").get(packageId, session.restaurant_id);

    if (!target) {
      sendJson(res, 404, { error: "Paket bulunamadi." });
      return;
    }

    const source = normalizeOrderSource(target.source, target.source_platform);
    const isPlatformBackedOrder = source !== "external_manual" && source !== "manual";

    if (action === "confirm") {
      db.prepare(`
        UPDATE packages
        SET status = ?, assignment_status = ?, assignment_reason = ?, eta = ?, updated_at = ?
        WHERE id = ?
      `).run(
        PREPARING_STATUS,
        "waiting_courier",
        "Restoran siparisi onayladi.",
        `${suggestedRestaurantPrepMinutes(target.zone)} dk`,
        nowIso(),
        packageId
      );
      if (isPlatformBackedOrder) {
        updatePlatformOrderStatusByPackage(target, "approved");
      }
      const confirmedPackage = getPackageById(packageId);
      if (isPlatformBackedOrder) {
        notifyPlatformOrderAccepted(target.source_platform, target.external_order_id || target.external_order_no, session.restaurant_id, confirmedPackage);
        notifyPlatformOrderPreparing(target.source_platform, target.external_order_id || target.external_order_no, confirmedPackage);
      }
      logger.info("Assignment triggered after restaurant approval", {
        packageId,
        sourcePlatform: target.source_platform || null,
        restaurantId: session.restaurant_id,
      });
      logger.info("Assignment state before approval assignment", {
        packageId,
        previousStatus: target.status,
        nextStatus: PREPARING_STATUS,
        restaurantId: session.restaurant_id,
        zone: target.zone,
      });
      const confirmedForAssignment = getPackageById(packageId);
      if (confirmedForAssignment) {
        persistPackageAssignment(assignPackage(assignmentStateForPackage(confirmedForAssignment), confirmedForAssignment));
      }
      const packageAfterAssignmentAttempt = getPackageById(packageId);
      logger.info("Assignment result after approval", {
        packageId,
        status: packageAfterAssignmentAttempt?.status,
        assignmentStatus: packageAfterAssignmentAttempt?.assignmentStatus,
        assignedCourierId: packageAfterAssignmentAttempt?.assignedCourierId || null,
        lastAssignmentError: packageAfterAssignmentAttempt?.lastAssignmentError || "",
      });
      if (packageAfterAssignmentAttempt?.assignedCourierId) {
        logger.info("Assignment success after approval", {
          packageId,
          courierId: packageAfterAssignmentAttempt.assignedCourierId,
          status: packageAfterAssignmentAttempt.status,
        });
      } else {
        logger.warn("Assignment failed after approval", {
          packageId,
          status: packageAfterAssignmentAttempt?.status || null,
          assignmentStatus: packageAfterAssignmentAttempt?.assignmentStatus || null,
          reason: packageAfterAssignmentAttempt?.lastAssignmentError || "uygun kurye yok",
        });
      }
      broadcastLiveEvent({
        type: "restaurant-confirmed",
        restaurantId: session.restaurant_id,
        message: isPlatformBackedOrder ? "Platform siparisi restoran tarafinda onaylandi." : "Manuel paket restoran tarafinda onaylandi.",
      });
      sendJson(res, 200, decorateState({
        restaurantId: session.restaurant_id,
        includeRestaurantSecrets: true,
        req,
      }));
      return;
    }

    if (action === "reject") {
      db.prepare(`
        UPDATE packages
        SET status = ?, assignment_status = ?, assignment_reason = ?, last_assignment_error = ?, updated_at = ?
        WHERE id = ?
      `).run(
        REJECTED_STATUS,
        "rejected",
        "Restoran platform siparisini reddetti.",
        trimmed(body.reason) || "Restoran reddetti.",
        nowIso(),
        packageId
      );
      if (isPlatformBackedOrder) {
        updatePlatformOrderStatusByPackage(target, "cancelled");
      }
      const rejectedPackage = getPackageById(packageId);
      if (isPlatformBackedOrder) {
        notifyPlatformOrderRejected(target.source_platform, target.external_order_id || target.external_order_no, body.reason, rejectedPackage);
      }
      broadcastLiveEvent({
        type: "platform-order-rejected",
        restaurantId: session.restaurant_id,
        message: isPlatformBackedOrder ? "Platform siparisi restoran tarafinda reddedildi." : "Manuel paket restoran tarafinda reddedildi.",
      });
      sendJson(res, 200, decorateState({
        restaurantId: session.restaurant_id,
        includeRestaurantSecrets: true,
        req,
      }));
      return;
    }

    sendJson(res, 400, { error: "Gecersiz restoran paketi aksiyonu." });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/restaurants") {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }

    const retryAfter = await applyRateLimit(req, "adminWrites", RATE_LIMITS.adminWrites);
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

    const retryAfter = await applyRateLimit(req, "adminWrites", RATE_LIMITS.adminWrites);
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
    const retryAfter = await applyRateLimit(req, "integrations", RATE_LIMITS.integrations);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Entegrasyon istek limiti asildi." });
      return;
    }

    const { raw, json: body } = await readRequestBody(req);
    const integrationKey = String(req.headers["x-integration-key"] || "").trim();
    const expectedIntegrationKey = trimmed(process.env.DELIVERA_INTEGRATION_KEY);
    const integrationKeyValid =
      Boolean(expectedIntegrationKey) &&
      integrationKey.length === expectedIntegrationKey.length &&
      crypto.timingSafeEqual(Buffer.from(integrationKey), Buffer.from(expectedIntegrationKey));

    if (!integrationKeyValid) {
      logWebhookAttempt({
        restaurantId: body.restaurantId ?? body.restaurant_id,
        sourcePlatform: body.platform ?? body.sourcePlatform,
        externalOrderNo: body.orderId ?? body.externalOrderNo,
        signatureValid: false,
        responseStatus: 403,
        requestBody: raw,
      });
      sendJson(res, 403, { ok: false, error: "Forbidden" });
      return;
    }

    let feederDraft;
    try {
      feederDraft = normalizeFeederIntegrationDraft(body);
    } catch (error) {
      logWebhookAttempt({
        restaurantId: body.restaurantId ?? body.restaurant_id,
        sourcePlatform: body.platform ?? body.sourcePlatform,
        externalOrderNo: body.orderId ?? body.externalOrderNo,
        signatureValid: false,
        responseStatus: 400,
        requestBody: raw,
      });
      sendJson(res, 400, { error: error.message });
      return;
    }

    const restaurantRow = db.prepare("SELECT * FROM restaurants WHERE id = ?").get(feederDraft.restaurantId);
    if (!restaurantRow) {
      logWebhookAttempt({
        restaurantId: feederDraft.restaurantId,
        sourcePlatform: feederDraft.sourcePlatform,
        externalOrderNo: feederDraft.externalOrderNo,
        signatureValid: true,
        responseStatus: 404,
        requestBody: raw,
      });
      sendJson(res, 404, { ok: false, error: "Restoran bulunamadi." });
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

    if (restaurant.platforms.length > 0 && !restaurant.platforms.includes(feederDraft.sourcePlatform)) {
      logWebhookAttempt({
        restaurantId: restaurant.id,
        sourcePlatform: feederDraft.sourcePlatform,
        externalOrderNo: feederDraft.externalOrderNo,
        signatureValid: true,
        responseStatus: 400,
        requestBody: raw,
      });
      sendJson(res, 400, { ok: false, error: "Bu restoran icin platform tanimli degil." });
      return;
    }

    const duplicate = findDuplicatePackage(feederDraft.restaurantId, feederDraft.source, feederDraft.externalOrderId);
    if (duplicate) {
      logWebhookAttempt({
        restaurantId: restaurant.id,
        sourcePlatform: feederDraft.sourcePlatform,
        externalOrderNo: feederDraft.externalOrderNo,
        signatureValid: true,
        responseStatus: 200,
        requestBody: raw,
      });
      sendJson(res, 200, { ok: true, duplicate: true, message: "Bu siparis zaten alinmis, yeni kayit acilmadi." });
      return;
    }

    let pkg;
    try {
      pkg = validateIntegrationDraft(feederDraft, restaurant);
    } catch (error) {
      logWebhookAttempt({
        restaurantId: restaurant.id,
        sourcePlatform: feederDraft.sourcePlatform,
        externalOrderNo: feederDraft.externalOrderNo,
        signatureValid: true,
        responseStatus: 400,
        requestBody: raw,
      });
      sendJson(res, 400, { ok: false, error: error.message });
      return;
    }

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
        receiver: "python_worker",
      },
    });

    logger.info("Integration order received from worker", {
      restaurantId: restaurant.id,
      platform: pkg.sourcePlatform,
      orderId: pkg.externalOrderId,
      packageId: pkg.id,
    });

    logWebhookAttempt({
      restaurantId: restaurant.id,
      sourcePlatform: pkg.sourcePlatform,
      externalOrderNo: pkg.externalOrderNo,
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
      ok: true,
      message: "Siparis alindi ve otomatik atama calisti.",
      package: created,
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/platform/poll-now") {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { ok: false, error: "Admin oturumu bulunamadi." });
      return;
    }
    const result = await platformService.pollAllPlatformAccounts({ manual: true, adminId: adminSession.admin_id });
    sendJson(res, 200, { ok: true, result });
    return;
  }

  if (req.method === "POST" && pathname === "/api/platform/order") {
    const retryAfter = await applyRateLimit(req, "platformOrder", RATE_LIMITS.platformOrder);
    if (retryAfter !== null) {
      logPlatformEvent({
        platform: null,
        eventType: "webhook",
        requestId: req.requestId,
        status: "error",
        httpStatus: 429,
        errorCode: HEALTH_ERROR_CODES.RATE_LIMITED,
        errorMessage: "Platform webhook rate limited",
        retryCount: 0,
        nextRetryAt: new Date(Date.now() + retryAfter * 1000).toISOString(),
      });
      sendRateLimited(res, retryAfter);
      return;
    }

    const { raw, json: body } = await readRequestBody(req);
    logger.info("Webhook received", {
      platform: body?.platform || null,
      platformRestaurantId: body?.platformRestaurantId || body?.externalStoreId || body?.external_store_id || null,
      orderId: body?.orderId || body?.order_id || body?.externalOrderId || null,
      requestId: req.requestId,
    });
    const order = normalizeOrder(body.platform, body);
    const match = findPlatformRestaurant(order.platform, order.platformRestaurantId);

    if (!match) {
      logWebhookAttempt({
        restaurantId: null,
        sourcePlatform: order.platform,
        externalOrderNo: order.orderId,
        signatureValid: false,
        responseStatus: 404,
        requestBody: raw,
      });
      logPlatformEvent({
        platform: order.platform,
        restaurantId: null,
        platformAccountId: null,
        eventType: "webhook",
        requestId: req.requestId,
        status: "error",
        httpStatus: 404,
        errorCode: HEALTH_ERROR_CODES.PROVIDER_NOT_CONFIGURED,
        errorMessage: "Restaurant/platform match failed",
        metadata: { platformRestaurantId: order.platformRestaurantId, orderId: order.orderId },
      });
      sendJson(res, 404, {
        ok: false,
        error: platformFriendlyError("Restaurant/platform match failed", order.platform),
        platform: order.platform,
        platformRestaurantId: order.platformRestaurantId,
        hint: "Platform panelindeki gerçek Store/Restaurant ID ile aynı değer kullanılmalı.",
      });
      return;
    }
    if (match.account.webhookEnabled === false) {
      db.prepare(`
        UPDATE platform_accounts
        SET connection_status = ?, last_error_at = ?, last_error_code = ?, last_error_message = ?, updated_at = ?
        WHERE id = ?
      `).run(HEALTH_STATUS.DISABLED, nowIso(), HEALTH_ERROR_CODES.PROVIDER_NOT_CONFIGURED, "Webhook disabled for this platform account", nowIso(), match.account.id);
      logPlatformEvent({
        platform: match.account.platform,
        restaurantId: match.restaurant.id,
        platformAccountId: match.account.id,
        eventType: "webhook",
        requestId: req.requestId,
        status: "error",
        httpStatus: 403,
        errorCode: HEALTH_ERROR_CODES.PROVIDER_NOT_CONFIGURED,
        errorMessage: "Webhook disabled for this platform account",
      });
      sendJson(res, 403, {
        ok: false,
        error: "Webhook disabled for this platform account",
        platform: order.platform,
        platformRestaurantId: order.platformRestaurantId,
      });
      return;
    }

    const adapter = getPlatformAdapter(normalizePlatformKey(match.account.platform));
    const signature = verifyPlatformSignature({
      req,
      account: match.account,
      restaurant: match.restaurant,
      rawBody: raw,
    });
    if (!signature.ok && !adapter.verifyWebhook(req, match.account) && !verifySimplePlatformSecret(match.account, match.restaurant, req)) {
      db.prepare(`
        UPDATE platform_accounts
        SET last_error = ?,
            connection_status = ?,
            last_error_at = ?,
            last_error_code = ?,
            last_error_message = ?,
            consecutive_failures = COALESCE(consecutive_failures, 0) + 1,
            updated_at = ?
        WHERE id = ?
      `).run("Invalid platform secret", HEALTH_STATUS.ERROR, nowIso(), HEALTH_ERROR_CODES.INVALID_SIGNATURE, "Invalid platform secret", nowIso(), match.account.id);
      logWebhookAttempt({
        restaurantId: match.restaurant.id,
        sourcePlatform: match.account.platform,
        externalOrderNo: order.orderId,
        signatureValid: false,
        responseStatus: 401,
        requestBody: raw,
      });
      logPlatformEvent({
        platform: match.account.platform,
        restaurantId: match.restaurant.id,
        platformAccountId: match.account.id,
        eventType: "webhook",
        requestId: req.requestId,
        status: "error",
        httpStatus: 401,
        errorCode: HEALTH_ERROR_CODES.INVALID_SIGNATURE,
        errorMessage: "Invalid platform secret",
        metadata: { orderId: order.orderId },
      });
      sendJson(res, 401, { ok: false, error: "Invalid platform secret" });
      return;
    }

    const result = handleSimplePlatformOrder(order);
    db.prepare(`
      UPDATE platform_accounts
      SET last_webhook_at = ?,
          last_success_at = ?,
          connection_status = ?,
          last_error = NULL,
          last_error_code = NULL,
          last_error_message = NULL,
          consecutive_failures = 0,
          updated_at = ?
      WHERE id = ?
    `).run(nowIso(), nowIso(), HEALTH_STATUS.CONNECTED, nowIso(), match.account.id);
    logWebhookAttempt({
      restaurantId: match.restaurant.id,
      sourcePlatform: match.account.platform,
      externalOrderNo: order.orderId,
      signatureValid: true,
      responseStatus: result.package?.duplicate ? 200 : 201,
      requestBody: raw,
    });
    logPlatformEvent({
      platform: match.account.platform,
      restaurantId: match.restaurant.id,
      platformAccountId: match.account.id,
      eventType: "webhook",
      requestId: req.requestId,
      status: result.package?.duplicate ? "duplicate" : "success",
      httpStatus: result.package?.duplicate ? 200 : 201,
      errorCode: null,
      errorMessage: result.package?.duplicate ? "Duplicate order controlled by idempotency" : null,
      metadata: { orderId: order.orderId, packageId: result.package?.id || null },
    });
    sendJson(res, result.package?.duplicate ? 200 : 201, {
      ok: true,
      trackingNo: result.package?.trackingNo || "",
      source: "platform_webhook",
      duplicate: Boolean(result.package?.duplicate),
      package: result.package,
    });
    logger.info("Webhook accepted successfully", {
      platform: match.account.platform,
      restaurantId: match.restaurant.id,
      orderId: order.orderId,
      trackingNo: result.package?.trackingNo || null,
      signatureMode: signature.ok ? signature.mode : "adapter_or_legacy_token",
      requestId: req.requestId,
    });
    return;
  }

  const platformWebhookMatch = pathname.match(/^\/api\/platforms\/([^/]+)\/webhook$/);
  if (req.method === "POST" && platformWebhookMatch) {
    const retryAfter = await applyRateLimit(req, "integrations", RATE_LIMITS.integrations);
    if (retryAfter !== null) {
      logPlatformEvent({
        platform: platformWebhookMatch[1],
        eventType: "webhook",
        requestId: req.requestId,
        status: "error",
        httpStatus: 429,
        errorCode: HEALTH_ERROR_CODES.RATE_LIMITED,
        errorMessage: "Platform webhook rate limited",
        nextRetryAt: new Date(Date.now() + retryAfter * 1000).toISOString(),
      });
      sendRateLimited(res, retryAfter);
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
      logPlatformEvent({
        platform: normalizedPlatform,
        restaurantId: body.restaurantId,
        platformAccountId: null,
        eventType: "webhook",
        requestId: req.requestId,
        status: "error",
        httpStatus: 401,
        errorCode: HEALTH_ERROR_CODES.PROVIDER_NOT_CONFIGURED,
        errorMessage: "Platform hesabi veya store/vendor eslesmesi bulunamadi.",
      });
      sendJson(res, 401, { error: "Platform hesabi veya store/vendor eslesmesi bulunamadi." });
      return;
    }

    if (!verifyPlatformWebhookAuth(account, req, raw)) {
      db.prepare(`
        UPDATE platform_accounts
        SET connection_status = ?, last_error_at = ?, last_error_code = ?, last_error_message = ?,
            consecutive_failures = COALESCE(consecutive_failures, 0) + 1, updated_at = ?
        WHERE id = ?
      `).run(HEALTH_STATUS.ERROR, nowIso(), HEALTH_ERROR_CODES.INVALID_SIGNATURE, "Platform webhook yetkilendirmesi dogrulanamadi.", nowIso(), account.id);
      logWebhookAttempt({
        restaurantId: account.restaurantId,
        sourcePlatform: normalizedPlatform,
        externalOrderNo: body.externalOrderNo || body.external_order_no || body.order_id || body.orderNumber,
        signatureValid: false,
        responseStatus: 401,
        requestBody: raw,
      });
      logPlatformEvent({
        platform: normalizedPlatform,
        restaurantId: account.restaurantId,
        platformAccountId: account.id,
        eventType: "webhook",
        requestId: req.requestId,
        status: "error",
        httpStatus: 401,
        errorCode: HEALTH_ERROR_CODES.INVALID_SIGNATURE,
        errorMessage: "Platform webhook yetkilendirmesi dogrulanamadi.",
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
      logPlatformEvent({
        platform: normalizedPlatform,
        restaurantId: account.restaurantId,
        platformAccountId: account.id,
        eventType: "webhook",
        requestId: req.requestId,
        status: "error",
        httpStatus: 400,
        errorCode: HEALTH_ERROR_CODES.UNKNOWN_ERROR,
        errorMessage: error.message,
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
    db.prepare(`
      UPDATE platform_accounts
      SET last_webhook_at = ?, last_success_at = ?, connection_status = ?, last_error_code = NULL,
          last_error_message = NULL, consecutive_failures = 0, updated_at = ?
      WHERE id = ?
    `).run(nowIso(), nowIso(), HEALTH_STATUS.CONNECTED, nowIso(), account.id);
    logPlatformEvent({
      platform: normalizedPlatform,
      restaurantId: account.restaurantId,
      platformAccountId: account.id,
      eventType: "webhook",
      requestId: req.requestId,
      status: "success",
      httpStatus: 201,
      metadata: { packageId: created?.id || null, externalOrderNo: created?.externalOrderNo || null },
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
    const retryAfter = await applyRateLimit(req, "courierLogin", RATE_LIMITS.courierLogin);
    if (retryAfter !== null) {
      sendRateLimited(res, retryAfter);
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

    setSessionCookie(res, auth.token);
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

  if (req.method === "PUT" && pathname === "/api/courier/me/credentials") {
    const session = getCourierSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Oturum bulunamadi." });
      return;
    }
    const { json: body } = await readRequestBody(req);
    const { username, password } = body;
    if (!username) {
      sendJson(res, 400, { error: "Kullanici adi zorunludur." });
      return;
    }
    if (db.prepare("SELECT id FROM couriers WHERE username = ? AND id != ?").get(username, session.courier_id)) {
      sendJson(res, 400, { error: "Bu kullanici adi baska bir kurye tarafindan kullaniliyor." });
      return;
    }
    if (password) {
      const passwordInfo = hashPassword(password);
      db.prepare("UPDATE couriers SET username = ?, password_hash = ?, password_salt = ? WHERE id = ?").run(username, passwordInfo.hash, passwordInfo.salt, session.courier_id);
    } else {
      db.prepare("UPDATE couriers SET username = ? WHERE id = ?").run(username, session.courier_id);
    }
    sendJson(res, 200, { message: "Bilgiler guncellendi." });
    return;
  }

  if (req.method === "GET" && pathname === "/api/courier/me") {
    const session = getCourierSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Oturum bulunamadi." });
      return;
    }

    const workspace = buildCourierWorkspace(session.courier_id, {
      pagination: paginationFromRequest(req, { limit: DEFAULT_PAGE_LIMIT, offset: 0 }),
    });
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

  const courierShiftPlanAcceptMatch = pathname.match(/^\/api\/courier\/shift-plans\/([^/]+)\/accept$/);
  if (req.method === "POST" && courierShiftPlanAcceptMatch) {
    const session = getCourierSession(req);
    if (!session) {
      sendJson(res, 401, { error: "Oturum bulunamadi." });
      return;
    }

    const retryAfter = await applyRateLimit(req, "courierStatus", RATE_LIMITS.courierStatus);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Vardiya onay limiti asildi." });
      return;
    }

    const planId = courierShiftPlanAcceptMatch[1];
    acceptShiftPlan(session.courier_id, planId);
    const workspace = buildCourierWorkspace(session.courier_id);
    const courier = getCourierById(session.courier_id);
    const acceptedPlan = getCourierShiftPlans(session.courier_id, 12).find((item) => item.id === planId);

    writeAuditLog({
      actorRole: "courier",
      actorId: session.courier_id,
      action: "courier_shift_plan_accepted",
      details: { planId },
    });
    broadcastLiveEvent({
      type: "shift-plan-accepted",
      courierId: session.courier_id,
      message: `${courier?.name || "Kurye"} ${acceptedPlan?.planDate || ""} vardiya planini kabul etti.`,
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
    const nextPaymentStatus = body.paymentStatus ? normalizePaymentStatus(body.paymentStatus, target.payment_method) : target.payment_status;

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

    if (nextStatus === DELIVERED_STATUS && !body.paymentStatus) {
      sendJson(res, 400, { error: "Teslim oncesi odeme durumu secilmelidir." });
      return;
    }

    updatePackageLifecycle(packageId, {
      status: nextStatus,
      failureReason: nextStatus === FAILED_STATUS ? failureReason : "",
      paymentStatus: nextPaymentStatus,
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
    if (nextStatus === DELIVERED_STATUS) {
      const deliveredPackage = getPackageById(packageId);
      updatePlatformOrderStatusByPackage(deliveredPackage || target, "completed");
      if (isPlatformBackedPackage(target)) {
        notifyPlatformOrderDelivered(target.source_platform, target.external_order_id || target.external_order_no, deliveredPackage);
      }
    }

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
    upsertCashReconciliation(session.courier_id, dayKey(), summary);
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

  if (req.method === "POST" && pathname === "/api/admin/shift-plans") {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }

    const retryAfter = await applyRateLimit(req, "adminWrites", RATE_LIMITS.adminWrites);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Vardiya planlama limiti asildi." });
      return;
    }

    const { json: body } = await readRequestBody(req);
    const courierId = trimmed(body.courierId);
    const planDate = trimmed(body.planDate) || dayKey();
    const startTime = trimmed(body.startTime) || "10:00";
    const endTime = trimmed(body.endTime) || "18:00";
    const zone = trimmed(body.zone);

    if (!courierId) {
      sendJson(res, 400, { error: "Kurye secilmelidir." });
      return;
    }

    upsertShiftPlan(courierId, planDate, startTime, endTime, zone);
    const courier = getCourierById(courierId);
    writeAuditLog({
      actorRole: "admin",
      actorId: adminActorId(adminSession),
      action: "courier_shift_planned",
      details: { courierId, planDate, startTime, endTime, zone },
    });
    broadcastLiveEvent({
      type: "shift-plan-offer",
      courierId,
      message: `${courier?.name || "Kurye"} icin ${planDate} ${startTime}-${endTime} vardiya plani olusturuldu. 1 saat icinde onay bekleniyor.`,
    });
    sendJson(res, 200, {
      ...decorateState(),
      auditLogs: getAuditLogs(20),
    });
    return;
  }

  const adminTestPlatformOrderMatch = pathname.match(/^\/api\/admin\/restaurants\/([^/]+)\/test-platform-order$/);
  if (req.method === "POST" && adminTestPlatformOrderMatch) {
    if (IS_PRODUCTION) {
      productionDisabled(res);
      return;
    }
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }

    const restaurantId = adminTestPlatformOrderMatch[1];
    const restaurant = getRestaurants({ restaurantId })[0];
    if (!restaurant) {
      sendJson(res, 404, { error: "Restoran bulunamadi." });
      return;
    }

    const account = getPlatformAccounts({ restaurantId }).find((item) => item.active);
    if (!account) {
      sendJson(res, 400, { error: "Bu restoran icin aktif platform hesabi yok." });
      return;
    }

    const result = handleSimplePlatformOrder({
      platform: account.platform,
      platformRestaurantId: account.externalStoreId,
      orderId: `ADMIN-TEST-${Date.now()}`,
      customerName: "Admin Test Musteri",
      phone: "05555555555",
      address: `${restaurant.zone} admin test siparis adresi`,
      totalPrice: 250,
      paymentMethod: "Online Odeme",
      customerNote: "Admin test platform siparisi",
      items: [{ id: "admin-test-1", name: "Test Menu", quantity: 1, price: 250 }],
    });
    if (!result.ok) {
      sendJson(res, result.statusCode || 404, { ok: false, error: result.error });
      return;
    }

    writeAuditLog({
      actorRole: "admin",
      actorId: adminActorId(adminSession),
      action: "admin_test_platform_order_sent",
      restaurantId,
      packageId: result.package?.id || null,
      details: {
        platform: account.platform,
        externalStoreId: account.externalStoreId,
      },
    });
    sendJson(res, 200, {
      ok: true,
      package: result.package,
      ...decorateState(),
      auditLogs: getAuditLogs(20),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/announcements") {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }

    const retryAfter = await applyRateLimit(req, "adminWrites", RATE_LIMITS.adminWrites);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Duyuru gonderme limiti asildi." });
      return;
    }

    const { json: body } = await readRequestBody(req);
    const title = trimmed(body.title);
    const message = trimmed(body.message);
    const targetRole = trimmed(body.targetRole) || "courier";

    if (!title || !message) {
      sendJson(res, 400, { error: "Baslik ve duyuru mesaji zorunludur." });
      return;
    }

    createAnnouncement(targetRole, title, message);
    writeAuditLog({
      actorRole: "admin",
      actorId: adminActorId(adminSession),
      action: "announcement_created",
      details: { targetRole, title },
    });
    broadcastLiveEvent({
      type: "workspace-update",
      message: `${title} duyurusu yayinlandi.`,
    });
    sendJson(res, 200, {
      ...decorateState(),
      auditLogs: getAuditLogs(20),
    });
    return;
  }

  const announcementMatch = pathname.match(/^\/api\/admin\/announcements\/([^/]+)$/);
  if (req.method === "DELETE" && announcementMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }

    if (!deactivateAnnouncement(announcementMatch[1])) {
      sendJson(res, 404, { error: "Duyuru bulunamadi." });
      return;
    }

    writeAuditLog({
      actorRole: "admin",
      actorId: adminActorId(adminSession),
      action: "announcement_cleared",
      details: { announcementId: announcementMatch[1] },
    });
    broadcastLiveEvent({
      type: "workspace-update",
      message: "Operasyon duyurusu kaldirildi.",
    });
    sendJson(res, 200, {
      ...decorateState(),
      auditLogs: getAuditLogs(20),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/announcements/clear") {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }

    clearAnnouncements("courier");
    writeAuditLog({
      actorRole: "admin",
      actorId: adminActorId(adminSession),
      action: "announcements_cleared",
      details: { targetRole: "courier" },
    });
    broadcastLiveEvent({
      type: "workspace-update",
      message: "Tum kurye duyurulari sifirlandi.",
    });
    sendJson(res, 200, {
      ...decorateState(),
      auditLogs: getAuditLogs(20),
    });
    return;
  }

  const reconciliationMatch = pathname.match(/^\/api\/admin\/cash-reconciliations\/([^/]+)$/);
  if (req.method === "PATCH" && reconciliationMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }

    const retryAfter = await applyRateLimit(req, "adminWrites", RATE_LIMITS.adminWrites);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Nakit mutabakat limiti asildi." });
      return;
    }

    const { json: body } = await readRequestBody(req);
    const updated = updateCashReconciliationRecord(reconciliationMatch[1], body);
    writeAuditLog({
      actorRole: "admin",
      actorId: adminActorId(adminSession),
      action: "cash_reconciliation_updated",
      details: {
        reconciliationId: updated.id,
        status: updated.status,
        reportedCash: updated.reported_cash,
      },
    });
    broadcastLiveEvent({
      type: "workspace-update",
      courierId: updated.courier_id,
      message: "Nakit mutabakat kaydi guncellendi.",
    });
    sendJson(res, 200, {
      ...decorateState(),
      auditLogs: getAuditLogs(20),
    });
    return;
  }

  const adminCourierMatch = pathname.match(/^\/api\/admin\/couriers\/([^/]+)$/);
  if (req.method === "DELETE" && adminCourierMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const targetId = adminCourierMatch[1];
    const courier = db.prepare("SELECT * FROM couriers WHERE id = ?").get(targetId);
    if (!courier) {
      sendJson(res, 404, { error: "Kurye bulunamadi." });
      return;
    }
    db.prepare("DELETE FROM courier_sessions WHERE courier_id = ?").run(targetId);
    db.prepare("UPDATE packages SET assigned_courier_id = NULL, status = 'awaiting_assignment' WHERE assigned_courier_id = ? AND status != 'delivered'").run(targetId);
    db.prepare("DELETE FROM courier_shifts WHERE courier_id = ?").run(targetId);
    db.prepare("DELETE FROM courier_shift_plans WHERE courier_id = ?").run(targetId);
    db.prepare("DELETE FROM cash_reconciliations WHERE courier_id = ?").run(targetId);
    db.prepare("DELETE FROM couriers WHERE id = ?").run(targetId);
    rebalancePackages();
    writeAuditLog({
      actorRole: "admin",
      actorId: adminActorId(adminSession),
      action: "courier_deleted",
      details: { username: courier.username },
    });
    broadcastLiveEvent({
      type: "courier-deleted",
      message: `${courier.name} sistemden silindi.`,
    });
    sendJson(res, 200, {
      ...decorateState(),
      auditLogs: getAuditLogs(20),
    });
    return;
  }

  if (req.method === "PUT" && adminCourierMatch) {
    const adminSession = getAdminSession(req);
    if (!adminSession) {
      sendJson(res, 401, { error: "Admin oturumu bulunamadi." });
      return;
    }
    const targetId = adminCourierMatch[1];
    const courier = db.prepare("SELECT * FROM couriers WHERE id = ?").get(targetId);
    if (!courier) {
      sendJson(res, 404, { error: "Kurye bulunamadi." });
      return;
    }
    const { json: body } = await readRequestBody(req);
    const { username, password, name, zone } = body;
    if (username && db.prepare("SELECT id FROM couriers WHERE username = ? AND id != ?").get(username, targetId)) {
      sendJson(res, 400, { error: "Bu kullanici adi baska bir kurye tarafindan kullaniliyor." });
      return;
    }
    if (password) {
      const passwordInfo = hashPassword(password);
      db.prepare("UPDATE couriers SET name = ?, zone = ?, username = ?, password_hash = ?, password_salt = ? WHERE id = ?").run(name || courier.name, zone || courier.zone, username || courier.username, passwordInfo.hash, passwordInfo.salt, targetId);
    } else {
      db.prepare("UPDATE couriers SET name = ?, zone = ?, username = ? WHERE id = ?").run(name || courier.name, zone || courier.zone, username || courier.username, targetId);
    }
    writeAuditLog({
      actorRole: "admin",
      actorId: adminActorId(adminSession),
      action: "courier_updated",
      details: { username: courier.username },
    });
    sendJson(res, 200, {
      ...decorateState(),
      auditLogs: getAuditLogs(20),
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

    const retryAfter = await applyRateLimit(req, "adminWrites", RATE_LIMITS.adminWrites);
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

    const retryAfter = await applyRateLimit(req, "adminWrites", RATE_LIMITS.adminWrites);
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
    if (nextStatus === DELIVERED_STATUS) {
      const deliveredPackage = getPackageById(statusMatch[1]);
      updatePlatformOrderStatusByPackage(deliveredPackage || target, "completed");
      if (isPlatformBackedPackage(target)) {
        notifyPlatformOrderDelivered(target.source_platform, target.external_order_id || target.external_order_no, deliveredPackage);
      }
    }
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

    const retryAfter = await applyRateLimit(req, "adminWrites", RATE_LIMITS.adminWrites);
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

    if ([PENDING_APPROVAL_STATUS, REJECTED_STATUS, ACCEPTED_BY_COURIER_STATUS, ON_ROUTE_STATUS, DELIVERED_STATUS, CANCELED_STATUS].includes(normalizeStatus(target.status))) {
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
  const requestStartedAt = Date.now();
  const incomingRequestId = trimmed(req.headers["x-request-id"] || req.headers["x-correlation-id"]).slice(0, 80);
  const requestId = incomingRequestId || uid("req");
  req.requestId = requestId;
  res._deliveraRequestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  res.on("finish", () => {
    recordRequestMetrics(requestStartedAt, res.statusCode || 0);
    recordRequestLog(req, res, requestStartedAt);
  });
  try {
    console.log(`[DEBUG] INCOMING REQUEST: ${req.method} ${req.url}`);
    res._deliveraRequest = req;
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const { pathname } = requestUrl;

    if (req.method === "OPTIONS" && pathname.startsWith("/api/")) {
      if (!originForCors(req)) {
        sendJson(res, 403, { error: "CORS origin not allowed." });
        return;
      }
      writeSecurityHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && pathname === "/health") {
      sendJson(res, 200, {
        ...systemStatusPayload(),
        secure: isSecureRequest(req),
        assignmentRetryMs: ASSIGNMENT_RETRY_INTERVAL_MS,
      });
      return;
    }

    if (req.method === "GET" && pathname === "/metrics") {
      sendText(res, 200, metricsTextPayload(), "text/plain; version=0.0.4; charset=utf-8");
      return;
    }

    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, pathname);
      return;
    }

    const staticFile = findStaticFile(pathname, req.method);
    if (staticFile) {
      sendFile(res, staticFile);
      return;
    }

    notFound(res);
  } catch (error) {
    const statusCode = error.statusCode || 500;
    const logPayload = {
      endpoint: (() => {
        try {
          return new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
        } catch {
          return req.url || "";
        }
      })(),
      method: req.method,
      requestId,
      statusCode,
      error,
    };
    if (statusCode >= 500) {
      logger.error("Unhandled request error", logPayload);
    } else if (statusCode === 401 || statusCode === 403 || statusCode === 429) {
      logger.warn("Request rejected", logPayload);
    }
    sendJson(res, statusCode, { error: error.message || "Bilinmeyen sunucu hatasi." });
  }
});

setInterval(() => {
  try {
    retryAwaitingAssignmentPackages();
  } catch (error) {
    logger.warn("Assignment retry sweep failed", { error });
    // Retry sweep should not crash the server loop.
  }
}, ASSIGNMENT_RETRY_INTERVAL_MS).unref();

connectionHealthService = createConnectionHealthService({
  db,
  logger,
  platformAccountMissingCredentials,
  providerHealthUrlForAccount,
});

platformService = createPlatformService({
  getPlatformAccounts,
  findPlatformRestaurant,
  handleSimplePlatformOrder,
  normalizeOrder,
  connectorForPlatform,
  platformAccountMissingCredentials,
  nowIso,
  db,
  log: logger,
});

if (PLATFORM_POLLING_ENABLED) {
  setInterval(() => {
    platformService.pollAllPlatformAccounts().catch((error) => {
      logger.error("Platform polling failed", { error });
    });
  }, PLATFORM_POLL_INTERVAL_MS).unref();
} else {
  logger.info("Platform polling disabled; webhook flow is active.");
  logger.info("Polling skipped because global disabled");
}

currentState().packages
  .filter((pkg) => normalizeStatus(pkg.status) === ASSIGNED_STATUS)
  .forEach((pkg) => syncAssignmentRetryForPackage(pkg));

server.listen(PORT, () => {
  logger.info("Delivera Express ready", { url: `http://localhost:${PORT}`, port: PORT });
});
