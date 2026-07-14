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
    await delay(100);
  }
  throw new Error("Admin capacity test server did not start in time.");
}

async function request(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.error || `Request failed with ${response.status}`);
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

test("only admin manual override can give a courier a second active package", { timeout: 20000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivera-admin-capacity-"));
  const dbFile = path.join(tempDir, "delivera.sqlite");
  const port = 39000 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const adminUsername = `capacity_admin_${Date.now()}`;
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
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    await waitForServer(baseUrl);
    const stamp = new Date().toISOString();
    const db = new DatabaseSync(dbFile);
    try {
      db.prepare(`
        INSERT INTO restaurants (id, name, zone, x, y, platforms_json, api_key, webhook_secret, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run("rst_capacity", "Capacity Restaurant", "Erdemli", 36.6, 34.3, "[]", "capacity-api-key", "capacity-webhook", stamp);
      db.prepare(`
        INSERT INTO couriers (id, name, zone, x, y, available, status, username, password_hash, password_salt, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run("cr_capacity", "Capacity Courier", "Erdemli", 36.6, 34.3, 1, "online", "capacity_courier", "unused", "unused", stamp);
      const insertPackage = db.prepare(`
        INSERT INTO packages (
          id, tracking_no, restaurant_id, source, source_platform, external_order_no,
          recipient, phone, address, zone, eta, payment_method, order_amount,
          x, y, note, status, assignment_status, assignment_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (let index = 1; index <= 3; index += 1) {
        insertPackage.run(
          `pkg_capacity_${index}`,
          `PKT-CAPACITY-${index}`,
          "rst_capacity",
          "restaurant_panel",
          "Manuel",
          `CAPACITY-${index}`,
          `Capacity Customer ${index}`,
          `555000000${index}`,
          `Capacity address ${index}`,
          "Erdemli",
          "15 dk",
          "Online Odeme",
          100 + index,
          36.6,
          34.3,
          "Admin manual capacity test",
          "awaiting_assignment",
          "pending",
          "Test setup",
          stamp,
          stamp
        );
      }
    } finally {
      db.close();
    }

    const login = await request(baseUrl, "/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ username: adminUsername, password: adminPassword }),
    });
    const headers = { Authorization: `Bearer ${login.token}` };

    await request(baseUrl, "/api/admin/packages/pkg_capacity_1/override", {
      method: "POST",
      headers,
      body: JSON.stringify({ courierId: "cr_capacity" }),
    });
    const secondAssignment = await request(baseUrl, "/api/admin/packages/pkg_capacity_2/override", {
      method: "POST",
      headers,
      body: JSON.stringify({ courierId: "cr_capacity" }),
    });
    assert.equal(secondAssignment.couriers.find((courier) => courier.id === "cr_capacity")?.activeLoad, 2);

    await assert.rejects(
      () => request(baseUrl, "/api/admin/packages/pkg_capacity_3/override", {
        method: "POST",
        headers,
        body: JSON.stringify({ courierId: "cr_capacity" }),
      }),
      (error) => error.status === 400 && /manuel atama limitine ulasti \(2 aktif paket\)/.test(error.body.error)
    );

    const verificationDb = new DatabaseSync(dbFile, { readOnly: true });
    try {
      assert.equal(
        verificationDb.prepare("SELECT COUNT(*) AS count FROM packages WHERE assigned_courier_id = ? AND status = 'assigned'").get("cr_capacity").count,
        2
      );
      assert.equal(
        verificationDb.prepare("SELECT assigned_courier_id FROM packages WHERE id = ?").get("pkg_capacity_3").assigned_courier_id,
        null
      );
    } finally {
      verificationDb.close();
    }
  } finally {
    await stopServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
