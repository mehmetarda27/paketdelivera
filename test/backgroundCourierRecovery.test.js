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
  throw new Error("Background courier recovery server did not start.");
}

async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  await new Promise((resolve) => {
    server.once("exit", resolve);
    server.kill();
    setTimeout(resolve, 2000).unref();
  });
}

async function waitForCourierAssignment(dbFile, packageId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 8000) {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    const row = db.prepare("SELECT assigned_courier_id, status, assignment_reason FROM packages WHERE id = ?").get(packageId);
    db.close();
    if (row?.assigned_courier_id) return row;
    await delay(100);
  }
  throw new Error("Waiting package was not assigned after background location recovered.");
}

test("an open-shift courier stays assignable and visible with last known location while the browser is suspended", { timeout: 25000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivera-background-recovery-"));
  const dbFile = path.join(tempDir, "delivera.sqlite");
  const port = 46800 + Math.floor(Math.random() * 700);
  const baseUrl = `http://127.0.0.1:${port}`;
  const adminUsername = `background_admin_${Date.now()}`;
  const adminPassword = "BackgroundAdmin123!";
  const courierUsername = `background_courier_${Date.now()}`;
  const courierPassword = "BackgroundCourier123!";
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
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    await waitForServer(baseUrl);
    const loginResponse = await fetch(`${baseUrl}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: adminUsername, password: adminPassword }),
    });
    const adminAuth = await loginResponse.json();
    assert.equal(loginResponse.status, 200, adminAuth.error);

    const createCourierResponse = await fetch(`${baseUrl}/api/admin/couriers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminAuth.token}` },
      body: JSON.stringify({
        name: "Arka Plan Kuryesi",
        username: courierUsername,
        password: courierPassword,
        zone: "Akdeniz",
        latitude: 36.78915,
        longitude: 34.59786,
        available: true,
      }),
    });
    const courierState = await createCourierResponse.json();
    assert.equal(createCourierResponse.status, 201, courierState.error);
    const courierId = courierState.createdCourier.id;

    const now = new Date();
    const stamp = now.toISOString();
    const staleStamp = new Date(now.getTime() - 35 * 60_000).toISOString();
    const db = new DatabaseSync(dbFile);
    db.exec("PRAGMA busy_timeout = 10000");
    db.prepare("UPDATE couriers SET last_location_at = ? WHERE id = ?").run(staleStamp, courierId);
    db.prepare(`
      INSERT INTO restaurants (id, name, zone, x, y, platforms_json, api_key, webhook_secret, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("rst_background_recovery", "Arka Plan Restoranı", "Akdeniz", 36.78915, 34.59786, "[]", "background-api", "background-secret", stamp);
    db.prepare(`
      INSERT INTO packages (
        id, tracking_no, restaurant_id, source, source_platform, external_order_no,
        recipient, phone, address, customer_lat, customer_lng, zone, eta,
        payment_method, order_amount, x, y, note, status, assignment_status,
        assignment_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "pkg_background_recovery", "PKT-BACKGROUND", "rst_background_recovery", "restaurant_panel", "Manuel", "BACKGROUND-1",
      "Arka Plan Müşterisi", "05320000000", "Test adresi", 36.7892, 34.5979, "Akdeniz", "15 dk",
      "Online Odeme", 100, 36.7892, 34.5979, "Background recovery", "awaiting_assignment", "pending",
      "Konumu eski kurye bekleniyor.", stamp, stamp
    );
    db.close();

    const courierLoginResponse = await fetch(`${baseUrl}/api/courier/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: courierUsername, password: courierPassword }),
    });
    const courierAuth = await courierLoginResponse.json();
    assert.equal(courierLoginResponse.status, 200, courierAuth.error);

    const availabilityResponse = await fetch(`${baseUrl}/api/admin/couriers/${courierId}/availability`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminAuth.token}` },
      body: JSON.stringify({ available: true }),
    });
    assert.equal(availabilityResponse.status, 200, await availabilityResponse.text());

    const assigned = await waitForCourierAssignment(dbFile, "pkg_background_recovery");
    assert.equal(assigned.assigned_courier_id, courierId);
    assert.equal(assigned.status, "assigned");
    assert.match(assigned.assignment_reason, /kayitli konum/i);

    const operationMapResponse = await fetch(`${baseUrl}/api/admin/operation-map`, {
      headers: { Authorization: `Bearer ${adminAuth.token}` },
    });
    const operationMap = await operationMapResponse.json();
    assert.equal(operationMapResponse.status, 200, operationMap.error);
    const mappedCourier = operationMap.activeCouriers.find((courier) => courier.id === courierId);
    assert.ok(mappedCourier, "Open-shift courier disappeared from the admin map in browser background.");
    assert.equal(mappedCourier.locationFresh, false);
    assert.equal(mappedCourier.locationSource, "last_known");

    const heartbeatResponse = await fetch(`${baseUrl}/api/courier/location`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${courierAuth.token}` },
      body: JSON.stringify({ latitude: 36.78915, longitude: 34.59786, available: true, locationOnly: true }),
    });
    assert.equal(heartbeatResponse.status, 200, await heartbeatResponse.text());
  } finally {
    await stopServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
