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
  throw new Error("Getir Posentegra webhook test server did not start in time.");
}

async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  await new Promise((resolve) => {
    server.once("exit", resolve);
    server.kill();
    setTimeout(resolve, 2000).unref();
  });
}

test("Posentegra webhooks prefer the common restaurant id and safely fall back to platform ids", { timeout: 20000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivera-getir-posentegra-"));
  const dbFile = path.join(tempDir, "delivera.sqlite");
  const port = 40000 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const webhookSecret = `getir-secret-${Date.now()}`;
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
      WEBHOOK_SECRET: webhookSecret,
      DELIVERA_ASSIGNMENT_RETRY_MS: "60000",
      DELIVERA_COURIER_OFFER_TIMEOUT_MS: "60000",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    await waitForServer(baseUrl);
    const stamp = new Date().toISOString();
    const posentegraRestaurantId = `pos-getir-${Date.now()}`;
    const db = new DatabaseSync(dbFile);
    try {
      db.prepare(`
        INSERT INTO restaurants (id, name, zone, x, y, platforms_json, api_key, webhook_secret, posentegra_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run("rst_getir_pos", "Getir Posentegra Restaurant", "Erdemli", 36.6, 34.3, "[]", "getir-api-key", webhookSecret, posentegraRestaurantId, stamp);
    } finally {
      db.close();
    }

    const pid = `GETIR-POS-${Date.now()}`;
    const response = await fetch(`${baseUrl}/api/webhooks/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-webhook-secret": webhookSecret },
      body: JSON.stringify({
        provider: { slug: "getir", api: "getirwh", kaynak: "Getir Yemek" },
        pid,
        platformRestaurantId: posentegraRestaurantId,
        customer: { name: "Getir Customer", phone: "05550000006" },
        deliveryAddress: { address1: "Getir address", district: "Erdemli", city: "Mersin" },
        totalAmount: 275,
        items: [{ id: "getir-item-1", name: "Tantuni", quantity: 1, price: 275, totalPrice: 275 }],
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.matched, true);
    assert.equal(body.package.restaurantId, "rst_getir_pos");
    assert.equal(body.package.sourcePlatform, "Getir Yemek");

    const progressedStatuses = [400, 500, 600, 700, 800, 900];
    for (const status of progressedStatuses) {
      const statusResponse = await fetch(`${baseUrl}/api/webhooks/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-webhook-secret": webhookSecret },
        body: JSON.stringify({
          provider: { slug: "getir", api: "getirwh", kaynak: "Getir Yemek" },
          pid,
          platformRestaurantId: posentegraRestaurantId,
          status,
          customer: { name: "Getir Customer", phone: "05550000006" },
          deliveryAddress: { address1: "Getir address", district: "Erdemli", city: "Mersin" },
          totalAmount: 275,
          items: [{ id: "getir-item-1", name: "Tantuni", quantity: 1, price: 275, totalPrice: 275 }],
        }),
      });
      assert.equal(statusResponse.status, 200);
      const intermediateDb = new DatabaseSync(dbFile, { readOnly: true });
      try {
        const intermediate = intermediateDb.prepare("SELECT status, assigned_courier_id, on_route_at FROM packages WHERE id = ?").get(body.package.id);
        if (status >= 400 && status < 900) {
          assert.equal(intermediate.status, "awaiting_assignment");
          assert.equal(intermediate.assigned_courier_id, null);
          assert.equal(intermediate.on_route_at, null);
        }
      } finally {
        intermediateDb.close();
      }
    }

    const verificationDb = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const row = verificationDb.prepare(`
        SELECT restaurant_id, platform_restaurant_id, posentegra_id, source_platform, status, delivered_at
        FROM packages WHERE id = ?
      `).get(body.package.id);
      assert.equal(row.restaurant_id, "rst_getir_pos");
      assert.equal(row.platform_restaurant_id, posentegraRestaurantId);
      assert.equal(row.posentegra_id, pid);
      assert.equal(row.source_platform, "Getir Yemek");
      assert.equal(row.status, "delivered");
      assert.ok(row.delivered_at);
      assert.equal(
        verificationDb.prepare("SELECT COUNT(*) AS count FROM posentegra_outbox WHERE aggregate_id = ?").get(body.package.id).count,
        0,
        "Posentegra'dan gelen durum tekrar Posentegra'ya gonderilmemeli."
      );
    } finally {
      verificationDb.close();
    }

    const trendyolPid = `TRENDYOL-POS-${Date.now()}`;
    const trendyolResponse = await fetch(`${baseUrl}/api/webhooks/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-webhook-secret": webhookSecret },
      body: JSON.stringify({
        provider: { slug: "ty", api: "tywh", kaynak: "Trendyol Yemek" },
        pid: trendyolPid,
        platformRestaurantId: `trendyol-seller-${Date.now()}`,
        restaurant: { id: posentegraRestaurantId, name: "Getir Posentegra Restaurant" },
        client: {
          name: "Trendyol Customer",
          clientPhoneNumber: "05550000007",
          deliveryAddress: { address: "Trendyol address", district: "Erdemli", city: "Mersin" },
        },
        totalPrice: 310,
        products: [{ id: "trendyol-item-1", name: { tr: "Tantuni" }, count: 1, price: 310, totalPrice: 310 }],
      }),
    });
    const trendyolBody = await trendyolResponse.json();
    assert.equal(trendyolResponse.status, 200);
    assert.equal(trendyolBody.matched, true);
    assert.equal(trendyolBody.package.restaurantId, "rst_getir_pos");
    assert.equal(trendyolBody.package.sourcePlatform, "Trendyol Yemek");
    assert.equal(trendyolBody.package.platformRestaurantId, posentegraRestaurantId);
  } finally {
    await stopServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
