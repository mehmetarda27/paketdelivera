const RESTAURANT_TOKEN_KEY = "deliveraRestaurantToken";
const RESTAURANT_REFRESH_TOKEN_KEY = "deliveraRestaurantRefreshToken";

const restaurantState = {
  data: null,
  token: localStorage.getItem(RESTAURANT_TOKEN_KEY) || "",
  refreshToken: localStorage.getItem(RESTAURANT_REFRESH_TOKEN_KEY) || "",
  selectedRestaurantId: "",
  historyRange: "7d",
  historyVisibleCount: 50,
};

const restaurantRefs = {
  summary: document.getElementById("restaurantSummary"),
  accessForm: document.getElementById("restaurantAccessForm"),
  logoutButton: document.getElementById("restaurantLogoutButton"),
  createSection: document.getElementById("restaurantCreateSection"),
  workspace: document.getElementById("restaurantWorkspace"),
  platformAccountForm: document.getElementById("platformAccountForm"),
  packageForm: document.getElementById("packageForm"),
  packageRestaurantId: document.getElementById("packageRestaurantId"),
  platformSelect: document.getElementById("platformSelect"),
  restaurantList: document.getElementById("restaurantList"),
  platformAccountList: document.getElementById("platformAccountList"),
  recentOrders: document.getElementById("recentOrders"),
  integrationEndpoint: document.getElementById("integrationEndpoint"),
  integrationRestaurant: document.getElementById("integrationRestaurant"),
  integrationApiKey: document.getElementById("integrationApiKey"),
  integrationPortalUsername: document.getElementById("integrationPortalUsername"),
  integrationWebhookSecret: document.getElementById("integrationWebhookSecret"),
  platformWebhookUrl: document.getElementById("platformWebhookUrl"),
  platformSetupName: document.getElementById("platformSetupName"),
  platformSetupAuth: document.getElementById("platformSetupAuth"),
  platformSetupStore: document.getElementById("platformSetupStore"),
  platformSetupHint: document.getElementById("platformSetupHint"),
  totalPackages: document.getElementById("restaurantTotalPackages"),
  waitingPackages: document.getElementById("restaurantWaitingPackages"),
  inTransitPackages: document.getElementById("restaurantInTransitPackages"),
  activeCouriers: document.getElementById("restaurantActiveCouriers"),
  activeOrders: document.getElementById("activeOrders"),
  orderHistory: document.getElementById("orderHistory"),
  historyMeta: document.getElementById("restaurantHistoryMeta"),
  historyMore: document.getElementById("restaurantHistoryMore"),
  historyFilters: document.getElementById("restaurantHistoryFilters"),
  samplePayload: document.getElementById("samplePayload"),
  samplePaymentMethod: document.getElementById("samplePaymentMethod"),
};

function restaurantAuthHeaders() {
  return authHeaders(restaurantState.token);
}

function persistRestaurantAuth(auth) {
  restaurantState.token = auth.token;
  restaurantState.refreshToken = auth.refreshToken;
  localStorage.setItem(RESTAURANT_TOKEN_KEY, auth.token);
  localStorage.setItem(RESTAURANT_REFRESH_TOKEN_KEY, auth.refreshToken);
}

function clearRestaurantAuth() {
  restaurantState.token = "";
  restaurantState.refreshToken = "";
  restaurantState.data = null;
  restaurantState.selectedRestaurantId = "";
  localStorage.removeItem(RESTAURANT_TOKEN_KEY);
  localStorage.removeItem(RESTAURANT_REFRESH_TOKEN_KEY);
}

async function refreshRestaurantAccess() {
  if (!restaurantState.refreshToken) {
    throw new Error("Restoran refresh token bulunamadi.");
  }

  const auth = await api("/api/restaurant/refresh", {
    method: "POST",
    body: JSON.stringify({
      refreshToken: restaurantState.refreshToken,
    }),
  });
  persistRestaurantAuth(auth);
}

