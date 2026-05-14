const { getPlatformAdapter, normalizePlatformKey } = require("../platform-adapters");
const logger = require("../services/logger");

const PLATFORM = "Getir Yemek";
const ENV_PREFIX = "GETIR";
const REQUEST_TIMEOUT_MS = 8_000;

function trimmed(value) {
  return String(value ?? "").trim();
}

function endpoint(account, kind) {
  return trimmed(account?.settings?.[`${kind}Url`]) ||
    trimmed(process.env[`${ENV_PREFIX}_${kind.toUpperCase()}_URL`]) ||
    (kind === "orders" ? trimmed(process.env.GETIR_POLLING_URL) : "");
}

function authHeaders(account) {
  const headers = { Accept: "application/json" };
  if (account?.accessToken) headers.Authorization = `Bearer ${account.accessToken}`;
  if (account?.apiKey) headers["x-api-key"] = account.apiKey;
  if (account?.apiSecret) headers["x-api-secret"] = account.apiSecret;
  if (account?.externalStoreId) headers["x-restaurant-id"] = account.externalStoreId;
  return headers;
}

function hasPollingCredentials(account) {
  return Boolean(account?.apiKey || account?.apiSecret || account?.accessToken || account?.token);
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function testConnection(account) {
  const url = endpoint(account, "verify") || endpoint(account, "orders");
  if (!url) return { ok: false, status: 404, message: "Getir verify/polling endpoint tanimli degil." };
  try {
    const response = await fetchWithTimeout(url, { method: "GET", headers: authHeaders(account) });
    return { ok: response.ok, status: response.status, message: response.ok ? "OK" : `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, status: "timeout", message: error.message };
  }
}

async function fetchOrders(account) {
  const url = endpoint(account, "orders");
  if (!hasPollingCredentials(account)) {
    logger.warn("Connector skipped because polling config is missing", { platform: PLATFORM, reason: "polling_endpoint_or_credentials_missing" });
    return [];
  }
  if (!url) {
    logger.warn("Polling endpoint not configured", { platform: PLATFORM, accountId: account?.id || null });
    const error = new Error("Polling endpoint ayarlı değil");
    error.code = "POLLING_ENDPOINT_NOT_CONFIGURED";
    throw error;
  }
  const response = await fetchWithTimeout(url, { method: "GET", headers: authHeaders(account) });
  if (!response.ok) throw new Error(`Getir polling HTTP ${response.status}`);
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("Invalid JSON from polling endpoint");
  }
  return Array.isArray(data) ? data : (data.orders || data.foodOrders || data.items || []);
}

function normalizeOrder(raw, account = {}) {
  const normalized = getPlatformAdapter(normalizePlatformKey(PLATFORM)).normalizeOrder({
    ...raw,
    platform: PLATFORM,
    platformRestaurantId: raw?.platformRestaurantId || raw?.platform_restaurant_id || account.externalStoreId,
  });
  return {
    platform: PLATFORM,
    restaurantId: account.restaurantId,
    externalStoreId: normalized.platformRestaurantId || account.externalStoreId,
    orderId: normalized.orderId,
    customerName: normalized.customerName,
    phone: normalized.phone,
    address: normalized.address,
    totalPrice: normalized.totalPrice,
    paymentMethod: normalized.paymentMethod,
    note: normalized.customerNote || "",
    rawPayload: raw,
  };
}

async function acknowledgeOrder(order) {
  return { ok: false, mode: "not_configured", orderId: order?.orderId || order?.platformOrderId || null };
}

async function updateOrderStatus(account, orderId, status) {
  return { ok: false, mode: "not_configured", orderId, status };
}

module.exports = { testConnection, fetchOrders, normalizeOrder, acknowledgeOrder, updateOrderStatus };
