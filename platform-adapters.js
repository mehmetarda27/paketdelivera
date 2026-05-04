function trimmed(value) {
  return String(value ?? "").trim();
}

function normalizeMoney(value) {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? Number(amount.toFixed(2)) : 0;
}

function normalizeItems(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items.map((item, index) => ({
    id: trimmed(item?.id) || `item-${index + 1}`,
    name: trimmed(item?.name ?? item?.productName ?? item?.title ?? item?.product) || `Urun ${index + 1}`,
    quantity: Number(item?.quantity ?? item?.qty ?? item?.count ?? 1) || 1,
    price: normalizeMoney(item?.price ?? item?.unitPrice ?? item?.totalPrice ?? 0),
  }));
}

function normalizeCoordinate(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : null;
}

function pickCoordinate(...values) {
  for (const value of values) {
    const normalized = normalizeCoordinate(value);
    if (normalized !== null) {
      return normalized;
    }
  }
  return null;
}

function normalizePlatformKey(platform) {
  return trimmed(platform).toLowerCase().replaceAll(" ", "_").replaceAll("-", "_");
}

function baseNormalizeOrder(platformKey, rawBody) {
  const body = rawBody || {};
  return {
    platform: platformKey,
    platformRestaurantId: trimmed(body.platformRestaurantId ?? body.platform_restaurant_id ?? body.externalStoreId ?? body.external_store_id ?? body.storeId ?? body.store_id ?? body.vendorId ?? body.vendor_id ?? body.restaurantId),
    orderId: trimmed(body.orderId ?? body.order_id ?? body.externalOrderId ?? body.external_order_id ?? body.id),
    customerName: trimmed(body.customerName ?? body.customer_name ?? body.customer?.name),
    phone: trimmed(body.phone ?? body.customer?.phone),
    address: trimmed(body.address ?? body.deliveryAddress ?? body.delivery_address),
    items: normalizeItems(body.items ?? body.products ?? body.lines),
    totalPrice: normalizeMoney(body.totalPrice ?? body.total_price ?? body.amount),
    paymentMethod: trimmed(body.paymentMethod ?? body.payment_method) || "Online Odeme",
    customerNote: trimmed(body.customerNote ?? body.customer_note ?? body.note),
    customerLatitude: pickCoordinate(
      body.customerLat,
      body.customer_lat,
      body.customerLatitude,
      body.customer_latitude,
      body.lat,
      body.latitude,
      body.customer?.lat,
      body.customer?.latitude,
      body.deliveryLocation?.lat,
      body.deliveryLocation?.latitude
    ),
    customerLongitude: pickCoordinate(
      body.customerLng,
      body.customer_lng,
      body.customerLongitude,
      body.customer_longitude,
      body.lng,
      body.longitude,
      body.lon,
      body.customer?.lng,
      body.customer?.longitude,
      body.customer?.lon,
      body.deliveryLocation?.lng,
      body.deliveryLocation?.longitude
    ),
    customerAddress: trimmed(body.customerAddress ?? body.customer_address ?? body.address ?? body.deliveryAddress ?? body.delivery_address),
    rawPayload: body,
  };
}

function createAdapter(platformKey, mapper) {
  return {
    normalizeOrder(rawBody) {
      return mapper(rawBody || {});
    },
    verifyWebhook(req, account) {
      const incomingSecret = [
        req?.headers?.["x-platform-secret"],
        req?.headers?.["x-webhook-secret"],
        req?.headers?.["x-api-key"],
      ].map(trimmed).find(Boolean);
      return Boolean(incomingSecret && incomingSecret === trimmed(account?.webhookSecret ?? account?.staticToken));
    },
    sendStatusUpdate(status, orderData) {
      console.log("Platform status callback called", {
        platform: platformKey,
        status,
        orderId: orderData?.orderId || orderData?.externalOrderNo || null,
      });
      return {
        ok: true,
        platform: platformKey,
        status,
        mode: "placeholder",
      };
    },
  };
}

