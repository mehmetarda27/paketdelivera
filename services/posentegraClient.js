function trimmed(value) {
  return String(value ?? "").trim();
}

function baseUrl() {
  return trimmed(process.env.POSENTEGRA_API_BASE_URL).replace(/\/+$/, "");
}

const API_V1_PREFIX = "/web-api/v1";

function requestUrl(pathname) {
  const configuredBase = baseUrl();
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  if (configuredBase.toLowerCase().endsWith(API_V1_PREFIX) && normalizedPath.toLowerCase().startsWith(API_V1_PREFIX)) {
    return `${configuredBase}${normalizedPath.slice(API_V1_PREFIX.length)}`;
  }
  return `${configuredBase}${normalizedPath}`;
}

function apiKey() {
  return trimmed(process.env.POSENTEGRA_API_KEY);
}

function businessId() {
  return trimmed(process.env.POSENTEGRA_BUSINESS_ID);
}

function configured() {
  return Boolean(baseUrl() && apiKey());
}

function requestTimeoutMs() {
  const configuredValue = Number(process.env.POSENTEGRA_REQUEST_TIMEOUT_MS || 8000);
  return Math.max(1000, Math.min(30000, Number.isFinite(configuredValue) ? configuredValue : 8000));
}

function retryAttempts() {
  const configuredValue = Number(process.env.POSENTEGRA_RETRY_ATTEMPTS || 3);
  return Math.max(1, Math.min(5, Number.isFinite(configuredValue) ? Math.floor(configuredValue) : 3));
}

function retryDelay(attempt) {
  const baseDelay = Math.max(100, Math.min(5000, Number(process.env.POSENTEGRA_RETRY_DELAY_MS || 500)));
  return new Promise((resolve) => setTimeout(resolve, baseDelay * (2 ** Math.max(0, attempt - 1))));
}

function redact(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > 160 ? `${value.slice(0, 157)}...` : value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, val]) => {
      const lower = key.toLowerCase();
      if (lower.includes("token") || lower.includes("secret") || lower.includes("password") || lower.includes("apikey") || lower.includes("api_key") || lower === "authorization") {
        return [key, "***"];
      }
      return [key, redact(val)];
    }));
  }
  return value;
}

async function request(pathname, options = {}) {
  if (!configured()) {
    const error = new Error("POSENTEGRA_API_BASE_URL ve POSENTEGRA_API_KEY tanimli degil.");
    error.code = "POSENTEGRA_NOT_CONFIGURED";
    throw error;
  }

  const method = options.method || "GET";
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const attempts = options.retryable ? retryAttempts() : 1;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs());
    try {
      const response = await fetch(requestUrl(pathname), {
        method,
        headers: {
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          Authorization: `Bearer ${apiKey()}`,
          "X-API-Key": apiKey(),
          ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
          ...(options.headers || {}),
        },
        body,
        signal: controller.signal,
      });
      const text = await response.text().catch(() => "");
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text };
      }
      const result = {
        ok: response.ok,
        status: response.status,
        method,
        path: pathname,
        requestBody: redact(options.body || null),
        responseBody: redact(data),
        attempt,
      };
      if (response.ok) {
        return result;
      }
      const error = new Error(`Posentegra API ${method} ${pathname} HTTP ${response.status}`);
      error.code = "POSENTEGRA_HTTP_ERROR";
      error.result = result;
      lastError = error;
      if (!options.retryable || response.status < 500 || attempt >= attempts) {
        throw error;
      }
    } catch (error) {
      lastError = error;
      if (error.name === "AbortError") {
        const timeoutError = new Error(`Posentegra API ${method} ${pathname} timeout`);
        timeoutError.code = "POSENTEGRA_TIMEOUT";
        timeoutError.result = { status: 504, method, path: pathname, requestBody: redact(options.body || null), responseBody: null, attempt };
        lastError = timeoutError;
      }
      const retryableNetworkError = options.retryable && (lastError.code === "POSENTEGRA_TIMEOUT" || !lastError.result || Number(lastError.result.status) >= 500);
      if (!retryableNetworkError || attempt >= attempts) {
        throw lastError;
      }
    } finally {
      clearTimeout(timeoutId);
    }
    await retryDelay(attempt);
  }
  throw lastError;
}

