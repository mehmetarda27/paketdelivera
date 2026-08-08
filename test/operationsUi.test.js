const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");

const rootDir = path.resolve(__dirname, "..");

function jsonResponse(payload = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    async json() {
      return payload;
    },
  };
}

function createPage(htmlFile) {
  return new JSDOM(fs.readFileSync(path.join(rootDir, htmlFile), "utf8"), {
    runScripts: "outside-only",
    url: `http://localhost/${htmlFile}`,
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = async () => jsonResponse({});
      window.EventSource = undefined;
      window.scrollTo = () => {};
      window.prompt = () => null;
      window.PLATFORM_OPTIONS = [];
      window.Notification = { permission: "denied", requestPermission: async () => "denied" };
      window.navigator.wakeLock = { request: async () => ({ addEventListener() {} }) };
    },
  });
}

function evaluatePage(dom, pageScript, exposure) {
  const sharedSource = fs.readFileSync(path.join(rootDir, "shared.js"), "utf8");
  const pageSource = fs.readFileSync(path.join(rootDir, pageScript), "utf8");
  dom.window.eval(sharedSource);
  dom.window.eval(`${pageSource}\n${exposure}`);
}

test.skip("legacy admin UI operations (replaced by the new admin design)", async () => {
  const dom = createPage("admin.html");
  try {
    evaluatePage(dom, "admin.js", `window.__operationsUi = {
      renderUnmatchedOrders,
      renderOrderHistoryOrders,
      initializeOrderHistoryDates,
      openOrderHistoryWorkspace,
      buildCourierOverrideOptions,
      isAdminActivePackage,
      startAdminLiveStream,
      connectLiveStream,
      adminState
    };`);
    await new Promise((resolve) => dom.window.setTimeout(resolve, 20));

    const unmatchedLink = dom.window.document.querySelector('[data-section="adminWorkspace_system_unmatched"]');
    const operationGroup = [...dom.window.document.querySelectorAll(".tree-group")]
      .find((group) => group.querySelector(".tree-header span")?.textContent.trim() === "Operasyon");
    const systemGroup = [...dom.window.document.querySelectorAll(".tree-group")]
      .find((group) => group.querySelector(".tree-header span")?.textContent.trim() === "Sistem & Loglar");
    assert.ok(operationGroup?.contains(unmatchedLink));
    assert.equal(systemGroup?.contains(unmatchedLink), false);

    const historyLink = dom.window.document.querySelector('[data-section="adminWorkspace_ops_history"]');
    assert.ok(operationGroup?.contains(historyLink));
    assert.ok(dom.window.document.getElementById("adminWorkspace_ops_history"));
    assert.ok(dom.window.document.getElementById("orderHistoryShortcut"));
    dom.window.__operationsUi.initializeOrderHistoryDates();
    assert.match(dom.window.document.getElementById("orderHistoryDateFrom").value, /^\d{4}-\d{2}-\d{2}$/);

    const pendingOrder = {
      id: "unm_pending",
      externalOrderId: "POS-ORDER-1",
      externalRestaurantId: "pos-restaurant-1",
      restaurantNameFromPayload: "FLASH HAN TANTUNİ",
      platform: "Trendyol Yemek",
      customerName: "Test Musteri",
      customerPhone: "05550000000",
      totalPrice: 250,
      isResolved: false,
      rawPayload: { pid: "POS-ORDER-1" },
      createdAt: "2026-07-13T18:00:00.000Z",
      updatedAt: "2026-07-13T18:00:00.000Z",
    };
    const resolvedOrder = {
      ...pendingOrder,
      id: "unm_resolved",
      externalOrderId: "POS-ORDER-2",
      isResolved: true,
      resolvedRestaurantId: "rst_flash",
      updatedAt: "2026-07-13T18:01:00.000Z",
    };
    const restaurants = [{ id: "rst_flash", name: "FLASH HAN TANTUNİ" }];

    dom.window.__operationsUi.renderUnmatchedOrders([pendingOrder, resolvedOrder], restaurants);
    const cards = dom.window.document.querySelectorAll(".unmatched-order-card");
    assert.equal(cards.length, 1);
    assert.match(cards[0].textContent, /POS-ORDER-1/);
    assert.equal(dom.window.document.getElementById("unmatchedPendingCount").textContent, "1");
    assert.equal(dom.window.document.getElementById("unmatchedResolvedCount").textContent, "1");
    assert.equal(dom.window.document.querySelector('[data-unmatched-restaurant="unm_pending"]').value, "rst_flash");

    dom.window.__operationsUi.adminState.unmatchedFilter = "resolved";
    dom.window.__operationsUi.renderUnmatchedOrders([pendingOrder, resolvedOrder], restaurants);
    assert.equal(dom.window.document.querySelectorAll(".unmatched-order-card").length, 1);
    assert.match(dom.window.document.querySelector(".unmatched-order-card").textContent, /POS-ORDER-2/);

    assert.equal(dom.window.__operationsUi.isAdminActivePackage({ status: "on_route" }), true);
    assert.equal(dom.window.__operationsUi.isAdminActivePackage({ status: "delivered" }), false);
    assert.match(String(dom.window.__operationsUi.startAdminLiveStream), /order:new/);
    assert.match(String(dom.window.__operationsUi.connectLiveStream), /order:new/);
    assert.match(String(dom.window.__operationsUi.connectLiveStream), /order:unmatched/);

    const archivedPackage = {
      id: "pkg_archived",
      trackingNo: "PKT-ARCHIVE",
      restaurantId: "rst_flash",
      recipient: "Arsiv Musterisi",
      phone: "05551112233",
      assignedCourierId: "cr_1",
      assignedCourierName: "Test Kurye",
      assignedAt: "2026-07-01T12:00:00.000Z",
      createdAt: "2026-07-01T11:45:00.000Z",
      status: "delivered",
      paymentMethod: "cash",
      paymentStatus: "paid",
      orderAmount: 325,
      address: "Mersin Test Adresi",
      zone: "Merkez",
    };
    dom.window.__operationsUi.renderOrderHistoryOrders([archivedPackage], { total: 1, hasMore: false });
    const historyCard = dom.window.document.querySelector('[data-order-history-id="pkg_archived"]');
    assert.match(historyCard.textContent, /PKT-ARCHIVE/);
    assert.match(historyCard.textContent, /Test Kurye/);
    assert.match(historyCard.textContent, /Teslim Edildi/);
    assert.equal(dom.window.document.getElementById("orderHistoryTotalCount").textContent, "1");
    assert.match(dom.window.document.getElementById("orderHistoryShortcut").textContent, /\(1\)/);
    dom.window.__operationsUi.openOrderHistoryWorkspace();
    assert.ok(dom.window.document.getElementById("adminWorkspace_ops_history").classList.contains("active-section"));

    dom.window.__operationsUi.adminState.data = {
      couriers: [
        { id: "cr_free", name: "Bos Kurye", zone: "Merkez", status: "online", activeLoad: 0, latitude: 36.8, longitude: 34.6 },
        { id: "cr_one", name: "Tek Paketli Kurye", zone: "Merkez", status: "busy", activeLoad: 1, latitude: 36.8, longitude: 34.6 },
        { id: "cr_two", name: "Iki Paketli Kurye", zone: "Merkez", status: "busy", activeLoad: 2, latitude: 36.8, longitude: 34.6 },
        { id: "cr_four", name: "Dort Paketli Kurye", zone: "Merkez", status: "busy", activeLoad: 4, latitude: 36.8, longitude: 34.6 },
      ],
    };
    const manualCourierOptions = dom.window.__operationsUi.buildCourierOverrideOptions({ latitude: 36.8, longitude: 34.6 });
    assert.equal(manualCourierOptions.find((option) => option.value === "cr_free").disabled, false);
    assert.equal(manualCourierOptions.find((option) => option.value === "cr_one").disabled, false);
    assert.match(manualCourierOptions.find((option) => option.value === "cr_one").label, /2\. paket/);
    assert.equal(manualCourierOptions.find((option) => option.value === "cr_two").disabled, false);
    assert.match(manualCourierOptions.find((option) => option.value === "cr_two").label, /3\. paket/);
    assert.equal(manualCourierOptions.find((option) => option.value === "cr_four").disabled, true);
    assert.match(manualCourierOptions.find((option) => option.value === "cr_four").label, /limit/);
  } finally {
    dom.window.close();
  }
});

