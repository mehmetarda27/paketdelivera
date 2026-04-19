const RESTAURANT_TOKEN_KEY = "deliveraRestaurantToken";

const restaurantState = {
  data: null,
  token: localStorage.getItem(RESTAURANT_TOKEN_KEY) || "",
  selectedRestaurantId: "",
};

const restaurantRefs = {
  summary: document.getElementById("restaurantSummary"),
  accessForm: document.getElementById("restaurantAccessForm"),
  restaurantForm: document.getElementById("restaurantForm"),
  platformAccountForm: document.getElementById("platformAccountForm"),
  packageForm: document.getElementById("packageForm"),
  packageRestaurantId: document.getElementById("packageRestaurantId"),
  restaurantZone: document.getElementById("restaurantZone"),
  platformSelect: document.getElementById("platformSelect"),
  restaurantList: document.getElementById("restaurantList"),
  platformAccountList: document.getElementById("platformAccountList"),
  recentOrders: document.getElementById("recentOrders"),
  platformChecks: document.getElementById("platformChecks"),
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
  samplePayload: document.getElementById("samplePayload"),
  samplePaymentMethod: document.getElementById("samplePaymentMethod"),
};

function restaurantAuthHeaders() {
  return authHeaders(restaurantState.token);
}

function renderPlatformChecks() {
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
    account.platform === "Trendyol Go"
      ? "Trendyol panelinde webhook URL ve auth bilgisini gir. Resmi dokumana uygun API key veya basic auth kullanabilirsin."
      : account.platform === "Yemeksepeti"
        ? "Yemeksepeti Partner Portal tarafinda webhook URL ve secret/basic auth tanimi yapilabilir."
        : "Platform panelinde bu webhook URL ve auth bilgisi tanimlandiginda siparisler otomatik akar.";
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
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <strong>${account.platform}</strong>
          <p>Store/Vendor: ${account.externalStoreId}</p>
          <p>Webhook: /api/platforms/${account.platformSlug}/webhook</p>
          <p>Yetki: ${authText}</p>
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
    restaurantRefs.recentOrders.innerHTML = '<div class="empty-state">Bu restorana ait otomatik gelen siparis yok.</div>';
    return;
  }

  list.forEach((pkg) => {
    const card = document.createElement("article");
    card.className = "stack-card";
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <strong>${pkg.packageType || "Standart Paket"} - ${pkg.externalOrderNo}</strong>
          <p>${pkg.restaurantName} - ${pkg.recipient}</p>
          <p>${pkg.deliveryAddress || pkg.address}</p>
          <p>${pkg.assignedCourierName || "Kurye bekleniyor"} - ${statusLabel(pkg.status)}</p>
        </div>
        <span class="soft-badge">${formatDate(pkg.createdAt)}</span>
      </div>
    `;
    restaurantRefs.recentOrders.appendChild(card);
  });
}

function hydrateRestaurant(data, explicitIntegration = null) {
  restaurantState.data = data;
  restaurantState.selectedRestaurantId = data.restaurants[0]?.id || restaurantState.selectedRestaurantId;

  if (data.restaurants.length === 0) {
    restaurantRefs.summary.textContent = "Restoran oturumu acik degil. Yeni restoran olusturabilir veya mevcut restoranla giris yapabilirsin.";
    restaurantRefs.packageRestaurantId.value = "";
  } else {
    restaurantRefs.summary.textContent =
      `${data.restaurants[0].name} icin ${data.stats.totalPackages} siparis gorunuyor. Bu panel yalnizca bu restoranin verilerini gosterir.`;
  }

  setZoneOptions(restaurantRefs.restaurantZone, data.zones);
  renderRestaurantList(data.restaurants);
  renderPlatformAccounts(data.platformAccounts || []);
  renderRecentOrders(data.packages);
  setIntegrationInfo(data, explicitIntegration);
  setPlatformSetup(data);
}

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
    });
    hydrateRestaurant(data);
  } catch (error) {
    localStorage.removeItem(RESTAURANT_TOKEN_KEY);
    restaurantState.token = "";
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
      restaurantId: formData.get("restaurantId"),
      apiKey: formData.get("apiKey"),
    }),
  });

  restaurantState.token = data.token;
  localStorage.setItem(RESTAURANT_TOKEN_KEY, data.token);
  restaurantRefs.accessForm.reset();
  hydrateRestaurant(data.state);
});

restaurantRefs.restaurantForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(restaurantRefs.restaurantForm);
  const payload = {
    name: formData.get("name"),
    portalUsername: formData.get("portalUsername"),
    portalPassword: formData.get("portalPassword"),
    zone: formData.get("zone"),
    latitude: formData.get("latitude"),
    longitude: formData.get("longitude"),
    platforms: formData.getAll("platforms"),
  };
  const data = await api("/api/restaurants", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  restaurantRefs.restaurantForm.reset();
  renderPlatformChecks();

  const session = await api("/api/restaurant/session", {
    method: "POST",
    body: JSON.stringify({
      username: data.integration.portalUsername,
      password: data.integration.portalPassword,
    }),
  });

  restaurantState.token = session.token;
  localStorage.setItem(RESTAURANT_TOKEN_KEY, session.token);
  hydrateRestaurant(session.state, data.integration || null);
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
});

restaurantRefs.packageForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!restaurantState.token) {
    restaurantRefs.summary.textContent = "Paket olusturmadan once restoran girisi yapmalisin.";
    return;
  }

  const formData = new FormData(restaurantRefs.packageForm);
  const data = await api("/api/restaurant/packages", {
    method: "POST",
    headers: restaurantAuthHeaders(),
    body: JSON.stringify({
      restaurantId: formData.get("restaurantId"),
      deliveryAddress: formData.get("deliveryAddress"),
      packageType: formData.get("packageType"),
    }),
  });

  restaurantRefs.packageForm.reset();
  hydrateRestaurant(data);
});

renderPlatformChecks();
restaurantRefs.platformSelect.innerHTML = createPlatformOptions();
restaurantRefs.samplePaymentMethod.innerHTML = PAYMENT_OPTIONS.map((item) => `<option value="${item}">${item}</option>`).join("");
restaurantRefs.samplePaymentMethod.addEventListener("change", () => {
  if (restaurantState.data) {
    setIntegrationInfo(restaurantState.data);
  }
});

api("/api/bootstrap")
  .then((data) => {
    setZoneOptions(restaurantRefs.restaurantZone, data.zones);
    return loadRestaurantWorkspace();
  })
  .catch((error) => {
    restaurantRefs.summary.textContent = error.message;
  });
