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
  throw new Error("Unmatched ingress test server did not start in time.");
}

async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  await new Promise((resolve) => {
    server.once("exit", resolve);
    server.kill();
    setTimeout(resolve, 2000).unref();
  });
}

async function postJson(url, headers, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test("authorized unmatched orders are durably captured across every supported API ingress", { timeout: 25000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivera-unmatched-ingress-"));
  const dbFile = path.join(tempDir, "delivera.sqlite");
  const port = 41000 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const webhookSecret = `unmatched-secret-${Date.now()}`;
  const integrationKey = `integration-key-${Date.now()}`;
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
      DELIVERA_INTEGRATION_KEY: integrationKey,
      DELIVERA_ASSIGNMENT_RETRY_MS: "60000",
      DELIVERA_COURIER_OFFER_TIMEOUT_MS: "60000",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    await waitForServer(baseUrl);
    const sharedPayload = {
      provider: { slug: "ys", api: "yswh", kaynak: "Yemek Sepeti" },
      pid: `POS-UNMATCHED-${Date.now()}`,
      restaurantId: `unknown-restaurant-${Date.now()}`,
      customerName: "Unmatched Customer",
      customerPhone: "05550000008",
      addressText: "Unmatched address, Mersin",
      totalPrice: 220,
      products: [{ id: "item-1", name: "Tantuni", quantity: 1, price: 220 }],
    };

    const commonWebhook = await postJson(
      `${baseUrl}/api/webhooks/orders`,
      { "x-webhook-secret": webhookSecret },
      sharedPayload
    );
    assert.equal(commonWebhook.response.status, 200);
    assert.equal(commonWebhook.body.matched, false);
    assert.ok(commonWebhook.body.unmatchedOrderId);

    const duplicateWebhook = await postJson(
      `${baseUrl}/api/webhooks/orders`,
      { "x-webhook-secret": webhookSecret },
      sharedPayload
    );
    assert.equal(duplicateWebhook.body.unmatchedOrderId, commonWebhook.body.unmatchedOrderId);

    const legacyOrderId = `LEGACY-UNMATCHED-${Date.now()}`;
    const legacyWebhook = await postJson(
      `${baseUrl}/api/platform/order`,
      { "x-webhook-secret": webhookSecret },
      {
        platform: "yemeksepeti",
        platformRestaurantId: "unknown-legacy-store",
        orderId: legacyOrderId,
        customerName: "Legacy Customer",
        phone: "05550000009",
        address: "Legacy unmatched address",
        totalPrice: 240,
      }
    );
    assert.equal(legacyWebhook.response.status, 202);
    assert.equal(legacyWebhook.body.matched, false);
    assert.ok(legacyWebhook.body.unmatchedOrderId);

    const platformSpecificOrderId = `PLATFORM-SPECIFIC-UNMATCHED-${Date.now()}`;
    const platformSpecificWebhook = await postJson(
      `${baseUrl}/api/platforms/yemeksepeti/webhook`,
      { "x-webhook-secret": webhookSecret },
      {
        restaurantId: "unknown-platform-specific-store",
        orderId: platformSpecificOrderId,
        customerName: "Platform Specific Customer",
        phone: "05550000012",
        address: "Platform specific unmatched address",
        totalPrice: 245,
      }
    );
    assert.equal(platformSpecificWebhook.response.status, 202);
    assert.equal(platformSpecificWebhook.body.matched, false);
    assert.ok(platformSpecificWebhook.body.unmatchedOrderId);

    const unauthorizedOrderId = `UNAUTHORIZED-${Date.now()}`;
    const unauthorizedWebhook = await postJson(
      `${baseUrl}/api/platform/order`,
      {},
      {
        platform: "yemeksepeti",
        platformRestaurantId: "unknown-unauthorized-store",
        orderId: unauthorizedOrderId,
        customerName: "Unauthorized Customer",
        phone: "05550000010",
        address: "Unauthorized address",
        totalPrice: 250,
      }
    );
    assert.equal(unauthorizedWebhook.response.status, 404);

    const externalOrderId = `EXTERNAL-UNMATCHED-${Date.now()}`;
    const externalWebhook = await postJson(
      `${baseUrl}/api/external/platform-orders`,
      { Authorization: `Bearer ${integrationKey}` },
      {
        platform: "yemeksepeti",
        platformRestaurantId: "unknown-external-store",
        platformOrderId: externalOrderId,
        customerName: "External Customer",
        customerPhone: "05550000011",
        deliveryAddress: "External unmatched address",
        totalAmount: 260,
      }
    );
    assert.equal(externalWebhook.response.status, 202);
    assert.equal(externalWebhook.body.matched, false);
    assert.ok(externalWebhook.body.unmatchedOrderId);

    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM unmatched_orders").get().count, 4);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM unmatched_orders WHERE external_order_id = ?").get(sharedPayload.pid).count, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM unmatched_orders WHERE external_order_id = ?").get(legacyOrderId).count, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM unmatched_orders WHERE external_order_id = ?").get(platformSpecificOrderId).count, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM unmatched_orders WHERE external_order_id = ?").get(externalOrderId).count, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM unmatched_orders WHERE external_order_id = ?").get(unauthorizedOrderId).count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM packages").get().count, 0);
    } finally {
      db.close();
    }
  } finally {
    await stopServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
