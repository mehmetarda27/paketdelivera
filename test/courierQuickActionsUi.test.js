const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("courier quick actions start closed and manager call uses the configured fallback number", async () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "courier-design-source", "ana_harita_ekran", "code.html"), "utf8");
  const bridge = fs.readFileSync(path.join(root, "courier-design-bridge.js"), "utf8");
  const dom = new JSDOM(html, { url: "http://localhost:3000/courier.html", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const workspace = {
    courier: { id: "cr_quick", name: "Hızlı İşlem Kurye", available: false, latitude: 36.81, longitude: 34.64 },
    packages: [], historyPackages: [{ id: "pkg-history", status: "delivered" }], notifications: [], restaurants: [],
    dayMetrics: {}, earningsSummary: { today: {}, last7Days: {} }, reportSummary: { daily: {} }, shiftSummary: {},
  };
  window.EventSource = class { addEventListener() {} close() {} };
  window.fetch = async () => ({ ok: true, status: 200, json: async () => workspace });
  window.localStorage.setItem("kuryeTakipCourierToken", "quick-action-token");
  window.eval(bridge);
  await delay(80);

  const managerButton = [...window.document.querySelectorAll("button")].find((button) => button.querySelector(".material-symbols-outlined")?.textContent.trim() === "phone_in_talk");
  assert.ok(managerButton);
  assert.equal(managerButton.getAttribute("aria-label"), "Yöneticiyi 0531 466 89 27 numarasından ara");
  assert.ok(managerButton.closest(".delivera-side-menu").classList.contains("is-collapsed"));
  assert.equal(window.document.querySelector("[data-delivera-history-pill]"), null);
  assert.match(bridge, /05314668927/);
  dom.window.close();
});