function setRestaurantWorkspaceVisible(isVisible) {
  restaurantRefs.createSection.classList.toggle("hidden", isVisible);
  restaurantRefs.workspace.classList.toggle("hidden", !isVisible);
  restaurantRefs.logoutButton.classList.toggle("hidden", !isVisible);
}

function renderPlatformChecks() {
  if (!restaurantRefs.platformChecks) {
    return;
  }
  restaurantRefs.platformChecks.innerHTML = PLATFORM_OPTIONS.map((platform) => `
    <label class="chip-option">
      <input type="checkbox" name="platforms" value="${platform}">
      <span>${platform}</span>
    </label>
  `).join("");
}

function getCurrentRestaurant(data) {
  return data.restaurants.find((item) => item.id === restaurantState.selectedRestaurantId) || data.restaurants[0] || null;
}

function getCurrentPlatformAccount(data) {
  return data.platformAccounts?.[0] || null;
}

function activeOrderPackages(packages) {
  return packages.filter((pkg) => !["delivered", "failed", "cancelled"].includes(pkg.status));
}

function courierMap(data) {
  return new Map((data.couriers || []).map((courier) => [courier.id, courier]));
}

function historyDateForPackage(pkg) {
  return new Date(pkg.updatedAt || pkg.deliveredAt || pkg.failedAt || pkg.createdAt);
}

function packageMatchesHistoryRange(pkg, range) {
  const targetDate = historyDateForPackage(pkg);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const sevenDayStart = new Date(todayStart);
  sevenDayStart.setDate(sevenDayStart.getDate() - 6);
  const thirtyDayStart = new Date(todayStart);
  thirtyDayStart.setDate(thirtyDayStart.getDate() - 29);

  if (range === "today") {
    return targetDate >= todayStart;
  }
  if (range === "yesterday") {
    return targetDate >= yesterdayStart && targetDate < todayStart;
  }
  if (range === "30d") {
    return targetDate >= thirtyDayStart;
  }
  if (range === "all") {
    return true;
  }

  return targetDate >= sevenDayStart;
}

function setIntegrationInfo(data, explicitIntegration = null) {
  const restaurant = getCurrentRestaurant(data);

  if (!restaurant) {
    restaurantRefs.integrationRestaurant.textContent = "Henuz restoran oturumu acik degil.";
    restaurantRefs.integrationApiKey.textContent = "API key burada gorunur";
    restaurantRefs.integrationPortalUsername.textContent = "Portal kullanici burada gorunur";
    restaurantRefs.integrationWebhookSecret.textContent = "Webhook secret burada gorunur";
    restaurantRefs.integrationEndpoint.textContent = "Restoran girisi yapildiginda endpoint gorunur";
    restaurantRefs.platformWebhookUrl.textContent = "Platform hesabini kaydedince webhook URL gorunur";
    restaurantRefs.platformSetupName.textContent = "Henuz kayitli platform yok.";
    restaurantRefs.platformSetupAuth.textContent = "Auth bilgisi burada gorunur";
    restaurantRefs.platformSetupStore.textContent = "Store/vendor bilgisi burada gorunur";
    restaurantRefs.platformSetupHint.textContent = "Trendyol ve Yemeksepeti icin webhook ile, digerleri icin ayni adapter mantigi ile calisir.";
    restaurantRefs.samplePayload.textContent = "Restoran girisi yapildiginda ornek payload gorunecek.";
    return;
  }

  restaurantState.selectedRestaurantId = restaurant.id;

  const integration = explicitIntegration || {
    restaurantId: restaurant.id,
    restaurantName: restaurant.name,
    portalUsername: restaurant.username,
    apiKey: restaurant.apiKey,
    webhookSecret: restaurant.webhookSecret,
    endpoint: `${window.location.origin}/api/integrations/orders`,
    samplePayload: {
      restaurantId: restaurant.id,
      sourcePlatform: restaurant.platforms[0] || "Trendyol Go",
      externalOrderNo: "ORDER-10001",
      recipient: "Ayse Demir",
      phone: "5551234567",
      address: "Teslimat adresi",
      zone: restaurant.zone,
      eta: "12:45",
      latitude: restaurant.latitude,
      longitude: restaurant.longitude,
      paymentMethod: restaurantRefs.samplePaymentMethod.value || "Online Odeme",
      note: "Kapidan ara",
    },
  };

  restaurantRefs.integrationRestaurant.textContent = `${integration.restaurantName} - ${restaurant.zone}`;
  restaurantRefs.integrationApiKey.textContent = integration.apiKey;
  restaurantRefs.integrationPortalUsername.textContent = integration.portalUsername || restaurant.username || "-";
  restaurantRefs.integrationWebhookSecret.textContent = integration.webhookSecret;
  restaurantRefs.integrationEndpoint.textContent = integration.endpoint;
  restaurantRefs.samplePayload.textContent = JSON.stringify(integration.samplePayload, null, 2);
  restaurantRefs.packageRestaurantId.value = restaurant.id;
}

