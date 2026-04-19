const { spawn } = require("child_process");

const PORT = 3210;
const BASE_URL = `http://127.0.0.1:${PORT}`;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(timeoutMs = 8000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${BASE_URL}/api/bootstrap`);
      if (response.ok) {
        return;
      }
    } catch {
      await delay(150);
    }
  }

  throw new Error("Sunucu belirtilen surede acilmadi.");
}

async function request(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${path} -> ${response.status}: ${body.error || "Bilinmeyen hata"}`);
  }

  return body;
}

async function run() {
  const server = spawn(process.execPath, ["server.js"], {
    env: {
      ...process.env,
      PORT: String(PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  server.stdout.on("data", (chunk) => process.stdout.write(chunk));
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    await waitForServer();

    const adminLogin = await request("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({
        username: process.env.DELIVERA_ADMIN_USERNAME || "admin",
        password: process.env.DELIVERA_ADMIN_PASSWORD || "Delivera123!",
      }),
    });
    const adminHeaders = { Authorization: `Bearer ${adminLogin.token}` };

    const createdRestaurant = await request("/api/restaurants", {
      method: "POST",
      body: JSON.stringify({
        name: `Smoke Restoran ${Date.now()}`,
        portalUsername: `smokerest${Math.floor(Math.random() * 100000)}`,
        portalPassword: "Rest12345!",
        zone: "Mezitli",
        latitude: 36.770001,
        longitude: 34.560001,
        platforms: ["Trendyol Go", "GetirYemek"],
      }),
    });

    const restaurantLogin = await request("/api/restaurant/session", {
      method: "POST",
      body: JSON.stringify({
        username: createdRestaurant.integration.portalUsername,
        password: createdRestaurant.integration.portalPassword,
      }),
    });
    const restaurantHeaders = { Authorization: `Bearer ${restaurantLogin.token}` };

    const platformState = await request("/api/restaurant/platform-accounts", {
      method: "POST",
      headers: restaurantHeaders,
      body: JSON.stringify({
        restaurantId: createdRestaurant.integration.restaurantId,
        platform: "Yemeksepeti",
        externalStoreId: `vendor-${Date.now()}`,
        webhookAuthType: "static_token",
      }),
    });
    const platformAccount = platformState.platformAccounts.find((item) => item.platform === "Yemeksepeti");
    if (!platformAccount) {
      throw new Error("Platform hesabi olusmadi.");
    }

    await request("/api/admin/couriers", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Smoke Kurye",
        username: `smokekurye${Math.floor(Math.random() * 100000)}`,
        password: "Kurye123!",
        zone: "Mezitli",
        latitude: 36.77005,
        longitude: 34.56005,
        available: true,
      }),
    });

    const restaurantPackageState = await request("/api/restaurant/packages", {
      method: "POST",
      headers: restaurantHeaders,
      body: JSON.stringify({
        restaurantId: createdRestaurant.integration.restaurantId,
        deliveryAddress: "Mersin Mezitli test mahallesi teslimat noktasi no 10",
        packageType: "Sicak Yemek",
      }),
    });

    const webhookResponse = await request("/api/platforms/yemeksepeti/webhook", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${platformAccount.staticToken}`,
      },
      body: JSON.stringify({
        vendorId: platformAccount.externalStoreId,
        external_order_id: `YS-${Date.now()}`,
        customer: {
          name: "Webhook Musteri",
          phone: "5550000000",
        },
        address: "Mersin Mezitli sahil caddesi webhook no 12",
        status: "RECEIVED",
        payment: {
          method: "Online Odeme",
        },
      }),
    });

    const bootstrap = await request("/api/admin/bootstrap", {
      headers: adminHeaders,
    });

    if (!restaurantPackageState.packages.some((pkg) => pkg.restaurantId === createdRestaurant.integration.restaurantId)) {
      throw new Error("Restoran paketi tenant filtreli listede bulunamadi.");
    }

    if (!bootstrap.restaurants.some((restaurant) => restaurant.id === createdRestaurant.integration.restaurantId)) {
      throw new Error("Admin bootstrap restoran kaydini dondurmedi.");
    }

    if (!bootstrap.auditLogs.some((log) => log.action === "restaurant_created")) {
      throw new Error("Audit log akisi beklenen kaydi uretmedi.");
    }

    if (!webhookResponse.package || webhookResponse.package.sourcePlatform !== "Yemeksepeti") {
      throw new Error("Platform webhook siparisi beklenen paketi uretmedi.");
    }

    console.log("Smoke test basarili: admin, restoran, kurye ve platform webhook akisi calisti.");
  } finally {
    server.kill("SIGTERM");
  }
}

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
