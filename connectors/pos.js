const { getPlatformAdapter, normalizePlatformKey } = require("../platform-adapters");
const logger = require("../services/logger");

const PLATFORM = "POS";
const REQUEST_TIMEOUT_MS = 8_000;
const DEFAULT_ADISYO_POLLING_PATH = "/integration/order/sellers/{sellerId}/orders";
let envCheckLogged = false;

function trimmed(value) {
  return String(value ?? "").trim();
}

function sellerId(account) {
  return trimmed(account?.platformRestaurantId || account?.externalStoreId || account?.externalId);
}

function replaceSellerId(value, account) {
  return trimmed(value).replaceAll("{sellerId}", encodeURIComponent(sellerId(account)));
}

function joinUrl(base, path) {
  const normalizedBase = trimmed(base).replace(/\/+$/, "");
  const normalizedPath = trimmed(path).replace(/^\/+/, "");
  if (!normalizedBase || !normalizedPath) {
    return "";
  }
  return `${normalizedBase}/${normalizedPath}`;
}

function pollingEndpoint(account) {
  logEnvCheck();
  const directUrl =
    trimmed(account?.settings?.ordersUrl) ||
    trimmed(account?.settings?.pollingUrl) ||
    trimmed(account?.settings?.adisyoPollingUrl) ||
    trimmed(process.env.ADISYO_POLLING_URL) ||
    trimmed(process.env.POS_ORDERS_URL) ||
    trimmed(process.env.POS_POLLING_URL);

  if (directUrl) {
    return replaceSellerId(directUrl, account);
  }

  const baseUrl =
    trimmed(account?.settings?.baseUrl) ||
    trimmed(account?.settings?.adisyoBaseUrl) ||
    trimmed(process.env.ADISYO_API_BASE_URL);
  const path =
    trimmed(account?.settings?.pollingPath) ||
    trimmed(process.env.ADISYO_POLLING_PATH) ||
    DEFAULT_ADISYO_POLLING_PATH;

  return replaceSellerId(joinUrl(baseUrl, path), account);
}

function verifyEndpoint(account) {
  logEnvCheck();
  const directUrl =
    trimmed(account?.settings?.verifyUrl) ||
    trimmed(account?.settings?.adisyoVerifyUrl) ||
    trimmed(process.env.ADISYO_VERIFY_URL) ||
    trimmed(process.env.POS_VERIFY_URL);

  return directUrl ? replaceSellerId(directUrl, account) : "";
}

function endpoint(account, kind) {
  return kind === "verify" ? verifyEndpoint(account) : pollingEndpoint(account);
}

function logEnvCheck() {
  if (envCheckLogged) {
    return;
  }
  envCheckLogged = true;
  logger.debug("POS connector environment checked", {
    baseUrl: process.env.ADISYO_API_BASE_URL || process.env["ADİSYO_API_BASE_URL"],
    path: process.env.ADISYO_POLLING_PATH || process.env["ADİSYO_POLLING_PATH"],
  });
}

function endpointConfigured(account) {
  return Boolean(endpoint(account, "orders"));
}

function missingEndpointResult() {
  return {
    ok: false,
    optional: true,
    manualAvailable: true,
    status: "missing_endpoint",
    message: "POS API endpoint eksik. ADISYO_API_BASE_URL veya ADISYO_POLLING_URL tanimlayin.",
  };
}

function endpointMissingError(kind) {
  const error = new Error("API endpoint eksik");
  error.code = "POS_ENDPOINT_MISSING";
  error.kind = kind;
  return error;
}

function authHeaders(account) {
  const token = trimmed(account?.token || account?.accessToken);
  const apiSecret = trimmed(account?.apiSecret || account?.webhookSecret);
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (account?.apiKey) headers["x-api-key"] = account.apiKey;
  if (apiSecret) headers["x-api-secret"] = apiSecret;
  if (account?.posSecretKey) headers["x-pos-secret-key"] = account.posSecretKey;
  if (account?.integrationReferenceCode) headers["x-integration-reference-code"] = account.integrationReferenceCode;
  if (account?.externalStoreId) headers["x-pos-store-id"] = account.externalStoreId;
  return headers;
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
  const url = endpoint(account, "verify") || endpoint(account, "orders");
  const hasToken = Boolean(trimmed(account?.token || account?.accessToken));
  const hasApiSecret = Boolean(trimmed(account?.apiSecret || account?.webhookSecret));

  logger.info("POS verify started", {
    accountId: account?.id || null,
    platformRestaurantId: sellerId(account) || null,
    endpointConfigured: Boolean(url),
    hasToken,
    hasApiSecret,
    hasPosSecretKey: Boolean(account?.posSecretKey),
  });

  if (!url) return missingEndpointResult();
  if (!hasToken) {
    return {
      ok: false,
      optional: true,
      manualAvailable: true,
      status: "missing_token",
      message: "POS token eksik. Token alanini doldurun.",
    };
  }
  if (!hasApiSecret) {
    return {
      ok: false,
      optional: true,
      manualAvailable: true,
      status: "missing_api_secret",
      message: "POS API Secret eksik. Webhook Secret veya API Secret alanini doldurun.",
    };
  }

  try {
    const response = await fetchWithTimeout(url, account);
    return {
      ok: response.ok,
      status: response.status,
      message: response.ok ? "OK" : `HTTP ${response.status}`,
    };
  } catch (error) {
    return { ok: false, status: "timeout", message: error.message };
  }
}

async function fetchOrders(account) {
  const url = endpoint(account, "orders");
  logger.info("POS polling started", {
    accountId: account?.id || null,
    platformRestaurantId: sellerId(account) || null,
    endpointConfigured: Boolean(url),
    hasToken: Boolean(trimmed(account?.token || account?.accessToken)),
    hasApiSecret: Boolean(trimmed(account?.apiSecret || account?.webhookSecret)),
  });
  if (!url) throw endpointMissingError("orders");

  const response = await fetchWithTimeout(url, account);
  if (!response.ok) throw new Error(`POS polling HTTP ${response.status}`);

  const data = await response.json();
  const orders = Array.isArray(data) ? data : (data.orders || data.items || data.content || data.data || []);
  orders.forEach((order) => {
    logger.debug("POS order found", {
      orderId: order?.orderId || order?.order_id || order?.receiptNo || order?.ticketNo || order?.id || null,
      platformRestaurantId: order?.platformRestaurantId || order?.platform_restaurant_id || order?.posStoreId || order?.storeId || sellerId(account) || null,
    });
  });
  return orders;
}

function normalizeOrder(raw) {
  return getPlatformAdapter(normalizePlatformKey(PLATFORM)).normalizeOrder({ ...raw, platform: PLATFORM });
}

async function acknowledgeOrder(order) {
  return { ok: false, mode: "not_configured", orderId: order?.orderId || order?.platformOrderId || null };
}

async function updateOrderStatus(order, status) {
  return { ok: false, mode: "not_configured", orderId: order?.orderId || order?.platformOrderId || null, status };
}

module.exports = { testConnection, fetchOrders, normalizeOrder, acknowledgeOrder, updateOrderStatus, endpointConfigured };