function setPlatformSetup(data) {
  const account = getCurrentPlatformAccount(data);

  if (!account) {
    restaurantRefs.platformWebhookUrl.textContent = "Platform hesabini kaydedince webhook URL gorunur";
    restaurantRefs.platformSetupName.textContent = "Henuz kayitli platform yok.";
    restaurantRefs.platformSetupAuth.textContent = "Auth bilgisi burada gorunur";
    restaurantRefs.platformSetupStore.textContent = "Store/vendor bilgisi burada gorunur";
    restaurantRefs.platformSetupHint.textContent = "Webhook kaydi sonrasi otomatik siparis akisina hazir olur.";
    return;
  }

  restaurantRefs.platformWebhookUrl.textContent = `${window.location.origin}/api/platforms/${account.platformSlug}/webhook`;
  restaurantRefs.platformSetupName.textContent = `${account.platform} - ${account.active ? "aktif" : "pasif"}`;
  restaurantRefs.platformSetupStore.textContent = `${account.externalStoreId}${account.externalMerchantId ? ` / ${account.externalMerchantId}` : ""}`;

  if (account.webhookAuthType === "basic_auth") {
    restaurantRefs.platformSetupAuth.textContent = `Basic Auth -> ${account.webhookUsername}:${account.webhookPassword}`;
  } else if (account.webhookAuthType === "static_token") {
    restaurantRefs.platformSetupAuth.textContent = `Bearer veya x-webhook-token -> ${account.staticToken}`;
  } else {
    restaurantRefs.platformSetupAuth.textContent = `x-api-key -> ${account.webhookApiKey}`;
  }

  restaurantRefs.platformSetupHint.textContent =
    `${account.verificationStatus === "verified" ? "Merchant dogrulamasi tamamlandi." : account.verificationStatus === "failed" ? "Merchant credential kontrolu basarisiz." : "Merchant credential kontrolu beklemede."} ${account.verificationNote || ""}`;
}

function renderRestaurantList(restaurants) {
  restaurantRefs.restaurantList.innerHTML = "";

  if (restaurants.length === 0) {
    restaurantRefs.restaurantList.innerHTML = '<div class="empty-state">Bu oturum icin restoran bulunamadi.</div>';
    return;
  }

  const restaurant = restaurants[0];
  const card = document.createElement("article");
  card.className = "stack-card";
  card.innerHTML = `
    <div class="stack-top">
      <div>
        <strong>${restaurant.name}</strong>
        <p>${restaurant.zone} bolgesi - GPS ${restaurant.latitude}, ${restaurant.longitude}</p>
        <div class="badge-row">${createPlatformBadges(restaurant.platforms)}</div>
      </div>
      <span class="soft-badge">Tenant Izole</span>
    </div>
  `;

  restaurantRefs.restaurantList.appendChild(card);
}

