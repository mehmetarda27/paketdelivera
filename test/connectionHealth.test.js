const assert = require("node:assert/strict");
const test = require("node:test");
const { createConnectionHealthService, HEALTH_STATUS, HEALTH_ERROR_CODES } = require("../services/connectionHealthService");

function fakeDb() {
  const updates = [];
  return {
    updates,
    prepare() {
      return {
        run(...args) {
          updates.push(args);
          return { changes: 1 };
        },
      };
    },
  };
}

test("saved webhook account without webhook becomes warning", async () => {
  const db = fakeDb();
  const service = createConnectionHealthService({
    db,
    platformAccountMissingCredentials: () => false,
    providerHealthUrlForAccount: () => "",
  });
  const result = await service.checkAccount({
    id: "pla_1",
    active: true,
    webhookEnabled: true,
    webhookSecret: "fixture",
    externalStoreId: "store-1",
    platform: "Yemeksepeti",
  });
  assert.equal(result.status, HEALTH_STATUS.WARNING);
  assert.equal(result.errorCode, HEALTH_ERROR_CODES.WEBHOOK_NOT_RECEIVED);
});

test("provider timeout is standardized", async () => {
  const db = fakeDb();
  const service = createConnectionHealthService({
    db,
    timeoutMs: 1,
    platformAccountMissingCredentials: () => false,
    providerHealthUrlForAccount: () => "https://provider.example/health",
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("timeout");
        error.name = "AbortError";
        reject(error);
      });
    }),
  });
  const result = await service.checkAccount({
    id: "pla_2",
    active: true,
    webhookEnabled: true,
    webhookSecret: "fixture",
    externalStoreId: "store-2",
    platform: "Getir Yemek",
  });
  assert.equal(result.status, HEALTH_STATUS.ERROR);
  assert.equal(result.errorCode, HEALTH_ERROR_CODES.TIMEOUT);
});

test("successful provider health check becomes connected", async () => {
  const db = fakeDb();
  const service = createConnectionHealthService({
    db,
    platformAccountMissingCredentials: () => false,
    providerHealthUrlForAccount: () => "https://provider.example/health",
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  const result = await service.checkAccount({
    id: "pla_3",
    active: true,
    webhookEnabled: true,
    webhookSecret: "fixture",
    externalStoreId: "store-3",
    platform: "Migros Yemek",
  });
  assert.equal(result.status, HEALTH_STATUS.CONNECTED);
  assert.equal(result.ok, true);
});
