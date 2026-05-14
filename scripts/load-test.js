const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const {
  DB_FILE,
  GENERATED_TEMP_LOAD_DB,
  RESTAURANT_PASSWORD,
  COURIER_PASSWORD,
  ensureSchema,
  seedLoadData,
} = require("./seed-load-data");

try {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
} catch {}

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.DELIVERA_LOAD_TEST_PORT || 3333);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const REQUEST_TIMEOUT_MS = Number(process.env.LOAD_REQUEST_TIMEOUT_MS || 30000);
const CONCURRENCY_LEVELS = (process.env.LOAD_CONCURRENCY || "5,10")
  .split(",")
  .map((item) => Number(item.trim()))
  .filter(Boolean);
let sourceIpCounter = 1;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${BASE_URL}/health`);
      if (response.ok) {
        return;
      }
    } catch {}
    await delay(200);
  }
  throw new Error("Load test server acilamadi.");
}

function nextSourceIp() {
  const value = sourceIpCounter;
  sourceIpCounter += 1;
  return `10.${Math.floor(value / 65000) % 255}.${Math.floor(value / 255) % 255}.${(value % 254) + 1}`;
}

async function request(method, targetPath, { token, body, headers = {}, sourceIp } = {}) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}${targetPath}`, {
      method,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "X-Forwarded-For": sourceIp || nextSourceIp(),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let payload = {};
    try {
      payload = await response.json();
    } catch {}
    return {
      ok: response.ok,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      payload,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      elapsedMs: Date.now() - startedAt,
      error: error.name === "AbortError" ? "timeout" : error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runPool(name, tasks, concurrency) {
  const results = [];
  let cursor = 0;
  const startedAt = Date.now();
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < tasks.length) {
      const taskIndex = cursor;
      cursor += 1;
      try {
        results[taskIndex] = await tasks[taskIndex]();
      } catch (error) {
        results[taskIndex] = {
          ok: false,
          status: 0,
          elapsedMs: 0,
          error: error.message,
        };
      }
    }
  });
  await Promise.all(workers);
  return summarize(name, results, Date.now() - startedAt, concurrency);
}

function summarize(name, results, wallTimeMs, concurrency) {
  const times = results.map((item) => item.elapsedMs).filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  const failures = results.filter((item) => !item.ok).length;
  const percentile = (value) => {
    if (times.length === 0) {
      return 0;
    }
    return times[Math.min(times.length - 1, Math.ceil((value / 100) * times.length) - 1)];
  };
  const average = times.length ? times.reduce((sum, value) => sum + value, 0) / times.length : 0;
  const statusCounts = results.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});
  return {
    name,
    concurrency,
    requests: results.length,
    wallTimeMs,
    averageMs: Number(average.toFixed(2)),
    maxMs: times[times.length - 1] || 0,
    p95Ms: percentile(95),
    failures,
    errorRate: Number((failures / Math.max(1, results.length)).toFixed(4)),
    statusCounts,
  };
}

function dbSnapshot() {
  const db = new DatabaseSync(DB_FILE);
  try {
    const counts = {
      restaurants: db.prepare("SELECT COUNT(*) AS count FROM restaurants").get().count,
      couriers: db.prepare("SELECT COUNT(*) AS count FROM couriers").get().count,
      packages: db.prepare("SELECT COUNT(*) AS count FROM packages").get().count,
      platformOrders: db.prepare("SELECT COUNT(*) AS count FROM platform_orders").get().count,
    };
    const packageIds = db.prepare(`
      SELECT id, restaurant_id AS restaurantId
      FROM packages
      WHERE status = 'pending_approval'
      ORDER BY created_at DESC
      LIMIT 300
    `).all();
    const restaurants = db.prepare(`
      SELECT id, username
      FROM restaurants
      WHERE username LIKE 'load_rest_%'
      ORDER BY username
      LIMIT 120
    `).all();
    const couriers = db.prepare(`
      SELECT id, username
      FROM couriers
      WHERE username LIKE 'load_courier_%'
      ORDER BY username
      LIMIT 150
    `).all();
    return {
      counts,
      packageIds,
      restaurants,
      couriers,
      dbSizeBytes: fs.existsSync(DB_FILE) ? fs.statSync(DB_FILE).size : 0,
    };
  } finally {
    db.close();
  }
}

