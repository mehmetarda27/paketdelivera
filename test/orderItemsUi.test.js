const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const root = path.join(__dirname, "..");

function read(name) {
  return fs.readFileSync(path.join(root, name), "utf8");
}

test("shared product box renders item details safely and handles missing platform items", () => {
  const dom = new JSDOM("<!doctype html><body></body>", {
    runScripts: "outside-only",
    url: "http://localhost/admin.html",
  });
  try {
    dom.window.fetch = async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({}) });
    dom.window.scrollTo = () => {};
    dom.window.eval(read("shared.js"));

    const html = dom.window.renderOrderItemsBox({
      items: [{
        name: "Tavuk <script>unsafe()</script>",
        quantity: 2,
        totalPrice: 480,
        extraIngredients: [{ name: "Kaşar" }],
        removedIngredients: ["Soğan"],
        note: "Acısız",
      }],
    });
    const host = dom.window.document.createElement("div");
    host.innerHTML = html;
    assert.match(host.textContent, /2×/);
    assert.match(host.textContent, /Tavuk <script>unsafe\(\)<\/script>/);
    assert.match(host.textContent, /Ekstra: Kaşar/);
    assert.match(host.textContent, /Çıkarılan: Soğan/);
    assert.match(host.textContent, /Not: Acısız/);
    assert.equal(host.querySelector("script"), null);

    const emptyHost = dom.window.document.createElement("div");
    emptyHost.innerHTML = dom.window.renderOrderItemsBox({ items: [] });
    assert.match(emptyHost.textContent, /Ürün bilgisi platformdan gelmedi/);
  } finally {
    dom.window.close();
  }
});

test("admin, restaurant detail and courier information surfaces are wired to the shared product box", () => {
  const adminHtml = read("admin.html");
  const courierHtml = read("courier.html");
  const adminScript = read("admin.js");
  const courierScript = read("courier.js");
  const restaurantScript = read("restaurant.js");
  const sharedScript = read("shared.js");

  assert.match(adminHtml, /class="order-items-slot"/);
  assert.match(courierHtml, /class="courier-order-items"/);
  assert.match(adminScript, /renderOrderItemsBox\?\.\(pkg, \{ compact: true \}\)/);
  assert.match(courierScript, /renderOrderItemsBox\?\.\(pkg, \{ compact: true \}\)/);
  assert.match(sharedScript, /\$\{window\.renderOrderItemsBox\(pkg\)\}/);
  assert.match(restaurantScript, /showPackageDetailsModal\?\.\(pkg\)/);
});
