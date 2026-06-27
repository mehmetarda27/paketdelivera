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
      if (response.ok) {
        return;
      }
    } catch {}
    await delay(150);
  }
  throw new Error("Test server did not start in time.");
}

async function request(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(`${route} -> ${response.status}: ${body.error || body.message || "request failed"}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function readRow(dbFile, sql, ...params) {
  const db = new DatabaseSync(dbFile);
  try {
    return db.prepare(sql).get(...params);
  } finally {
    db.close();
  }
}

async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) {
    return;
  }
  await new Promise((resolve) => {
    server.once("exit", resolve);
    server.kill();
    setTimeout(resolve, 2000).unref();
  });
}

test("panel create/update/delete flows persist to database tables", { timeout: 30000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivera-panel-persistence-"));
  const dbFile = path.join(tempDir, "delivera.sqlite");
  const port = 34000 + (process.pid % 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const adminUsername = `admin_${Date.now()}`;
  const adminPassword = "Delivera123!";
  const restaurantUsername = `rest_${Date.now()}`;
  const restaurantPassword = "Rest12345!";
  const secondRestaurantUsername = `rest2_${Date.now()}`;
  const secondRestaurantPassword = "Rest22345!";
  const yemeksepetiRestaurantId = "6377deac15d5d59aee02bf51";

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
      DELIVERA_INTEGRATION_KEY: "test-integration-key",
      WEBHOOK_SECRET: "test-webhook-secret",
      WEBHOOK_ENABLED: "true",
      DELIVERA_ASSIGNMENT_RETRY_MS: "60000",
      DELIVERA_COURIER_OFFER_TIMEOUT_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  server.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
  });

  try {
    await waitForServer(baseUrl);

    const adminLogin = await request(baseUrl, "/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ username: adminUsername, password: adminPassword }),
    });
    const adminHeaders = { Authorization: `Bearer ${adminLogin.token}` };

    const restaurantState = await request(baseUrl, "/restaurants", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Persistence Test Restaurant",
        portalUsername: restaurantUsername,
        portalPassword: restaurantPassword,
        zone: "Erdemli",
        latitude: 36.601,
        longitude: 34.32,
        platforms: ["Getir Yemek"],
        yemeksepetiRestaurantId,
        externalRestaurantIds: JSON.stringify([{ platform: "other", restaurantId: `other-${Date.now()}` }]),
      }),
    });
    assert.ok(restaurantState.createdRestaurant?.id);
    assert.ok(readRow(dbFile, "SELECT id FROM restaurants WHERE id = ?", restaurantState.createdRestaurant.id));

    const secondRestaurantState = await request(baseUrl, "/restaurants", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Second Persistence Test Restaurant",
        portalUsername: secondRestaurantUsername,
        portalPassword: secondRestaurantPassword,
        zone: "Mezitli",
        latitude: 36.75,
        longitude: 34.55,
        platforms: ["POS"],
        getirRestaurantId: `getir-${Date.now()}`,
      }),
    });
    assert.ok(secondRestaurantState.createdRestaurant?.id);
    assert.notEqual(secondRestaurantState.createdRestaurant.id, restaurantState.createdRestaurant.id);
    assert.ok(readRow(dbFile, "SELECT id FROM restaurants WHERE id = ?", secondRestaurantState.createdRestaurant.id));
    assert.equal(
      readRow(dbFile, "SELECT yemeksepeti_restaurant_id FROM restaurants WHERE id = ?", restaurantState.createdRestaurant.id).yemeksepeti_restaurant_id,
      restaurantState.createdRestaurant.yemeksepetiRestaurantId
    );
    assert.equal(
      readRow(dbFile, "SELECT getir_restaurant_id FROM restaurants WHERE id = ?", secondRestaurantState.createdRestaurant.id).getir_restaurant_id,
      secondRestaurantState.createdRestaurant.getirRestaurantId
    );

    const courierState = await request(baseUrl, "/couriers", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Persistence Courier",
        username: `courier_${Date.now()}`,
        password: "Kurye123!",
        zone: "Erdemli",
        latitude: 36.602,
        longitude: 34.321,
        available: true,
      }),
    });
    assert.ok(courierState.createdCourier?.id);
    assert.ok(readRow(dbFile, "SELECT id FROM couriers WHERE id = ?", courierState.createdCourier.id));

    await request(baseUrl, `/api/admin/couriers/${courierState.createdCourier.id}`, {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Persistence Courier Updated",
        username: courierState.createdCourier.username,
        zone: "Erdemli",
      }),
    });
    assert.equal(
      readRow(dbFile, "SELECT name FROM couriers WHERE id = ?", courierState.createdCourier.id).name,
      "Persistence Courier Updated"
    );

    const deleteCourierState = await request(baseUrl, "/api/admin/couriers", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Delete Persistence Courier",
        username: `delete_courier_${Date.now()}`,
        password: "Kurye123!",
        zone: "Erdemli",
        latitude: 36.603,
        longitude: 34.322,
        available: false,
      }),
    });
    await request(baseUrl, `/api/admin/couriers/${deleteCourierState.createdCourier.id}`, {
      method: "DELETE",
      headers: adminHeaders,
    });
    assert.equal(readRow(dbFile, "SELECT id FROM couriers WHERE id = ?", deleteCourierState.createdCourier.id), undefined);

    const restaurantLogin = await request(baseUrl, "/api/restaurant/session", {
      method: "POST",
      body: JSON.stringify({ username: restaurantUsername, password: restaurantPassword }),
    });
    const restaurantHeaders = { Authorization: `Bearer ${restaurantLogin.token}` };

    const platformOrderId = `PLATFORM-${Date.now()}`;
    const platformOrderState = await request(baseUrl, "/platform-orders", {
      method: "POST",
      headers: restaurantHeaders,
      body: JSON.stringify({
        platform: "POS",
        orderId: platformOrderId,
        customerName: "Platform Persistence Customer",
        phone: "5554443322",
        address: "Platform persistence address",
        totalPrice: 210,
        paymentMethod: "Online Odeme",
        note: "platform_orders persistence test",
      }),
    });
    assert.ok(platformOrderState.package?.id);
    assert.ok(platformOrderState.platformOrder?.id);
    assert.ok(readRow(dbFile, "SELECT id FROM packages WHERE id = ?", platformOrderState.package.id));
    assert.ok(readRow(dbFile, "SELECT id FROM platform_orders WHERE id = ?", platformOrderState.platformOrder.id));
    assert.ok(
      readRow(dbFile, "SELECT id FROM platform_orders WHERE platform_order_id = ?", platformOrderId)
    );

    const packageState = await request(baseUrl, "/packages", {
      method: "POST",
      headers: restaurantHeaders,
      body: JSON.stringify({
        restaurantId: restaurantState.createdRestaurant.id,
        deliveryAddress: "Persistence mahallesi no 1 Erdemli",
        packageType: "Test Paket",
        orderAmount: 125,
        customerName: "Persistence Customer",
        phone: "5551112233",
        customerNote: "DB persistence test",
        paymentMethod: "Panel Kaydi",
      }),
    });
    assert.ok(packageState.createdPackage?.id);
    assert.ok(readRow(dbFile, "SELECT id FROM packages WHERE id = ?", packageState.createdPackage.id));
    assert.equal(
      readRow(dbFile, "SELECT restaurant_id FROM packages WHERE id = ?", packageState.createdPackage.id).restaurant_id,
      restaurantState.createdRestaurant.id
    );

    const courierLogin = await request(baseUrl, "/api/courier/login", {
      method: "POST",
      body: JSON.stringify({ username: courierState.createdCourier.username, password: "Kurye123!" }),
    });
    assert.ok(courierLogin.token);
    const courierWorkspace = await request(baseUrl, "/api/courier/me", {
      headers: { Authorization: `Bearer ${courierLogin.token}` },
    });
    assert.equal(courierWorkspace.courier.id, courierState.createdCourier.id);
    assert.ok(courierWorkspace.dayMetrics);

    const secondRestaurantLogin = await request(baseUrl, "/api/restaurant/session", {
      method: "POST",
      body: JSON.stringify({ username: secondRestaurantUsername, password: secondRestaurantPassword }),
    });
    const secondRestaurantHeaders = { Authorization: `Bearer ${secondRestaurantLogin.token}` };
    const secondPackageState = await request(baseUrl, "/packages", {
      method: "POST",
      headers: secondRestaurantHeaders,
      body: JSON.stringify({
        restaurantId: restaurantState.createdRestaurant.id,
        deliveryAddress: "Second restaurant package address",
        packageType: "Second Test Paket",
        orderAmount: 175,
        customerName: "Second Restaurant Customer",
        phone: "5559998877",
        customerNote: "body restaurantId must be ignored",
        paymentMethod: "Panel Kaydi",
      }),
    });
    assert.ok(secondPackageState.createdPackage?.id);
    assert.equal(
      readRow(dbFile, "SELECT restaurant_id FROM packages WHERE id = ?", secondPackageState.createdPackage.id).restaurant_id,
      secondRestaurantState.createdRestaurant.id
    );
    assert.equal(
      readRow(dbFile, "SELECT COUNT(DISTINCT restaurant_id) AS count FROM packages").count,
      2
    );

    const reloadedRestaurantState = await request(baseUrl, "/api/restaurant/bootstrap", {
      headers: restaurantHeaders,
    });
    assert.ok(reloadedRestaurantState.packages.some((pkg) => pkg.id === packageState.createdPackage.id));
    assert.ok(!reloadedRestaurantState.packages.some((pkg) => pkg.id === secondPackageState.createdPackage.id));
    const reloadedSecondRestaurantState = await request(baseUrl, "/api/restaurant/bootstrap", {
      headers: secondRestaurantHeaders,
    });
    assert.ok(reloadedSecondRestaurantState.packages.some((pkg) => pkg.id === secondPackageState.createdPackage.id));
    assert.ok(!reloadedSecondRestaurantState.packages.some((pkg) => pkg.id === packageState.createdPackage.id));

    await assert.rejects(
      () => request(baseUrl, "/api/external/packages"),
      (error) => error.status === 401
    );

    const externalHeaders = { Authorization: "Bearer test-integration-key" };
    const externalRestaurants = await request(baseUrl, "/api/external/restaurants", {
      headers: externalHeaders,
    });
    assert.ok(externalRestaurants.some((item) =>
      item.id === restaurantState.createdRestaurant.id &&
      item.yemeksepetiRestaurantId === restaurantState.createdRestaurant.yemeksepetiRestaurantId
    ));

    const externalOrderOne = await request(baseUrl, "/api/external/platform-orders", {
      method: "POST",
      headers: externalHeaders,
      body: JSON.stringify({
        platform: "yemeksepeti",
        platformRestaurantId: restaurantState.createdRestaurant.yemeksepetiRestaurantId,
        platformOrderId: `YS-${Date.now()}`,
        customerName: "External Customer One",
        customerPhone: "05550000001",
        deliveryAddress: "External address one",
        items: [{ name: "Lahmacun", quantity: 2, price: 120 }],
        totalAmount: 240,
        rawPayload: { source: "test" },
      }),
    });
    const externalOrderTwo = await request(baseUrl, "/api/external/platform-orders", {
      method: "POST",
      headers: externalHeaders,
      body: JSON.stringify({
        platform: "getir",
        platformRestaurantId: secondRestaurantState.createdRestaurant.getirRestaurantId,
        platformOrderId: `GETIR-${Date.now()}`,
        customerName: "External Customer Two",
        customerPhone: "05550000002",
        deliveryAddress: "External address two",
        items: [{ name: "Burger", quantity: 1, price: 180 }],
        totalAmount: 180,
        rawPayload: { source: "test" },
      }),
    });
    assert.equal(externalOrderOne.package.restaurantId, restaurantState.createdRestaurant.id);
    assert.equal(externalOrderTwo.package.restaurantId, secondRestaurantState.createdRestaurant.id);
    assert.notEqual(externalOrderOne.package.restaurantId, externalOrderTwo.package.restaurantId);
    assert.equal(
      readRow(dbFile, "SELECT restaurant_id FROM packages WHERE id = ?", externalOrderOne.package.id).restaurant_id,
      restaurantState.createdRestaurant.id
    );
    assert.equal(
      readRow(dbFile, "SELECT restaurant_id FROM packages WHERE id = ?", externalOrderTwo.package.id).restaurant_id,
      secondRestaurantState.createdRestaurant.id
    );
    assert.equal(
      readRow(dbFile, "SELECT platform_restaurant_id FROM platform_orders WHERE id = ?", externalOrderOne.platformOrder.id).platform_restaurant_id,
      restaurantState.createdRestaurant.yemeksepetiRestaurantId
    );
    assert.equal(
      readRow(dbFile, "SELECT platform_restaurant_id FROM platform_orders WHERE id = ?", externalOrderTwo.platformOrder.id).platform_restaurant_id,
      secondRestaurantState.createdRestaurant.getirRestaurantId
    );
    assert.equal(
      readRow(dbFile, "SELECT package_id FROM platform_orders WHERE id = ?", externalOrderOne.platformOrder.id).package_id,
      externalOrderOne.package.id
    );
    const externalPackageDetail = await request(baseUrl, `/api/external/packages/${externalOrderOne.package.id}`, {
      headers: externalHeaders,
    });
    assert.equal(externalPackageDetail.platformRestaurantId, restaurantState.createdRestaurant.yemeksepetiRestaurantId);
    assert.equal(externalPackageDetail.platformOrderId, externalOrderOne.platformOrder.platformOrderId);

    const webhookOrderId = `YS-WEBHOOK-${Date.now()}`;
    const webhookOrder = await request(baseUrl, "/api/webhooks/orders", {
      method: "POST",
      headers: { "x-webhook-secret": "test-webhook-secret" },
      body: JSON.stringify({
        provider: { slug: "ys" },
        restaurantId: yemeksepetiRestaurantId,
        restaurant: { id: yemeksepetiRestaurantId, name: "Persistence Test Restaurant" },
        orderId: webhookOrderId,
        customerName: "Webhook Customer",
        customerPhone: "05550000003",
        addressText: "Webhook address",
        totalPrice: 320,
        products: [{ id: "prod-1", name: "Kofte", quantity: 1, price: 320, totalPrice: 320 }],
      }),
    });
    assert.equal(webhookOrder.matched, true);
    assert.equal(webhookOrder.package.restaurantId, restaurantState.createdRestaurant.id);
    assert.equal(
      readRow(dbFile, "SELECT restaurant_id FROM packages WHERE id = ?", webhookOrder.package.id).restaurant_id,
      restaurantState.createdRestaurant.id
    );
    assert.equal(
      readRow(dbFile, "SELECT platform_restaurant_id FROM platform_orders WHERE platform_order_id = ?", webhookOrderId).platform_restaurant_id,
      yemeksepetiRestaurantId
    );
    assert.equal(
      readRow(dbFile, "SELECT package_id FROM platform_orders WHERE platform_order_id = ?", webhookOrderId).package_id,
      webhookOrder.package.id
    );

    const packageCountBeforeUnmatched = readRow(dbFile, "SELECT COUNT(*) AS count FROM packages").count;
    const unmatchedWebhookOrder = await request(baseUrl, "/api/webhooks/orders", {
      method: "POST",
      headers: { "x-webhook-secret": "test-webhook-secret" },
      body: JSON.stringify({
        provider: { slug: "ys" },
        restaurantId: "unknown-yemeksepeti-restaurant",
        orderId: `YS-UNMATCHED-${Date.now()}`,
        customerName: "Unmatched Webhook Customer",
        customerPhone: "05550000004",
        addressText: "Unmatched webhook address",
        totalPrice: 100,
        products: [{ id: "prod-2", name: "Ayran", quantity: 1, price: 100, totalPrice: 100 }],
      }),
    });
    assert.equal(unmatchedWebhookOrder.matched, false);
    assert.equal(readRow(dbFile, "SELECT COUNT(*) AS count FROM packages").count, packageCountBeforeUnmatched);

    const externalPackages = await request(baseUrl, "/api/external/packages", {
      headers: externalHeaders,
    });
    assert.ok(externalPackages.some((pkg) => pkg.id === externalOrderOne.package.id));
    const patched = await request(baseUrl, `/api/external/packages/${externalOrderOne.package.id}/status`, {
      method: "PATCH",
      headers: externalHeaders,
      body: JSON.stringify({ status: "picked_up" }),
    });
    assert.equal(patched.package.status, "picked_up");

    const counts = readRow(dbFile, `
      SELECT
        (SELECT COUNT(*) FROM restaurants) AS restaurants,
        (SELECT COUNT(*) FROM couriers) AS couriers,
        (SELECT COUNT(*) FROM packages) AS packages,
        (SELECT COUNT(*) FROM platform_orders) AS platform_orders
    `);
    assert.ok(counts.restaurants > 0);
    assert.ok(counts.couriers > 0);
    assert.ok(counts.packages > 0);
    assert.ok(counts.platform_orders > 0);
  } finally {
    await stopServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
