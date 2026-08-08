const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("new courier design shows a blocking assignment offer and accepts it through the API", async () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "courier-design-source", "performans_raporlar", "code.html"), "utf8");
  const bridge = fs.readFileSync(path.join(root, "courier-design-bridge.js"), "utf8");
  const dom = new JSDOM(html, { url: "http://localhost:3000/courier-reports.html", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const requests = [];
  const assignedPackage = {
    id: "pkg_ui_offer",
    trackingNo: "PKT-UI-OFFER",
    status: "assigned",
    assignedAt: new Date().toISOString(),
    restaurantName: "UI Test Restoran",
    recipient: "UI Test Müşteri",
    deliveryAddress: "Test teslimat adresi",
    paymentMethod: "Online ödendi",
    distanceKm: 1.2,
  };
  const baseWorkspace = {
    courier: { id: "cr_ui", name: "UI Kurye", available: true },
    packages: [assignedPackage],
    historyPackages: [],
    notifications: [{ id: "ntf_ui", message: "Yeni paket atandı.", createdAt: new Date().toISOString() }],
    dayMetrics: { deliveredCount: 0 },
    earningsSummary: { today: {}, last7Days: {} },
    reportSummary: { daily: { deliveredCount: 0, averageDeliveryMinutes: 0 } },
    shiftSummary: {},
  };

  class FakeEventSource {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, handler) { this.listeners.set(type, handler); }
    close() {}
  }
  window.EventSource = FakeEventSource;
  window.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method || "GET", body: options.body || "" });
    const payload = String(url).includes("/status")
      ? { ...baseWorkspace, packages: [{ ...assignedPackage, status: "accepted_by_courier" }] }
      : baseWorkspace;
    return { ok: true, status: 200, json: async () => payload };
  };
  window.localStorage.setItem("kuryeTakipCourierToken", "ui-test-token");
  window.eval(bridge);
  await delay(80);

  const offer = window.document.querySelector(".delivera-offer-modal");
  assert.ok(offer, "assigned package must open the blocking offer");
  assert.match(offer.textContent, /Yeni Paket Düştü/);
  assert.match(offer.textContent, /UI Test Restoran/);
  assert.equal(offer.querySelector(".delivera-close"), null);
  const accept = [...offer.querySelectorAll("button")].find((button) => button.textContent.includes("Paketi Kabul Et"));
  const reject = [...offer.querySelectorAll("button")].find((button) => button.textContent.includes("Paketi Reddet"));
  assert.ok(accept);
  assert.ok(reject);

  accept.click();
  await delay(80);
  assert.ok(requests.some((request) => request.url.includes("/api/courier/packages/pkg_ui_offer/status") && request.method === "PATCH"));
  assert.equal(window.document.querySelector(".delivera-offer-modal"), null);
  dom.window.close();
});
