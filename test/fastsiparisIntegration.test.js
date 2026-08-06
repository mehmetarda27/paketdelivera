const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
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
      if (response.ok) return;
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
    const error = new Error(`${route} -> ${response.status}: ${body.error || body.message || "request failed"}`);
    error.status = response.status;
    error.body = body;
    throw error;
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

function runSql(dbFile, sql, ...params) {
  const db = new DatabaseSync(dbFile);
  try {
    return db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  await new Promise((resolve) => {
    server.once("exit", resolve);
    server.kill();
    setTimeout(resolve, 2000).unref();
  });
}

function startMockPosentegra() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString();
    });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.setHeader("Content-Type", "application/json");
      if (req.method === "POST" && req.url === "/web-api/v1/restaurants") {
        res.end(JSON.stringify({ id: body?.name === "Rollback Posentegra Restaurant" ? "rollback-posentegra-003" : "987654321" }));
        return;
      }
      if (req.method === "POST" && req.url === "/web-api/v1/businesses/biz-1/restaurants") {
        if (body?.restaurantId === "rollback-posentegra-003") {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "link failed" }));
          return;
        }
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "DELETE" && req.url.startsWith("/web-api/v1/restaurants/")) {
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "POST" && req.url === "/web-api/v1/orders/change-status/test-pid-001") {
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        calls,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
      });
    });
  });
}

