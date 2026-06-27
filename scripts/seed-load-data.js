const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

try {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
} catch {}

const ROOT = path.resolve(__dirname, "..");
const { databaseUrl } = require("../db/config");
const USE_POSTGRES = Boolean(databaseUrl());
const GENERATED_TEMP_LOAD_DB = !USE_POSTGRES && !process.env.DELIVERA_LOAD_DB_FILE;
const DB_FILE = path.resolve(process.env.DELIVERA_LOAD_DB_FILE || path.join(os.tmpdir(), `delivera-load-${process.pid}-${Date.now()}.sqlite`));
const NODE_ENV = String(process.env.NODE_ENV || "development").toLowerCase();
const PORT = Number(process.env.DELIVERA_LOAD_SEED_PORT || 3321);
const RESTAURANT_COUNT = Number(process.env.LOAD_RESTAURANTS || 50);
const COURIER_COUNT = Number(process.env.LOAD_COURIERS || 100);
const PACKAGE_COUNT = Number(process.env.LOAD_PACKAGES || 300);
const RESTAURANT_PASSWORD = process.env.LOAD_RESTAURANT_PASSWORD || "LoadRest123!";
const COURIER_PASSWORD = process.env.LOAD_COURIER_PASSWORD || "LoadCourier123!";
const ZONES = ["Akdeniz", "Yenisehir", "Mezitli", "Toroslar", "Tarsus", "Erdemli"];
const PLATFORMS = ["Yemeksepeti", "Trendyol Yemek", "Getir Yemek", "Migros Yemek", "POS"];

if (NODE_ENV === "production" && process.env.DELIVERA_ALLOW_PRODUCTION_LOAD_SEED !== "1") {
  throw new Error("Production ortaminda load seed icin DELIVERA_ALLOW_PRODUCTION_LOAD_SEED=1 gerekir. Script veri silmez, sadece load_ prefix'li test verisi ekler.");
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return {
    salt,
    hash: crypto.scryptSync(String(password), salt, 64).toString("hex"),
  };
}

function isoMinutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function waitForServer(baseUrl, timeoutMs = 15000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const response = await fetch(`${baseUrl}/health`);
        if (response.ok) {
          resolve();
          return;
        }
      } catch {}
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error("Seed init server acilamadi."));
        return;
      }
      setTimeout(tick, 200);
    };
    tick();
  });
}

async function ensureSchema() {
  if (USE_POSTGRES) {
    const { runMigrations } = require("./migrate");
    runMigrations();
    return;
  }

  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const server = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_PATH: DB_FILE,
      DB_PATH: DB_FILE,
      DELIVERA_DB_FILE: DB_FILE,
      DELIVERA_PLATFORM_POLLING_ENABLED: "0",
    },
    stdio: ["ignore", "ignore", "ignore"],
  });

  try {
    await waitForServer(`http://127.0.0.1:${PORT}`);
  } finally {
    await stopChild(server);
  }
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (!child || child.killed) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve();
    }, 3000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(timeout);
      resolve();
    }
  });
}