function createLoadSessions(snapshot) {
  const db = new DatabaseSync(DB_FILE);
  const stamp = new Date().toISOString();
  const prefix = `load_session_${crypto.randomBytes(6).toString("hex")}`;
  try {
    const admin = db.prepare("SELECT id FROM admins ORDER BY created_at LIMIT 1").get();
    if (!admin) {
      throw new Error("Load test admin oturumu icin admin kaydi bulunamadi.");
    }
    const adminToken = `${prefix}_admin`;
    db.prepare("INSERT OR REPLACE INTO admin_sessions (token, admin_id, created_at) VALUES (?, ?, ?)").run(adminToken, admin.id, stamp);

    const restaurantInsert = db.prepare("INSERT OR REPLACE INTO restaurant_sessions (token, restaurant_id, created_at) VALUES (?, ?, ?)");
    const restaurantTokens = snapshot.restaurants.slice(0, 100).map((restaurant, index) => {
      const token = `${prefix}_restaurant_${index}`;
      restaurantInsert.run(token, restaurant.id, stamp);
      return { ...restaurant, token };
    });

    const courierInsert = db.prepare("INSERT OR REPLACE INTO courier_sessions (token, courier_id, created_at) VALUES (?, ?, ?)");
    const courierTokens = snapshot.couriers.slice(0, 100).map((courier, index) => {
      const token = `${prefix}_courier_${index}`;
      courierInsert.run(token, courier.id, stamp);
      return { ...courier, token };
    });

    return {
      adminToken,
      restaurantTokens,
      courierTokens,
    };
  } finally {
    db.close();
  }
}

function platformOrderTask(index) {
  const restaurantIndex = (index % 100) + 1;
  return () => request("POST", "/api/platform/order", {
    headers: { "x-platform-secret": `load-secret-${restaurantIndex}` },
    sourceIp: `10.40.${Math.floor(index / 254) % 254}.${(index % 254) + 1}`,
    body: {
      platform: "yemeksepeti",
      platformRestaurantId: `load-store-${restaurantIndex}`,
      orderId: `LOAD-RUNTIME-${Date.now()}-${index}`,
      customerName: `Runtime Musteri ${index}`,
      phone: "05550000000",
      address: `Runtime adres ${index}`,
      totalPrice: 250,
      paymentMethod: "Online Odeme",
    },
  });
}

function duplicatePlatformOrderTasks() {
  return [0, 1].map(() => request("POST", "/api/platform/order", {
    headers: { "x-platform-secret": "load-secret-1" },
    sourceIp: "10.50.1.1",
    body: {
      platform: "yemeksepeti",
      platformRestaurantId: "load-store-1",
      orderId: "LOAD-DUPLICATE-CHECK",
      customerName: "Duplicate Musteri",
      phone: "05550000001",
      address: "Duplicate adres",
      totalPrice: 123,
      paymentMethod: "Online Odeme",
    },
  }));
}