test("Trendyol webhook and courier delivery sync use Posentegra ids", { timeout: 30000 }, async () => {
  const mock = await startMockPosentegra();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivera-fastsiparis-"));
  const dbFile = path.join(tempDir, "delivera.sqlite");
  const port = 37000 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const adminUsername = `admin_${Date.now()}`;
  const adminPassword = "Delivera123!";
  const restaurantUsername = `rest_${Date.now()}`;
  const restaurantPassword = "Rest12345!";
  const courierUsername = `courier_${Date.now()}`;
  const courierPassword = "Kurye123!";

  const app = spawn(process.execPath, ["server.js"], {
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
      WEBHOOK_SECRET: "test-webhook-secret",
      WEBHOOK_ENABLED: "true",
      POSENTEGRA_API_BASE_URL: mock.baseUrl,
      POSENTEGRA_API_KEY: "test-api-key",
      POSENTEGRA_BUSINESS_ID: "biz-1",
      DELIVERA_ASSIGNMENT_RETRY_MS: "60000",
      DELIVERA_COURIER_OFFER_TIMEOUT_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stderr.on("data", (chunk) => process.stderr.write(chunk));

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
        name: "FastSiparis Test Restaurant",
        portalUsername: restaurantUsername,
        portalPassword: restaurantPassword,
        zone: "Erdemli",
        latitude: 36.601,
        longitude: 34.32,
        platforms: ["Trendyol Yemek"],
      }),
    });

    assert.equal(restaurantState.createdRestaurant.posentegraId, "987654321");
    assert.equal(restaurantState.createdRestaurant.verification, true);
    assert.equal(
      readRow(dbFile, "SELECT posentegra_id FROM restaurants WHERE id = ?", restaurantState.createdRestaurant.id).posentegra_id,
      "987654321"
    );
    assert.ok(mock.calls.some((call) => call.method === "POST" && call.url === "/web-api/v1/restaurants"));
    assert.ok(mock.calls.some((call) => call.method === "POST" && call.url === "/web-api/v1/businesses/biz-1/restaurants"));
    assert.ok(readRow(dbFile, "SELECT id FROM webhook_logs WHERE source_platform = ? AND status = ?", "Posentegra", "posentegra_restaurant_create"));

    const existingPosentegraId = "existing-posentegra-002";
    const createCallCountBeforeExistingLink = mock.calls.filter((call) => call.method === "POST" && call.url === "/web-api/v1/restaurants").length;
    const existingRestaurantState = await request(baseUrl, "/api/admin/restaurants", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Existing Posentegra Restaurant",
        portalUsername: `existing_${Date.now()}`,
        portalPassword: "Existing123!",
        zone: "Erdemli",
        latitude: 36.602,
        longitude: 34.321,
        posentegraId: existingPosentegraId,
      }),
    });
    assert.equal(existingRestaurantState.createdRestaurant.posentegraId, existingPosentegraId);
    assert.equal(
      mock.calls.filter((call) => call.method === "POST" && call.url === "/web-api/v1/restaurants").length,
      createCallCountBeforeExistingLink
    );
    assert.ok(mock.calls.some((call) =>
      call.method === "POST" &&
      call.url === "/web-api/v1/businesses/biz-1/restaurants" &&
      call.body?.restaurantId === existingPosentegraId
    ));

    const rollbackUsername = `rollback_${Date.now()}`;
    await assert.rejects(
      () => request(baseUrl, "/api/admin/restaurants", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          name: "Rollback Posentegra Restaurant",
          portalUsername: rollbackUsername,
          portalPassword: "Rollback123!",
          zone: "Erdemli",
          latitude: 36.603,
          longitude: 34.322,
        }),
      }),
      (error) => error.status === 500
    );
    assert.equal(readRow(dbFile, "SELECT id FROM restaurants WHERE username = ?", rollbackUsername), undefined);
    assert.ok(mock.calls.some((call) => call.method === "DELETE" && call.url === "/web-api/v1/restaurants/rollback-posentegra-003"));

    const courierState = await request(baseUrl, "/couriers", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "FastSiparis Courier",
        username: courierUsername,
        password: courierPassword,
        zone: "Erdemli",
        latitude: 36.602,
        longitude: 34.321,
        available: true,
      }),
    });
    assert.ok(courierState.createdCourier?.id);
    await request(baseUrl, `/api/admin/couriers/${courierState.createdCourier.id}/availability`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ available: true }),
    });
    runSql(dbFile, "UPDATE couriers SET available = 1, status = 'online' WHERE id = ?", courierState.createdCourier.id);

    const webhookOrder = await request(baseUrl, "/api/webhooks/orders", {
      method: "POST",
      headers: { "x-webhook-secret": "test-webhook-secret" },
      body: JSON.stringify({
        provider: { slug: "ty", api: "tywh", kaynak: "Trendyol Yemek" },
        pid: "test-pid-001",
        restaurantId: "987654321",
        restaurant: { id: "987654321", name: "FastSiparis Test Restaurant" },
        customerName: "FastSiparis Customer",
        customerPhone: "05550000007",
        addressText: "FastSiparis webhook address",
        totalPrice: 330,
        paymentMethod: "PAY_WITH_MEAL_CARD",
        products: [{ id: "prod-fast-1", name: "Menu", quantity: 1, price: 330, totalPrice: 330 }],
      }),
    });
    assert.equal(webhookOrder.matched, true);
    assert.equal(webhookOrder.package.restaurantId, restaurantState.createdRestaurant.id);
    assert.equal(
      readRow(dbFile, "SELECT platform_restaurant_id FROM packages WHERE id = ?", webhookOrder.package.id).platform_restaurant_id,
      "987654321"
    );
    assert.equal(
      readRow(dbFile, "SELECT posentegra_id FROM packages WHERE id = ?", webhookOrder.package.id).posentegra_id,
      "test-pid-001"
    );
    assert.equal(
      readRow(dbFile, "SELECT posentegra_id FROM platform_orders WHERE platform_order_id = ?", "test-pid-001").posentegra_id,
      "test-pid-001"
    );
    assert.notEqual(webhookOrder.package.status, "pending_approval");
    assert.equal(
      readRow(dbFile, "SELECT status FROM platform_orders WHERE platform_order_id = ?", "test-pid-001").status,
      "approved"
    );
    assert.equal(
      readRow(dbFile, "SELECT payment_status FROM packages WHERE id = ?", webhookOrder.package.id).payment_status,
      "paid_online"
    );
    runSql(
      dbFile,
      "UPDATE packages SET status = 'assigned', assignment_status = 'assigned', assigned_courier_id = ?, assigned_courier_name = ?, assigned_at = datetime('now') WHERE id = ?",
      courierState.createdCourier.id,
      courierState.createdCourier.name,
      webhookOrder.package.id
    );
    const assigned = readRow(dbFile, "SELECT assigned_courier_id, status FROM packages WHERE id = ?", webhookOrder.package.id);
    assert.equal(assigned.assigned_courier_id, courierState.createdCourier.id);

    const courierLogin = await request(baseUrl, "/api/courier/login", {
      method: "POST",
      body: JSON.stringify({ username: courierUsername, password: courierPassword }),
    });
    await request(baseUrl, `/api/courier/packages/${webhookOrder.package.id}/status`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${courierLogin.token}` },
      body: JSON.stringify({ status: "accepted_by_courier" }),
    });
    await request(baseUrl, `/api/courier/packages/${webhookOrder.package.id}/status`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${courierLogin.token}` },
      body: JSON.stringify({ status: "on_route" }),
    });
    await request(baseUrl, `/api/courier/packages/${webhookOrder.package.id}/status`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${courierLogin.token}` },
      body: JSON.stringify({ status: "delivered" }),
    });
    const deliveredOnlinePackage = readRow(
      dbFile,
      "SELECT status, payment_status FROM packages WHERE id = ?",
      webhookOrder.package.id
    );
    assert.equal(deliveredOnlinePackage.status, "delivered");
    assert.equal(deliveredOnlinePackage.payment_status, "paid_online");

    let deliveredStatusCall = null;
    for (let attempt = 0; attempt < 40 && !deliveredStatusCall; attempt += 1) {
      deliveredStatusCall = mock.calls.find((call) =>
        call.method === "POST" &&
        call.url === "/web-api/v1/orders/change-status/test-pid-001" &&
        call.body?.status === "delivered"
      );
      if (!deliveredStatusCall) await delay(50);
    }
    assert.ok(deliveredStatusCall);
    assert.equal(deliveredStatusCall.body.packageId, webhookOrder.package.id);
    assert.equal(deliveredStatusCall.body.internalStatus, "delivered");
    const deliveredOutbox = readRow(
      dbFile,
      "SELECT status, attempts FROM posentegra_outbox WHERE dedupe_key = ?",
      `order.status:${webhookOrder.package.id}:delivered`
    );
    assert.equal(deliveredOutbox.status, "completed");
    assert.equal(deliveredOutbox.attempts, 0);
    const deliveredPackageWithLogs = readRow(
      dbFile,
      "SELECT platform_status_logs_json FROM packages WHERE id = ?",
      webhookOrder.package.id
    );
    assert.match(deliveredPackageWithLogs.platform_status_logs_json, /posentegra_outbox/);
    assert.equal(
      readRow(dbFile, "SELECT COUNT(*) AS count FROM packages WHERE posentegra_id IS NULL OR posentegra_id = ''").count,
      0
    );
  } finally {
    await stopServer(app);
    await new Promise((resolve) => mock.server.close(resolve));
  }
});