function renderPlatformAccounts(accounts) {
  restaurantRefs.platformAccountList.innerHTML = "";

  if (!accounts || accounts.length === 0) {
    restaurantRefs.platformAccountList.innerHTML = '<div class="empty-state">Bu restorana bagli platform hesabi yok.</div>';
    return;
  }

  accounts.forEach((account) => {
    const card = document.createElement("article");
    card.className = "stack-card";
    const authText = account.webhookAuthType === "basic_auth"
      ? `Basic Auth - ${account.webhookUsername}`
      : account.webhookAuthType === "static_token"
        ? "Static Token"
        : "API Key";
    const verificationText = account.verificationStatus === "verified"
      ? "Merchant verified"
      : account.verificationStatus === "failed"
        ? "Merchant verify failed"
        : "Merchant verify pending";
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <strong>${account.platform}</strong>
          <p>Store/Vendor: ${account.externalStoreId}</p>
          <p>Webhook: /api/platforms/${account.platformSlug}/webhook</p>
          <p>Yetki: ${authText}</p>
          <p>${verificationText}${account.verificationNote ? ` - ${account.verificationNote}` : ""}</p>
        </div>
        <span class="soft-badge">${account.active ? "Canli" : "Pasif"}</span>
      </div>
    `;
    restaurantRefs.platformAccountList.appendChild(card);
  });
}

function renderRecentOrders(packages) {
  restaurantRefs.recentOrders.innerHTML = "";
  const list = packages.slice(0, 8);

  if (list.length === 0) {
    restaurantRefs.recentOrders.innerHTML = '<div class="empty-state">Bu restorana ait aktif siparis veya manuel paket yok.</div>';
    return;
  }

  list.forEach((pkg) => {
    const card = document.createElement("article");
    card.className = "stack-card order-summary-card";
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <strong>${pkg.packageType || "Standart Paket"} - ${pkg.externalOrderNo}</strong>
          <p>${pkg.restaurantName} - ${pkg.recipient}</p>
          <p>Kaynak: ${pkg.source === "external_manual" || pkg.source === "manual" ? "Manuel Paket" : pkg.sourcePlatform}</p>
        </div>
        <span class="soft-badge">${statusLabel(pkg.status)}</span>
      </div>
      <div class="meta-grid compact-meta-grid">
        <div>
          <span>Adres</span>
          <strong>${pkg.deliveryAddress || pkg.address}</strong>
        </div>
        <div>
          <span>Kurye</span>
          <strong>${pkg.assignedCourierName || "Kurye bekleniyor"}</strong>
        </div>
        <div>
          <span>Odeme</span>
          <strong>${pkg.paymentMethod || "-"} - ${paymentStatusLabel(pkg.paymentStatus)} - ${formatCurrency(pkg.orderAmount)}</strong>
        </div>
        <div>
          <span>Zaman</span>
          <strong>${formatDate(pkg.createdAt)}</strong>
        </div>
      </div>
    `;
    restaurantRefs.recentOrders.appendChild(card);
  });
}

