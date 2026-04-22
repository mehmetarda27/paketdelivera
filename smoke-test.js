const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

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
  const adminUsername = process.env.DELIVERA_ADMIN_USERNAME || "admin";
  const adminPassword = process.env.DELIVERA_ADMIN_PASSWORD || "Delivera123!";
  const courierUsername = `smokekurye${Math.floor(Math.random() * 100000)}`;
  const courierPassword = "Kurye123!";
  const courier2Username = `smokekurye${Math.floor(Math.random() * 100000)}`;
  const courier2Password = "Kurye123!";
  const courier3Username = `smokekurye${Math.floor(Math.random() * 100000)}`;
  const courier3Password = "Kurye123!";
  const restaurantLatitude = 36.601001;
  const restaurantLongitude = 34.320001;
  const courierLatitude = 36.601051;
  const courierLongitude = 34.320051;
  const firstAddress = `Mersin Erdemli test mahallesi teslimat noktasi ${Date.now()} no 10`;
  const secondAddress = `Mersin Erdemli ikinci teslim noktasi ${Date.now()} no 20`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivera-smoke-"));
  const tempDbFile = path.join(tempDir, "delivera.sqlite");
  const server = spawn(process.execPath, ["server.js"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DELIVERA_ADMIN_USERNAME: adminUsername,
      DELIVERA_ADMIN_PASSWORD: adminPassword,
      DELIVERA_ASSIGNMENT_RETRY_MS: "1000",
      DELIVERA_DB_FILE: tempDbFile,
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
        username: adminUsername,
        password: adminPassword,
      }),
    });
    const adminHeaders = { Authorization: `Bearer ${adminLogin.token}` };

    const restaurantUsername = `smokerest${Math.floor(Math.random() * 100000)}`;
    const restaurantPassword = "Rest12345!";
    const createdRestaurant = await request("/api/admin/restaurants", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: `Smoke Restoran ${Date.now()}`,
        portalUsername: restaurantUsername,
        portalPassword: restaurantPassword,
        zone: "Erdemli",
        latitude: restaurantLatitude,
        longitude: restaurantLongitude,
        platforms: ["Trendyol Go", "GetirYemek"],
      }),
    });
    const createdRestaurantRecord = createdRestaurant.restaurants.find((item) => item.username === restaurantUsername);
    if (!createdRestaurantRecord) {
      throw new Error("Admin restoran kaydini dondurmedi.");
    }

    const restaurantLogin = await request("/api/restaurant/session", {
      method: "POST",
      body: JSON.stringify({
        username: restaurantUsername,
        password: restaurantPassword,
      }),
    });
    const restaurantHeaders = { Authorization: `Bearer ${restaurantLogin.token}` };

    const platformState = await request("/api/restaurant/platform-accounts", {
      method: "POST",
      headers: restaurantHeaders,
      body: JSON.stringify({
        restaurantId: createdRestaurantRecord.id,
        platform: "Yemeksepeti",
        externalStoreId: `vendor-${Date.now()}`,
        webhookAuthType: "static_token",
      }),
    });
    const platformAccount = platformState.platformAccounts.find((item) => item.platform === "Yemeksepeti");
    if (!platformAccount) {
      throw new Error("Platform hesabi olusmadi.");
    }

    const courierState = await request("/api/admin/couriers", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Smoke Kurye",
        username: courierUsername,
        password: courierPassword,
        zone: "Erdemli",
        latitude: courierLatitude,
        longitude: courierLongitude,
        available: true,
      }),
    });
    const createdCourier = courierState.couriers.find((item) => item.username === courierUsername);
    if (!createdCourier) {
      throw new Error("Kurye olusturulamadi.");
    }
    const courierState2 = await request("/api/admin/couriers", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Smoke Kurye 2",
        username: courier2Username,
        password: courier2Password,
        zone: "Erdemli",
        latitude: courierLatitude + 0.0001,
        longitude: courierLongitude + 0.0001,
        available: true,
      }),
    });
    const createdCourier2 = courierState2.couriers.find((item) => item.username === courier2Username);
    if (!createdCourier2) {
      throw new Error("Ikinci kurye olusturulamadi.");
    }
    const courierState3 = await request("/api/admin/couriers", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Smoke Kurye 3",
        username: courier3Username,
        password: courier3Password,
        zone: "Erdemli",
        latitude: courierLatitude + 0.0002,
        longitude: courierLongitude + 0.0002,
        available: false,
      }),
    });
    const createdCourier3 = courierState3.couriers.find((item) => item.username === courier3Username);
    if (!createdCourier3) {
      throw new Error("Ucuncu kurye olusturulamadi.");
    }
    let bootstrap = await request("/api/admin/bootstrap", {
      headers: adminHeaders,
    });
    if (!bootstrap.couriers.some((item) => item.id === createdCourier.id) ||
      !bootstrap.couriers.some((item) => item.id === createdCourier2.id) ||
      !bootstrap.couriers.some((item) => item.id === createdCourier3.id)) {
      throw new Error("Yeni eklenen kuryeler admin bootstrap listesine dusmedi.");
    }

    const firstRestaurantPackageState = await request("/api/restaurant/packages", {
      method: "POST",
      headers: restaurantHeaders,
      body: JSON.stringify({
        restaurantId: createdRestaurantRecord.id,
        deliveryAddress: firstAddress,
        packageType: "Sicak Yemek",
        orderAmount: 250,
      }),
    });
    const firstManualPackage = firstRestaurantPackageState.packages.find((pkg) => pkg.deliveryAddress === firstAddress);
    if (!firstManualPackage || firstManualPackage.status !== "assigned" || firstManualPackage.assignedCourierId !== createdCourier.id) {
      throw new Error("Uygun kurye varken ilk siparis otomatik atanamadi.");
    }
    if (firstManualPackage.source !== "external_manual") {
      throw new Error("Manuel paket source alani beklenen sekilde isaretlenmedi.");
    }

    const secondRestaurantPackageState = await request("/api/restaurant/packages", {
      method: "POST",
      headers: restaurantHeaders,
      body: JSON.stringify({
        restaurantId: createdRestaurantRecord.id,
        deliveryAddress: secondAddress,
        packageType: "Tatli",
        orderAmount: 180,
      }),
    });
    const secondManualPackage = secondRestaurantPackageState.packages.find((pkg) => pkg.deliveryAddress === secondAddress);
    if (!secondManualPackage || secondManualPackage.status !== "assigned") {
      throw new Error("Ikinci uygun kurye varken ikinci siparis atanamadi.");
    }
    if (secondManualPackage.assignedCourierId !== createdCourier2.id) {
      throw new Error("Ikinci siparis beklenen ikinci kuryeye atanamadi.");
    }

    const thirdAddress = `Mersin Erdemli ucuncu teslim noktasi ${Date.now()} no 30`;
    const thirdRestaurantPackageState = await request("/api/restaurant/packages", {
      method: "POST",
      headers: restaurantHeaders,
      body: JSON.stringify({
        restaurantId: createdRestaurantRecord.id,
        deliveryAddress: thirdAddress,
        packageType: "Icecek",
        orderAmount: 90,
      }),
    });
    const thirdManualPackage = thirdRestaurantPackageState.packages.find((pkg) => pkg.deliveryAddress === thirdAddress);
    if (!thirdManualPackage || thirdManualPackage.status !== "awaiting_assignment") {
      throw new Error("Tum kuryeler busy iken ucuncu siparis awaiting_assignment olmadi.");
    }
    if (!thirdManualPackage.lastAssignmentError) {
      throw new Error("Atama basarisizlik nedeni kaydedilmedi.");
    }

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
          amount: 320,
        },
      }),
    });
    await request("/api/platforms/yemeksepeti/webhook", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${platformAccount.staticToken}`,
      },
      body: JSON.stringify({
        vendorId: platformAccount.externalStoreId,
        external_order_id: webhookResponse.package.externalOrderNo,
        customer: {
          name: "Webhook Musteri",
          phone: "5550000000",
        },
        address: "Mersin Mezitli sahil caddesi webhook no 12",
        status: "RECEIVED",
        payment: {
          method: "Online Odeme",
          amount: 320,
        },
      }),
    });

    const courierLogin = await request("/api/courier/login", {
      method: "POST",
      body: JSON.stringify({
        username: courierUsername,
        password: courierPassword,
      }),
    });
    const courierHeaders = { Authorization: `Bearer ${courierLogin.token}` };

    let shiftPlanState = await request("/api/admin/shift-plans", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        courierId: createdCourier.id,
        planDate: new Date().toISOString().slice(0, 10),
        startTime: "11:00",
        endTime: "19:00",
        zone: "Erdemli",
      }),
    });
    const pendingShiftPlan = (shiftPlanState.shiftPlans || []).find((plan) => plan.courierId === createdCourier.id);
    if (!pendingShiftPlan || pendingShiftPlan.status !== "awaiting_courier_acceptance") {
      throw new Error("Kurye vardiya teklifi olusmadi.");
    }

    let courierWorkspace = await request("/api/courier/me", {
      headers: courierHeaders,
    });
    const courierShiftPlan = (courierWorkspace.shiftSummary?.shiftPlans || []).find((plan) => plan.id === pendingShiftPlan.id);
    if (!courierShiftPlan || courierShiftPlan.status !== "awaiting_courier_acceptance") {
      throw new Error("Kurye panelinde vardiya teklifi gorunmedi.");
    }
    courierWorkspace = await request(`/api/courier/shift-plans/${pendingShiftPlan.id}/accept`, {
      method: "POST",
      headers: courierHeaders,
      body: JSON.stringify({}),
    });
    const acceptedShiftPlan = (courierWorkspace.shiftSummary?.shiftPlans || []).find((plan) => plan.id === pendingShiftPlan.id);
    if (!acceptedShiftPlan || acceptedShiftPlan.status !== "accepted") {
      throw new Error("Kurye vardiya planini kabul edemedi.");
    }
    shiftPlanState = await request("/api/admin/bootstrap", {
      headers: adminHeaders,
    });
    const acceptedAdminShiftPlan = (shiftPlanState.shiftPlans || []).find((plan) => plan.id === pendingShiftPlan.id);
    if (!acceptedAdminShiftPlan || acceptedAdminShiftPlan.status !== "accepted") {
      throw new Error("Admin vardiya kabul bilgisini goremiyor.");
    }

    if (courierWorkspace.packages.filter((pkg) => ["assigned", "accepted_by_courier", "on_route"].includes(pkg.status)).length !== 1) {
      throw new Error("Ayni kurye birden fazla aktif paket aldi.");
    }
    const assignedPackage = courierWorkspace.packages.find((pkg) => pkg.id === firstManualPackage.id);
    if (!assignedPackage) {
      throw new Error("Atanan ilk siparis kurye panelinde bulunamadi.");
    }
    if (assignedPackage.source !== "external_manual") {
      throw new Error("Manuel paket kurye paneline beklenen source ile dusmedi.");
    }

    courierWorkspace = await request(`/api/courier/packages/${assignedPackage.id}/status`, {
      method: "PATCH",
      headers: courierHeaders,
      body: JSON.stringify({ status: "accepted_by_courier" }),
    });
    courierWorkspace = await request(`/api/courier/packages/${assignedPackage.id}/status`, {
      method: "PATCH",
      headers: courierHeaders,
      body: JSON.stringify({ status: "on_route" }),
    });
    courierWorkspace = await request(`/api/courier/packages/${assignedPackage.id}/status`, {
      method: "PATCH",
      headers: courierHeaders,
      body: JSON.stringify({ status: "delivered", paymentStatus: "cash_collected" }),
    });
    await request(`/api/admin/packages/${assignedPackage.id}/status`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ status: "delivered", paymentStatus: "cash_collected" }),
    });
    await delay(1200);

    const restaurantBootstrap = await request("/api/restaurant/bootstrap", {
      headers: restaurantHeaders,
    });

    bootstrap = await request("/api/admin/bootstrap", {
      headers: adminHeaders,
    });

    if (!firstRestaurantPackageState.packages.some((pkg) => pkg.restaurantId === createdRestaurantRecord.id)) {
      throw new Error("Restoran paketi tenant filtreli listede bulunamadi.");
    }
    if (!restaurantBootstrap.packages.every((pkg) => pkg.restaurantId === createdRestaurantRecord.id)) {
      throw new Error("Restoran bootstrap baska tenant siparislerini dondurdu.");
    }
    if (!restaurantBootstrap.packages.some((pkg) => pkg.source === "external_manual") || !restaurantBootstrap.packages.some((pkg) => pkg.source !== "external_manual")) {
      throw new Error("Restoran paneli manuel ve webhook siparislerini birlikte gosteremedi.");
    }
    if (!restaurantBootstrap.packages.some((pkg) => pkg.assignedCourierName === createdCourier.name)) {
      throw new Error("Restoran panelinde atanmis kurye bilgisi gorunmuyor.");
    }
    if (!restaurantBootstrap.packages.every((pkg) => pkg.paymentStatus && pkg.status)) {
      throw new Error("Restoran paneli siparis veya odeme durumunu eksik aldi.");
    }
    if (!restaurantBootstrap.packages.some((pkg) => pkg.status === "awaiting_assignment")) {
      throw new Error("Restoran paneli atama bekleyen siparisi ayirt edemedi.");
    }

    if (!bootstrap.restaurants.some((restaurant) => restaurant.id === createdRestaurantRecord.id)) {
      throw new Error("Admin bootstrap restoran kaydini dondurmedi.");
    }

    if (!bootstrap.auditLogs.some((log) => log.action === "restaurant_created")) {
      throw new Error("Audit log akisi beklenen kaydi uretmedi.");
    }

    if (!webhookResponse.package || webhookResponse.package.sourcePlatform !== "Yemeksepeti") {
      throw new Error("Platform webhook siparisi beklenen paketi uretmedi.");
    }
    const duplicateWebhookPackages = bootstrap.packages.filter((pkg) => pkg.externalOrderNo === webhookResponse.package.externalOrderNo);
    if (duplicateWebhookPackages.length !== 1) {
      throw new Error("Duplicate siparis korumasi ayni siparisten birden fazla kayit olusturdu.");
    }

    const availableCouriers = bootstrap.couriers.filter((courier) => courier.status === "online");
    const busyCouriers = bootstrap.couriers.filter((courier) => courier.status === "busy");
    const offlineCouriers = bootstrap.couriers.filter((courier) => courier.status === "offline");
    if ((availableCouriers.length + busyCouriers.length + offlineCouriers.length) < 3 || busyCouriers.length < 1 || offlineCouriers.length < 1) {
      throw new Error("Admin operasyon ozeti kurye durumlarini beklenen sekilde yansitmadi.");
    }

    await request(`/api/admin/couriers/${createdCourier3.id}/availability`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ available: false }),
    });
    await request(`/api/admin/packages/${thirdManualPackage.id}/override`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ courierId: createdCourier3.id }),
    }).then(() => {
      throw new Error("Offline kurye override ile atanabildi.");
    }).catch((error) => {
      if (!String(error.message).includes("online")) {
        throw error;
      }
    });
    await request(`/api/admin/couriers/${createdCourier3.id}/availability`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ available: true }),
    });

    await request(`/api/admin/packages/${thirdManualPackage.id}/override`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ courierId: createdCourier3.id }),
    });
    bootstrap = await request("/api/admin/bootstrap", {
      headers: adminHeaders,
    });
    const overriddenPackage = bootstrap.packages.find((pkg) => pkg.id === thirdManualPackage.id);
    if (!overriddenPackage || overriddenPackage.assignedCourierId !== createdCourier3.id) {
      throw new Error("Admin manuel override beklenen sekilde calismadi.");
    }
    const courier3Login = await request("/api/courier/login", {
      method: "POST",
      body: JSON.stringify({
        username: courier3Username,
        password: courier3Password,
      }),
    });
    const courier3Headers = { Authorization: `Bearer ${courier3Login.token}` };
    await request(`/api/courier/packages/${thirdManualPackage.id}/status`, {
      method: "PATCH",
      headers: courier3Headers,
      body: JSON.stringify({ status: "failed" }),
    }).then(() => {
      throw new Error("Kurye sorun nedeni secmeden paketi failed yapabildi.");
    }).catch((error) => {
      if (!String(error.message).includes("sorun nedeni")) {
        throw error;
      }
    });
    await request(`/api/courier/packages/${thirdManualPackage.id}/status`, {
      method: "PATCH",
      headers: courier3Headers,
      body: JSON.stringify({ status: "failed", failureReason: "teknik_sorun" }),
    });
    bootstrap = await request("/api/admin/bootstrap", {
      headers: adminHeaders,
    });
    const failedPackage = bootstrap.packages.find((pkg) => pkg.id === thirdManualPackage.id);
    if (!failedPackage || failedPackage.status !== "failed" || failedPackage.failureReason !== "teknik_sorun") {
      throw new Error("Kurye reddetme/sorun bildirme akisi beklenen sekilde calismadi.");
    }
    await request(`/api/admin/packages/${thirdManualPackage.id}/status`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ status: "awaiting_assignment" }),
    });

    await request(`/api/admin/packages/${thirdManualPackage.id}/unassign`, {
      method: "POST",
      headers: adminHeaders,
      body: "{}",
    });
    await delay(1200);
    bootstrap = await request("/api/admin/bootstrap", {
      headers: adminHeaders,
    });
    const retriedPackage = bootstrap.packages.find((pkg) => pkg.id === thirdManualPackage.id);
    if (!retriedPackage || retriedPackage.status !== "assigned") {
      throw new Error("Unassign sonrasi yeniden atama mantigi calismadi.");
    }
    if (!retriedPackage.lastAssignmentAttemptAt) {
      throw new Error("Son atama denemesi bilgisi admin tarafinda gorunmuyor.");
    }

    const activeAssignments = bootstrap.packages.filter((pkg) => pkg.assignedCourierId === createdCourier.id && ["assigned", "accepted_by_courier", "on_route"].includes(pkg.status));
    if (activeAssignments.length > 1) {
      throw new Error("Kurye basina tek aktif paket kurali bozuldu.");
    }
    const deliveredManualPackage = bootstrap.packages.find((pkg) => pkg.id === firstManualPackage.id);
    if (!deliveredManualPackage || deliveredManualPackage.status !== "delivered") {
      throw new Error("Manuel paket teslimat yasam dongusunde delivered durumuna gecemedi.");
    }
    if (deliveredManualPackage.paymentStatus !== "cash_collected") {
      throw new Error("Manuel paket odeme yasam dongusu guncellenemedi.");
    }

    console.log("Smoke test basarili: admin, restoran, kurye ve platform webhook akisi calisti.");
  } finally {
    server.kill("SIGTERM");
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore temp cleanup errors.
    }
  }
}

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