function restaurantPayload(restaurant = {}) {
  return {
    name: restaurant.name,
    title: restaurant.name,
    username: restaurant.username,
    zone: restaurant.zone,
    latitude: restaurant.latitude,
    longitude: restaurant.longitude,
    externalId: restaurant.id,
  };
}

async function createRestaurant(restaurant) {
  return request("/web-api/v1/restaurants", {
    method: "POST",
    body: restaurantPayload(restaurant),
  });
}

async function deleteRestaurant(id) {
  return request(`/web-api/v1/restaurants/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: {},
  });
}

async function getBusinesses() {
  return request("/web-api/v1/businesses");
}

async function createBusiness(payload = {}) {
  return request("/web-api/v1/businesses", { method: "POST", body: payload });
}

async function getBusiness(id) {
  return request(`/web-api/v1/businesses/${encodeURIComponent(id)}`);
}

async function updateBusiness(id, payload = {}) {
  return request(`/web-api/v1/businesses/${encodeURIComponent(id)}`, { method: "PUT", body: payload });
}

async function deleteBusiness(id) {
  return request(`/web-api/v1/businesses/${encodeURIComponent(id)}`, { method: "DELETE", body: {} });
}

async function linkRestaurantToBusiness(posentegraRestaurantId) {
  const id = businessId();
  if (!id) {
    return null;
  }
  return request(`/web-api/v1/businesses/${encodeURIComponent(id)}/restaurants`, {
    method: "POST",
    body: { restaurantId: posentegraRestaurantId },
  });
}

async function assignPackageToRestaurant(posentegraRestaurantId, payload = {}) {
  return request(`/web-api/v1/restaurants/${encodeURIComponent(posentegraRestaurantId)}/assign-package`, {
    method: "POST",
    body: payload,
    retryable: true,
    idempotencyKey: `package:${payload.id || payload.packageId || payload.externalOrderId || "unknown"}`,
  });
}

async function changeOrderStatus(orderId, status, meta = {}) {
  return request(`/web-api/v1/orders/change-status/${encodeURIComponent(orderId)}`, {
    method: "POST",
    // FastSiparis change-status hedef durum kabul etmez; siparisi tek adim ilerletir.
    // Govde veya otomatik HTTP retry gondermek belirsiz bir timeout sonrasinda
    // ayni siparisi yanlislikla iki kez ilerletebilir.
    idempotencyKey: `status:${orderId}:${status}:${meta.packageId || ""}`,
  });
}

async function getOrder(orderId) {
  return request(`/web-api/v1/orders/${encodeURIComponent(orderId)}`);
}

async function verifyOrder(orderId) {
  return request(`/web-api/v1/orders/verify/${encodeURIComponent(orderId)}`, { method: "POST", body: {} });
}

async function markOrderReported(orderId) {
  return request("/web-api/v1/orders/reports/mark", { method: "POST", body: { orderId } });
}

async function getPendingReports() {
  return request("/web-api/v1/orders/reports/pending");
}

async function getCancelReasons(orderId) {
  return request(`/web-api/v1/orders/reasons/${encodeURIComponent(orderId)}`);
}

async function cancelOrder(orderId, reason, meta = {}) {
  return request(`/web-api/v1/orders/cancel/${encodeURIComponent(orderId)}`, {
    method: "POST",
    // FastSiparis iptal sozlesmesi yalnizca reason ve opsiyonel note kabul eder.
    // packageId/reconciliation gibi yerel idempotency metadatasini dis API'ye
    // gondermek bazi platformlarda 4xx/5xx ile reddedilmeye yol aciyor.
    body: {
      reason,
      ...(meta.note ? { note: meta.note } : {}),
    },
    retryable: true,
    idempotencyKey: `cancel:${orderId}:${meta.packageId || ""}`,
  });
}

module.exports = {
  configured,
  businessId,
  getBusinesses,
  createBusiness,
  getBusiness,
  updateBusiness,
  deleteBusiness,
  createRestaurant,
  deleteRestaurant,
  linkRestaurantToBusiness,
  assignPackageToRestaurant,
  changeOrderStatus,
  getOrder,
  verifyOrder,
  markOrderReported,
  getPendingReports,
  getCancelReasons,
  cancelOrder,
};
