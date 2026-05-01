const { getPlatformAdapter, normalizePlatformKey } = require("../platform-adapters");

const PLATFORM = "Trendyol Go";
const DEFAULT_BASE_URL = "https://apigw.trendyol.com";
const REQUEST_TIMEOUT_MS = 8_000;

function trimmed(value) {
  return String(value ?? "").trim();
}

function sellerId(account) {
  return trimmed(account?.externalId || account?.sellerId || account?.externalStoreId);
}

function ordersEndpoint(account, params = {}) {
  const base =
    trimmed(process.env.TRENDYOL_BASE_URL) ||
    DEFAULT_BASE_URL;

  const url = new URL(
    `${base}/integration/order/sellers/${encodeURIComponent(sellerId(account))}/orders`
  );

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  });

  return url.toString();
}

function authHeaders(account) {
  const apiKey = trimmed(account?.apiKey);
  const apiSecret = trimmed(account?.apiSecret);

  if (!apiKey || !apiSecret) {
    throw new Error("API Key veya API Secret eksik");
  }

  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0",
    Authorization: `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`,
  };
}

function statusMessage(status) {
  if (status === 200) return "API aktif, devam et.";
  if (status === 401) return "API Key veya API Secret hatalı olabilir.";
  if (status === 403) return "API erişimi yok veya bu satıcı için yetki kapalı.";
  if (status === 404) return "Endpoint yanlış veya Seller ID hatalı olabilir.";
  if (status === "timeout") return "Bağlantı zaman aşımına uğradı.";
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
  const sid = sellerId(account);

  if (!sid) {
    return {
      ok: false,
      status: 400,
      message: "Trendyol Seller ID eksik.",
    };
  }

  try {
    authHeaders(account);
  } catch (error) {
    return {
      ok: false,
      status: 401,
      message: error.message,
    };
  }

  const url = ordersEndpoint(account);

  try {
    const response = await fetchWithTimeout(url, account);

    let detail = "";
    try {
      const text = await response.text();
      if (text) detail = text.slice(0, 300);
    } catch {}

    return {
      ok: response.status === 200,
      status: response.status,
      message: detail
        ? `${statusMessage(response.status)} Detay: ${detail}`
        : statusMessage(response.status),
    };
  } catch (error) {
    return {
      ok: false,
      status: "timeout",
      message: statusMessage("timeout"),
    };
  }
}

async function fetchOrders(account) {
  const sid = sellerId(account);

  if (!sid) {
    throw new Error("Trendyol Seller ID eksik.");
  }

  authHeaders(account);

  const response = await fetchWithTimeout(
    ordersEndpoint(account, { status: "Created" }),
    account
  );

  if (!response.ok) {
    throw new Error(statusMessage(response.status));
  }

  const data = await response.json();

  if (Array.isArray(data)) return data;
  if (Array.isArray(data.orders)) return data.orders;
  if (Array.isArray(data.content)) return data.content;
  if (Array.isArray(data.data)) return data.data;

  return [];
}

function normalizeOrder(raw) {
  return getPlatformAdapter(normalizePlatformKey(PLATFORM)).normalizeOrder({
    ...raw,
    platform: PLATFORM,
  });
}

async function acknowledgeOrder(order) {
  return {
    ok: true,
    mode: "local",
    orderId: order?.orderId || order?.platformOrderId || null,
  };
}

async function updateOrderStatus(order, status) {
  return {
    ok: true,
    mode: "local",
    orderId: order?.orderId || order?.platformOrderId || null,
    status,
  };
}

module.exports = {
  testConnection,
  fetchOrders,
  normalizeOrder,
  acknowledgeOrder,
  updateOrderStatus,
};