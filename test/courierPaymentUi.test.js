const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");

const rootDir = path.resolve(__dirname, "..");

function createCourierPage() {
  const dom = new JSDOM(fs.readFileSync(path.join(rootDir, "courier.html"), "utf8"), {
    runScripts: "outside-only",
    url: "http://localhost/courier.html",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({}) });
      window.EventSource = undefined;
      window.scrollTo = () => {};
      window.Notification = { permission: "denied", requestPermission: async () => "denied" };
      window.navigator.wakeLock = { request: async () => ({ addEventListener() {} }) };
    },
  });
  dom.window.eval(fs.readFileSync(path.join(rootDir, "shared.js"), "utf8"));
  const courierSource = fs.readFileSync(path.join(rootDir, "courier.js"), "utf8")
    .replace(/\nloadCourierWorkspace\(\);\s*$/, "");
  dom.window.eval(`${courierSource}\nwindow.__paymentUi = { renderPackages, courierState };`);
  dom.window.__paymentUi.courierState.data = { mapsConfig: {}, courier: {} };
  return dom;
}

function onRoutePackage(overrides = {}) {
  return {
    id: "pkg-payment-ui",
    trackingNo: "PKT-TEST",
    status: "on_route",
    recipient: "Test Musteri",
    phone: "05550000000",
    deliveryAddress: "Test adresi",
    customerAddress: "Test adresi",
    customerLat: 36.8,
    customerLng: 34.6,
    restaurantName: "Test Restoran",
    restaurantId: "rst_test",
    zone: "Yenisehir",
    eta: "15 dk",
    assignedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    orderAmount: 250,
    paymentMethod: "Online Odeme",
    paymentMethodCode: "paid_online",
    paymentStatus: "paid_online",
    items: [],
    ...overrides,
  };
}

test("online odemede sahte tahsilat secimi yerine sabit odeme durumu gosterilir", () => {
  const dom = createCourierPage();
  try {
    dom.window.__paymentUi.renderPackages([onRoutePackage()]);
    const actions = dom.window.document.querySelector(".courier-card-actions");
    const collectionSelect = [...actions.querySelectorAll("select")]
      .find((select) => select.textContent.includes("Tahsilat"));
    assert.equal(collectionSelect, undefined);
    assert.match(actions.querySelector(".courier-payment-summary")?.textContent || "", /Online/);
    assert.equal(actions.querySelector(".courier-action-note"), null);
  } finally {
    dom.window.close();
  }
});

test("kapida odemede tahsilat secimi acilir ve not alani normal metin alanidir", () => {
  const dom = createCourierPage();
  try {
    dom.window.__paymentUi.renderPackages([onRoutePackage({
      paymentMethod: "Nakit",
      paymentMethodCode: "cash_on_delivery",
      paymentStatus: "cash_expected",
    })]);
    const actions = dom.window.document.querySelector(".courier-card-actions");
    const collectionSelect = [...actions.querySelectorAll("select")]
      .find((select) => select.textContent.includes("Tahsilat"));
    const noteInput = actions.querySelector(".courier-action-note");
    assert.ok(collectionSelect);
    assert.ok(noteInput);
    assert.equal(noteInput.classList.contains("status-select"), false);
    assert.equal(noteInput.classList.contains("hidden"), true);

    collectionSelect.value = "cash_collected";
    collectionSelect.dispatchEvent(new dom.window.Event("change"));
    assert.equal(noteInput.classList.contains("hidden"), false);
  } finally {
    dom.window.close();
  }
});
