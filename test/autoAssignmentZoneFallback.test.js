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

async function waitForNoAssignment(dbFile, packageId, timeoutMs = 1500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    const row = db.prepare("SELECT * FROM packages WHERE id = ?").get(packageId);
    db.close();
    assert.equal(row?.assigned_courier_id, null);
    await delay(100);
  }
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const row = db.prepare("SELECT * FROM packages WHERE id = ?").get(packageId);
  db.close();
  return row;
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
  throw new Error("Zone fallback test server did not start in time.");
}

async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  await new Promise((resolve) => {
    server.once("exit", resolve);
    server.kill();
    setTimeout(resolve, 2000).unref();
  });
}

test("automatic assignment never uses a same-zone courier beyond the 8 km hard limit", { timeout: 20000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivera-zone-fallback-"));
  const dbFile = path.join(tempDir, "delivera.sqlite");
  const port = 43000 + Math.floor(Math.random() * 1000);
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
    `).run("rst_zone_fallback", "Zone Fallback Restaurant", "Akdeniz", 51.5, -0.12, "[]", "zone-api-key", "zone-secret", stamp);
    db.prepare(`
      INSERT INTO couriers (id, name, zone, x, y, available, status, username, password_hash, password_salt, last_location_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("cr_zone_fallback", "Zone Fallback Courier", "Akdeniz", 36.78914, 34.59782, 1, "online", "zone_courier", "unused", "unused", stamp, stamp);
    db.prepare(`
      INSERT INTO packages (
        id, tracking_no, restaurant_id, source, source_platform, external_order_no,
        recipient, phone, address, zone, eta, payment_method, order_amount,
        x, y, note, status, assignment_status, assignment_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "pkg_zone_fallback", "PKT-ZONE-FALLBACK", "rst_zone_fallback", "restaurant_panel", "Manuel", "ZONE-1",
      "Zone Customer", "5550000000", "-", "Akdeniz", "15 dk", "Online Odeme", 100,
      51.5, -0.12, "Zone fallback test", "awaiting_assignment", "pending", "Test setup", stamp, stamp
    );
    db.close();

    const waiting = await waitForNoAssignment(dbFile, "pkg_zone_fallback");
    assert.equal(waiting.status, "awaiting_assignment");
    assert.equal(waiting.assignment_status, "pending");
    assert.match(waiting.last_assignment_error, /mesafe disi/);
    assert.match(waiting.assignment_reason, /8 km icinde kurye yok/);
  } finally {
    await stopServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
