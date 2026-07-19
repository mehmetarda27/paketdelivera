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
  throw new Error("Courier issue reporting test server did not start in time.");
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
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

test("courier issue cancellation keeps its reason and earns one package fee", { timeout: 30000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivera-courier-issue-"));
  const dbFile = path.join(tempDir, "delivera.sqlite");
  const port = 47000 + Math.floor(Math.random() * 1000);
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
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    await waitForServer(baseUrl);
    const stamp = new Date().toISOString();
    const reportDate = stamp.slice(0, 10);
    const db = new DatabaseSync(dbFile);
    db.prepare(`
      INSERT INTO restaurants (id, name, zone, x, y, platforms_json, api_key, webhook_secret, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("rst_issue", "Issue Restaurant", "Akdeniz", 36.7891, 34.5978, "[]", "issue-api", "issue-secret", stamp);
    db.prepare(`
      INSERT INTO couriers (id, name, zone, x, y, available, status, username, password_hash, password_salt, per_package_fee, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("cr_issue", "Issue Courier", "Akdeniz", 36.7892, 34.5979, 1, "busy", "issue", "unused", "unused", 40, stamp);
    db.prepare("INSERT INTO courier_sessions (token, courier_id, created_at) VALUES (?, ?, ?)")
      .run("token-issue", "cr_issue", stamp);
    db.prepare(`
      INSERT INTO admins (id, username, password_hash, password_salt, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run("adm_issue", "issue-admin", "unused", "unused", stamp);
    db.prepare("INSERT INTO admin_sessions (token, admin_id, created_at) VALUES (?, ?, ?)")
      .run("token-admin-issue", "adm_issue", stamp);

    const insertPackage = db.prepare(`
      INSERT INTO packages (
        id, tracking_no, restaurant_id, source, source_platform, external_order_no,
        recipient, phone, address, zone, eta, payment_method, order_amount,
        x, y, note, status, assignment_status, assigned_courier_id, assigned_courier_name,
        assigned_at, accepted_at, on_route_at, assignment_reason, failure_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertPackage.run(
      "pkg_issue", "PKT-ISSUE", "rst_issue", "restaurant_panel", "Manuel", "ISSUE-1",
      "Issue Customer", "5550000000", "Issue address", "Akdeniz", "15 dk", "Online Odeme", 200,
      36.7891, 34.5978, "Issue test", "on_route", "assigned", "cr_issue", "Issue Courier",
      stamp, stamp, stamp, "Test assignment", null, stamp, stamp
    );
    insertPackage.run(
      "pkg_platform_cancel", "PKT-PLATFORM-CANCEL", "rst_issue", "platform_webhook", "Yemeksepeti", "PLATFORM-CANCEL-1",
      "Platform Customer", "5550000001", "Platform address", "Akdeniz", "15 dk", "Online Odeme", 100,
      36.7891, 34.5978, "Platform cancellation", "cancelled", "cancelled", "cr_issue", "Issue Courier",
      stamp, stamp, stamp, "Platform cancellation", "Platform iptal bildirimi.", stamp, stamp
    );
    db.close();

    const workspace = await request(baseUrl, "/api/courier/packages/pkg_issue/status", {
      method: "PATCH",
      headers: { Authorization: "Bearer token-issue" },
      body: JSON.stringify({ status: "failed", failureReason: "adres_bulunamadi" }),
    });
    const cancelled = workspace.historyPackages.find((pkg) => pkg.id === "pkg_issue");
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.failureReason, "adres_bulunamadi");
    assert.equal(cancelled.assignedCourierId, "cr_issue");

    const orders = await request(baseUrl, "/api/admin/orders?search=PKT-ISSUE", {
      headers: { Authorization: "Bearer token-admin-issue" },
    });
    assert.equal(orders.orders[0].status, "cancelled");
    assert.equal(orders.orders[0].failureReason, "adres_bulunamadi");

    const generated = await request(baseUrl, "/api/admin/courier-earnings/generate", {
      method: "POST",
      headers: { Authorization: "Bearer token-admin-issue" },
      body: JSON.stringify({ date: reportDate, courierId: "cr_issue" }),
    });
    const earning = generated.courierEarnings[0];
    assert.equal(earning.deliveredPackageCount, 1);
    assert.equal(earning.totalPayable, 40);
    assert.equal(earning.items.length, 1);
    assert.equal(earning.items[0].packageId, "pkg_issue");
    assert.equal(earning.items[0].package.failureReason, "adres_bulunamadi");
  } finally {
    await stopServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
