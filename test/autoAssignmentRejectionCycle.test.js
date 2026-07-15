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
  throw new Error("Rejection cycle test server did not start in time.");
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
  throw new Error(`Package was not assigned to ${courierId}.`);
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

test("automatic assignment expands 5-6-7-8 km in nearest order and restarts after all reject", { timeout: 20000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivera-rejection-cycle-"));
  const dbFile = path.join(tempDir, "delivera.sqlite");
  const port = 44000 + Math.floor(Math.random() * 1000);
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
      DELIVERA_COURIER_REJECT_REOFFER_COOLDOWN_MS: "0",
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
    `).run("rst_reject_cycle", "Reject Cycle Restaurant", "Akdeniz", 36.7891, 34.5978, "[]", "reject-api", "reject-secret", stamp);

    const insertCourier = db.prepare(`
      INSERT INTO couriers (id, name, zone, x, y, available, status, username, password_hash, password_salt, last_location_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertCourier.run("cr_reject_a", "A Courier", "Akdeniz", 36.82957, 34.5978, 1, "online", "reject_a", "unused", "unused", stamp, stamp);
    insertCourier.run("cr_reject_b", "B Courier", "Akdeniz", 36.83856, 34.5978, 1, "online", "reject_b", "unused", "unused", stamp, stamp);
    insertCourier.run("cr_reject_c", "C Courier", "Akdeniz", 36.84755, 34.5978, 1, "online", "reject_c", "unused", "unused", stamp, stamp);
    insertCourier.run("cr_reject_d", "D Courier", "Akdeniz", 36.85654, 34.5978, 1, "online", "reject_d", "unused", "unused", stamp, stamp);
    db.prepare("INSERT INTO courier_sessions (token, courier_id, created_at) VALUES (?, ?, ?)").run("token-reject-a", "cr_reject_a", stamp);
    db.prepare("INSERT INTO courier_sessions (token, courier_id, created_at) VALUES (?, ?, ?)").run("token-reject-b", "cr_reject_b", stamp);
    db.prepare("INSERT INTO courier_sessions (token, courier_id, created_at) VALUES (?, ?, ?)").run("token-reject-c", "cr_reject_c", stamp);
    db.prepare("INSERT INTO courier_sessions (token, courier_id, created_at) VALUES (?, ?, ?)").run("token-reject-d", "cr_reject_d", stamp);
    db.prepare(`
      INSERT INTO packages (
        id, tracking_no, restaurant_id, source, source_platform, external_order_no,
        recipient, phone, address, zone, eta, payment_method, order_amount,
        x, y, note, status, assignment_status, assignment_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "pkg_reject_cycle", "PKT-REJECT-CYCLE", "rst_reject_cycle", "restaurant_panel", "Manuel", "REJECT-CYCLE-1",
      "Reject Customer", "5550000000", "Test address", "Akdeniz", "15 dk", "Online Odeme", 100,
      36.7891, 34.5978, "Reject cycle test", "awaiting_assignment", "pending", "Test setup", stamp, stamp
    );
    db.close();

    const firstOffer = await waitForCourier(dbFile, "pkg_reject_cycle", "cr_reject_a");
    assert.ok(Number(firstOffer.distance_km) <= 5);
    assert.match(firstOffer.assignment_reason, /5 km arama capinda/);
    await rejectPackage(baseUrl, "pkg_reject_cycle", "token-reject-a");
    const secondOffer = await waitForCourier(dbFile, "pkg_reject_cycle", "cr_reject_b");
    assert.ok(Number(secondOffer.distance_km) > 5 && Number(secondOffer.distance_km) <= 6);
    assert.match(secondOffer.assignment_reason, /6 km arama capinda/);
    await rejectPackage(baseUrl, "pkg_reject_cycle", "token-reject-b");
    const thirdOffer = await waitForCourier(dbFile, "pkg_reject_cycle", "cr_reject_c");
    assert.ok(Number(thirdOffer.distance_km) > 6 && Number(thirdOffer.distance_km) <= 7);
    assert.match(thirdOffer.assignment_reason, /7 km arama capinda/);
    await rejectPackage(baseUrl, "pkg_reject_cycle", "token-reject-c");
    const fourthOffer = await waitForCourier(dbFile, "pkg_reject_cycle", "cr_reject_d");
    assert.ok(Number(fourthOffer.distance_km) > 7 && Number(fourthOffer.distance_km) <= 8);
    assert.match(fourthOffer.assignment_reason, /8 km arama capinda/);
    await rejectPackage(baseUrl, "pkg_reject_cycle", "token-reject-d");
    const restarted = await waitForCourier(dbFile, "pkg_reject_cycle", "cr_reject_a");

    assert.equal(restarted.status, "assigned");
    assert.deepEqual(JSON.parse(restarted.assignment_tried_courier_ids_json), ["cr_reject_a"]);
    assert.equal(restarted.last_assignment_error, "");
  } finally {
    await stopServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
