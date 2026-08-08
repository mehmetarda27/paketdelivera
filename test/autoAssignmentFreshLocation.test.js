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
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error("Fresh location test server did not start in time.");
}

async function waitForAssignment(dbFile, packageId, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    const row = db.prepare("SELECT * FROM packages WHERE id = ?").get(packageId);
    db.close();
    if (row?.assigned_courier_id) return row;
    await delay(100);
  }
  throw new Error("Package was not assigned using fresh courier GPS.");
}

async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  await new Promise((resolve) => {
    server.once("exit", resolve);
    server.kill();
    setTimeout(resolve, 2000).unref();
  });
}

test("automatic assignment requires fresh GPS and uses distance regardless of courier zone", { timeout: 20000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivera-fresh-location-"));
  const dbFile = path.join(tempDir, "delivera.sqlite");
  const port = 45000 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
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
      DELIVERA_ASSIGNMENT_RETRY_MS: "150",
      DELIVERA_COURIER_OFFER_TIMEOUT_MS: "60000",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    await waitForServer(baseUrl);
    const now = new Date();
    const stamp = now.toISOString();
    const staleStamp = new Date(now.getTime() - 35 * 60_000).toISOString();
    const historicalPackageStamp = new Date(now.getTime() - 48 * 60 * 60_000).toISOString();
    const db = new DatabaseSync(dbFile);
    db.prepare(`
      INSERT INTO restaurants (id, name, zone, x, y, platforms_json, api_key, webhook_secret, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("rst_fresh_location", "Fresh Location Restaurant", "Akdeniz", 36.78915, 34.59786, "[]", "fresh-api", "fresh-secret", stamp);

    const insertCourier = db.prepare(`
      INSERT INTO couriers (id, name, zone, x, y, available, status, username, password_hash, password_salt, last_location_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertCourier.run("cr_stale_closer", "Stale Closer Courier", "Akdeniz", 36.78915, 34.59786, 1, "online", "stale_closer", "unused", "unused", staleStamp, stamp);
    insertCourier.run("cr_wrong_zone", "Wrong Zone Courier", "Mezitli", 36.78915, 34.59786, 1, "online", "wrong_zone", "unused", "unused", stamp, stamp);
    insertCourier.run("cr_fresh_near", "Fresh Nearby Courier", "Akdeniz", 36.78935, 34.59786, 1, "online", "fresh_near", "unused", "unused", stamp, stamp);

    db.prepare(`
      INSERT INTO packages (
        id, tracking_no, restaurant_id, source, source_platform, external_order_no,
        recipient, phone, address, zone, eta, payment_method, order_amount,
        x, y, note, status, assignment_status, assignment_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "pkg_fresh_location", "PKT-FRESH-LOCATION", "rst_fresh_location", "restaurant_panel", "Manuel", "FRESH-1",
      "Fresh Customer", "5550000000", "Test address", "Akdeniz", "15 dk", "Online Odeme", 100,
      51.5, -0.12, "Old package coordinate snapshot", "awaiting_assignment", "pending", "Test setup", stamp, stamp
    );
    db.prepare(`
      INSERT INTO packages (
        id, tracking_no, restaurant_id, source, source_platform, external_order_no,
        recipient, phone, address, zone, eta, payment_method, order_amount,
        x, y, note, status, assignment_status, assignment_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "pkg_historical_waiting", "PKT-HISTORICAL-WAITING", "rst_fresh_location", "restaurant_panel", "Manuel", "OLD-1",
      "Historical Customer", "5550000001", "Old test address", "Akdeniz", "15 dk", "Online Odeme", 100,
      36.78915, 34.59786, "Must not be revived", "awaiting_assignment", "pending", "Historical setup",
      historicalPackageStamp, historicalPackageStamp
    );
    db.close();

    const assigned = await waitForAssignment(dbFile, "pkg_fresh_location");
    assert.equal(assigned.assigned_courier_id, "cr_wrong_zone");
    assert.ok(Number(assigned.distance_km) < 0.1);
    assert.equal(assigned.last_assignment_error, "");
    const verificationDb = new DatabaseSync(dbFile, { readOnly: true });
    const historical = verificationDb.prepare("SELECT * FROM packages WHERE id = ?").get("pkg_historical_waiting");
    verificationDb.close();
    assert.equal(historical.assigned_courier_id, null);
    assert.equal(historical.status, "awaiting_assignment");
  } finally {
    await stopServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
