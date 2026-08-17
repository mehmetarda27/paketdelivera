const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const rootDir = path.resolve(__dirname, "..");

function jsonResponse(payload) {
  return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => payload };
}

test("new restaurant design filters closed orders and subscribes to named live events", async () => {
  const eventTypes = new Set();
  const desktopPrints = [];
  const desktopNotifications = [];
  class FakeEventSource {
    addEventListener(type) { eventTypes.add(type); }
    close() {}
  }
  const html = fs.readFileSync(path.join(rootDir, "restaurant-design-source", "code.html"), "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost/restaurant-panel", pretendToBeVisual: true });
  try {
    dom.window.__DELIVERA_TEST__ = true;
    dom.window.EventSource = FakeEventSource;
    dom.window.deliveraDesktop = {
      autoPrintReceipt: async (payload) => { desktopPrints.push(payload); return { ok: true }; },
      showNotification: async (payload) => { desktopNotifications.push(payload); return { ok: true }; },
    };
    dom.window.localStorage.setItem("deliveraRestaurantToken", "test-token");
    dom.window.fetch = async () => jsonResponse({ packages: [], couriers: [], restaurants: [] });
    dom.window.eval(fs.readFileSync(path.join(rootDir, "restaurant-design-bridge.js"), "utf8"));
    await new Promise((resolve) => dom.window.setTimeout(resolve, 30));

    const hooks = dom.window.__restaurantDesignTest;
    assert.equal(hooks.platformKey("ty"), "trendyol");
    assert.equal(hooks.platformKey("Trendyol Yemek"), "trendyol");
    assert.equal(hooks.platformKey("gy"), "getir");
    assert.equal(hooks.platformKey("my"), "migros");
    assert.equal(hooks.platformKey("ys"), "yemeksepeti");
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    const today = new Date().toISOString();
    hooks.hydrate({
      packages: [
        { id: "pkg_active", trackingNo: "PKT-ACTIVE", status: "on_route", sourcePlatform: "Trendyol Yemek", updatedAt: yesterday, items: [{ name: "Tantuni", quantity: 2, price: 125, extraIngredients: [{ name: "Kaşar" }], note: "Acısız" }] },
        { id: "pkg_delivered", trackingNo: "PKT-DELIVERED", status: "delivered", sourcePlatform: "Yemeksepeti", deliveredAt: today },
        { id: "pkg_old", trackingNo: "PKT-OLD", status: "delivered", sourcePlatform: "Yemeksepeti", deliveredAt: yesterday },
      ],
      couriers: [],
      restaurants: [],
    });
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    assert.equal(desktopPrints.length, 1);
    assert.equal(desktopPrints[0].packageId, "pkg_active");
    assert.match(desktopPrints[0].html, /SİPARİŞ İÇERİĞİ|SÄ°PARÄ°Å Ä°Ã‡ERÄ°ÄÄ°/);
    assert.doesNotMatch(desktopPrints[0].html, /window\.print/);
    assert.equal(desktopNotifications.length, 1);
    const platformAttention = dom.window.document.querySelector(".zg-platform-attention-root");
    assert.ok(platformAttention);
    assert.match(platformAttention.textContent, /Trendyol/);
    assert.match(platformAttention.textContent, /PKT-ACTIVE/);
    assert.match(platformAttention.textContent, /yalnızca uyarıyı kapatır/);
    platformAttention.querySelector("[data-platform-seen]").click();
    assert.equal(dom.window.document.querySelector(".zg-platform-attention-root"), null);
    assert.match(dom.window.localStorage.getItem("deliveraRestaurantPlatformAttentionAcknowledged"), /pkg_active/);
    hooks.hydrate({
      packages: [{ id: "pkg_phone", trackingNo: "PKT-PHONE", status: "pending", source: "phone", createdAt: today }],
      couriers: [],
      restaurants: [],
    });
    assert.equal(dom.window.document.querySelector(".zg-platform-attention-root"), null);
    hooks.hydrate({
      packages: [
        { id: "pkg_active", trackingNo: "PKT-ACTIVE", status: "on_route", sourcePlatform: "Trendyol Yemek", updatedAt: yesterday, items: [{ name: "Tantuni", quantity: 2, price: 125, extraIngredients: [{ name: "Kaşar" }], note: "Acısız" }] },
        { id: "pkg_delivered", trackingNo: "PKT-DELIVERED", status: "delivered", sourcePlatform: "Yemeksepeti", deliveredAt: today },
        { id: "pkg_old", trackingNo: "PKT-OLD", status: "delivered", sourcePlatform: "Yemeksepeti", deliveredAt: yesterday },
      ],
      couriers: [],
      restaurants: [],
    });
    hooks.state.filter = "active";
    assert.deepEqual(Array.from(hooks.currentPackages(), (pkg) => pkg.id), ["pkg_active"]);
    hooks.state.filter = "all";
    assert.deepEqual(Array.from(hooks.currentPackages(), (pkg) => pkg.id), ["pkg_active", "pkg_delivered"]);
    const actionLabels = Array.from(dom.window.document.querySelectorAll("#restaurantOrders [data-action]"), (button) => button.textContent.trim());
    ["Yazdır", "Zaman", "Sipariş Detayı"].forEach((label) => assert.ok(actionLabels.includes(label), label));
    assert.equal(actionLabels.includes("Faturalı Fiş"), false);
    dom.window.document.querySelector('#restaurantOrders button[data-action="detail"]').click();
    const detailModalText = dom.window.document.querySelector(".zg-modal-root")?.textContent || "";
    assert.match(detailModalText, /PKT-ACTIVE/);
    assert.match(detailModalText, /2× Tantuni/);
    assert.match(detailModalText, /Ekstra: Kaşar/);
    assert.match(detailModalText, /Not: Acısız/);
    dom.window.document.querySelector(".zg-modal-root [data-close]")?.click();
    let printedHtml = "";
    dom.window.open = () => ({ document: { write(value) { printedHtml += value; }, close() {} } });
    dom.window.document.querySelector('#restaurantOrders [data-action="print"]').click();
    const printModal = dom.window.document.querySelector(".zg-modal-root");
    assert.ok(printModal);
    assert.equal(printModal.querySelectorAll("[data-print-size]").length, 3);
    printModal.querySelector("[data-save-print-default]").checked = false;
    printModal.querySelector('[data-print-size="58mm"]').click();
    assert.match(printedHtml, /@page\{size:58mm auto/);
    assert.match(printedHtml, /DELIVERA <span>EXPRESS<\/span>/);
    assert.match(printedHtml, /Delivera Express altyapısıyla yönetilmektedir/);
    assert.match(printedHtml, /SİPARİŞ İÇERİĞİ/);
    assert.match(printedHtml, /2× Tantuni/);
    assert.match(printedHtml, /Birim: 125,00 ₺/);
    assert.match(printedHtml, /250,00 ₺/);
    assert.match(printedHtml, /Ekstra: Kaşar/);
    assert.match(printedHtml, /Not: Acısız/);
    hooks.connectStream();
    ["order:new", "package-created", "package-assigned", "package-status", "courier-location", "courier-availability", "workspace-update"].forEach((type) => assert.ok(eventTypes.has(type), type));

    hooks.state.data.couriers = [
      { id: "online", status: "online", available: true, latitude: 36.81, longitude: 34.64, lastLocationAt: today },
      { id: "offline", status: "offline", available: false, latitude: 36.81, longitude: 34.64, lastLocationAt: today },
      { id: "stale", status: "online", available: true, latitude: 36.81, longitude: 34.64, lastLocationAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() },
    ];
    assert.deepEqual(
      Array.from(hooks.restaurantLiveMapCouriers({ latitude: 36.8121, longitude: 34.6415 }), (courier) => courier.id),
      ["online"],
    );
  } finally {
    dom.window.close();
  }
});
