const assert = require("node:assert/strict");
const test = require("node:test");
const { sendPlatformStatusCallback } = require("../services/platformCallbackService");

function fakeDb(rows = []) {
  return {
    prepare() {
      return {
        all() {
          return rows;
        },
      };
    },
  };
}

test("platform callback skips safely when URL is not configured", async () => {
  const previousGlobal = process.env.DELIVERA_PLATFORM_CALLBACK_URL;
  const previousPlatform = process.env.DELIVERA_PLATFORM_CALLBACK_URL_YEMEKSEPETI;
  delete process.env.DELIVERA_PLATFORM_CALLBACK_URL;
  delete process.env.DELIVERA_PLATFORM_CALLBACK_URL_YEMEKSEPETI;

  try {
    const result = await sendPlatformStatusCallback({
      db: fakeDb([{ id: "acc_1", restaurant_id: "rst_1", platform: "Yemeksepeti", active: 1 }]),
      packageRecord: {
        id: "pkg_1",
        restaurantId: "rst_1",
        sourcePlatform: "Yemeksepeti",
        externalOrderId: "ord_1",
      },
      status: "assigned",
    });

    assert.equal(result.ok, false);
    assert.equal(result.mode, "not_configured");
    assert.equal(result.status, "not_configured");
  } finally {
    if (previousGlobal === undefined) delete process.env.DELIVERA_PLATFORM_CALLBACK_URL;
    else process.env.DELIVERA_PLATFORM_CALLBACK_URL = previousGlobal;
    if (previousPlatform === undefined) delete process.env.DELIVERA_PLATFORM_CALLBACK_URL_YEMEKSEPETI;
    else process.env.DELIVERA_PLATFORM_CALLBACK_URL_YEMEKSEPETI = previousPlatform;
  }
});

test("platform callback uses env URL and sends status payload", async () => {
  const previousUrl = process.env.DELIVERA_PLATFORM_CALLBACK_URL_YEMEKSEPETI;
  const previousFetch = global.fetch;
  process.env.DELIVERA_PLATFORM_CALLBACK_URL_YEMEKSEPETI = "https://partner.example.test/status";
  let captured = null;
  global.fetch = async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return {
      ok: true,
      status: 200,
      async text() {
        return "ok";
      },
    };
  };

  try {
    const result = await sendPlatformStatusCallback({
      db: fakeDb([{ id: "acc_1", restaurant_id: "rst_1", platform: "Yemeksepeti", active: 1, static_token: "secret" }]),
      packageRecord: {
        id: "pkg_1",
        restaurantId: "rst_1",
        sourcePlatform: "Yemeksepeti",
        externalOrderId: "ord_1",
        platformRestaurantId: "6377deac15d5d59aee02bf51",
        posentegraId: "pid_1",
        assignedCourierId: "cou_1",
      },
      status: "assigned",
      meta: { courierId: "cou_1" },
    });

    assert.equal(result.ok, true);
    assert.equal(result.mode, "http_callback");
    assert.equal(captured.url, "https://partner.example.test/status");
    assert.equal(captured.options.method, "POST");
    assert.equal(captured.options.headers["X-Delivera-Event"], "status.updated");
    assert.ok(captured.options.headers["X-Delivera-Signature"]);
    assert.equal(captured.body.orderId, "ord_1");
    assert.equal(captured.body.restaurantId, "rst_1");
    assert.equal(captured.body.platformRestaurantId, "6377deac15d5d59aee02bf51");
    assert.equal(captured.body.posentegraId, "pid_1");
    assert.equal(captured.body.courierId, "cou_1");
    assert.equal(captured.body.status, "assigned");
  } finally {
    if (previousUrl === undefined) delete process.env.DELIVERA_PLATFORM_CALLBACK_URL_YEMEKSEPETI;
    else process.env.DELIVERA_PLATFORM_CALLBACK_URL_YEMEKSEPETI = previousUrl;
    global.fetch = previousFetch;
  }
});