function renderActiveOrders(data) {
  restaurantRefs.activeOrders.innerHTML = "";
  const packageList = [...data.packages].sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
  const courierById = courierMap(data);

  if (packageList.length === 0) {
    restaurantRefs.activeOrders.innerHTML = '<div class="empty-state">Bu restorana ait siparis yok. Manuel paket veya webhook siparisi geldiginde burada gorunecek.</div>';
    return;
  }

  packageList.forEach((pkg) => {
    const courier = pkg.assignedCourierId ? courierById.get(pkg.assignedCourierId) : null;
    const sourceLabel = pkg.source === "external_manual" || pkg.source === "manual" ? "Manuel Paket" : pkg.sourcePlatform;
    const assignmentBadge = pkg.assignedCourierId ? "Kurye Atandi" : "Atama Bekliyor";
    const assignmentTone = pkg.assignedCourierId ? "soft-badge" : "soft-badge status-awaiting-assignment";

    const card = document.createElement("article");
    card.className = "stack-card order-summary-card";
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <strong>${pkg.trackingNo} - ${pkg.externalOrderNo}</strong>
          <p>Kaynak: ${sourceLabel} - Musteri: ${pkg.recipient}</p>
          <p>Olusturulma: ${formatDate(pkg.createdAt)}</p>
        </div>
        <div class="badge-row">
          <span class="${assignmentTone}">${assignmentBadge}</span>
          <span class="soft-badge">${statusLabel(pkg.status)}</span>
          <span class="soft-badge">${paymentStatusLabel(pkg.paymentStatus)}</span>
        </div>
      </div>
      <div class="meta-grid compact-meta-grid">
        <div>
          <span>Paket ID</span>
          <strong>${pkg.id}</strong>
        </div>
        <div>
          <span>Adres</span>
          <strong>${pkg.deliveryAddress || pkg.address}</strong>
        </div>
        <div>
          <span>Not</span>
          <strong>${pkg.note || "-"}</strong>
        </div>
        <div>
          <span>Odeme</span>
          <strong>${pkg.paymentMethod} - ${paymentStatusLabel(pkg.paymentStatus)} - ${formatCurrency(pkg.orderAmount)}</strong>
        </div>
        <div>
          <span>Kurye</span>
          <strong>${pkg.assignedCourierName || "Henuz atanmadı"}</strong>
        </div>
        <div>
          <span>Kurye Durumu</span>
          <strong>${courier ? courierStatusLabel(courier.status) : "-"}</strong>
        </div>
        <div>
          <span>Kurye Telefon</span>
          <strong>-</strong>
        </div>
        <div>
          <span>Atama Zamani</span>
          <strong>${pkg.assignedAt ? formatDate(pkg.assignedAt) : "-"}</strong>
        </div>
      </div>
      ${pkg.lastAssignmentError ? `<p>Son Atama Notu: ${pkg.lastAssignmentError}</p>` : ""}
    `;
    restaurantRefs.activeOrders.appendChild(card);
  });
}

function renderOrderHistory(packages) {
  restaurantRefs.orderHistory.innerHTML = "";
  const filteredHistory = [...packages]
    .filter((pkg) => ["delivered", "failed", "cancelled"].includes(pkg.status))
    .filter((pkg) => packageMatchesHistoryRange(pkg, restaurantState.historyRange))
    .sort((left, right) => new Date(right.updatedAt || right.createdAt) - new Date(left.updatedAt || left.createdAt))
  const list = filteredHistory.slice(0, restaurantState.historyVisibleCount);

  restaurantRefs.historyMeta.textContent = `${filteredHistory.length} kapanan siparis icinden ${list.length} kayit gorunuyor.`;
  restaurantRefs.historyMore.classList.toggle("hidden", list.length >= filteredHistory.length);
  [...restaurantRefs.historyFilters.querySelectorAll("[data-range]")].forEach((button) => {
    button.classList.toggle("active", button.dataset.range === restaurantState.historyRange);
  });

  if (list.length === 0) {
    restaurantRefs.orderHistory.innerHTML = '<div class="empty-state">Dun veya onceki gunlerden kapanan siparis kaydi henuz yok.</div>';
    return;
  }

  list.forEach((pkg) => {
    const card = document.createElement("article");
    card.className = "stack-card order-summary-card";
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <strong>${pkg.trackingNo} - ${pkg.externalOrderNo}</strong>
          <p>${pkg.packageType || "Standart Paket"} - ${pkg.deliveryAddress || pkg.address}</p>
          <p>Guncelleme: ${formatDate(pkg.updatedAt || pkg.createdAt)}</p>
        </div>
        <span class="soft-badge">${statusLabel(pkg.status)}</span>
      </div>
      <div class="meta-grid compact-meta-grid">
        <div>
          <span>Kaynak</span>
          <strong>${pkg.source === "external_manual" || pkg.source === "manual" ? "Manuel Paket" : pkg.sourcePlatform}</strong>
        </div>
        <div>
          <span>Kurye</span>
          <strong>${pkg.assignedCourierName || "Atama yok"}</strong>
        </div>
        <div>
          <span>Odeme</span>
          <strong>${pkg.paymentMethod || "-"} - ${paymentStatusLabel(pkg.paymentStatus)} - ${formatCurrency(pkg.orderAmount)}</strong>
        </div>
      </div>
    `;
    restaurantRefs.orderHistory.appendChild(card);
  });
}

