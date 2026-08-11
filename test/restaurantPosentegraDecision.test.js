const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(check, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await check();
    if (value) return value;
    await delay(40);
  }
  throw new Error("Timed out while waiting for the isolated Posentegra test flow.");
}

async function request(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`${route} -> ${response.status}: ${body.error || "request failed"}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function withDb(dbFile, callback) {
  const db = new DatabaseSync(dbFile);
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    return callback(db);
  } finally {
    db.close();
  }
}

function insertDecisionOrder(dbFile, { restaurantId, platform, slug, decision }) {
  const packageId = `pkg_${slug}_${decision}`;
  const orderId = `pid-${slug}-${decision}`;
  const stamp = new Date().toISOString();
  withDb(dbFile, (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`
        INSERT INTO packages (
          id, tracking_no, restaurant_id, source, delivery_address, package_type,
          source_platform, platform_restaurant_id, posentegra_id, external_order_no,
          external_order_id, recipient, phone, address, zone, eta, payment_method,
          order_amount, payment_status, x, y, note, status, assignment_status,
          assignment_reason, created_at, updated_at
        ) VALUES (?, ?, ?, 'platform_webhook', ?, 'Test Menü', ?, 'pos-rest-decisions', ?, ?, ?, ?, ?, ?,
          'Akdeniz', '20 dk', 'Online Ödeme', 100, 'paid_online', 36.8, 34.6, '',
          'pending_approval', 'pending_approval', 'Platform onayı bekleniyor.', ?, ?)
      `).run(
        packageId,
        `PKT-${slug}-${decision}`,
        restaurantId,
        `Test adres ${slug}`,
        platform,
        orderId,
        orderId,
        orderId,
        `Test Müşteri ${slug}`,
        "05310000000",
        `Test adres ${slug}`,
        stamp,
        stamp
      );
      db.prepare(`
        INSERT INTO platform_orders (
          id, platform, platform_order_id, platform_restaurant_id, posentegra_id,
          restaurant_id, package_id, customer_name, phone, address, total_price,
          note, status, raw_payload, created_at, updated_at
        ) VALUES (?, ?, ?, 'pos-rest-decisions', ?, ?, ?, ?, '05310000000', ?, 100,
          '', 'pending_approval', '{}', ?, ?)
      `).run(
        `por_${slug}_${decision}`,
        platform,
        orderId,
        orderId,
        restaurantId,
        packageId,
        `Test Müşteri ${slug}`,
        `Test adres ${slug}`,
        stamp,
        stamp
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
  return { packageId, orderId, platform, decision };
}

function startIsolatedPosentegra() {
  const calls = [];
  const attempts = new Map();
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk.toString(); });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const call = { method: req.method, url: req.url, headers: req.headers, body };
      calls.push(call);
      res.setHeader("Content-Type", "application/json");
      if (req.method === "POST" && req.url === "/web-api/v1/restaurants") {
        res.end(JSON.stringify({ id: "pos-rest-decisions" }));
        return;
      }
      if (req.method === "POST" && req.url === "/web-api/v1/businesses/test-business/restaurants") {
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "POST" && req.url.startsWith("/web-api/v1/orders/change-status/")) {
        const count = (attempts.get(req.url) || 0) + 1;
        attempts.set(req.url, count);
        if (req.url.endsWith("pid-trendyol-approve") && count === 1) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: "isolated temporary failure" }));
          return;
        }
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "POST" && req.url.startsWith("/web-api/v1/orders/cancel/")) {
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "isolated mock endpoint not found" }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    server,
    calls,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  })));
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill();
    setTimeout(resolve, 2000).unref();
  });
}

test("restaurant approve/reject routes every supported source through an isolated Posentegra outbox", { timeout: 40000 }, async () => {
  const mock = await startIsolatedPosentegra();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivera-posentegra-decisions-"));
  const dbFile = path.join(tempDir, "isolated.sqlite");
  const port = 39000 + Math.floor(Math.random() * 900);
  const baseUrl = `http://127.0.0.1:${port}`;
  const adminUsername = `decision_admin_${Date.now()}`;
  const adminPassword = "AdminDecision123!";
  const restaurantUsername = `decision_rest_${Date.now()}`;
  const restaurantPassword = "RestaurantDecision123!";
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
      POSENTEGRA_API_BASE_URL: mock.baseUrl,
      POSENTEGRA_API_KEY: "isolated-test-key",
      POSENTEGRA_BUSINESS_ID: "test-business",
      POSENTEGRA_RETRY_ATTEMPTS: "1",
      POSENTEGRA_RETRY_DELAY_MS: "10",
      POSENTEGRA_OUTBOX_POLL_MS: "60000",
      DELIVERA_ASSIGNMENT_RETRY_MS: "60000",
      DELIVERA_COURIER_OFFER_TIMEOUT_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childOutput = "";
  app.stdout.on("data", (chunk) => { childOutput += chunk.toString(); });
  app.stderr.on("data", (chunk) => { childOutput += chunk.toString(); });

  try {
    await waitUntil(async () => {
      if (app.exitCode !== null || app.signalCode !== null) {
        throw new Error(`Isolated Delivera test server exited early: ${childOutput.slice(-3000)}`);
      }
      try { return (await fetch(`${baseUrl}/api/bootstrap`)).ok; } catch { return false; }
    }, 20000);
    const adminLogin = await request(baseUrl, "/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ username: adminUsername, password: adminPassword }),
    });
    const adminHeaders = { Authorization: `Bearer ${adminLogin.token}` };
    const restaurantState = await request(baseUrl, "/restaurants", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Isolated Decision Restaurant",
        portalUsername: restaurantUsername,
        portalPassword: restaurantPassword,
        zone: "Akdeniz",
        latitude: 36.8,
        longitude: 34.6,
        platforms: ["Trendyol Yemek", "Getir Yemek", "Yemeksepeti", "Migros Yemek"],
      }),
    });
    const restaurantId = restaurantState.createdRestaurant.id;
    const restaurantLogin = await request(baseUrl, "/api/restaurant/session", {
      method: "POST",
      body: JSON.stringify({ username: restaurantUsername, password: restaurantPassword }),
    });
    const restaurantHeaders = { Authorization: `Bearer ${restaurantLogin.token}` };
    const platforms = [
      ["Trendyol Yemek", "trendyol"],
      ["Getir Yemek", "getir"],
      ["Yemeksepeti", "yemeksepeti"],
      ["Migros Yemek", "migros"],
    ];
    const orders = platforms.flatMap(([platform, slug]) => [
      insertDecisionOrder(dbFile, { restaurantId, platform, slug, decision: "approve" }),
      insertDecisionOrder(dbFile, { restaurantId, platform, slug, decision: "reject" }),
    ]);

    for (const order of orders) {
      await request(baseUrl, `/api/restaurant/packages/${order.packageId}/action`, {
        method: "POST",
        headers: restaurantHeaders,
        body: JSON.stringify(order.decision === "approve"
          ? { action: "confirm" }
          : { action: "reject", reason: `${order.platform} restoran reddi` }),
      });
    }

    await request(baseUrl, `/api/restaurant/packages/pkg_trendyol_approve/action`, {
      method: "POST",
      headers: restaurantHeaders,
      body: JSON.stringify({ action: "confirm" }),
    });
    await assert.rejects(
      request(baseUrl, `/api/restaurant/packages/pkg_trendyol_reject/action`, {
        method: "POST",
        headers: restaurantHeaders,
        body: JSON.stringify({ action: "reject", reason: "tekrar" }),
      }),
      (error) => error.status === 409
    );

    const failedApproval = await waitUntil(() => withDb(dbFile, (db) => db.prepare(`
      SELECT * FROM posentegra_outbox
      WHERE dedupe_key = 'order.status:pkg_trendyol_approve:accepted' AND status = 'dead_letter'
    `).get()));
    await request(baseUrl, `/api/admin/posentegra-outbox/${failedApproval.id}/retry`, {
      method: "POST",
      headers: adminHeaders,
      body: "{}",
    });

    await waitUntil(() => withDb(dbFile, (db) => {
      const row = db.prepare("SELECT COUNT(*) AS count FROM posentegra_outbox WHERE status = 'completed'").get();
      return Number(row.count) === 8;
    }));

    for (const [platform, slug] of platforms) {
      const approvedCalls = mock.calls.filter((call) => call.url === `/web-api/v1/orders/change-status/pid-${slug}-approve`);
      assert.ok(approvedCalls.every((call) => Object.keys(call.body || {}).length === 0));
      assert.ok(approvedCalls.every((call) => call.headers["idempotency-key"] === `status:pid-${slug}-approve:accepted:pkg_${slug}_approve`));
      assert.equal(approvedCalls.length, slug === "trendyol" ? 2 : 1);

      const rejectedCalls = mock.calls.filter((call) => call.url === `/web-api/v1/orders/cancel/pid-${slug}-reject`);
      assert.equal(rejectedCalls.length, 1);
      assert.equal(rejectedCalls[0].body.sourcePlatform, platform);
      assert.equal(rejectedCalls[0].body.reason, `${platform} restoran reddi`);
      assert.equal(rejectedCalls[0].headers["idempotency-key"], `cancel:pid-${slug}-reject:pkg_${slug}_reject`);

      assert.equal(withDb(dbFile, (db) => db.prepare("SELECT status FROM platform_orders WHERE id = ?").get(`por_${slug}_approve`).status), "approved");
      assert.equal(withDb(dbFile, (db) => db.prepare("SELECT status FROM platform_orders WHERE id = ?").get(`por_${slug}_reject`).status), "cancelled");
    }
    assert.equal(withDb(dbFile, (db) => db.prepare("SELECT COUNT(*) AS count FROM posentegra_outbox").get().count), 8);
    assert.equal(withDb(dbFile, (db) => db.prepare("SELECT COUNT(*) AS count FROM posentegra_outbox WHERE status != 'completed'").get().count), 0);
  } finally {
    await stopChild(app);
    await new Promise((resolve) => mock.server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
