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
    const result = handleSimplePlatformOrder(order);
    if (result.ok) {
      log.info?.("Package created from platform order", {
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

  async function pollAllPlatformAccounts(options = {}) {
    const accounts = getActivePlatformAccounts().filter((account) => account.pollingEnabled);
    log.info?.("Polling started", { accountCount: accounts.length });
    let createdCount = 0;
    let skippedCount = 0;

    for (const account of accounts) {
      const connector = connectorForPlatform(account.platform);
      if (!connector?.fetchOrders || platformAccountMissingCredentials(account)) {
        skippedCount += 1;
        log.info?.("Polling skipped", {
          platform: account.platform,
          accountId: account.id,
          reason: "Polling kapali veya API bilgileri eksik",
        });
        continue;
      }

      try {
        const rawOrders = await connector.fetchOrders(account);
        log.info?.("Orders fetched", {
          platform: account.platform,
          accountId: account.id,
          count: rawOrders.length,
        });

        for (const rawOrder of rawOrders) {
          const normalized = connector.normalizeOrder(rawOrder, account);
          const order = normalizeOrder(account.platform, {
            ...normalized,
            platform: account.platform,
            platformRestaurantId: normalized.platformRestaurantId || account.externalStoreId,
          });
          if (dedupePlatformOrder(order, account.restaurantId)) {
            continue;
          }
          const result = createPackageFromPlatformOrder(order);
          if (result.ok) createdCount += 1;
        }

        db.prepare("UPDATE platform_accounts SET last_poll_at = ?, last_sync_at = ?, last_error = NULL, updated_at = ? WHERE id = ?")
          .run(nowIso(), nowIso(), nowIso(), account.id);
      } catch (error) {
        skippedCount += 1;
        db.prepare("UPDATE platform_accounts SET last_error = ?, updated_at = ? WHERE id = ?")
          .run(error.message, nowIso(), account.id);
        log.warn?.("Polling skipped", {
          platform: account.platform,
          accountId: account.id,
          reason: error.message,
        });
      }
    }

    return { ok: true, createdCount, skippedCount, accountCount: accounts.length };
  }

  return {
    savePlatformAccount,
    getActivePlatformAccounts,
    handleWebhookOrder,
    pollAllPlatformAccounts,
    createPackageFromPlatformOrder,
    dedupePlatformOrder,
  };
}

module.exports = { createPlatformService };
