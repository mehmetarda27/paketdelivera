const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

test("new admin restaurant management exposes coordinate editing and the live location endpoint", () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "admin-design-source", "code.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "admin-design-bridge.js"), "utf8");
  const dom = new JSDOM(html);
  const document = dom.window.document;
  assert.match(document.querySelector("aside").textContent, /Kuryeler/);
  assert.match(document.querySelector("aside").textContent, /İşletmeler/);
  assert.match(script, /function editRestaurantLocation\(restaurant\)/);
  assert.match(script, /input name="latitude"/);
  assert.match(script, /input name="longitude"/);
  assert.match(script, /\/api\/admin\/restaurants\/\$\{encodeURIComponent\(restaurant\.id\)\}\/location/);
});