const platformAdapters = {
  trendyol_go: createAdapter("trendyol_go", (rawBody) => {
    const order = rawBody.order || rawBody;
    return {
      ...baseNormalizeOrder("trendyol_go", rawBody),
      platformRestaurantId: trimmed(rawBody.platformRestaurantId ?? order.storeFrontCode ?? order.store_front_code ?? order.sellerId ?? order.seller_id),
      orderId: trimmed(rawBody.orderId ?? order.orderNumber ?? order.order_number ?? order.id),
      customerName: trimmed(rawBody.customerName ?? order.customer?.fullName ?? order.customer?.name),
      phone: trimmed(rawBody.phone ?? order.customer?.phoneNumber ?? order.customer?.phone),
      address: trimmed(rawBody.address ?? order.deliveryAddress?.address1 ?? order.address),
      totalPrice: normalizeMoney(rawBody.totalPrice ?? order.totalPrice ?? order.payment?.totalPrice),
      paymentMethod: trimmed(rawBody.paymentMethod ?? order.payment?.method ?? order.paymentMethod) || "Online Odeme",
      customerNote: trimmed(rawBody.customerNote ?? order.customerNote ?? order.note),
      customerLatitude: pickCoordinate(
        rawBody.customerLat,
        rawBody.customer_lat,
        order.deliveryAddress?.lat,
        order.deliveryAddress?.latitude,
        order.customer?.lat,
        order.customer?.latitude
      ),
      customerLongitude: pickCoordinate(
        rawBody.customerLng,
        rawBody.customer_lng,
        order.deliveryAddress?.lng,
        order.deliveryAddress?.longitude,
        order.customer?.lng,
        order.customer?.longitude
      ),
      customerAddress: trimmed(rawBody.customerAddress ?? rawBody.customer_address ?? order.deliveryAddress?.address1 ?? order.address),
      items: normalizeItems(rawBody.items ?? order.items ?? order.products),
      rawPayload: rawBody,
    };
  }),
  yemeksepeti: createAdapter("yemeksepeti", (rawBody) => {
    const order = rawBody.order || rawBody;
    return {
      ...baseNormalizeOrder("yemeksepeti", rawBody),
      platformRestaurantId: trimmed(rawBody.platformRestaurantId ?? order.vendorId ?? order.vendor_id),
      orderId: trimmed(rawBody.orderId ?? order.external_order_id ?? order.externalOrderId ?? order.orderId),
      customerName: trimmed(rawBody.customerName ?? order.customerName ?? order.customer?.name),
      phone: trimmed(rawBody.phone ?? order.phone ?? order.customer?.phone),
      address: trimmed(rawBody.address ?? order.address ?? order.deliveryAddress),
      totalPrice: normalizeMoney(rawBody.totalPrice ?? order.totalPrice ?? order.total_amount ?? order.payment?.amount),
      paymentMethod: trimmed(rawBody.paymentMethod ?? order.paymentMethod ?? order.payment?.method) || "Online Odeme",
      customerNote: trimmed(rawBody.customerNote ?? order.customerNote ?? order.note),
      customerLatitude: pickCoordinate(
        rawBody.customerLat,
        rawBody.customer_lat,
        order.deliveryAddress?.lat,
        order.deliveryAddress?.latitude,
        order.customer?.lat,
        order.customer?.latitude
      ),
      customerLongitude: pickCoordinate(
        rawBody.customerLng,
        rawBody.customer_lng,
        order.deliveryAddress?.lng,
        order.deliveryAddress?.longitude,
        order.customer?.lng,
        order.customer?.longitude
      ),
      customerAddress: trimmed(rawBody.customerAddress ?? rawBody.customer_address ?? order.address ?? order.deliveryAddress),
      items: normalizeItems(rawBody.items ?? order.items ?? order.products),
      rawPayload: rawBody,
    };
  }),
  getir_yemek: createAdapter("getir_yemek", (rawBody) => {
    const order = rawBody.order || rawBody;
    return {
      ...baseNormalizeOrder("getir_yemek", rawBody),
      platformRestaurantId: trimmed(rawBody.platformRestaurantId ?? order.restaurantId ?? order.vendorId),
      orderId: trimmed(rawBody.orderId ?? order.id ?? order.orderId),
      customerName: trimmed(rawBody.customerName ?? order.customer?.name),
      phone: trimmed(rawBody.phone ?? order.customer?.phone),
      address: trimmed(rawBody.address ?? order.address),
      totalPrice: normalizeMoney(rawBody.totalPrice ?? order.totalPrice ?? order.totalAmount),
      paymentMethod: trimmed(rawBody.paymentMethod ?? order.paymentMethod ?? order.payment?.method) || "Online Odeme",
      customerNote: trimmed(rawBody.customerNote ?? order.note ?? order.customerNote),
      customerLatitude: pickCoordinate(
        rawBody.customerLat,
        rawBody.customer_lat,
        order.customer?.lat,
        order.customer?.latitude,
        order.deliveryLocation?.lat,
        order.deliveryLocation?.latitude
      ),
      customerLongitude: pickCoordinate(
        rawBody.customerLng,
        rawBody.customer_lng,
        order.customer?.lng,
        order.customer?.longitude,
        order.deliveryLocation?.lng,
        order.deliveryLocation?.longitude
      ),
      customerAddress: trimmed(rawBody.customerAddress ?? rawBody.customer_address ?? order.address),
      items: normalizeItems(rawBody.items ?? order.items ?? order.products),
      rawPayload: rawBody,
    };
  }),
  migros_yemek: createAdapter("migros_yemek", (rawBody) => {
    const order = rawBody.order || rawBody;
    return {
      ...baseNormalizeOrder("migros_yemek", rawBody),
      platformRestaurantId: trimmed(rawBody.platformRestaurantId ?? order.merchantId ?? order.vendorId),
      orderId: trimmed(rawBody.orderId ?? order.id ?? order.orderNo),
      customerName: trimmed(rawBody.customerName ?? order.customer?.name),
      phone: trimmed(rawBody.phone ?? order.customer?.phone),
      address: trimmed(rawBody.address ?? order.address ?? order.deliveryAddress),
      totalPrice: normalizeMoney(rawBody.totalPrice ?? order.totalPrice ?? order.amount),
      paymentMethod: trimmed(rawBody.paymentMethod ?? order.paymentMethod ?? order.payment?.method) || "Online Odeme",
      customerNote: trimmed(rawBody.customerNote ?? order.note ?? order.customerNote),
      customerLatitude: pickCoordinate(
        rawBody.customerLat,
        rawBody.customer_lat,
        order.customer?.lat,
        order.customer?.latitude,
        order.deliveryAddress?.lat,
        order.deliveryAddress?.latitude
      ),
      customerLongitude: pickCoordinate(
        rawBody.customerLng,
        rawBody.customer_lng,
        order.customer?.lng,
        order.customer?.longitude,
        order.deliveryAddress?.lng,
        order.deliveryAddress?.longitude
      ),
      customerAddress: trimmed(rawBody.customerAddress ?? rawBody.customer_address ?? order.address ?? order.deliveryAddress),
      items: normalizeItems(rawBody.items ?? order.items ?? order.products),
      rawPayload: rawBody,
    };
  }),
  pos: createAdapter("pos", (rawBody) => {
    const order = rawBody.order || rawBody;
    return {
      ...baseNormalizeOrder("pos", rawBody),
      platformRestaurantId: trimmed(
        rawBody.platformRestaurantId ??
        rawBody.platform_restaurant_id ??
        order.platformRestaurantId ??
        order.platform_restaurant_id ??
        order.posStoreId ??
        order.pos_store_id ??
        order.storeId ??
        order.store_id ??
        order.merchantId ??
        order.merchant_id ??
        order.branchId ??
        order.branch_id
      ),
      orderId: trimmed(rawBody.orderId ?? rawBody.order_id ?? rawBody.externalOrderId ?? rawBody.external_order_id ?? order.orderId ?? order.order_id ?? order.externalOrderId ?? order.external_order_id ?? order.receiptNo ?? order.receipt_no ?? order.ticketNo ?? order.ticket_no ?? order.id),
      customerName: trimmed(rawBody.customerName ?? rawBody.customer_name ?? order.customerName ?? order.customer_name ?? order.customer?.name) || "POS Musteri",
      phone: trimmed(rawBody.phone ?? rawBody.customerPhone ?? rawBody.customer_phone ?? order.phone ?? order.customerPhone ?? order.customer_phone ?? order.customer?.phone) || "Gizli Numara",
      address: trimmed(rawBody.address ?? rawBody.deliveryAddress ?? rawBody.delivery_address ?? order.address ?? order.deliveryAddress ?? order.delivery_address) || "POS siparis adresi",
      totalPrice: normalizeMoney(rawBody.totalPrice ?? rawBody.total_price ?? order.totalPrice ?? order.total_price ?? order.amount ?? order.total),
      paymentMethod: trimmed(rawBody.paymentMethod ?? rawBody.payment_method ?? order.paymentMethod ?? order.payment_method ?? order.payment?.method) || "POS",
      customerNote: trimmed(rawBody.customerNote ?? rawBody.customer_note ?? order.note ?? order.customerNote ?? order.customer_note),
      customerAddress: trimmed(rawBody.customerAddress ?? rawBody.customer_address ?? order.address ?? order.deliveryAddress ?? order.delivery_address),
      items: normalizeItems(rawBody.items ?? order.items ?? order.lines ?? order.products),
      rawPayload: rawBody,
    };
  }),
};

platformAdapters.trendyol_yemek = platformAdapters.trendyol_go;
platformAdapters.adisyo = platformAdapters.pos;

function getPlatformAdapter(platform) {
  const key = normalizePlatformKey(platform);
  return platformAdapters[key] || createAdapter(key || "unknown_platform", (rawBody) => baseNormalizeOrder(key || "unknown_platform", rawBody));
}

module.exports = {
  getPlatformAdapter,
  normalizePlatformKey,
};
