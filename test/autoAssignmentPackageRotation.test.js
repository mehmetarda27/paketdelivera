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
  throw new Error("Package rotation test server did not start in time.");
}

async function waitForCourier(dbFile, packageId, courierId, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    const row = db.prepare("SELECT * FROM packages WHERE id = ?").get(packageId);
    db.close();
    if (row?.assigned_courier_id === courierId) return row;
    await delay(100);
  }
  throw new Error(`${packageId} was not assigned to ${courierId}.`);
}

async function assertPackagesStayUnassigned(dbFile, packageIds, timeoutMs = 1200) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    const rows = packageIds.map((packageId) => db.prepare("SELECT * FROM packages WHERE id = ?").get(packageId));
    db.close();
    rows.forEach((row) => assert.equal(row?.assigned_courier_id, null));
    await delay(100);
  }
}

async function rejectPackage(baseUrl, packageId, token) {
  const response = await fetch(`${baseUrl}/api/courier/packages/${packageId}/reject`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  const body = await response.json();
  assert.equal(response.status, 200, body.error || "Courier rejection failed.");
}

async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  await new Promise((resolve) => {
    server.once("exit", resolve);
    server.kill();
    setTimeout(resolve, 2000).unref();
  });
}

test("rejected package moves behind other waiting packages before returning to the same courier", { timeout: 20000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivera-package-rotation-"));
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
    const stamp = new Date().toISOString();
    const db = new DatabaseSync(dbFile);
    db.prepare(`
      INSERT INTO restaurants (id, name, zone, x, y, platforms_json, api_key, webhook_secret, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("rst_rotation", "Rotation Restaurant", "Akdeniz", 36.7891, 34.5978, "[]", "rotation-api", "rotation-secret", stamp);
    db.prepare(`
      INSERT INTO couriers (id, name, zone, x, y, available, status, username, password_hash, password_salt, last_location_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("cr_rotation", "Rotation Courier", "Akdeniz", 36.7892, 34.5979, 1, "online", "rotation", "unused", "unused", stamp, stamp);
    db.prepare("INSERT INTO courier_sessions (token, courier_id, created_at) VALUES (?, ?, ?)").run("token-rotation", "cr_rotation", stamp);

    const insertPackage = db.prepare(`
      INSERT INTO packages (
        id, tracking_no, restaurant_id, source, source_platform, external_order_no,
        recipient, phone, address, zone, eta, payment_method, order_amount,
        x, y, note, status, assignment_status, assignment_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertPackage.run(
      "pkg_rotation_burger", "PKT-ROTATION-BURGER", "rst_rotation", "restaurant_panel", "Manuel", "ROTATION-BURGER",
      "Burger Customer", "5550000001", "Burger address", "Akdeniz", "15 dk", "Online Odeme", 100,
      36.7891, 34.5978, "Burger package", "awaiting_assignment", "pending", "Test setup", stamp, stamp
    );
    const flashStamp = new Date(Date.now() + 1000).toISOString();
    insertPackage.run(
      "pkg_rotation_flash", "PKT-ROTATION-FLASH", "rst_rotation", "restaurant_panel", "Manuel", "ROTATION-FLASH",
      "Flash Customer", "5550000002", "Flash address", "Akdeniz", "15 dk", "Online Odeme", 100,
      36.7891, 34.5978, "Flash package", "awaiting_assignment", "pending", "Test setup", flashStamp, flashStamp
    );
    db.close();

    await waitForCourier(dbFile, "pkg_rotation_burger", "cr_rotation");
    await rejectPackage(baseUrl, "pkg_rotation_burger", "token-rotation");
    const flashOffer = await waitForCourier(dbFile, "pkg_rotation_flash", "cr_rotation");
    assert.equal(flashOffer.status, "assigned");

    const verificationDb = new DatabaseSync(dbFile, { readOnly: true });
    const rejectedBurger = verificationDb.prepare("SELECT * FROM packages WHERE id = ?").get("pkg_rotation_burger");
    verificationDb.close();
    assert.equal(rejectedBurger.assigned_courier_id, null);
    assert.deepEqual(JSON.parse(rejectedBurger.assignment_tried_courier_ids_json), ["cr_rotation"]);

    await rejectPackage(baseUrl, "pkg_rotation_flash", "token-rotation");
    await assertPackagesStayUnassigned(dbFile, ["pkg_rotation_burger", "pkg_rotation_flash"]);
  } finally {
    await stopServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
