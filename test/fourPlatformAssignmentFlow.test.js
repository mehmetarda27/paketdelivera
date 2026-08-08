const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer(baseUrl) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10000) {
    try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch {}
    await delay(100);
  }
  throw new Error("Four platform flow test server did not start.");
}

async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  await new Promise((resolve) => {
    server.once("exit", resolve);
    server.kill();
    setTimeout(resolve, 2000).unref();
  });
}

async function removeTempDir(tempDir) {
  let lastError;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); return; }
    catch (error) { lastError = error; await delay(250); }
  }
  if (process.platform === "win32" && ["EPERM", "EBUSY"].includes(lastError?.code)) return;
  throw lastError;
}

test("Yemeksepeti, Getir, Trendyol and Migros orders persist and immediately reach the nearest courier", { timeout: 30000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivera-four-platform-"));
  const dbFile = path.join(tempDir, "delivera.sqlite");
  const port = 47500 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(port), NODE_ENV: "test", DATABASE_URL: "", POSTGRES_URL: "", DATABASE_PATH: dbFile, DB_PATH: dbFile, DELIVERA_DB_FILE: dbFile, DELIVERA_ASSIGNMENT_RETRY_MS: "60000" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));
  try {
    await waitForServer(baseUrl);
    const db = new DatabaseSync(dbFile);
    db.exec("PRAGMA busy_timeout = 10000");
    const stamp = new Date().toISOString();
    const token = "four-platform-restaurant-token";
    db.prepare("INSERT INTO restaurants (id, name, zone, x, y, platforms_json, api_key, webhook_secret, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("rst_platform_four", "Dört Platform Restoran", "Akdeniz", 36.8081, 34.6372, "[]", "four-api", "four-secret", stamp);
    db.prepare("INSERT INTO restaurant_sessions (token, restaurant_id, created_at) VALUES (?, ?, ?)").run(token, "rst_platform_four", stamp);
    db.prepare("INSERT INTO couriers (id, name, zone, x, y, available, status, username, password_hash, password_salt, last_location_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("cr_platform_near", "En Yakın Kurye", "Akdeniz", 36.8082, 34.6373, 1, "online", "near", "unused", "unused", stamp, stamp);

    const cases = [
      ["Yemeksepeti", "Yemeksepeti"],
      ["Getir", "Getir Yemek"],
      ["Trendyol", "Trendyol Yemek"],
      ["Migros", "Migros Yemek"],
    ];
    for (let index = 0; index < cases.length; index += 1) {
      const [incomingPlatform, expectedPlatform] = cases[index];
      const response = await fetch(`${baseUrl}/api/restaurant/platform-orders/manual`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ platform: incomingPlatform, orderId: `FOUR-${index}`, customerName: `Müşteri ${index}`, phone: "05321112233", address: "Test adresi", totalPrice: 100 + index, paymentMethod: "paid_online" }),
      });
      const body = await response.json();
      assert.equal(response.status, 201, body.error);
      const row = db.prepare("SELECT * FROM packages WHERE external_order_id = ?").get(`FOUR-${index}`);
      assert.ok(row);
      assert.equal(row.source_platform, expectedPlatform);
      assert.equal(row.assigned_courier_id, "cr_platform_near");
      assert.equal(row.status, "assigned");
      db.prepare("UPDATE packages SET status = 'delivered', assignment_status = 'assigned', delivered_at = ?, updated_at = ? WHERE id = ?").run(stamp, stamp, row.id);
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM platform_orders WHERE restaurant_id = ?").get("rst_platform_four").total, 4);
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM notification_logs WHERE target_role = 'courier' AND target_id = ? AND event_type = 'package-assigned'").get("cr_platform_near").total, 4);
    db.close();
  } finally {
    await stopServer(server);
    await removeTempDir(tempDir);
  }
});
