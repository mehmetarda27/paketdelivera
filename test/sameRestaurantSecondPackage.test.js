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
  throw new Error("Same restaurant capacity test server did not start in time.");
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json();
  assert.equal(response.ok, true, body.error || `${options.method || "GET"} ${pathname} failed.`);
  return body;
}

async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  await new Promise((resolve) => {
    server.once("exit", resolve);
    server.kill();
    setTimeout(resolve, 2000).unref();
  });
}

async function waitForAssignedCourier(dbFile, packageId, courierId, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    const row = db.prepare("SELECT status, assigned_courier_id FROM packages WHERE id = ?").get(packageId);
    db.close();
    if (row?.status === "assigned" && row.assigned_courier_id === courierId) return row;
    await delay(50);
  }
  throw new Error(`Package ${packageId} was not assigned to ${courierId}.`);
}

test("automatic assignment prefers a free courier before batching a second package and direction conflict returns it to the pool", { timeout: 30000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivera-same-restaurant-second-"));
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
      DELIVERA_ASSIGNMENT_RETRY_MS: "60000",
      DELIVERA_COURIER_OFFER_TIMEOUT_MS: "60000",
      DELIVERA_COURIER_REJECTION_COOLDOWN_MS: "0",
      DELIVERA_PACKAGE_REJECTION_COOLDOWN_MS: "100",
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
    `).run("rst_batch", "Batch Restaurant", "Erdemli", 36.6, 34.3, "[]", "batch-api", "batch-secret", stamp);
    db.prepare(`
      INSERT INTO couriers (id, name, zone, x, y, available, status, last_location_at, username, password_hash, password_salt, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("cr_batch_1", "Batch Courier One", "Erdemli", 36.6, 34.3, 1, "busy", stamp, "batch_one", "unused", "unused", stamp);
    db.prepare(`
      INSERT INTO couriers (id, name, zone, x, y, available, status, last_location_at, username, password_hash, password_salt, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("cr_batch_2", "Batch Courier Two", "Erdemli", 36.6002, 34.3002, 1, "online", stamp, "batch_two", "unused", "unused", stamp);
    db.prepare("INSERT INTO restaurant_sessions (token, restaurant_id, created_at) VALUES (?, ?, ?)")
      .run("token-batch-restaurant", "rst_batch", stamp);
    db.prepare("INSERT INTO courier_sessions (token, courier_id, created_at) VALUES (?, ?, ?)")
      .run("token-batch-one", "cr_batch_1", stamp);
    db.prepare("INSERT INTO courier_sessions (token, courier_id, created_at) VALUES (?, ?, ?)")
      .run("token-batch-two", "cr_batch_2", stamp);
    db.prepare(`
      INSERT INTO packages (
        id, tracking_no, restaurant_id, source, source_platform, external_order_no,
        recipient, phone, address, zone, eta, payment_method, payment_status, order_amount,
        x, y, note, status, assignment_status, assigned_courier_id, assigned_courier_name,
        assigned_at, accepted_at, assignment_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "pkg_batch_first", "PKT-BATCH-FIRST", "rst_batch", "restaurant_panel", "Manuel", "BATCH-FIRST",
      "First Customer", "5550000001", "First address", "Erdemli", "15 dk", "Online Odeme", "paid_online", 100,
      36.6, 34.3, "First accepted package", "accepted_by_courier", "assigned", "cr_batch_1", "Batch Courier One",
      stamp, stamp, "Initial accepted assignment", stamp, stamp
    );
    db.close();

    const restaurantHeaders = { Authorization: "Bearer token-batch-restaurant" };
    const packageBody = (customerName) => JSON.stringify({
      deliveryAddress: `${customerName} address Erdemli`,
      packageType: "Test Paket",
      orderAmount: 125,
      customerName,
      phone: "5551112233",
      customerNote: "Same restaurant automatic capacity test",
      paymentMethod: "Online Odeme",
    });

    const secondState = await request(baseUrl, "/packages", {
      method: "POST",
      headers: restaurantHeaders,
      body: packageBody("Second Customer"),
    });
    const secondPackage = secondState.createdPackage;
    assert.equal(secondPackage.assignedCourierId, "cr_batch_2");
    assert.equal(secondPackage.status, "assigned");
    assert.doesNotMatch(secondPackage.assignmentReason, /ayni restorandan ikinci paket/);

    await request(baseUrl, `/api/courier/packages/${secondPackage.id}/status`, {
      method: "PATCH",
      headers: { Authorization: "Bearer token-batch-two" },
      body: JSON.stringify({ status: "accepted_by_courier" }),
    });

    const thirdState = await request(baseUrl, "/packages", {
      method: "POST",
      headers: restaurantHeaders,
      body: packageBody("Third Customer"),
    });
    const thirdPackage = thirdState.createdPackage;
    assert.equal(thirdPackage.assignedCourierId, "cr_batch_1");
    assert.match(thirdPackage.assignmentReason, /ayni restorandan ikinci paket/);

    await request(baseUrl, `/api/courier/packages/${thirdPackage.id}/status`, {
      method: "PATCH",
      headers: { Authorization: "Bearer token-batch-one" },
      body: JSON.stringify({ status: "accepted_by_courier" }),
    });
    const directionWorkspace = await request(baseUrl, `/api/courier/packages/${thirdPackage.id}/status`, {
      method: "PATCH",
      headers: { Authorization: "Bearer token-batch-one" },
      body: JSON.stringify({ status: "failed", failureReason: "ters_yon" }),
    });
    assert.equal(directionWorkspace.packages.some((pkg) => pkg.id === thirdPackage.id), false);

    const verificationDb = new DatabaseSync(dbFile, { readOnly: true });
    const pooled = verificationDb.prepare(`
      SELECT status, assigned_courier_id, accepted_at, on_route_at, failure_reason,
             last_assignment_error, assignment_tried_courier_ids_json
      FROM packages WHERE id = ?
    `).get(thirdPackage.id);
    assert.equal(pooled.status, "awaiting_assignment");
    assert.equal(pooled.assigned_courier_id, null);
    assert.equal(pooled.accepted_at, null);
    assert.equal(pooled.on_route_at, null);
    assert.equal(pooled.failure_reason, null);
    assert.match(pooled.last_assignment_error, /ters yon/);
    assert.deepEqual(JSON.parse(pooled.assignment_tried_courier_ids_json), ["cr_batch_1"]);
    assert.equal(
      verificationDb.prepare("SELECT COUNT(*) AS total FROM audit_logs WHERE action = ? AND package_id = ?").get("courier_package_rejected", thirdPackage.id).total,
      1
    );
    verificationDb.close();

    await waitForAssignedCourier(dbFile, thirdPackage.id, "cr_batch_2");
  } finally {
    await stopServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
