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
  throw new Error("Admin accepted reassignment test server did not start in time.");
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.error || `${options.method || "GET"} ${pathname} failed.`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
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

test("admin can move a courier-accepted package but cannot take an on-route package back", { timeout: 30000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivera-admin-accepted-reassign-"));
  const dbFile = path.join(tempDir, "delivera.sqlite");
  const port = 45000 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const adminUsername = `move_admin_${Date.now()}`;
  const adminPassword = "CapacityAdmin123!";
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
      DELIVERA_COURIER_REJECTION_COOLDOWN_MS: "0",
      DELIVERA_PACKAGE_REJECTION_COOLDOWN_MS: "0",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    await waitForServer(baseUrl);
    const stamp = new Date().toISOString();
    const db = new DatabaseSync(dbFile);
    try {
      assert.equal(db.prepare("SELECT username FROM admins LIMIT 1").get()?.username, adminUsername);
      db.prepare(`
        INSERT INTO restaurants (id, name, zone, x, y, platforms_json, api_key, webhook_secret, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run("rst_admin_move", "Admin Move Restaurant", "Erdemli", 36.6, 34.3, "[]", "move-api", "move-secret", stamp);
      const insertCourier = db.prepare(`
        INSERT INTO couriers (id, name, zone, x, y, available, status, last_location_at, username, password_hash, password_salt, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertCourier.run("cr_admin_old", "Old Courier", "Erdemli", 36.6, 34.3, 1, "busy", stamp, "old_courier", "unused", "unused", stamp);
      insertCourier.run("cr_admin_new", "New Courier", "Erdemli", 36.6002, 34.3002, 1, "online", stamp, "new_courier", "unused", "unused", stamp);
      db.prepare(`
        INSERT INTO packages (
          id, tracking_no, restaurant_id, source, source_platform, external_order_no,
          recipient, phone, address, zone, eta, payment_method, order_amount,
          x, y, note, status, assignment_status, assigned_courier_id, assigned_courier_name,
          assigned_at, accepted_at, assignment_reason, assignment_tried_courier_ids_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "pkg_admin_move", "PKT-ADMIN-MOVE", "rst_admin_move", "restaurant_panel", "Manuel", "ADMIN-MOVE",
        "Move Customer", "5550000000", "Move address", "Erdemli", "15 dk", "Online Odeme", 250,
        36.6, 34.3, "Accepted reassignment test", "accepted_by_courier", "assigned", "cr_admin_old", "Old Courier",
        stamp, stamp, "Courier accepted", '["cr_admin_old"]', stamp, stamp
      );
    } finally {
      db.close();
    }

    const login = await request(baseUrl, "/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ username: adminUsername, password: adminPassword }),
    });
    const headers = { Authorization: `Bearer ${login.token}` };

    const unassigned = await request(baseUrl, "/api/admin/packages/pkg_admin_move/unassign", {
      method: "POST",
      headers,
      body: "{}",
    });
    const automaticallyMoved = unassigned.packages.find((pkg) => pkg.id === "pkg_admin_move");
    assert.equal(automaticallyMoved.assignedCourierId, "cr_admin_new");
    assert.equal(automaticallyMoved.status, "assigned");
    assert.equal(automaticallyMoved.acceptedAt, null);
    assert.deepEqual(automaticallyMoved.assignmentTriedCourierIds, ["cr_admin_old", "cr_admin_new"]);
    assert.equal(unassigned.couriers.find((courier) => courier.id === "cr_admin_old")?.status, "online");

    const acceptedDb = new DatabaseSync(dbFile);
    acceptedDb.prepare(`
      UPDATE packages
      SET status = 'accepted_by_courier', assignment_status = 'assigned', accepted_at = ?, updated_at = ?
      WHERE id = ?
    `).run(stamp, stamp, "pkg_admin_move");
    acceptedDb.close();

    const movedBack = await request(baseUrl, "/api/admin/packages/pkg_admin_move/override", {
      method: "POST",
      headers,
      body: JSON.stringify({ courierId: "cr_admin_old" }),
    });
    const reassigned = movedBack.packages.find((pkg) => pkg.id === "pkg_admin_move");
    assert.equal(reassigned.assignedCourierId, "cr_admin_old");
    assert.equal(reassigned.status, "assigned");
    assert.equal(reassigned.acceptedAt, null);
    assert.equal(movedBack.couriers.find((courier) => courier.id === "cr_admin_new")?.status, "online");

    const verificationDb = new DatabaseSync(dbFile);
    verificationDb.prepare(`
      UPDATE packages
      SET status = 'on_route', assignment_status = 'assigned', accepted_at = ?, on_route_at = ?, updated_at = ?
      WHERE id = ?
    `).run(stamp, stamp, stamp, "pkg_admin_move");
    verificationDb.close();

    await assert.rejects(
      () => request(baseUrl, "/api/admin/packages/pkg_admin_move/unassign", {
        method: "POST",
        headers,
        body: "{}",
      }),
      (error) => error.status === 400 && /atamasi kaldirilamaz/.test(error.body.error)
    );
  } finally {
    await stopServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