function hydrateRestaurant(data, explicitIntegration = null) {
  restaurantState.data = data;
  restaurantState.selectedRestaurantId = data.restaurants[0]?.id || restaurantState.selectedRestaurantId;
  const activePackages = activeOrderPackages(data.packages || []);
  const awaitingPackages = activePackages.filter((pkg) => pkg.status === "pending" || pkg.status === "awaiting_assignment");
  const inTransitPackages = activePackages.filter((pkg) => pkg.status === "accepted_by_courier" || pkg.status === "on_route");
  const activeCourierIds = [...new Set(activePackages.filter((pkg) => pkg.assignedCourierId).map((pkg) => pkg.assignedCourierId))];

  if (data.restaurants.length === 0) {
    setRestaurantWorkspaceVisible(false);
    restaurantRefs.summary.textContent = "Restoran oturumu acik degil. Yeni restoran olusturabilir veya mevcut restoranla giris yapabilirsin.";
    restaurantRefs.packageRestaurantId.value = "";
  } else {
    setRestaurantWorkspaceVisible(true);
    restaurantRefs.summary.textContent =
      `${data.restaurants[0].name} icin ${data.packages.length} siparis gorunuyor. Bu panel yalnizca bu restoranin verilerini gosterir.`;
  }

  restaurantRefs.totalPackages.textContent = activePackages.length;
  restaurantRefs.waitingPackages.textContent = awaitingPackages.length;
  restaurantRefs.inTransitPackages.textContent = inTransitPackages.length;
  restaurantRefs.activeCouriers.textContent = activeCourierIds.length;

  renderRestaurantList(data.restaurants);
  renderPlatformAccounts(data.platformAccounts || []);
  renderRecentOrders(data.packages);
  renderActiveOrders(data);
  renderOrderHistory(data.packages);
  setIntegrationInfo(data, explicitIntegration);
  setPlatformSetup(data);
}

restaurantRefs.historyFilters?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-range]");
  if (!button) {
    return;
  }
  restaurantState.historyRange = button.dataset.range;
  restaurantState.historyVisibleCount = 50;
  if (restaurantState.data) {
    renderOrderHistory(restaurantState.data.packages || []);
  }
});

restaurantRefs.historyMore?.addEventListener("click", () => {
  restaurantState.historyVisibleCount += 50;
  if (restaurantState.data) {
    renderOrderHistory(restaurantState.data.packages || []);
  }
});

async function loadRestaurantWorkspace() {
  if (!restaurantState.token) {
    hydrateRestaurant({
      zones: [],
      restaurants: [],
      couriers: [],
      packages: [],
      webhookLogs: [],
      stats: {
        totalRestaurants: 0,
        totalCouriers: 0,
        activeCouriers: 0,
        totalPackages: 0,
        waitingPackages: 0,
        assignedPackages: 0,
        inTransitPackages: 0,
        deliveredPackages: 0,
      },
    });
    return;
  }

  try {
    const data = await api("/api/restaurant/bootstrap", {
      headers: restaurantAuthHeaders(),
      retryWithRefresh: refreshRestaurantAccess,
    });
    hydrateRestaurant(data);
  } catch (error) {
    clearRestaurantAuth();
    restaurantRefs.summary.textContent = error.message;
  }
}

restaurantRefs.accessForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(restaurantRefs.accessForm);
  const data = await api("/api/restaurant/session", {
    method: "POST",
    body: JSON.stringify({
      username: formData.get("username"),
      password: formData.get("password"),
    }),
  });

  persistRestaurantAuth(data);
  restaurantRefs.accessForm.reset();
  hydrateRestaurant(data.state);
});

