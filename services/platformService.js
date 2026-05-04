function createPlatformService(deps = {}) {
  const {
    getPlatformAccounts,
    findPlatformRestaurant,
    handleSimplePlatformOrder,
    normalizeOrder,
    connectorForPlatform,
    platformAccountMissingCredentials,
    nowIso,
    db,
    log = console,
  } = deps;

  function savePlatformAccount(account) {
    log.info?.("Platform account saved", {
      restaurantId: account?.restaurantId,
      platform: account?.platform,
      externalStoreId: account?.externalStoreId,
      webhookEnabled: account?.webhookEnabled,
      pollingEnabled: account?.pollingEnabled,
      active: account?.active,
    });
    return account;
  }

  function getActivePlatformAccounts() {
    return getPlatformAccounts().filter((account) => account.active);
  }

  function dedupePlatformOrder(order, restaurantId) {
    const existing = db.prepare(`
      SELECT id FROM platform_orders
      WHERE platform = ? AND platform_order_id = ? AND restaurant_id = ?
    `).get(order.platform, order.orderId, restaurantId);
    if (existing) {
      log.info?.("Duplicate order skipped", {
        platform: order.platform,
        restaurantId,
        orderId: order.orderId,
      });
    }
    return Boolean(existing);
  }

  function createPackageFromPlatformOrder(order) {
    const result = handleSimplePlatformOrder({
      ...order,
      source: order.source || "platform_polling",
    });
    if (result.ok) {
      log.info?.(order.source === "platform_webhook" ? "Package created from platform order" : "Package created from polling", {
        platform: order.platform,
        restaurantId: result.restaurant?.id,
        orderId: order.orderId,
        trackingNo: result.package?.trackingNo || null,
      });
    }
    return result;
  }

  function handleWebhookOrder(order) {
    const match = findPlatformRestaurant(order.platform, order.platformRestaurantId || order.externalStoreId);
    if (!match) {
      return { ok: false, statusCode: 404, error: "Restaurant/platform match failed" };
    }
    log.info?.("Platform matched", {
      platform: match.account.platform,
      restaurantId: match.restaurant.id,
      externalStoreId: match.account.externalStoreId,
    });
    return createPackageFromPlatformOrder({
      ...order,
      platform: match.account.platform,
      platformRestaurantId: match.account.externalStoreId,
    });
  }

  async function pollPlatformAccount(account, options = {}) {
    if (!account?.active) {
      log.info?.("Polling skipped because account disabled", { platform: account?.platform, accountId: account?.id });
      return { ok: false, skipped: true, reason: "Polling kapalı" };
    }
    if (!account.pollingEnabled) {
      log.info?.("Polling skipped because account disabled", { platform: account.platform, accountId: account.id, reason: "polling_enabled false" });
      return { ok: false, skipped: true, reason: "Polling kapalı" };
    }

    const connector = connectorForPlatform(account.platform);
    if (!connector?.fetchOrders) {
      const reason = "Platform connector desteklenmiyor";
      db.prepare("UPDATE platform_accounts SET last_error = ?, updated_at = ? WHERE id = ?").run(reason, nowIso(), account.id);
      log.warn?.("Polling skipped", { platform: account.platform, accountId: account.id, reason });
      return { ok: false, skipped: true, reason };
    }
    if (platformAccountMissingCredentials(account)) {
      const reason = "API bilgileri eksik";
      db.prepare("UPDATE platform_accounts SET last_error = ?, updated_at = ? WHERE id = ?").run(reason, nowIso(), account.id);
      log.info?.("Polling skipped because credentials missing", { platform: account.platform, accountId: account.id });
      return { ok: false, skipped: true, reason };
    }

    try {
      log.info?.("Polling request started", { platform: account.platform, accountId: account.id });
      const rawOrders = await connector.fetchOrders(account);
      log.info?.("Orders fetched", {
        platform: account.platform,
        accountId: account.id,
        count: rawOrders.length,
      });

      const trackingNumbers = [];
      let createdCount = 0;
      let duplicateCount = 0;
      for (const rawOrder of rawOrders) {
        const normalized = connector.normalizeOrder(rawOrder, account);
        const order = normalizeOrder(account.platform, {
          ...normalized,
          platform: account.platform,
          platformRestaurantId: normalized.platformRestaurantId || normalized.externalStoreId || account.externalStoreId,
          customerNote: normalized.note || normalized.customerNote,
        });
        order.restaurantId = account.restaurantId;
        order.externalStoreId = account.externalStoreId;
        order.note = normalized.note || normalized.customerNote || "";
        order.source = "platform_polling";
        if (dedupePlatformOrder(order, account.restaurantId)) {
          duplicateCount += 1;
          continue;
        }
        const result = createPackageFromPlatformOrder(order);
        if (result.ok) {
          createdCount += 1;
          if (result.package?.trackingNo) trackingNumbers.push(result.package.trackingNo);
        }
      }

      db.prepare("UPDATE platform_accounts SET last_poll_at = ?, last_sync_at = ?, last_error = NULL, updated_at = ? WHERE id = ?")
        .run(nowIso(), nowIso(), nowIso(), account.id);
      log.info?.("Polling test completed", {
        platform: account.platform,
        accountId: account.id,
        fetchedCount: rawOrders.length,
        createdCount,
        duplicateCount,
      });
      return { ok: true, fetchedCount: rawOrders.length, createdCount, duplicateCount, trackingNumbers };
    } catch (error) {
      const reason = error.code === "POLLING_ENDPOINT_NOT_CONFIGURED" ? "Polling endpoint ayarlı değil" : error.message;
      db.prepare("UPDATE platform_accounts SET last_error = ?, updated_at = ? WHERE id = ?")
        .run(reason, nowIso(), account.id);
      log.warn?.(error.code === "POLLING_ENDPOINT_NOT_CONFIGURED" ? "Polling endpoint not configured" : "Polling request failed", {
        platform: account.platform,
        accountId: account.id,
        reason,
      });
      return { ok: false, skipped: true, reason };
    }
  }

  async function pollAllPlatformAccounts(options = {}) {
    const accounts = getActivePlatformAccounts().filter((account) => account.pollingEnabled);
    log.info?.("Polling worker started", { accountCount: accounts.length });
    let createdCount = 0;
    let skippedCount = 0;
    let fetchedCount = 0;

    for (const account of accounts) {
      const result = await pollPlatformAccount(account, options);
      if (result.ok) {
        createdCount += result.createdCount || 0;
        fetchedCount += result.fetchedCount || 0;
      } else {
        skippedCount += 1;
      }
    }

    return { ok: true, createdCount, fetchedCount, skippedCount, accountCount: accounts.length };
  }

  return {
    savePlatformAccount,
    getActivePlatformAccounts,
    handleWebhookOrder,
    pollAllPlatformAccounts,
    pollPlatformAccount,
    createPackageFromPlatformOrder,
    dedupePlatformOrder,
  };
}

module.exports = { createPlatformService };