test.skip("legacy restaurant UI active views (replaced by the new restaurant design)", async () => {
  const dom = createPage("restaurant.html");
  try {
    evaluatePage(dom, "restaurant.js", `window.__restaurantOperationsUi = {
      renderActiveOrders,
      renderRecentOrders,
      renderOrderHistory,
      activeOrderPackages,
      startRestaurantLiveStream,
      connectLiveStream,
      buildThermalReceiptHtml,
      isAutoPrintEnabledForRestaurant,
      setAutoPrintEnabledForRestaurant,
      hasAutoPrintedPackage,
      markPackageAutoPrinted,
      queueAutomaticPackagePrint,
      shouldSuppressRestaurantOrderAlert,
      restaurantState
    };`);
    await new Promise((resolve) => dom.window.setTimeout(resolve, 20));

    const recentTimestamp = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const activePackage = {
      id: "pkg_active",
      trackingNo: "PKT-ACTIVE",
      status: "on_route",
      source: "trendyol",
      sourcePlatform: "Trendyol Yemek",
      restaurantName: "FLASH HAN TANTUNİ",
      recipient: "Aktif Musteri",
      createdAt: recentTimestamp,
      updatedAt: recentTimestamp,
      items: [],
    };
    const deliveredPackage = {
      ...activePackage,
      id: "pkg_delivered",
      trackingNo: "PKT-DELIVERED",
      status: "delivered",
      recipient: "Teslim Musteri",
      updatedAt: recentTimestamp,
      deliveredAt: recentTimestamp,
    };
    const data = {
      packages: [activePackage, deliveredPackage],
      couriers: [],
      restaurants: [{ id: "rst_flash", name: "FLASH HAN TANTUNİ" }],
    };

    dom.window.__restaurantOperationsUi.renderRecentOrders(data.packages);
    dom.window.__restaurantOperationsUi.renderActiveOrders(data);
    dom.window.__restaurantOperationsUi.renderOrderHistory(data.packages);

    assert.match(dom.window.document.getElementById("recentOrders").textContent, /PKT-ACTIVE/);
    assert.doesNotMatch(dom.window.document.getElementById("recentOrders").textContent, /PKT-DELIVERED/);
    assert.match(dom.window.document.getElementById("activeOrders").textContent, /PKT-ACTIVE/);
    assert.doesNotMatch(dom.window.document.getElementById("activeOrders").textContent, /PKT-DELIVERED/);
    assert.match(dom.window.document.getElementById("orderHistory").textContent, /PKT-DELIVERED/);
    assert.match(dom.window.document.getElementById("activeOrders").textContent, /58 mm Fiş Yazdır/);
    assert.match(dom.window.document.getElementById("orderHistory").textContent, /Fişi Tekrar Yazdır/);
    assert.equal(dom.window.__restaurantOperationsUi.activeOrderPackages(data.packages).length, 1);
    assert.match(String(dom.window.__restaurantOperationsUi.startRestaurantLiveStream), /order:new/);
    assert.match(String(dom.window.__restaurantOperationsUi.connectLiveStream), /order:new/);
    assert.equal(dom.window.__restaurantOperationsUi.shouldSuppressRestaurantOrderAlert({
      type: "package-created",
      source: "external_manual",
      suppressRestaurantAlert: true,
    }), true);
    assert.equal(dom.window.__restaurantOperationsUi.shouldSuppressRestaurantOrderAlert({
      type: "order:new",
      source: "trendyol",
    }), false);

    const receiptHtml = dom.window.__restaurantOperationsUi.buildThermalReceiptHtml({
      ...activePackage,
      externalOrderNo: "TY-123",
      recipient: "<script>alert(1)</script>",
      address: "Test adresi",
      phone: "05550000000",
      paymentMethod: "Online",
      orderAmount: 250,
      items: [{ name: "Tantuni", quantity: 2, price: 125 }],
    }, "Test Restoran");
    assert.match(receiptHtml, /@page \{ size: 58mm auto/);
    assert.match(receiptHtml, /2×/);
    assert.match(receiptHtml, /Tantuni/);
    assert.doesNotMatch(receiptHtml, /<script>alert\(1\)<\/script>/);
    assert.match(receiptHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);

    const printState = dom.window.__restaurantOperationsUi.restaurantState;
    printState.selectedRestaurantId = "rst_flash";
    assert.equal(dom.window.__restaurantOperationsUi.isAutoPrintEnabledForRestaurant("rst_flash"), false);
    assert.equal(dom.window.__restaurantOperationsUi.queueAutomaticPackagePrint({ packageId: "pkg_active" }), false);
    assert.equal(dom.window.__restaurantOperationsUi.setAutoPrintEnabledForRestaurant("rst_flash", true), true);
    assert.equal(dom.window.__restaurantOperationsUi.isAutoPrintEnabledForRestaurant("rst_flash"), true);
    assert.equal(dom.window.__restaurantOperationsUi.queueAutomaticPackagePrint({ packageId: "pkg_active" }), true);
    assert.equal(printState.pendingAutoPrintKeys.has("pkg_active"), true);
    assert.equal(dom.window.__restaurantOperationsUi.hasAutoPrintedPackage("rst_flash", "pkg_active"), false);
    dom.window.__restaurantOperationsUi.markPackageAutoPrinted("rst_flash", "pkg_active");
    dom.window.__restaurantOperationsUi.markPackageAutoPrinted("rst_flash", "pkg_active");
    assert.equal(dom.window.__restaurantOperationsUi.hasAutoPrintedPackage("rst_flash", "pkg_active"), true);
    assert.deepEqual(
      JSON.parse(dom.window.localStorage.getItem("deliveraRestaurantPrintedPackages:rst_flash")),
      ["pkg_active"]
    );
  } finally {
    dom.window.close();
  }
});
