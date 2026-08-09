const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("courier design refreshes an expired access token without showing login", async () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "courier-design-source", "profil_ve_ayarlar", "code.html"), "utf8");
  const bridge = fs.readFileSync(path.join(root, "courier-design-bridge.js"), "utf8");
  const dom = new JSDOM(html, { url: "http://localhost:3000/courier-profile.html", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const requests = [];
  const workspace = {
    courier: { id: "cr_refresh", name: "Refresh Kurye", available: true },
    packages: [],
    historyPackages: [],
    notifications: [],
    dayMetrics: { deliveredCount: 0 },
    earningsSummary: { today: {}, last7Days: {} },
    reportSummary: { daily: {} },
    shiftSummary: {},
  };

  window.__DELIVERA_TEST__ = true;
  window.scrollTo = () => {};
  window.EventSource = class { addEventListener() {} close() {} };
  window.fetch = async (url, options = {}) => {
    const request = { url: String(url), options };
    requests.push(request);
    if (request.url === "/api/courier/refresh") {
      assert.deepEqual(JSON.parse(options.body), { refreshToken: "old-refresh-token" });
      return { ok: true, status: 200, json: async () => ({ token: "new-access-token", refreshToken: "new-refresh-token" }) };
    }
    if (request.url.startsWith("/api/courier/me") && options.headers.Authorization === "Bearer old-access-token") {
      return { ok: false, status: 401, json: async () => ({ error: "Oturum suresi doldu." }) };
    }
    if (request.url.startsWith("/api/courier/me") && options.headers.Authorization === "Bearer new-access-token") {
      return { ok: true, status: 200, json: async () => workspace };
    }
    throw new Error(`Unexpected request: ${request.url}`);
  };
  window.localStorage.setItem("kuryeTakipCourierToken", "old-access-token");
  window.localStorage.setItem("kuryeTakipCourierRefreshToken", "old-refresh-token");
  assert.equal(window.document.documentElement.classList.contains("delivera-booting"), true);
  window.eval(bridge);
  await delay(100);

  assert.equal(window.localStorage.getItem("kuryeTakipCourierToken"), "new-access-token");
  assert.equal(window.localStorage.getItem("kuryeTakipCourierRefreshToken"), "new-refresh-token");
  assert.equal(window.document.querySelector(".delivera-login"), null);
  assert.equal(window.document.documentElement.classList.contains("delivera-booting"), false);
  assert.match(window.document.body.textContent, /Refresh Kurye/);
  assert.equal(requests.filter((request) => request.url.startsWith("/api/courier/me")).length, 2);
  dom.window.close();
});
