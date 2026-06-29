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

function withDb(dbFile, callback) {
  const db = new DatabaseSync(dbFile);
  try {
    return callback(db);
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

test("courier earnings count delivered packages and avoid duplicate daily records", { timeout: 30000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivera-courier-earnings-"));
  const dbFile = path.join(tempDir, "delivera.sqlite");
  const port = 35000 + (process.pid % 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const adminUsername = `admin_${Date.now()}`;
  const adminPassword = "Delivera123!";
  const restaurantUsername = `rest_${Date.now()}`;
  const restaurantPassword = "Rest12345!";
  const reportDate = "2026-06-29";
  const deliveredAt = `${reportDate}T12:30:00.000Z`;

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
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    await waitForServer(baseUrl);
    const adminLogin = await request(baseUrl, "/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ username: adminUsername, password: adminPassword }),
    });
    const adminHeaders = { Authorization: `Bearer ${adminLogin.token}` };

    await request(baseUrl, "/api/admin/settings", {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({ courier_per_package_fee: 30 }),
    });

    const restaurantState = await request(baseUrl, "/restaurants", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Earnings Test Restaurant",
        portalUsername: restaurantUsername,
        portalPassword: restaurantPassword,
        zone: "Erdemli",
        latitude: 36.601,
        longitude: 34.32,
        platforms: ["POS"],
      }),
    });
    const courierState = await request(baseUrl, "/couriers", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Earnings Courier",
        username: `courier_${Date.now()}`,
        password: "Kurye123!",
        zone: "Erdemli",
        latitude: 36.602,
        longitude: 34.321,
        available: true,
        perPackageFee: 35,
      }),
    });

    const restaurantLogin = await request(baseUrl, "/api/restaurant/session", {
      method: "POST",
      body: JSON.stringify({ username: restaurantUsername, password: restaurantPassword }),
    });
    const restaurantHeaders = { Authorization: `Bearer ${restaurantLogin.token}` };
    const deliveredPackage = await request(baseUrl, "/packages", {
      method: "POST",
      headers: restaurantHeaders,
      body: JSON.stringify({
        restaurantId: restaurantState.createdRestaurant.id,
        deliveryAddress: "Teslim edilen adres",
        packageType: "Test Paket",
        orderAmount: 200,
        customerName: "Teslim Musteri",
        phone: "5551112233",
        paymentMethod: "Nakit",
      }),
    });
    const waitingPackage = await request(baseUrl, "/packages", {
      method: "POST",
      headers: restaurantHeaders,
      body: JSON.stringify({
        restaurantId: restaurantState.createdRestaurant.id,
        deliveryAddress: "Bekleyen adres",
        packageType: "Test Paket",
        orderAmount: 100,
        customerName: "Bekleyen Musteri",
        phone: "5551112244",
        paymentMethod: "Nakit",
      }),
    });

    withDb(dbFile, (db) => {
      db.prepare(`
        UPDATE packages
        SET assigned_courier_id = ?, assigned_courier_name = ?, status = 'delivered', assignment_status = 'assigned',
            delivered_at = ?, updated_at = ?
        WHERE id = ?
      `).run(courierState.createdCourier.id, courierState.createdCourier.name, deliveredAt, deliveredAt, deliveredPackage.createdPackage.id);
      db.prepare(`
        UPDATE packages
        SET assigned_courier_id = ?, assigned_courier_name = ?, status = 'on_route', assignment_status = 'assigned',
            updated_at = ?
        WHERE id = ?
      `).run(courierState.createdCourier.id, courierState.createdCourier.name, deliveredAt, waitingPackage.createdPackage.id);
    });

    const generated = await request(baseUrl, "/api/admin/courier-earnings/generate", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ date: reportDate, courierId: courierState.createdCourier.id }),
    });
    assert.equal(generated.courierEarnings.length, 1);
    const earning = generated.courierEarnings[0];
    assert.equal(earning.deliveredPackageCount, 1);
    assert.equal(earning.perPackageFee, 35);
    assert.equal(earning.totalPayable, 35);
    assert.equal(earning.items.length, 1);
    assert.equal(earning.items[0].packageId, deliveredPackage.createdPackage.id);

    await request(baseUrl, `/api/admin/courier-earnings/${earning.id}`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ perPackageFee: 30, bonusAmount: 10, deductionAmount: 5, adminNote: "test update" }),
    });
    const updated = await request(baseUrl, `/api/admin/courier-earnings/${earning.id}`, {
      headers: adminHeaders,
    });
    assert.equal(updated.courierEarning.totalPayable, 35);

    await request(baseUrl, `/api/admin/courier-earnings/${earning.id}/mark-paid`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ adminNote: "odendi" }),
    });
    const paid = await request(baseUrl, `/api/admin/courier-earnings/${earning.id}`, {
      headers: adminHeaders,
    });
    assert.equal(paid.courierEarning.paymentStatus, "paid");
    assert.ok(paid.courierEarning.paidAt);

    await request(baseUrl, "/api/admin/courier-earnings/generate", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ date: reportDate, courierId: courierState.createdCourier.id, adminNote: "paid sync" }),
    });
    const count = withDb(dbFile, (db) =>
      db.prepare("SELECT COUNT(*) AS count FROM courier_earnings WHERE courier_id = ? AND report_date = ?")
        .get(courierState.createdCourier.id, reportDate).count
    );
    assert.equal(count, 1);
  } finally {
    await stopServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
