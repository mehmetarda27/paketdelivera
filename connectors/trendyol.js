const { getPlatformAdapter, normalizePlatformKey } = require("../platform-adapters");
const logger = require("../services/logger");

const PLATFORM = "Trendyol Yemek";
const REQUEST_TIMEOUT_MS = 8_000;

function trimmed(value) {
  return String(value ?? "").trim();
}

function sellerId(account) {
  return trimmed(account?.sellerId || account?.externalMerchantId || account?.externalStoreId);
}

function missingCredentialsResult() {
  return {
    ok: false,
    optional: true,
    manualAvailable: true,
    status: 200,
    message: "API bilgileri eksik, manuel paket sistemi kullanilabilir.",
  };
}

function ordersEndpoint(account, params = {}) {
  const configuredUrl = trimmed(account?.settings?.ordersUrl) ||
    trimmed(process.env.TRENDYOL_YEMEK_ORDERS_URL) ||
    trimmed(process.env.TRENDYOL_ORDERS_URL) ||
    trimmed(process.env.TRENDYOL_POLLING_URL);

  if (configuredUrl) {
    const url = new URL(configuredUrl);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, value);
      }
    });
    return url.toString();
  }

  const base = trimmed(process.env.TRENDYOL_YEMEK_BASE_URL) || trimmed(process.env.TRENDYOL_BASE_URL);
  if (!base) {
    return "";
  }

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

function endpointNotConfiguredError() {
  const error = new Error("Polling endpoint ayarlı değil");
  error.code = "POLLING_ENDPOINT_NOT_CONFIGURED";
  return error;
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
      ...missingCredentialsResult(),
      message: "Trendyol Seller ID eksik. API bilgileri eksik, manuel paket sistemi kullanilabilir.",
    };
  }

  try {
    authHeaders(account);
  } catch (error) {
    return {
      ...missingCredentialsResult(),
      message: `${error.message}. API bilgileri eksik, manuel paket sistemi kullanilabilir.`,
    };
  }

  const url = ordersEndpoint(account);
  if (!url) {
    return { ok: false, status: 404, message: "Polling endpoint ayarlı değil" };
  }

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
    logger.warn("Connector skipped because seller id is missing", { platform: PLATFORM, reason: "seller_id_missing" });
    return [];
  }

  try {
    authHeaders(account);
  } catch {
    logger.warn("Connector skipped because API credentials are missing", { platform: PLATFORM, reason: "api_credentials_missing" });
    return [];
  }

  const endpoint = ordersEndpoint(account, { status: "Created" });
  if (!endpoint) {
    logger.warn("Polling endpoint not configured", { platform: PLATFORM, accountId: account?.id || null });
    throw endpointNotConfiguredError();
  }

  const response = await fetchWithTimeout(
    endpoint,
    account
  );

  if (!response.ok) {
    throw new Error(statusMessage(response.status));
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("Invalid JSON from polling endpoint");
  }

  if (Array.isArray(data)) return data;
  if (Array.isArray(data.orders)) return data.orders;
  if (Array.isArray(data.content)) return data.content;
  if (Array.isArray(data.data)) return data.data;

  return [];
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
  return {
    ok: false,
    mode: "not_configured",
    orderId: order?.orderId || order?.platformOrderId || null,
  };
}

async function updateOrderStatus(account, orderId, status) {
  return {
    ok: false,
    mode: "not_configured",
    orderId,
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
