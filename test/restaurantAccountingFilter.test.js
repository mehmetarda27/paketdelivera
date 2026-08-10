const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.unref();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const { port } = listener.address();
      listener.close(() => resolve(port));
    });
  });
}

async function waitForServer(baseUrl) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/api/bootstrap`)).ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error("Accounting test server did not start.");
}

async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  await new Promise((resolve) => {
    server.once("exit", resolve);
    server.kill();
    setTimeout(resolve, 2000).unref();
  });
}

test("restaurant accounting separates cancelled packages and filters by restaurant", { timeout: 30000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivera-accounting-filter-"));
  const dbFile = path.join(tempDir, "delivera.sqlite");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const username = `accounting_admin_${Date.now()}`;
  const password = "AccountingAdmin123!";
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
      DELIVERA_ADMIN_USERNAME: username,
      DELIVERA_ADMIN_PASSWORD: password,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => process.stdout.write(chunk));
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    await waitForServer(baseUrl);
    const date = new Date().toISOString().slice(0, 10);
    const stamp = `${date}T12:00:00.000Z`;
    const db = new DatabaseSync(dbFile);
    db.exec("PRAGMA busy_timeout = 10000");
    const insertRestaurant = db.prepare("INSERT INTO restaurants (id, name, zone, x, y, platforms_json, api_key, webhook_secret, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    insertRestaurant.run("rst_accounting_a", "Restoran A", "Akdeniz", 36.8, 34.6, "[]", "accounting-a", "secret-a", stamp);
    insertRestaurant.run("rst_accounting_b", "Restoran B", "Yenişehir", 36.81, 34.61, "[]", "accounting-b", "secret-b", stamp);
    const insertPackage = db.prepare(`
      INSERT INTO packages (
        id, tracking_no, restaurant_id, source, source_platform, external_order_no,
        recipient, phone, address, zone, eta, payment_method, order_amount, payment_status,
        x, y, note, status, assignment_status, delivered_at, failed_at,
        assignment_reason, created_at, updated_at
      ) VALUES (?, ?, ?, 'restaurant_panel', 'Telefon', ?, ?, '05310000000', 'Test adresi', 'Akdeniz', '20 dk', 'cash_on_delivery', ?, 'cash_collected', 36.8, 34.6, '', ?, ?, ?, ?, 'test', ?, ?)
    `);
    insertPackage.run("pkg_accounting_delivered_a", "PKT-ACC-A-1", "rst_accounting_a", "ACC-A-1", "Müşteri A", 250, "delivered", "delivered", stamp, null, stamp, stamp);
    insertPackage.run("pkg_accounting_cancelled_a", "PKT-ACC-A-2", "rst_accounting_a", "ACC-A-2", "Müşteri A", 125, "cancelled", "cancelled", null, stamp, stamp, stamp);
    insertPackage.run("pkg_accounting_delivered_b", "PKT-ACC-B-1", "rst_accounting_b", "ACC-B-1", "Müşteri B", 300, "delivered", "delivered", stamp, null, stamp, stamp);
    db.close();

    const loginResponse = await fetch(`${baseUrl}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const login = await loginResponse.json();
    assert.equal(loginResponse.status, 200, login.error);
    const headers = { Authorization: `Bearer ${login.token}` };

    const allResponse = await fetch(`${baseUrl}/api/admin/accounting/restaurants?startDate=${date}&endDate=${date}`, { headers });
    const all = await allResponse.json();
    assert.equal(allResponse.status, 200, all.error);
    const restaurantA = all.restaurantAccounting.find((item) => item.restaurantId === "rst_accounting_a");
    assert.equal(restaurantA.totalSubmittedPackages, 2);
    assert.equal(restaurantA.totalPackages, 1);
    assert.equal(restaurantA.totalCancelledPackages, 1);

    const filteredResponse = await fetch(`${baseUrl}/api/admin/accounting/restaurants?startDate=${date}&endDate=${date}&restaurantId=rst_accounting_a`, { headers });
    const filtered = await filteredResponse.json();
    assert.equal(filteredResponse.status, 200, filtered.error);
    assert.deepEqual(filtered.restaurantAccounting.map((item) => item.restaurantId), ["rst_accounting_a"]);

    const detailsResponse = await fetch(`${baseUrl}/api/admin/accounting/restaurants/rst_accounting_a/details?startDate=${date}&endDate=${date}`, { headers });
    const details = await detailsResponse.json();
    assert.equal(detailsResponse.status, 200, details.error);
    assert.deepEqual(details.details.packageStats, {
      totalSubmittedPackages: 2,
      totalDeliveredPackages: 1,
      totalCancelledPackages: 1,
    });
    assert.deepEqual(details.details.packages.map((pkg) => pkg.id), ["pkg_accounting_delivered_a"]);
    assert.deepEqual(details.details.cancelledPackages.map((pkg) => pkg.id), ["pkg_accounting_cancelled_a"]);
  } finally {
    await stopServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
