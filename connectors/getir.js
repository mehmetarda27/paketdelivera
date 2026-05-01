const { getPlatformAdapter, normalizePlatformKey } = require("../platform-adapters");

const PLATFORM = "GetirYemek";
const ENV_PREFIX = "GETIR";

function trimmed(value) {
  return String(value ?? "").trim();
}

function endpoint(account, kind) {
  return trimmed(account?.settings?.[`${kind}Url`]) || trimmed(process.env[`${ENV_PREFIX}_${kind.toUpperCase()}_URL`]);
}

function authHeaders(account) {
  const headers = { Accept: "application/json" };
  if (account?.accessToken) headers.Authorization = `Bearer ${account.accessToken}`;
  if (account?.apiKey) headers["x-api-key"] = account.apiKey;
  if (account?.apiSecret) headers["x-api-secret"] = account.apiSecret;
  if (account?.externalStoreId) headers["x-restaurant-id"] = account.externalStoreId;
  return headers;
}

async function testConnection(account) {
  const url = endpoint(account, "verify") || endpoint(account, "orders");
  if (!url) return { ok: false, status: 404, message: "Getir verify/polling endpoint tanimli degil." };
  try {
    const response = await fetch(url, { method: "GET", headers: authHeaders(account) });
    return { ok: response.ok, status: response.status, message: response.ok ? "OK" : `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, status: "timeout", message: error.message };
  }
}

async function fetchOrders(account) {
  const url = endpoint(account, "orders");
  if (!url) return [];
  const response = await fetch(url, { method: "GET", headers: authHeaders(account) });
  if (!response.ok) throw new Error(`Getir polling HTTP ${response.status}`);
  const data = await response.json();
  return Array.isArray(data) ? data : (data.orders || data.foodOrders || data.items || []);
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
