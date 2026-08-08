const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForServer(baseUrl) { const start = Date.now(); while (Date.now() - start < 10000) { try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch {} await delay(100); } throw new Error("Admin package test server did not start."); }
async function stopServer(server) { if (server.exitCode !== null || server.signalCode !== null) return; await new Promise((resolve) => { server.once("exit", resolve); server.kill(); setTimeout(resolve, 2000).unref(); }); }
async function removeTempDir(tempDir) { let lastError; for (let attempt = 0; attempt < 12; attempt += 1) { try { fs.rmSync(tempDir, { recursive: true, force: true }); return; } catch (error) { lastError = error; await delay(250); } } if (process.platform === "win32" && ["EPERM", "EBUSY"].includes(lastError?.code)) return; throw lastError; }

test("admin-created package persists and immediately enters nearest-courier assignment", { timeout: 25000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivera-admin-package-"));
  const dbFile = path.join(tempDir, "delivera.sqlite");
  const port = 48500 + Math.floor(Math.random() * 800);
  const baseUrl = `http://127.0.0.1:${port}`;
  const username = `admin_package_${Date.now()}`;
  const password = "AdminPackage123!";
  const server = spawn(process.execPath, ["server.js"], { cwd: path.join(__dirname, ".."), env: { ...process.env, PORT: String(port), NODE_ENV: "test", DATABASE_URL: "", POSTGRES_URL: "", DATABASE_PATH: dbFile, DB_PATH: dbFile, DELIVERA_DB_FILE: dbFile, DELIVERA_ADMIN_USERNAME: username, DELIVERA_ADMIN_PASSWORD: password, DELIVERA_ASSIGNMENT_RETRY_MS: "60000" }, stdio: ["ignore", "ignore", "pipe"] });
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));
  try {
    await waitForServer(baseUrl);
    const db = new DatabaseSync(dbFile); db.exec("PRAGMA busy_timeout = 10000");
    const stamp = new Date().toISOString();
    db.prepare("INSERT INTO restaurants (id, name, zone, x, y, platforms_json, api_key, webhook_secret, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("rst_admin_package", "Admin Paket Restoran", "Akdeniz", 36.8081, 34.6372, "[]", "admin-api", "admin-secret", stamp);
    db.prepare("INSERT INTO couriers (id, name, zone, x, y, available, status, username, password_hash, password_salt, last_location_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("cr_admin_package", "Admin Yakın Kurye", "Akdeniz", 36.8082, 34.6373, 1, "online", "admin-near", "unused", "unused", stamp, stamp);
    const loginResponse = await fetch(`${baseUrl}/api/admin/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
    const auth = await loginResponse.json(); assert.equal(loginResponse.status, 200, auth.error);
    const createResponse = await fetch(`${baseUrl}/api/admin/packages`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.token}` }, body: JSON.stringify({ restaurantId: "rst_admin_package", customerName: "Admin Müşteri", phone: "05321112233", deliveryAddress: "Admin test adresi", packageType: "", orderAmount: 175, paymentMethod: "paid_online" }) });
    const created = await createResponse.json(); assert.equal(createResponse.status, 201, created.error);
    const row = db.prepare("SELECT * FROM packages WHERE id = ?").get(created.createdPackage.id);
    assert.equal(row.restaurant_id, "rst_admin_package");
    assert.equal(row.package_type, "Standart Paket");
    assert.equal(row.assigned_courier_id, "cr_admin_package");
    assert.equal(row.status, "assigned");
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM notification_logs WHERE target_role = 'courier' AND target_id = ? AND event_type = 'package-assigned'").get("cr_admin_package").total, 1);
    db.close();
  } finally { await stopServer(server); await removeTempDir(tempDir); }
});
