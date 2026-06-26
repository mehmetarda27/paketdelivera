const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { JSDOM } = require("jsdom");

const rootDir = path.resolve(__dirname, "..");

function workspacePayload(available, packages = [], historyPackages = []) {
  return {
    courier: {
      id: "cr_test",
      name: "Test Kurye",
      zone: "Merkez",
      latitude: 36.8,
      longitude: 34.6,
      available,
      status: available ? "online" : "offline",
      lastLocationAt: "2026-06-23T10:00:00.000Z",
      username: "testkurye",
    },
    packages,
    historyPackages,
    notifications: [],
    announcements: [],
    dayMetrics: null,
    earningsSummary: null,
    shiftSummary: {
      currentShift: null,
      recentShifts: [],
      shiftPlans: [],
    },
  };
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "content-type" ? "application/json" : "";
      },
    },
    async json() {
      return payload;
    },
  };
}

async function loadCourierPage(available, packages = [], historyPackages = []) {
  const html = fs.readFileSync(path.join(rootDir, "courier.html"), "utf8");
  const sharedJs = fs.readFileSync(path.join(rootDir, "shared.js"), "utf8");
  const courierJs = fs.readFileSync(path.join(rootDir, "courier.js"), "utf8");
  let watchCount = 0;
  let clearCount = 0;

  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://localhost/courier.html",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = async (requestPath) => {
        if (String(requestPath).startsWith("/api/courier/me")) {
          return jsonResponse(workspacePayload(available, packages, historyPackages));
        }
        return jsonResponse({});
      };
      window.Notification = {
        permission: "denied",
        requestPermission: async () => "denied",
      };
      window.navigator.geolocation = {
        watchPosition() {
          watchCount += 1;
          return watchCount;
        },
        clearWatch() {
          clearCount += 1;
        },
        getCurrentPosition() {},
      };
      window.navigator.wakeLock = {
        request: async () => ({ addEventListener() {} }),
      };
      window.EventSource = undefined;
      window.scrollTo = () => {};
    },
  });

  dom.window.__deliveraInitialCourierAuth = { token: "token", refreshToken: "refresh" };
  dom.window.eval(sharedJs);
  dom.window.eval(courierJs);

  await new Promise((resolve) => dom.window.setTimeout(resolve, 50));
  return {
    dom,
    get watchCount() {
      return watchCount;
    },
    get clearCount() {
      return clearCount;
    },
  };
}

test("courier connection switch mirrors backend online state after reload", async () => {
  const page = await loadCourierPage(true);
  const connectionSwitch = page.dom.window.document.getElementById("courierConnectionSwitch");
  const locationStatus = page.dom.window.document.getElementById("locationStatus");

  assert.equal(connectionSwitch.checked, true);
  assert.equal(connectionSwitch.getAttribute("aria-checked"), "true");
  assert.equal(locationStatus.textContent, "Hayırlı günler");
  assert.equal(page.watchCount, 1);

  page.dom.window.close();
});

test("courier connection switch stays off after reload when backend is offline", async () => {
  const page = await loadCourierPage(false);
  const connectionSwitch = page.dom.window.document.getElementById("courierConnectionSwitch");
  const locationStatus = page.dom.window.document.getElementById("locationStatus");

  assert.equal(connectionSwitch.checked, false);
  assert.equal(connectionSwitch.getAttribute("aria-checked"), "false");
  assert.equal(locationStatus.textContent, "Hayırlı akşamlar");
  assert.equal(page.watchCount, 0);
  assert.equal(page.clearCount, 0);

  page.dom.window.close();
});

test("courier task area stays blank when every package is closed", async () => {
  const closedPackage = {
    id: "pkg_done",
    trackingNo: "PKT-DONE",
    externalOrderNo: "DONE-1",
    recipient: "Teslim Edilen Musteri",
    phone: "555",
    restaurantName: "Test Restoran",
    sourcePlatform: "Panel",
    source: "manual",
    zone: "Merkez",
    eta: "Planlanacak",
    paymentMethod: "Nakit",
    paymentStatus: "cash_collected",
    orderAmount: 100,
    deliveryAddress: "Kapanan adres",
    address: "Kapanan adres",
    status: "delivered",
    assignedAt: "2026-06-23T10:00:00.000Z",
    updatedAt: "2026-06-23T10:15:00.000Z",
    deliveredAt: "2026-06-23T10:15:00.000Z",
    rawPayload: {},
  };
  const page = await loadCourierPage(true, [closedPackage], [closedPackage]);
  const focusCard = page.dom.window.document.querySelector(".courier-focus-card");
  const destinationMap = page.dom.window.document.getElementById("courierDestinationMap");
  const packageList = page.dom.window.document.getElementById("courierPackages");

  assert.equal(focusCard.classList.contains("hidden"), true);
  assert.equal(destinationMap.classList.contains("hidden"), true);
  assert.equal(packageList.textContent.trim(), "");

  page.dom.window.close();
});