async function main() {
  await ensureSchema();
  let snapshot = dbSnapshot();
  if (
    snapshot.counts.restaurants < Number(process.env.LOAD_RESTAURANTS || 100) ||
    snapshot.counts.couriers < Number(process.env.LOAD_COURIERS || 1000) ||
    snapshot.counts.packages < Number(process.env.LOAD_PACKAGES || 100000)
  ) {
    seedLoadData();
    snapshot = dbSnapshot();
  }

  const server = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_PATH: DB_FILE,
      DB_PATH: DB_FILE,
      DELIVERA_DB_FILE: DB_FILE,
      DELIVERA_PLATFORM_POLLING_ENABLED: "0",
      TRUST_PROXY: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  server.stdout.on("data", (chunk) => {
    if (process.env.LOAD_VERBOSE === "1") {
      process.stdout.write(chunk);
    }
  });
  server.stderr.on("data", (chunk) => {
    if (process.env.LOAD_VERBOSE === "1") {
      process.stderr.write(chunk);
    }
  });

  try {
    await waitForServer();
    const actors = createLoadSessions(snapshot);
    const summaries = [];

    for (const concurrency of CONCURRENCY_LEVELS) {
      summaries.push(await runPool(
        `system-status-${concurrency}`,
        Array.from({ length: concurrency }, (_, index) => () => request("GET", "/api/admin/system-status", {
          token: actors.adminToken,
          sourceIp: `10.60.${Math.floor(index / 254) % 254}.${(index % 254) + 1}`,
        })),
        concurrency
      ));
      summaries.push(await runPool(
        `platform-order-${concurrency}`,
        Array.from({ length: concurrency }, (_, index) => platformOrderTask(index + concurrency * 1000)),
        concurrency
      ));
    }

    summaries.push(await runPool(
      "50-couriers-online",
      actors.courierTokens.slice(0, 50).map((courier) => () => request("PATCH", "/api/courier/location", {
        token: courier.token,
        sourceIp: `10.70.1.${(actors.courierTokens.indexOf(courier) % 254) + 1}`,
        body: { available: true, latitude: 36.61, longitude: 34.33 },
      })),
      50
    ));
    summaries.push(await runPool(
      "100-couriers-online",
      actors.courierTokens.slice(0, 100).map((courier) => () => request("PATCH", "/api/courier/location", {
        token: courier.token,
        sourceIp: `10.70.2.${(actors.courierTokens.indexOf(courier) % 254) + 1}`,
        body: { available: true, latitude: 36.62, longitude: 34.34 },
      })),
      100
    ));

    const byRestaurant = new Map(snapshot.packageIds.map((pkg) => [pkg.id, pkg.restaurantId]));
    const restaurantById = new Map(actors.restaurantTokens.map((restaurant) => [restaurant.id, restaurant]));
    const approvalTasks = snapshot.packageIds
      .map((pkg) => ({ pkg, restaurant: restaurantById.get(byRestaurant.get(pkg.id)) }))
      .filter((item) => item.restaurant)
      .slice(0, 100)
      .map(({ pkg, restaurant }, index) => () => request("POST", `/api/restaurant/packages/${pkg.id}/action`, {
        token: restaurant.token,
        sourceIp: `10.80.1.${(index % 254) + 1}`,
        body: { action: "confirm" },
      }));
    summaries.push(await runPool("50-restaurants-approve", approvalTasks.slice(0, 50), 50));
    summaries.push(await runPool("100-restaurants-approve", approvalTasks.slice(0, 100), 100));

    summaries.push(await runPool(
      "admin-heavy-bootstrap-10",
      Array.from({ length: 10 }, (_, index) => () => request("GET", "/api/admin/bootstrap", {
        token: actors.adminToken,
        sourceIp: `10.90.1.${index + 1}`,
      })),
      10
    ));

    const duplicateResults = await Promise.all(duplicatePlatformOrderTasks());
    const performance = await request("GET", "/api/admin/performance-summary", { token: actors.adminToken });
    const finalSnapshot = dbSnapshot();

    console.log(JSON.stringify({
      dbFile: DB_FILE,
      before: snapshot.counts,
      after: finalSnapshot.counts,
      dbSizeBytes: finalSnapshot.dbSizeBytes,
      concurrencyLevels: CONCURRENCY_LEVELS,
      duplicateCheck: duplicateResults.map((item) => ({
        ok: item.ok,
        status: item.status,
        duplicate: Boolean(item.payload?.package && item.status === 200),
        elapsedMs: item.elapsedMs,
      })),
      summaries,
      serverPerformance: performance.payload,
      processMemory: process.memoryUsage(),
    }, null, 2));
  } finally {
    server.kill();
    if (GENERATED_TEMP_LOAD_DB) {
      [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`].forEach((filePath) => {
        try {
          fs.rmSync(filePath, { force: true });
        } catch {}
      });
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