restaurantRefs.platformAccountForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!restaurantState.token || !restaurantState.data?.restaurants?.[0]) {
    restaurantRefs.summary.textContent = "Platform baglamadan once restoran girisi yapmalisin.";
    return;
  }

  const restaurant = restaurantState.data.restaurants[0];
  const formData = new FormData(restaurantRefs.platformAccountForm);
  const data = await api("/api/restaurant/platform-accounts", {
    method: "POST",
    headers: restaurantAuthHeaders(),
    retryWithRefresh: refreshRestaurantAccess,
    body: JSON.stringify({
      restaurantId: restaurant.id,
      platform: formData.get("platform"),
      externalStoreId: formData.get("externalStoreId"),
      externalMerchantId: formData.get("externalMerchantId"),
      webhookAuthType: formData.get("webhookAuthType"),
      apiUsername: formData.get("apiUsername"),
      apiPassword: formData.get("apiPassword"),
      apiKey: formData.get("apiKey"),
      apiSecret: formData.get("apiSecret"),
      storeFrontCode: formData.get("storeFrontCode"),
      chainId: formData.get("chainId"),
      vendorId: formData.get("vendorId"),
      staticToken: formData.get("staticToken"),
    }),
  });

  restaurantRefs.platformAccountForm.reset();
  restaurantRefs.platformSelect.innerHTML = createPlatformOptions();
  hydrateRestaurant(data);
  showToast(`${restaurant.name} icin platform entegrasyonu kaydedildi.`);
});

restaurantRefs.logoutButton?.addEventListener("click", () => {
  if (restaurantState.refreshToken) {
    api("/api/restaurant/logout", {
      method: "POST",
      headers: restaurantAuthHeaders(),
      body: JSON.stringify({ refreshToken: restaurantState.refreshToken }),
    }).catch(() => {
      // Local cleanup should still continue.
    });
  }
  clearRestaurantAuth();
  restaurantRefs.summary.textContent = "Restoran oturumu kapatildi.";
  hydrateRestaurant({
    zones: [],
    restaurants: [],
    couriers: [],
    packages: [],
    webhookLogs: [],
    platformAccounts: [],
    stats: {
      totalRestaurants: 0,
      totalCouriers: 0,
      activeCouriers: 0,
      totalPackages: 0,
      waitingPackages: 0,
      assignedPackages: 0,
      inTransitPackages: 0,
      deliveredPackages: 0,
    },
  });
});

restaurantRefs.packageForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!restaurantState.token) {
    restaurantRefs.summary.textContent = "Paket olusturmadan once restoran girisi yapmalisin.";
    return;
  }

  const currentRestaurant = restaurantState.data?.restaurants?.[0];
  if (!currentRestaurant) {
    restaurantRefs.summary.textContent = "Aktif restoran oturumu bulunamadi. Once tekrar giris yap.";
    return;
  }

  const formData = new FormData(restaurantRefs.packageForm);
  const data = await api("/api/restaurant/packages", {
    method: "POST",
    headers: restaurantAuthHeaders(),
    retryWithRefresh: refreshRestaurantAccess,
    body: JSON.stringify({
      restaurantId: currentRestaurant.id,
      deliveryAddress: formData.get("deliveryAddress"),
      packageType: formData.get("packageType"),
      orderAmount: formData.get("orderAmount"),
    }),
  });

  restaurantRefs.packageForm.reset();
  hydrateRestaurant(data);
  restaurantRefs.summary.textContent = `${currentRestaurant.name} icin manuel paket kaydedildi ve operasyon akisina alindi.`;
  showToast("Manuel paket basariyla kaydedildi ve operasyon akisina alindi.");
});

restaurantRefs.platformSelect.innerHTML = createPlatformOptions();
restaurantRefs.samplePaymentMethod.innerHTML = PAYMENT_OPTIONS.map((item) => `<option value="${item}">${item}</option>`).join("");
restaurantRefs.samplePaymentMethod.addEventListener("change", () => {
  if (restaurantState.data) {
    setIntegrationInfo(restaurantState.data);
  }
});

api("/api/bootstrap")
  .then((data) => {
    return loadRestaurantWorkspace();
  })
  .catch((error) => {
    restaurantRefs.summary.textContent = error.message;
  });
