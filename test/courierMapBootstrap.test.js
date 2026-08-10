const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

test("courier map does not render the old mock map layer before Leaflet starts", () => {
  const root = path.join(__dirname, "..");
  const files = [
    path.join(root, "courier.html"),
    path.join(root, "courier-design-source", "ana_harita_ekran", "code.html"),
  ];

  for (const file of files) {
    const dom = new JSDOM(fs.readFileSync(file, "utf8"));
    const map = dom.window.document.querySelector(".map-bg");
    assert.ok(map, `${path.basename(file)} map canvas is missing`);
    assert.equal(map.childElementCount, 0, `${path.basename(file)} still contains a mock map layer`);
    dom.window.close();
  }
});
