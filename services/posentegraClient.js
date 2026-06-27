function trimmed(value) {
  return String(value ?? "").trim();
}

function baseUrl() {
  return trimmed(process.env.POSENTEGRA_API_BASE_URL).replace(/\/+$/, "");
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
  const response = await fetch(`${baseUrl()}${pathname}`, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey()}`,
      "X-API-Key": apiKey(),
      ...(options.headers || {}),
    },
    body,
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
  };
  if (!response.ok) {
    const error = new Error(`Posentegra API ${method} ${pathname} HTTP ${response.status}`);
    error.code = "POSENTEGRA_HTTP_ERROR";
    error.result = result;
    throw error;
  }
  return result;
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
  });
}

async function changeOrderStatus(orderId, status, meta = {}) {
  return request(`/web-api/v1/orders/change-status/${encodeURIComponent(orderId)}`, {
    method: "POST",
    body: { status, ...meta },
  });
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

async function cancelOrder(orderId, reason) {
  return request(`/web-api/v1/orders/cancel/${encodeURIComponent(orderId)}`, { method: "POST", body: { reason } });
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
  linkRestaurantToBusiness,
  assignPackageToRestaurant,
  changeOrderStatus,
  verifyOrder,
  markOrderReported,
  getPendingReports,
  getCancelReasons,
  cancelOrder,
};