function seedLoadData() {
  const dbFacade = require("../db");
  const db = dbFacade.getDb({ filename: DB_FILE });
  const restaurantPassword = hashPassword(RESTAURANT_PASSWORD, "load_restaurant_salt");
  const courierPassword = hashPassword(COURIER_PASSWORD, "load_courier_salt");
  const startedAt = Date.now();

  try {
    if (!USE_POSTGRES) {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
    }
    db.exec("BEGIN IMMEDIATE");

    const restaurantInsert = db.prepare(`
      INSERT OR IGNORE INTO restaurants (
        id, name, zone, x, y, username, password_hash, password_salt, platforms_json, api_key, webhook_secret, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const accountInsert = db.prepare(`
      INSERT OR IGNORE INTO platform_accounts (
        id, restaurant_id, platform, external_id, external_store_id, external_merchant_id, api_username, api_password,
        api_key, api_secret, token, store_front_code, chain_id, vendor_id, webhook_auth_type, webhook_api_key,
        webhook_username, webhook_password, static_token, webhook_secret, integration_reference_code, pos_secret_key,
        is_active, last_sync_at, webhook_id, settings_json, verification_status, verification_note,
        last_verification_at, verified_at, last_validation_mode, active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'static_token', NULL,
        NULL, NULL, ?, ?, NULL, NULL, 1, NULL, NULL, '{}', 'verified', NULL, NULL, ?, 'seed', 1, ?, ?)
    `);
    const courierInsert = db.prepare(`
      INSERT OR IGNORE INTO couriers (
        id, name, zone, x, y, available, status, last_location_at, username, password_hash, password_salt, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const packageInsert = db.prepare(`
      INSERT OR IGNORE INTO packages (
        id, tracking_no, restaurant_id, source, delivery_address, package_type, source_platform,
        external_order_no, external_order_id, recipient, phone, address, zone, eta, payment_method,
        order_amount, payment_status, x, y, customer_lat, customer_lng, customer_address, note, status,
        assignment_status, assigned_courier_id, assigned_courier_name, assigned_at, accepted_at, on_route_at,
        delivered_at, failed_at, distance_km, assignment_reason, failure_reason, last_assignment_attempt_at,
        last_assignment_error, assignment_tried_courier_ids_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, ?, NULL, NULL, ?, '[]', ?, ?)
    `);
    const platformOrderInsert = db.prepare(`
      INSERT OR IGNORE INTO platform_orders (
        id, platform, platform_order_id, restaurant_id, customer_name, phone, address, total_price,
        note, status, raw_payload, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (let index = 1; index <= RESTAURANT_COUNT; index += 1) {
      const id = `load_rst_${String(index).padStart(6, "0")}`;
      const zone = ZONES[index % ZONES.length];
      const stamp = isoMinutesAgo(index);
      restaurantInsert.run(
        id,
        `Load Test Restoran ${index}`,
        zone,
        36.60 + (index % 50) * 0.001,
        34.32 + (index % 50) * 0.001,
        `load_rest_${String(index).padStart(6, "0")}`,
        restaurantPassword.hash,
        restaurantPassword.salt,
        JSON.stringify(PLATFORMS),
        `load-api-key-${index}`,
        `load-webhook-secret-${index}`,
        stamp
      );
      accountInsert.run(
        `load_pa_${String(index).padStart(6, "0")}`,
        id,
        "Yemeksepeti",
        `load-store-${index}`,
        `load-store-${index}`,
        `load-secret-${index}`,
        `load-secret-${index}`,
        stamp,
        stamp,
        stamp
      );
    }

    for (let index = 1; index <= COURIER_COUNT; index += 1) {
      const id = `load_cr_${String(index).padStart(6, "0")}`;
      const zone = ZONES[index % ZONES.length];
      const online = index % 3 !== 0;
      const stamp = isoMinutesAgo(index);
      courierInsert.run(
        id,
        `Load Test Kurye ${index}`,
        zone,
        36.60 + (index % 100) * 0.0005,
        34.32 + (index % 100) * 0.0005,
        online ? 1 : 0,
        online ? "online" : "offline",
        stamp,
        `load_courier_${String(index).padStart(6, "0")}`,
        courierPassword.hash,
        courierPassword.salt,
        stamp
      );
    }

    for (let index = 1; index <= PACKAGE_COUNT; index += 1) {
      const restaurantIndex = ((index - 1) % RESTAURANT_COUNT) + 1;
      const restaurantId = `load_rst_${String(restaurantIndex).padStart(6, "0")}`;
      const zone = ZONES[restaurantIndex % ZONES.length];
      const platform = PLATFORMS[index % PLATFORMS.length];
      const externalOrderId = `LOAD-ORDER-${String(index).padStart(8, "0")}`;
      const status = index % 10 === 0
        ? "delivered"
        : index % 3 === 0
          ? "preparing"
          : "pending_approval";
      const assignmentStatus = status === "delivered"
        ? "assigned"
        : status === "pending_approval"
          ? "pending_approval"
          : "waiting_courier";
      const stamp = isoMinutesAgo(index % 10080);
      packageInsert.run(
        `load_pkg_${String(index).padStart(8, "0")}`,
        `LOAD-PKT-${String(index).padStart(8, "0")}`,
        restaurantId,
        "platform_webhook",
        `Load test adres ${index}`,
        "Platform",
        platform,
        externalOrderId,
        externalOrderId,
        `Load Musteri ${index}`,
        `0555${String(index).padStart(7, "0").slice(-7)}`,
        `Load test teslimat adresi ${index}`,
        zone,
        "25 dk",
        index % 2 === 0 ? "Online Odeme" : "Nakit",
        100 + (index % 500),
        index % 2 === 0 ? "paid_online" : "cash_expected",
        36.60 + (index % 100) * 0.0005,
        34.32 + (index % 100) * 0.0005,
        36.61 + (index % 100) * 0.0005,
        34.33 + (index % 100) * 0.0005,
        `Load test teslimat adresi ${index}`,
        "Load test kaydi",
        status,
        assignmentStatus,
        status === "delivered" ? "Load test atama." : "Restoran onayi bekleniyor.",
        status === "pending_approval" ? "" : "load test",
        stamp,
        stamp
      );
      if (platform !== "POS") {
        platformOrderInsert.run(
          `load_po_${String(index).padStart(8, "0")}`,
          platform,
          externalOrderId,
          restaurantId,
          `Load Musteri ${index}`,
          `0555${String(index).padStart(7, "0").slice(-7)}`,
          `Load test teslimat adresi ${index}`,
          100 + (index % 500),
          "Load test kaydi",
          status === "pending_approval" ? "pending_approval" : "approved",
          JSON.stringify({ load: true, orderId: externalOrderId }),
          stamp,
          stamp
        );
      }
    }

    db.prepare(`
      UPDATE packages
      SET status = 'pending_approval',
          assignment_status = 'pending_approval',
          assigned_courier_id = NULL,
          assigned_courier_name = NULL,
          assigned_at = NULL,
          assignment_reason = 'Restoran onayi bekleniyor.',
          updated_at = ?
      WHERE id LIKE 'load_pkg_%' AND status = 'assigned'
    `).run(new Date().toISOString());

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    dbFacade.close();
  }

  return {
    dbFile: DB_FILE,
    restaurants: RESTAURANT_COUNT,
    couriers: COURIER_COUNT,
    packages: PACKAGE_COUNT,
    elapsedMs: Date.now() - startedAt,
    restaurantPassword: RESTAURANT_PASSWORD,
    courierPassword: COURIER_PASSWORD,
  };
}

async function main() {
  await ensureSchema();
  const result = seedLoadData();
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  DB_FILE,
  GENERATED_TEMP_LOAD_DB,
  USE_POSTGRES,
  RESTAURANT_PASSWORD,
  COURIER_PASSWORD,
  ensureSchema,
  seedLoadData,
};
