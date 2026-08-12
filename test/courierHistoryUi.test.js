const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("courier can open real completed order history with delivery details", async () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "courier-design-source", "performans_raporlar", "code.html"), "utf8");
  const bridge = fs.readFileSync(path.join(root, "courier-design-bridge.js"), "utf8");
  const dom = new JSDOM(html, { url: "http://localhost:3000/courier-reports.html", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const finishedAt = new Date().toISOString();
  const workspace = {
    courier: { id: "cr_history", name: "Geçmiş Kurye", available: false },
    packages: [],
    historyPackages: [{ id: "pkg_history", trackingNo: "PKT-GECMIS-1", status: "delivered", restaurantName: "Geçmiş Restoran", recipient: "Geçmiş Müşteri", deliveryAddress: "Geçmiş teslimat adresi", orderAmount: 325, paymentMethod: "Online ödendi", deliveredAt: finishedAt, createdAt: finishedAt }],
    notifications: [], dayMetrics: { deliveredCount: 1 }, earningsSummary: { today: {}, last7Days: {} }, reportSummary: { daily: { deliveredCount: 1, averageDeliveryMinutes: 12 } }, shiftSummary: {},
  };
  window.__DELIVERA_TEST__ = true;
  window.EventSource = class { addEventListener() {} close() {} };
  window.fetch = async () => ({ ok: true, status: 200, json: async () => workspace });
  window.localStorage.setItem("kuryeTakipCourierToken", "history-token");
  window.eval(bridge);
  await delay(70);

  window.__courierDesignTest.packageSheet("history");
  const modal = window.document.querySelector(".delivera-modal");
  assert.ok(modal);
  assert.match(modal.textContent, /Geçmiş Siparişler/);
  assert.match(modal.textContent, /PKT-GECMIS-1/);
  assert.match(modal.textContent, /Geçmiş Restoran/);
  assert.match(modal.textContent, /Geçmiş teslimat adresi/);
  assert.match(modal.textContent, /325/);
  assert.match(modal.textContent, /Teslim edildi/);
  dom.window.close();
});

test("courier active package sheet shows customer phone and keeps the call action", async () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "courier-design-source", "performans_raporlar", "code.html"), "utf8");
  const bridge = fs.readFileSync(path.join(root, "courier-design-bridge.js"), "utf8");
  const dom = new JSDOM(html, { url: "http://localhost:3000/courier-reports.html", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const workspace = {
    courier: { id: "cr_phone", name: "Telefon Kuryesi", available: true },
    packages: [{ id: "pkg_phone", trackingNo: "PKT-TELEFON", status: "on_route", recipient: "Müşteri", phone: "0531 466 89 27", restaurantName: "Test Restoran", deliveryAddress: "Test adresi", paymentMethod: "Online ödendi" }],
    historyPackages: [], notifications: [], dayMetrics: {}, earningsSummary: { today: {}, last7Days: {} }, reportSummary: { daily: {} }, shiftSummary: {},
  };
  window.__DELIVERA_TEST__ = true;
  window.EventSource = class { addEventListener() {} close() {} };
  window.fetch = async () => ({ ok: true, status: 200, json: async () => workspace });
  window.localStorage.setItem("kuryeTakipCourierToken", "phone-token");
  window.eval(bridge);
  await delay(70);

  window.__courierDesignTest.packageSheet("road");
  const modal = window.document.querySelector(".delivera-modal");
  assert.match(modal.textContent, /Müşteri telefonu/);
  assert.match(modal.textContent, /0531 466 89 27/);
  assert.equal(modal.querySelector('a[href="tel:05314668927"]')?.textContent, "Müşteriyi Ara");
  dom.window.close();
});

test("courier sees admin payment changes and earning adjustments", async () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "courier-design-source", "performans_raporlar", "code.html"), "utf8");
  const bridge = fs.readFileSync(path.join(root, "courier-design-bridge.js"), "utf8");
  const dom = new JSDOM(html, { url: "http://localhost:3000/courier-reports.html?view=payment-changes", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const workspace = {
    courier: { id: "cr_records", name: "Kayıt Kuryesi", available: true }, packages: [], historyPackages: [], notifications: [],
    dayMetrics: {}, earningsSummary: { today: {}, last7Days: {}, total: {} }, reportSummary: { daily: {} }, shiftSummary: {},
    managementRecords: [
      { id: "pay-1", recordType: "payment_change", title: "Nakit düzeltmesi", amount: 75, startDate: "2026-08-08", status: "active", note: "Admin kaydı" },
      { id: "adj-1", recordType: "courier_adjustment", title: "Başarı ödülü", amount: 125, startDate: "2026-08-08", status: "active" },
    ],
  };
  window.__DELIVERA_TEST__ = true;
  window.scrollTo = () => {};
  window.EventSource = class { addEventListener() {} close() {} };
  window.fetch = async () => ({ ok: true, status: 200, json: async () => workspace });
  window.localStorage.setItem("kuryeTakipCourierToken", "records-token");
  window.eval(bridge);
  await delay(70);
  assert.match(window.document.body.textContent, /Nakit düzeltmesi/);
  assert.match(window.document.body.textContent, /Admin kaydı/);
  dom.window.close();
});
