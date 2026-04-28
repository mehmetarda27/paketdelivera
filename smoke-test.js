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
  const courier4Username = `smokekurye${Math.floor(Math.random() * 100000)}`;
  const courier4Password = "Kurye123!";
  const courier5Username = `smokekurye${Math.floor(Math.random() * 100000)}`;
  const courier5Password = "Kurye123!";
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
        staticToken: "smoke-platform-secret",
      }),
    });
    const platformAccount = platformState.platformAccounts.find((item) => item.platform === "Yemeksepeti");
    if (!platformAccount) {
      throw new Error("Platform hesabi olusmadi.");
    }
    if (platformAccount.staticToken !== "smoke-platform-secret") {
      throw new Error("Static Token webhook secret olarak map edilmedi.");
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
        zone: "Akdeniz",
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

    await request("/api/platform/order", {
      method: "POST",
      headers: {
        "x-platform-secret": "wrong-secret",
      },
      body: JSON.stringify({
        platform: "yemeksepeti",
        platformRestaurantId: platformAccount.externalStoreId,
        orderId: `YS-WRONG-${Date.now()}`,
        customerName: "Yanlis Secret",
        phone: "05550000000",
        address: "Mersin gizli test adresi",
        totalPrice: 99,
      }),
    }).then(() => {
      throw new Error("Yanlis secret ile siparis kabul edildi.");
    }).catch((error) => {
      if (!String(error.message).includes("401")) {
        throw error;
      }
    });

    const webhookResponse = await request("/api/platform/order", {
      method: "POST",
      headers: {
        "x-platform-secret": "smoke-platform-secret",
      },
      body: JSON.stringify({
        platform: "yemeksepeti",
        platformRestaurantId: platformAccount.externalStoreId,
        orderId: `YS-${Date.now()}`,
        customerName: "Webhook Musteri",
        phone: "5550000000",
        address: "Mersin Mezitli sahil caddesi webhook no 12",
        totalPrice: 320,
        items: [
          { id: "ys-1", name: "Lahmacun", quantity: 2, price: 120 },
          { id: "ys-2", name: "Ayran", quantity: 1, price: 80 },
        ],
        paymentMethod: "Online Odeme",
        customerNote: "Zili calma",
      }),
    });
    if (webhookResponse.package.status !== "pending_approval") {
      throw new Error("Platform siparisi pending_approval durumunda kaydolmadi.");
    }
    if (webhookResponse.package.customerAddress !== "Mersin Mezitli sahil caddesi webhook no 12") {
      throw new Error("Platform siparisinde musteri adresi customer_address alanina kaydolmadi.");
    }
    if (webhookResponse.package.assignedCourierId) {
      throw new Error("Platform siparisi restoran onayi olmadan kuryeye atandi.");
    }

    const duplicateWebhookResponse = await request("/api/platform/order", {
      method: "POST",
      headers: {
        "x-platform-secret": "smoke-platform-secret",
      },
      body: JSON.stringify({
        platform: "yemeksepeti",
        platformRestaurantId: platformAccount.externalStoreId,
        orderId: webhookResponse.package.externalOrderNo,
        customerName: "Webhook Musteri",
        phone: "5550000000",
        address: "Mersin Mezitli sahil caddesi webhook no 12",
        totalPrice: 320,
      }),
    });
    if (duplicateWebhookResponse.package.id !== webhookResponse.package.id) {
      throw new Error("Duplicate platform siparisi ikinci kez olustu.");
    }

    const rejectedWebhookResponse = await request("/api/platform/order", {
      method: "POST",
      headers: {
        "x-platform-secret": "smoke-platform-secret",
      },
      body: JSON.stringify({
        platform: "yemeksepeti",
        platformRestaurantId: platformAccount.externalStoreId,
        orderId: `YS-REJECT-${Date.now()}`,
        customerName: "Reddedilecek Musteri",
        phone: "05554443322",
        address: "Mersin red test adresi",
        totalPrice: 120,
      }),
    });
    if (rejectedWebhookResponse.package.status !== "pending_approval") {
      throw new Error("Reddedilecek platform siparisi pending_approval olmadi.");
    }
    const pendingRestaurantBootstrap = await request("/api/restaurant/bootstrap", {
      headers: restaurantHeaders,
    });
    if (!pendingRestaurantBootstrap.packages.some((pkg) => pkg.id === webhookResponse.package.id && pkg.status === "pending_approval")) {
      throw new Error("Restoran paneli pending_approval platform siparisini gormedi.");
    }
    const pendingAdminBootstrap = await request("/api/admin/bootstrap", {
      headers: adminHeaders,
    });
    if (!pendingAdminBootstrap.packages.some((pkg) => pkg.id === webhookResponse.package.id && pkg.status === "pending_approval")) {
      throw new Error("Admin paneli pending_approval platform siparisini gormedi.");
    }

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

    const courier2Login = await request("/api/courier/login", {
      method: "POST",
      body: JSON.stringify({
        username: courier2Username,
        password: courier2Password,
      }),
    });
    const courier2Headers = { Authorization: `Bearer ${courier2Login.token}` };
    await request(`/api/courier/packages/${secondManualPackage.id}/status`, {
      method: "PATCH",
      headers: courier2Headers,
      body: JSON.stringify({ status: "accepted_by_courier" }),
    });
    await request(`/api/courier/packages/${secondManualPackage.id}/status`, {
      method: "PATCH",
      headers: courier2Headers,
      body: JSON.stringify({ status: "on_route" }),
    });
    await request(`/api/courier/packages/${secondManualPackage.id}/status`, {
      method: "PATCH",
      headers: courier2Headers,
      body: JSON.stringify({ status: "delivered", paymentStatus: "paid_online" }),
    });
    await delay(1200);

    const courierState4 = await request("/api/admin/couriers", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Smoke Kurye 4",
        username: courier4Username,
        password: courier4Password,
        zone: "Erdemli",
        latitude: courierLatitude + 0.0003,
        longitude: courierLongitude + 0.0003,
        available: true,
      }),
    });
    const createdCourier4 = courierState4.couriers.find((item) => item.username === courier4Username);
    if (!createdCourier4) {
      throw new Error("Dorduncu kurye olusturulamadi.");
    }
    const courierState5 = await request("/api/admin/couriers", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Smoke Kurye 5",
        username: courier5Username,
        password: courier5Password,
        zone: "Erdemli",
        latitude: courierLatitude + 0.0004,
        longitude: courierLongitude + 0.0004,
        available: true,
      }),
    });
    const createdCourier5 = courierState5.couriers.find((item) => item.username === courier5Username);
    if (!createdCourier5) {
      throw new Error("Besinci kurye olusturulamadi.");
    }

    const rejectedState = await request(`/api/restaurant/packages/${rejectedWebhookResponse.package.id}/action`, {
      method: "POST",
      headers: restaurantHeaders,
      body: JSON.stringify({ action: "reject", reason: "Test red" }),
    });
    const rejectedPackage = rejectedState.packages.find((pkg) => pkg.id === rejectedWebhookResponse.package.id);
    if (!rejectedPackage || rejectedPackage.status !== "rejected" || rejectedPackage.assignedCourierId) {
      throw new Error("Reddedilen platform siparisi kuryeye atanmamasi gerekirken akisa girdi.");
    }
    if (!rejectedPackage.platformStatusLogs?.some((item) => item.status === "rejected")) {
      throw new Error("Platform rejected callback logu yazilmadi.");
    }

    const approvedState = await request(`/api/restaurant/packages/${webhookResponse.package.id}/action`, {
      method: "POST",
      headers: restaurantHeaders,
      body: JSON.stringify({ action: "confirm" }),
    });
    const assignedWebhookAfterDelivery = approvedState.packages.find((pkg) => pkg.id === webhookResponse.package.id);
    if (!assignedWebhookAfterDelivery) {
      throw new Error("Onaylanan platform siparisi restoran durumunda bulunamadi.");
    }
    if (!["preparing", "assigned"].includes(assignedWebhookAfterDelivery.status)) {
      throw new Error("Onaylanan platform siparisi preparing veya assigned durumuna gecmedi.");
    }
    if (!assignedWebhookAfterDelivery.platformStatusLogs?.some((item) => item.status === "accepted")) {
      throw new Error("Platform accepted callback logu yazilmadi.");
    }
    if (!assignedWebhookAfterDelivery.platformStatusLogs?.some((item) => item.status === "preparing")) {
      throw new Error("Platform preparing callback logu yazilmadi.");
    }

    const printSource = fs.readFileSync(path.join(__dirname, "restaurant.js"), "utf8");
    if (!printSource.includes(".print()")) {
      throw new Error("Yazdirma ekrani window.print akisini icermiyor.");
    }
    const courierSource = fs.readFileSync(path.join(__dirname, "courier.js"), "utf8");
    if (!courierSource.includes("Restorani Haritada Ac") || !courierSource.includes("Musteriyi Haritada Ac") || !courierSource.includes("openOrderMap")) {
      throw new Error("Kurye paneli restoran/musteri harita butonlarini icermiyor.");
    }

    await delay(1200);
    const afterDeliveryBootstrap = await request("/api/admin/bootstrap", {
      headers: adminHeaders,
    });
    const assignedWebhookPackage = afterDeliveryBootstrap.packages.find((pkg) => pkg.id === assignedWebhookAfterDelivery.id);
    if (!assignedWebhookPackage?.assignedCourierId) {
      throw new Error("Platform siparisi bos kurye olmasina ragmen atanmadi.");
    }
    if (!assignedWebhookPackage.platformStatusLogs?.some((item) => item.status === "assigned")) {
      throw new Error("Platform assigned callback logu yazilmadi.");
    }

    const courier4Login = await request("/api/courier/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        username: courier4Username,
        password: courier4Password,
      }),
    });
    const courier4Headers = { Authorization: `Bearer ${courier4Login.token}` };
    const courier5Login = await request("/api/courier/login", {
      method: "POST",
      body: JSON.stringify({
        username: courier5Username,
        password: courier5Password,
      }),
    });
    const courier5Headers = { Authorization: `Bearer ${courier5Login.token}` };

    const platformCourierHeaders = assignedWebhookPackage.assignedCourierId === createdCourier.id
      ? courierHeaders
      : assignedWebhookPackage.assignedCourierId === createdCourier2.id
        ? courier2Headers
        : assignedWebhookPackage.assignedCourierId === createdCourier4.id
          ? courier4Headers
          : assignedWebhookPackage.assignedCourierId === createdCourier5.id
            ? courier5Headers
        : null;
    if (!platformCourierHeaders) {
      throw new Error("Platform siparisi beklenmeyen kuryeye atandi.");
    }

    const assignedCourierWorkspace = await request("/api/courier/me", {
      headers: platformCourierHeaders,
    });
    if (!assignedCourierWorkspace.packages.some((pkg) => pkg.id === assignedWebhookAfterDelivery.id)) {
      throw new Error("Platform siparisi uygun kurye bosalinca kurye paneline dusmedi.");
    }
    await request(`/api/courier/packages/${assignedWebhookAfterDelivery.id}/status`, {
      method: "PATCH",
      headers: platformCourierHeaders,
      body: JSON.stringify({ status: "accepted_by_courier" }),
    });
    await request(`/api/courier/packages/${assignedWebhookAfterDelivery.id}/status`, {
      method: "PATCH",
      headers: platformCourierHeaders,
      body: JSON.stringify({ status: "on_route" }),
    });
    await request(`/api/courier/packages/${assignedWebhookAfterDelivery.id}/status`, {
      method: "PATCH",
      headers: platformCourierHeaders,
      body: JSON.stringify({ status: "delivered", paymentStatus: "paid_online" }),
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
    if (!restaurantBootstrap.packages.some((pkg) => pkg.id === webhookResponse.package.id && ["preparing", "assigned", "delivered"].includes(pkg.status))) {
      throw new Error("Restoran paneli onaylanan platform siparisini guncel gostermedi.");
    }
    if (!restaurantBootstrap.packages.some((pkg) => pkg.id === rejectedWebhookResponse.package.id && pkg.status === "rejected")) {
      throw new Error("Restoran paneli reddedilen platform siparisini gormedi.");
    }
    if (!restaurantBootstrap.packages.some((pkg) => pkg.assignedCourierName === createdCourier.name)) {
      throw new Error("Restoran panelinde atanmis kurye bilgisi gorunmuyor.");
    }
    if (!restaurantBootstrap.packages.every((pkg) => pkg.paymentStatus && pkg.status)) {
      throw new Error("Restoran paneli siparis veya odeme durumunu eksik aldi.");
    }
    if (!restaurantBootstrap.packages.some((pkg) => pkg.id === thirdManualPackage.id)) {
      throw new Error("Restoran paneli daha once beklemeye dusen siparisi koruyamadi.");
    }

    if (!bootstrap.restaurants.some((restaurant) => restaurant.id === createdRestaurantRecord.id)) {
      throw new Error("Admin bootstrap restoran kaydini dondurmedi.");
    }

    if (!bootstrap.auditLogs.some((log) => log.restaurantId === createdRestaurantRecord.id)) {
      throw new Error("Audit log akisi beklenen tenant kaydini uretmedi.");
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
    await request(`/api/admin/couriers/${createdCourier.id}/availability`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ available: false }),
    });
    await request(`/api/admin/couriers/${createdCourier2.id}/availability`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ available: false }),
    });
    await request(`/api/admin/couriers/${createdCourier4.id}/availability`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ available: false }),
    });
    await request(`/api/admin/couriers/${createdCourier5.id}/availability`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ available: false }),
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
    if (retriedPackage.assignedCourierId !== createdCourier3.id) {
      throw new Error("Farkli bolgedeki ama 5 km icindeki online kurye otomatik atamada secilemedi.");
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
    const deliveredWebhookPackage = bootstrap.packages.find((pkg) => pkg.id === assignedWebhookAfterDelivery.id);
    if (!deliveredWebhookPackage?.platformStatusLogs?.some((item) => item.status === "delivered")) {
      throw new Error("Platform delivered callback logu yazilmadi.");
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
