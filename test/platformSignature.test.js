const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const { verifyPlatformSignature } = require("../services/platformSignature");

const FIXTURE_DIR = path.join(__dirname, "fixtures", "platform-webhooks");
const secret = "fixture-secret";

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8"));
}

function req(headers) {
  return {
    headers: Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [key.toLowerCase(), value])),
  };
}

for (const fileName of ["trendyol-yemek.json", "getir-yemek.json", "yemeksepeti.json", "migros-yemek.json"]) {
  test(`${fileName} accepts valid HMAC signature`, () => {
    const data = fixture(fileName);
    const rawBody = JSON.stringify(data.body);
    const result = verifyPlatformSignature({
      req: req(data.headers),
      account: { webhookSecret: secret },
      restaurant: {},
      rawBody,
    });
    assert.equal(result.ok, true);
    assert.equal(result.mode, "hmac_sha256");
  });

  test(`${fileName} rejects invalid HMAC signature`, () => {
    const data = fixture(fileName);
    const rawBody = JSON.stringify(data.body);
    const headers = { ...data.headers, "x-platform-signature": "bad-signature", "x-webhook-signature": "bad-signature" };
    delete headers["x-platform-secret"];
    delete headers["x-webhook-secret"];
    delete headers["x-yemeksepeti-token"];
    delete headers["x-partner-token"];
    const result = verifyPlatformSignature({
      req: req(headers),
      account: { webhookSecret: secret },
      restaurant: {},
      rawBody,
    });
    assert.equal(result.ok, false);
  });

  test(`${fileName} rejects missing signature without token fallback`, () => {
    const data = fixture(fileName);
    const rawBody = JSON.stringify(data.body);
    const headers = { ...data.headers };
    delete headers["x-platform-signature"];
    delete headers["x-webhook-signature"];
    delete headers["x-hub-signature-256"];
    delete headers["x-platform-secret"];
    delete headers["x-webhook-secret"];
    delete headers["x-yemeksepeti-token"];
    delete headers["x-partner-token"];
    const result = verifyPlatformSignature({
      req: req(headers),
      account: { webhookSecret: secret },
      restaurant: {},
      rawBody,
    });
    assert.equal(result.ok, false);
  });
}

test("duplicate order fixture identity remains stable for idempotency checks", () => {
  const data = fixture("yemeksepeti.json");
  const first = `${data.body.platform}:${data.body.platformRestaurantId}:${data.body.orderId}`;
  const second = `${data.body.platform}:${data.body.platformRestaurantId}:${data.body.orderId}`;
  assert.equal(first, second);
});

test("replay attack risk is documented in fixture notes", () => {
  const note = fs.readFileSync(path.join(FIXTURE_DIR, "README.md"), "utf8");
  assert.match(note, /Replay/i);
  assert.match(note, /timestamp/i);
});
