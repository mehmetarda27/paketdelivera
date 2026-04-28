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

function normalizePlatformKey(platform) {
  return trimmed(platform).toLowerCase().replaceAll(" ", "_").replaceAll("-", "_");
}

function baseNormalizeOrder(platformKey, rawBody) {
  const body = rawBody || {};
  return {
    platform: platformKey,
    platformRestaurantId: trimmed(body.platformRestaurantId ?? body.platform_restaurant_id ?? body.storeId ?? body.store_id ?? body.vendorId ?? body.vendor_id ?? body.restaurantId),
    orderId: trimmed(body.orderId ?? body.order_id ?? body.externalOrderId ?? body.external_order_id ?? body.id),
    customerName: trimmed(body.customerName ?? body.customer_name ?? body.customer?.name),
    phone: trimmed(body.phone ?? body.customer?.phone),
    address: trimmed(body.address ?? body.deliveryAddress ?? body.delivery_address),
    items: normalizeItems(body.items ?? body.products ?? body.lines),
    totalPrice: normalizeMoney(body.totalPrice ?? body.total_price ?? body.amount),
    paymentMethod: trimmed(body.paymentMethod ?? body.payment_method) || "Online Odeme",
    customerNote: trimmed(body.customerNote ?? body.customer_note ?? body.note),
    rawPayload: body,
  };
}

function createAdapter(platformKey, mapper) {
  return {
    normalizeOrder(rawBody) {
      return mapper(rawBody || {});
    },
    verifyWebhook(req, account) {
      const incomingSecret = trimmed(req?.headers?.["x-platform-secret"]);
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
      items: normalizeItems(rawBody.items ?? order.items ?? order.products),
      rawPayload: rawBody,
    };
  }),
};

function getPlatformAdapter(platform) {
  const key = normalizePlatformKey(platform);
  return platformAdapters[key] || createAdapter(key || "unknown_platform", (rawBody) => baseNormalizeOrder(key || "unknown_platform", rawBody));
}

module.exports = {
  getPlatformAdapter,
  normalizePlatformKey,
};
