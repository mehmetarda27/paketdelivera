const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("courier profile sends day close to the admin collection workflow", async () => {
  const today = new Date();
  const localDateKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "courier-design-source", "profil_ve_ayarlar", "code.html"), "utf8");
  const bridge = fs.readFileSync(path.join(root, "courier-design-bridge.js"), "utf8");
  const dom = new JSDOM(html, { url: "http://localhost:3000/courier-profile.html", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const workspace = {
    courier: { id: "cr_day_close", name: "Gün Sonu Kurye", available: true },
    packages: [],
    historyPackages: [{ id: "pkg-history", trackingNo: "PKT-GECMIS-15", status: "delivered", restaurantName: "Geçmiş Restoran", recipient: "Müşteri", deliveryAddress: "Teslimat adresi", orderAmount: 250, deliveredAt: new Date().toISOString() }],
    notifications: [],
    dayMetrics: { deliveredCount: 5, totalAmount: 475, cashCollectedAmount: 300, failedCollectionTotal: 0, hasClosedDay: false },
    earningsSummary: { today: { courierEarnings: 475 }, last7Days: {} },
    reportSummary: { daily: {} },
    shiftSummary: {},
    managementRecords: [{ id: "leave-1", recordType: "courier_leave", title: "Haftalık izin", note: "Planlı izin", startDate: localDateKey, endDate: localDateKey, status: "active" }],
  };
  const requests = [];
  window.__DELIVERA_TEST__ = true;
  window.scrollTo = () => {};
  window.EventSource = class { addEventListener() {} close() {} };
  window.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url === "/api/courier/day-close") {
      workspace.dayMetrics.hasClosedDay = true;
      return { ok: true, status: 200, json: async () => ({ ...workspace, dayCloseReport: { cashCollectedAmount: 300, status: "pending_approval" } }) };
    }
    return { ok: true, status: 200, json: async () => workspace };
  };
  window.localStorage.setItem("kuryeTakipCourierToken", "day-close-token");
  window.eval(bridge);
  await delay(80);

  const dayCloseButton = window.document.querySelector("[data-courier-day-close]");
  const packageHistoryButton = window.document.querySelector("[data-courier-package-history]");
  assert.ok(packageHistoryButton);
  assert.match(packageHistoryButton.textContent, /Geçmiş Paketler/);
  assert.match(packageHistoryButton.textContent, /1 tamamlanan paket/);
  packageHistoryButton.click();
  assert.match(window.document.querySelector(".delivera-sheet").textContent, /Geçmiş Siparişler/);
  assert.match(window.document.querySelector(".delivera-sheet").textContent, /PKT-GECMIS-15/);
  window.document.querySelector(".delivera-close").click();
  const leaveButton = [...window.document.querySelectorAll("button")].find((button) => button.textContent.includes("İzin Günüm"));
  assert.ok(leaveButton);
  leaveButton.click();
  assert.match(window.document.querySelector(".delivera-sheet").textContent, /İzinli · Haftalık izin · Planlı izin/);
  window.document.querySelector(".delivera-close").click();
  assert.ok(dayCloseButton);
  assert.match(dayCloseButton.textContent, /Gün Sonu Al/);
  dayCloseButton.click();
  const submit = window.document.querySelector(".delivera-day-close-submit");
  assert.ok(submit);
  assert.match(window.document.querySelector(".delivera-sheet").textContent, /Kurye Tahsilat/);
  submit.click();
  await delay(40);

  const dayCloseRequest = requests.find((item) => item.url === "/api/courier/day-close");
  assert.ok(dayCloseRequest);
  assert.equal(dayCloseRequest.options.method, "POST");
  assert.match(window.document.querySelector("[data-day-close-label]").textContent, /Gün Sonu Alındı/);
  assert.equal(dayCloseButton.disabled, false);
  dayCloseButton.click();
  assert.match(window.document.querySelector(".delivera-sheet").textContent, /daha önce alındı/);
  dom.window.close();
});
