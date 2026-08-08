const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer(baseUrl) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10000) {
    try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch {}
    await delay(100);
  }
  throw new Error("Restaurant phone customer test server did not start.");
}

async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  await new Promise((resolve) => {
    server.once("exit", resolve);
    server.kill();
    setTimeout(resolve, 2000).unref();
  });
}

async function request(baseUrl, route, token, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  const body = await response.json();
  assert.equal(response.ok, true, body.error || `${options.method || "GET"} ${route} failed`);
  return body;
}

test("phone order saves the customer, supports phone lookup and does not require a menu", { timeout: 20000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivera-phone-customer-"));
  const dbFile = path.join(tempDir, "delivera.sqlite");
  const port = 46500 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(port), NODE_ENV: "test", DATABASE_URL: "", POSTGRES_URL: "", DATABASE_PATH: dbFile, DB_PATH: dbFile, DELIVERA_DB_FILE: dbFile, DELIVERA_ASSIGNMENT_RETRY_MS: "60000" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));
  try {
    await waitForServer(baseUrl);
    const db = new DatabaseSync(dbFile);
    const stamp = new Date().toISOString();
    const token = "restaurant-phone-test-token";
    db.prepare("INSERT INTO restaurants (id, name, zone, x, y, platforms_json, api_key, webhook_secret, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("rst_phone", "Telefon Test Restoran", "Akdeniz", 36.8081, 34.6372, "[]", "phone-api", "phone-secret", stamp);
    db.prepare("INSERT INTO restaurant_sessions (token, restaurant_id, created_at) VALUES (?, ?, ?)").run(token, "rst_phone", stamp);

    const first = await request(baseUrl, "/api/restaurant/packages", token, {
      method: "POST",
      body: JSON.stringify({ customerName: "Ayşe Test", phone: "0532 111 22 33", deliveryAddress: "Test Mahallesi No 1", packageType: "", orderAmount: 150, paymentMethod: "paid_online" }),
    });
    assert.equal(first.createdPackage.packageType, "Standart Paket");
    assert.ok(first.createdPackage.restaurantCustomerId);
    const customerId = first.createdPackage.restaurantCustomerId;

    const lookup = await request(baseUrl, "/api/restaurant/customers?phone=05321112233", token);
    assert.equal(lookup.customers.length, 1);
    assert.equal(lookup.customers[0].name, "Ayşe Test");
    assert.equal(lookup.customers[0].address, "Test Mahallesi No 1");

    const second = await request(baseUrl, "/api/restaurant/packages", token, {
      method: "POST",
      body: JSON.stringify({ restaurantCustomerId: customerId, packageType: "", orderAmount: 90, paymentMethod: "paid_online" }),
    });
    assert.equal(second.createdPackage.recipient, "Ayşe Test");
    assert.equal(second.createdPackage.customerAddress, "Test Mahallesi No 1");
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM customers WHERE restaurant_id = ?").get("rst_phone").total, 1);
    assert.equal(db.prepare("SELECT order_count FROM customers WHERE id = ?").get(customerId).order_count, 2);
    db.close();
  } finally {
    await stopServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
