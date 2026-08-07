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
  throw new Error("Fairness test server did not start in time.");
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
  throw new Error("Fairness package was not assigned.");
}

async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  await new Promise((resolve) => {
    server.once("exit", resolve);
    server.kill();
    setTimeout(resolve, 2000).unref();
  });
}

test("automatic assignment balances today's work between similarly close couriers", { timeout: 20000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivera-assignment-fairness-"));
  const dbFile = path.join(tempDir, "delivera.sqlite");
  const port = 46000 + Math.floor(Math.random() * 1000);
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
    `).run("rst_fair", "Fair Restaurant", "Akdeniz", 36.7891, 34.5978, "[]", "fair-api", "fair-secret", stamp);
    const insertCourier = db.prepare(`
      INSERT INTO couriers (id, name, zone, x, y, available, status, username, password_hash, password_salt, last_location_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertCourier.run("cr_overworked", "A Overworked Courier", "Akdeniz", 36.7891, 34.5978, 1, "online", "overworked", "unused", "unused", stamp, stamp);
    insertCourier.run("cr_resting", "Z Resting Courier", "Akdeniz", 36.7910, 34.5978, 1, "online", "resting", "unused", "unused", stamp, stamp);

    const insertPackage = db.prepare(`
      INSERT INTO packages (
        id, tracking_no, restaurant_id, source, source_platform, external_order_no,
        recipient, phone, address, zone, eta, payment_method, order_amount, x, y, note,
        status, assignment_status, assigned_courier_id, assigned_courier_name, assigned_at,
        delivered_at, assignment_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (let index = 0; index < 3; index += 1) {
      insertPackage.run(
        `pkg_fair_history_${index}`, `PKT-FAIR-HISTORY-${index}`, "rst_fair", "restaurant_panel", "Manuel", `FAIR-HISTORY-${index}`,
        "History Customer", "5550000000", "History address", "Akdeniz", "15 dk", "Online Odeme", 100,
        36.7891, 34.5978, "Completed fairness history", "delivered", "assigned", "cr_overworked", "A Overworked Courier",
        stamp, stamp, "Test history", stamp, stamp
      );
    }
    insertPackage.run(
      "pkg_fair_target", "PKT-FAIR-TARGET", "rst_fair", "restaurant_panel", "Manuel", "FAIR-TARGET",
      "Target Customer", "5550000001", "Target address", "Akdeniz", "15 dk", "Online Odeme", 100,
      36.7891, 34.5978, "Fairness target", "awaiting_assignment", "pending", null, null, null,
      null, "Test setup", stamp, stamp
    );
    db.close();

    const assigned = await waitForAssignment(dbFile, "pkg_fair_target");
    assert.equal(assigned.assigned_courier_id, "cr_resting");
    assert.notEqual(assigned.assigned_courier_name, "A Overworked Courier");
  } finally {
    await stopServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
