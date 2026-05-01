const { getPlatformAdapter, normalizePlatformKey } = require("../platform-adapters");

const PLATFORM = "Trendyol Go";
const DEFAULT_BASE_URL = "https://apigw.trendyol.com";
const REQUEST_TIMEOUT_MS = 8_000;

function trimmed(value) {
  return String(value ?? "").trim();
}

function sellerId(account) {
  return trimmed(account?.externalStoreId || account?.sellerId);
}

function ordersEndpoint(account, params = {}) {
  const overrideUrl = trimmed(account?.settings?.ordersUrl || process.env.TRENDYOL_ORDERS_URL);
  const baseUrl = overrideUrl || `${trimmed(process.env.TRENDYOL_BASE_URL) || DEFAULT_BASE_URL}/integration/order/sellers/${encodeURIComponent(sellerId(account))}/orders`;
  const url = new URL(baseUrl);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  });
  return url.toString();
}

function authHeaders(account) {
  const headers = { Accept: "application/json" };
  if (account?.apiKey && account?.apiSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${account.apiKey}:${account.apiSecret}`).toString("base64")}`;
  }
  return headers;
}

function statusMessage(status) {
  if (status === 200) return "API aktif, devam et.";
  if (status === 401) return "API key hatali.";
  if (status === 403) return "API erisimi yok.";
  if (status === 404) return "Endpoint yanlis.";
  if (status === "timeout") return "Baglanti yok.";
  return `Trendyol API HTTP ${status}.`;
}

async function fetchWithTimeout(url, account) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: "GET",
      headers: authHeaders(account),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function testConnection(account) {
  if (!sellerId(account) || !account?.apiKey || !account?.apiSecret) {
    return { ok: false, status: 401, message: "Trendyol Seller ID, API key ve API secret zorunludur." };
  }

  const url = ordersEndpoint(account);
  try {
    const response = await fetchWithTimeout(url, account);
    return {
      ok: response.status === 200,
      status: response.status,
      message: statusMessage(response.status),
    };
  } catch (error) {
    return { ok: false, status: "timeout", message: statusMessage("timeout") };
  }
}

async function fetchOrders(account) {
  if (!sellerId(account) || !account?.apiKey || !account?.apiSecret) {
    throw new Error("Trendyol Seller ID, API key ve API secret zorunludur.");
  }

  const response = await fetchWithTimeout(ordersEndpoint(account, { status: "Created" }), account);
  if (!response.ok) {
    throw new Error(statusMessage(response.status));
  }
  const data = await response.json();
  return Array.isArray(data) ? data : (data.orders || data.content || []);
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
