const { getPlatformAdapter, normalizePlatformKey } = require("../platform-adapters");

const PLATFORM = "POS";
const ENV_PREFIX = "POS";
const REQUEST_TIMEOUT_MS = 8_000;

function trimmed(value) {
  return String(value ?? "").trim();
}

function endpoint(account, kind) {
  const envKind = kind.toUpperCase();
  return (
    trimmed(account?.settings?.[`${kind}Url`]) ||
    trimmed(account?.settings?.[`adisyo${envKind[0]}${envKind.slice(1).toLowerCase()}Url`]) ||
    trimmed(process.env[`${ENV_PREFIX}_${envKind}_URL`]) ||
    trimmed(process.env[`ADISYO_${envKind}_URL`]) ||
    trimmed(process.env[`${ENV_PREFIX}_ADISYO_${envKind}_URL`])
  );
}

function missingEndpointResult() {
  return {
    ok: false,
    optional: true,
    manualAvailable: true,
    status: "missing_endpoint",
    message: "API endpoint eksik. Adisyo/POS verify veya polling endpoint tanimli degil.",
  };
}

function endpointMissingError(kind) {
  const error = new Error("API endpoint eksik");
  error.code = "POS_ENDPOINT_MISSING";
  error.kind = kind;
  return error;
}

function authHeaders(account) {
  const headers = { Accept: "application/json" };
  if (account?.accessToken) headers.Authorization = `Bearer ${account.accessToken}`;
  if (account?.token && !headers.Authorization) headers.Authorization = `Bearer ${account.token}`;
  if (account?.apiKey) headers["x-api-key"] = account.apiKey;
  if (account?.apiSecret) headers["x-api-secret"] = account.apiSecret;
  if (account?.webhookSecret) headers["x-webhook-secret"] = account.webhookSecret;
  if (account?.posSecretKey) headers["x-pos-secret-key"] = account.posSecretKey;
  if (account?.integrationReferenceCode) headers["x-integration-reference-code"] = account.integrationReferenceCode;
  if (account?.externalStoreId) headers["x-pos-store-id"] = account.externalStoreId;
  return headers;
}

async function fetchWithTimeout(url, account) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { method: "GET", headers: authHeaders(account), signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function testConnection(account) {
  console.log("POS verify başladı", {
    accountId: account?.id || null,
    platformRestaurantId: account?.externalStoreId || null,
    hasToken: Boolean(account?.token || account?.accessToken),
    hasApiSecret: Boolean(account?.apiSecret),
    hasPosSecretKey: Boolean(account?.posSecretKey),
  });
  const url = endpoint(account, "verify") || endpoint(account, "orders");
  if (!url) return missingEndpointResult();
  try {
    const response = await fetchWithTimeout(url, account);
    return { ok: response.ok, status: response.status, message: response.ok ? "OK" : `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, status: "timeout", message: error.message };
  }
}

async function fetchOrders(account) {
  const url = endpoint(account, "orders");
  console.log("POS polling başladı", {
    accountId: account?.id || null,
    platformRestaurantId: account?.externalStoreId || null,
    endpointConfigured: Boolean(url),
  });
  if (!url) throw endpointMissingError("orders");
  const response = await fetchWithTimeout(url, account);
  if (!response.ok) throw new Error(`POS polling HTTP ${response.status}`);
  const data = await response.json();
  const orders = Array.isArray(data) ? data : (data.orders || data.items || data.content || data.data || []);
  orders.forEach((order) => {
    console.log("POS sipariş bulundu", {
      orderId: order?.orderId || order?.order_id || order?.receiptNo || order?.ticketNo || order?.id || null,
      platformRestaurantId: order?.platformRestaurantId || order?.platform_restaurant_id || order?.posStoreId || order?.storeId || account?.externalStoreId || null,
    });
  });
  return orders;
}

function normalizeOrder(raw) {
  return getPlatformAdapter(normalizePlatformKey(PLATFORM)).normalizeOrder({ ...raw, platform: PLATFORM });
}

async function acknowledgeOrder(order) {
  return { ok: true, mode: "local", orderId: order?.orderId || order?.platformOrderId || null };
}

async function updateOrderStatus(order, status) {
  return { ok: true, mode: "local", orderId: order?.orderId || order?.platformOrderId || null, status };
}

module.exports = { testConnection, fetchOrders, normalizeOrder, acknowledgeOrder, updateOrderStatus };
