const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

test("restaurant location management is placed below courier management and wired to its endpoint", () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "admin.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "admin.js"), "utf8");
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const courierLink = document.querySelector('[data-section="adminWorkspace_management_couriers"]');
  const restaurantLink = document.querySelector('[data-section="adminWorkspace_management_restaurants"]');

  assert.ok(courierLink);
  assert.ok(restaurantLink);
  assert.equal(courierLink.nextElementSibling, restaurantLink);
  assert.ok(document.getElementById("adminWorkspace_management_restaurants"));
  assert.ok(document.getElementById("adminRestaurantLocationTableBody"));
  assert.ok(document.getElementById("adminRestaurantLocationModal"));
  assert.ok(document.querySelector('#adminRestaurantLocationForm input[name="latitude"]'));
  assert.ok(document.querySelector('#adminRestaurantLocationForm input[name="longitude"]'));

  assert.match(script, /renderRestaurantLocationManagement\(data\.restaurants \|\| \[\]\)/);
  assert.match(script, /\/api\/admin\/restaurants\/\$\{encodeURIComponent\(restaurantId\)\}\/location/);
  assert.match(script, /item\.latitude, item\.longitude/);
});
