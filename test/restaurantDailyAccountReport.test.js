const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.unref();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const { port } = listener.address();
      listener.close(() => resolve(port));
    });
  });
}

async function waitForServer(baseUrl) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/api/bootstrap`)).ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error("Daily account report test server did not start.");
}

async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  await new Promise((resolve) => {
    server.once("exit", resolve);
    server.kill();
    setTimeout(resolve, 2000).unref();
  });
}

test("restaurant account report uses Istanbul midnight and exposes cancellation/payment filters", { timeout: 30000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivera-restaurant-daily-report-"));
  const dbFile = path.join(tempDir, "delivera.sqlite");
  const port = await freePort();
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
      DELIVERA_ADMIN_USERNAME: "report-admin",
      DELIVERA_ADMIN_PASSWORD: "ReportAdmin123!",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => process.stdout.write(chunk));
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    await waitForServer(baseUrl);
    const db = new DatabaseSync(dbFile);
    db.exec("PRAGMA busy_timeout = 10000");
    db.prepare("INSERT INTO restaurants (id, name, zone, x, y, platforms_json, api_key, webhook_secret, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("rst_daily_report", "Günlük Rapor Restoranı", "Akdeniz", 36.8, 34.6, "[]", "daily-report-key", "daily-report-secret", "2026-08-11T12:00:00.000Z");
    const insertPackage = db.prepare(`
      INSERT INTO packages (
        id, tracking_no, restaurant_id, source, source_platform, external_order_no,
        recipient, phone, address, zone, eta, payment_method, order_amount, payment_status,
        x, y, note, status, assignment_status, delivered_at, failed_at,
        assignment_reason, created_at, updated_at
      ) VALUES (?, ?, 'rst_daily_report', 'restaurant_panel', 'Telefon', ?, 'Müşteri', '05310000000', 'Test adresi', 'Akdeniz', '20 dk', ?, ?, ?, 36.8, 34.6, '', ?, ?, ?, ?, 'test', ?, ?)
    `);
    insertPackage.run("pkg_before_midnight", "PKT-BEFORE", "BEFORE", "cash_on_delivery", 100, "cash_collected", "delivered", "delivered", "2026-08-11T20:59:00.000Z", null, "2026-08-11T20:59:00.000Z", "2026-08-11T20:59:00.000Z");
    insertPackage.run("pkg_after_midnight_cash", "PKT-AFTER-CASH", "AFTER-CASH", "cash_on_delivery", 250, "cash_collected", "delivered", "delivered", "2026-08-11T21:01:00.000Z", null, "2026-08-11T21:01:00.000Z", "2026-08-11T21:01:00.000Z");
    insertPackage.run("pkg_after_midnight_cancel", "PKT-AFTER-CANCEL", "AFTER-CANCEL", "paid_online", 125, "paid_online", "cancelled", "cancelled", null, "2026-08-11T21:02:00.000Z", "2026-08-11T21:02:00.000Z", "2026-08-11T21:02:00.000Z");
    db.close();

    const loginResponse = await fetch(`${baseUrl}/api/restaurant/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ restaurantId: "rst_daily_report", apiKey: "daily-report-key" }),
    });
    const login = await loginResponse.json();
    assert.equal(loginResponse.status, 200, login.error);
    const headers = { Authorization: `Bearer ${login.token}` };

    const reportResponse = await fetch(`${baseUrl}/api/restaurant/reports/account?date=2026-08-12`, { headers });
    const report = await reportResponse.json();
    assert.equal(reportResponse.status, 200, report.error);
    assert.equal(report.timezone, "Europe/Istanbul");
    assert.equal(report.summary.totalOrders, 2);
    assert.equal(report.summary.deliveredCount, 1);
    assert.equal(report.summary.cancelledCount, 1);
    assert.equal(report.summary.cashCount, 1);
    assert.equal(report.summary.cashAmount, 250);
    assert.equal(report.summary.cancelledAmount, 125);
    assert.deepEqual(report.packages.map((pkg) => pkg.id).sort(), ["pkg_after_midnight_cancel", "pkg_after_midnight_cash"]);

    const cancelledResponse = await fetch(`${baseUrl}/api/restaurant/reports/account?date=2026-08-12&status=cancelled`, { headers });
    const cancelled = await cancelledResponse.json();
    assert.equal(cancelledResponse.status, 200, cancelled.error);
    assert.deepEqual(cancelled.packages.map((pkg) => pkg.id), ["pkg_after_midnight_cancel"]);

    const previousDayResponse = await fetch(`${baseUrl}/api/restaurant/reports/account?date=2026-08-11`, { headers });
    const previousDay = await previousDayResponse.json();
    assert.equal(previousDayResponse.status, 200, previousDay.error);
    assert.deepEqual(previousDay.packages.map((pkg) => pkg.id), ["pkg_before_midnight"]);

    const weeklyResponse = await fetch(`${baseUrl}/api/restaurant/reports/account?date=2026-08-12&period=week`, { headers });
    const weekly = await weeklyResponse.json();
    assert.equal(weeklyResponse.status, 200, weekly.error);
    assert.equal(weekly.period, "week");
    assert.equal(weekly.rangeStart, "2026-08-10");
    assert.equal(weekly.rangeEnd, "2026-08-16");
    assert.equal(weekly.summary.totalOrders, 3);
    assert.equal(weekly.summary.deliveredCount, 2);
    assert.equal(weekly.summary.cancelledCount, 1);

    const adminLoginResponse = await fetch(`${baseUrl}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "report-admin", password: "ReportAdmin123!" }),
    });
    const adminLogin = await adminLoginResponse.json();
    assert.equal(adminLoginResponse.status, 200, adminLogin.error);
    const adminReportResponse = await fetch(`${baseUrl}/api/admin/reports/account?date=2026-08-12&period=week`, {
      headers: { Authorization: `Bearer ${adminLogin.token}` },
    });
    const adminReport = await adminReportResponse.json();
    assert.equal(adminReportResponse.status, 200, adminReport.error);
    assert.equal(adminReport.summary.totalOrders, 3);
    assert.deepEqual(new Set(adminReport.packages.map((pkg) => pkg.restaurantName)), new Set(["Günlük Rapor Restoranı"]));
  } finally {
    await stopServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
