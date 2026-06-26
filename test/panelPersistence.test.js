const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(baseUrl, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/bootstrap`);
      if (response.ok) {
        return;
      }
    } catch {}
    await delay(150);
  }
  throw new Error("Test server did not start in time.");
}

async function request(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${route} -> ${response.status}: ${body.error || body.message || "request failed"}`);
  }
  return body;
}

function readRow(dbFile, sql, ...params) {
  const db = new DatabaseSync(dbFile);
  try {
    return db.prepare(sql).get(...params);
  } finally {
    db.close();
  }
}

async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) {
    return;
  }
  await new Promise((resolve) => {
    server.once("exit", resolve);
    server.kill();
    setTimeout(resolve, 2000).unref();
  });
}

test("panel create/update/delete flows persist to database tables", { timeout: 30000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivera-panel-persistence-"));
  const dbFile = path.join(tempDir, "delivera.sqlite");
  const port = 34000 + (process.pid % 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const adminUsername = `admin_${Date.now()}`;
  const adminPassword = "Delivera123!";
  const restaurantUsername = `rest_${Date.now()}`;
  const restaurantPassword = "Rest12345!";

  const server = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "test",
      DATABASE_URL: "",
      POSTGRES_URL: "",
      DATABASE_PATH: dbFile,
      DB_PATH: dbFile,
      DELIVERA_DB_FILE: dbFile,
      DELIVERA_ADMIN_USERNAME: adminUsername,
      DELIVERA_ADMIN_PASSWORD: adminPassword,
      DELIVERA_ASSIGNMENT_RETRY_MS: "60000",
      DELIVERA_COURIER_OFFER_TIMEOUT_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  server.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
  });

  try {
    await waitForServer(baseUrl);

    const adminLogin = await request(baseUrl, "/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ username: adminUsername, password: adminPassword }),
    });
    const adminHeaders = { Authorization: `Bearer ${adminLogin.token}` };

    const restaurantState = await request(baseUrl, "/restaurants", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Persistence Test Restaurant",
        portalUsername: restaurantUsername,
        portalPassword: restaurantPassword,
        zone: "Erdemli",
        latitude: 36.601,
        longitude: 34.32,
        platforms: ["Getir Yemek"],
      }),
    });
    assert.ok(restaurantState.createdRestaurant?.id);
    assert.ok(readRow(dbFile, "SELECT id FROM restaurants WHERE id = ?", restaurantState.createdRestaurant.id));

    const courierState = await request(baseUrl, "/couriers", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Persistence Courier",
        username: `courier_${Date.now()}`,
        password: "Kurye123!",
        zone: "Erdemli",
        latitude: 36.602,
        longitude: 34.321,
        available: true,
      }),
    });
    assert.ok(courierState.createdCourier?.id);
    assert.ok(readRow(dbFile, "SELECT id FROM couriers WHERE id = ?", courierState.createdCourier.id));

    await request(baseUrl, `/api/admin/couriers/${courierState.createdCourier.id}`, {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Persistence Courier Updated",
        username: courierState.createdCourier.username,
        zone: "Erdemli",
      }),
    });
    assert.equal(
      readRow(dbFile, "SELECT name FROM couriers WHERE id = ?", courierState.createdCourier.id).name,
      "Persistence Courier Updated"
    );

    const deleteCourierState = await request(baseUrl, "/api/admin/couriers", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Delete Persistence Courier",
        username: `delete_courier_${Date.now()}`,
        password: "Kurye123!",
        zone: "Erdemli",
        latitude: 36.603,
        longitude: 34.322,
        available: false,
      }),
    });
    await request(baseUrl, `/api/admin/couriers/${deleteCourierState.createdCourier.id}`, {
      method: "DELETE",
      headers: adminHeaders,
    });
    assert.equal(readRow(dbFile, "SELECT id FROM couriers WHERE id = ?", deleteCourierState.createdCourier.id), undefined);

    const restaurantLogin = await request(baseUrl, "/api/restaurant/session", {
      method: "POST",
      body: JSON.stringify({ username: restaurantUsername, password: restaurantPassword }),
    });
    const restaurantHeaders = { Authorization: `Bearer ${restaurantLogin.token}` };

    const platformOrderId = `PLATFORM-${Date.now()}`;
    const platformOrderState = await request(baseUrl, "/platform-orders", {
      method: "POST",
      headers: restaurantHeaders,
      body: JSON.stringify({
        platform: "POS",
        orderId: platformOrderId,
        customerName: "Platform Persistence Customer",
        phone: "5554443322",
        address: "Platform persistence address",
        totalPrice: 210,
        paymentMethod: "Online Odeme",
        note: "platform_orders persistence test",
      }),
    });
    assert.ok(platformOrderState.package?.id);
    assert.ok(platformOrderState.platformOrder?.id);
    assert.ok(readRow(dbFile, "SELECT id FROM packages WHERE id = ?", platformOrderState.package.id));
    assert.ok(readRow(dbFile, "SELECT id FROM platform_orders WHERE id = ?", platformOrderState.platformOrder.id));
    assert.ok(
      readRow(dbFile, "SELECT id FROM platform_orders WHERE platform_order_id = ?", platformOrderId)
    );

    const packageState = await request(baseUrl, "/packages", {
      method: "POST",
      headers: restaurantHeaders,
      body: JSON.stringify({
        restaurantId: restaurantState.createdRestaurant.id,
        deliveryAddress: "Persistence mahallesi no 1 Erdemli",
        packageType: "Test Paket",
        orderAmount: 125,
        customerName: "Persistence Customer",
        phone: "5551112233",
        customerNote: "DB persistence test",
        paymentMethod: "Panel Kaydi",
      }),
    });
    assert.ok(packageState.createdPackage?.id);
    assert.ok(readRow(dbFile, "SELECT id FROM packages WHERE id = ?", packageState.createdPackage.id));

    const reloadedRestaurantState = await request(baseUrl, "/api/restaurant/bootstrap", {
      headers: restaurantHeaders,
    });
    assert.ok(reloadedRestaurantState.packages.some((pkg) => pkg.id === packageState.createdPackage.id));

    const counts = readRow(dbFile, `
      SELECT
        (SELECT COUNT(*) FROM restaurants) AS restaurants,
        (SELECT COUNT(*) FROM couriers) AS couriers,
        (SELECT COUNT(*) FROM packages) AS packages,
        (SELECT COUNT(*) FROM platform_orders) AS platform_orders
    `);
    assert.ok(counts.restaurants > 0);
    assert.ok(counts.couriers > 0);
    assert.ok(counts.packages > 0);
    assert.ok(counts.platform_orders > 0);
  } finally {
    await stopServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
