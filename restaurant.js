
const SVG_PACKAGE = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#F27A1A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: text-bottom; margin-right: 4px;"><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"></line><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>`;
const SVG_PHONE = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#F27A1A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: text-bottom; margin-right: 4px;"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect><line x1="12" y1="18" x2="12.01" y2="18"></line></svg>`;
const SVG_MOTO = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#64748B" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: text-bottom; margin-right: 4px;"><path d="M5 16A3 3 0 1 0 5 22A3 3 0 1 0 5 16Z"></path><path d="M19 16A3 3 0 1 0 19 22A3 3 0 1 0 19 16Z"></path><path d="M5 19H19"></path><path d="M8 15L10 9H15L17 15"></path><path d="M14 9L13 5H17"></path></svg>`;
const SVG_PIN = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#EF4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: text-bottom; margin-right: 4px;"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>`;
const SVG_COURIER = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6366F1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: text-bottom; margin-right: 4px;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`;

const RESTAURANT_TOKEN_KEY = "deliveraRestaurantToken";
const RESTAURANT_REFRESH_TOKEN_KEY = "deliveraRestaurantRefreshToken";
const RESTAURANT_ID_KEY = "deliveraRestaurantId";
const RESTAURANT_API_KEY_KEY = "deliveraRestaurantApiKey";
const RESTAURANT_WORKSPACE_REFRESH_MS = 12_000;

const restaurantState = {
  data: null,
  token: "",
  refreshToken: "",
  selectedRestaurantId: "",
  historyRange: "7d",
  historyVisibleCount: 50,
  packageLimit: 100,
  packageCursor: "0",
  workspacePollId: null,
  liveStream: null,
  activeWorkspaceCard: "restaurant-integration-wizard",
};

const restaurantRefs = {
  summary: document.getElementById("restaurantSummary"),
  accessForm: document.getElementById("restaurantAccessForm"),
  logoutButton: document.getElementById("restaurantLogoutButton"),
  createSection: document.getElementById("restaurantCreateSection"),
  workspace: document.getElementById("restaurantWorkspace"),
  platformAccountForm: document.getElementById("platformAccountForm"),
  manualPlatformOrderForm: document.getElementById("manualPlatformOrderForm"),
  packageForm: document.getElementById("packageForm"),
  packageRestaurantId: document.getElementById("packageRestaurantId"),
  restaurantCustomerId: document.getElementById("restaurantCustomerId"),
  customerPhoneSearch: document.getElementById("customerPhoneSearch"),
  customerSearchHint: document.getElementById("customerSearchHint"),
  packagePaymentMethod: document.getElementById("packagePaymentMethod"),
  platformSelect: document.getElementById("platformSelect"),
  manualPlatformSelect: document.getElementById("manualPlatformSelect"),
  restaurantList: document.getElementById("restaurantList"),
  platformAccountList: document.getElementById("platformAccountList"),
  recentOrders: document.getElementById("recentOrders"),
  searchInput: document.getElementById("restaurantSearchInput"),
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
  performanceBoard: document.getElementById("restaurantPerformanceBoard"),
  liveBadge: document.getElementById("restaurantLiveBadge"),
  notificationCenter: document.getElementById("restaurantNotificationCenter"),
  activeOrders: document.getElementById("activeOrders"),
  orderHistory: document.getElementById("orderHistory"),
  historyMeta: document.getElementById("restaurantHistoryMeta"),
  historyMore: document.getElementById("restaurantHistoryMore"),
  historyFilters: document.getElementById("restaurantHistoryFilters"),
  samplePayload: document.getElementById("samplePayload"),
  samplePaymentMethod: document.getElementById("samplePaymentMethod"),
  integrationWizardSteps: document.getElementById("integrationWizardSteps"),
  reportTableBody: document.getElementById("restaurantReportTableBody"),
  printReportButton: document.getElementById("printReportButton"),
  integrationWizardWebhook: document.getElementById("integrationWizardWebhook"),
  integrationWizardStatus: document.getElementById("integrationWizardStatus"),
  copyWebhookButton: document.getElementById("copyWebhookButton"),
  mainQuickPasteRawText: document.getElementById("mainQuickPasteRawText"),
  mainQuickPasteParseButton: document.getElementById("mainQuickPasteParseButton"),
  packageImageInput: document.getElementById("packageImageInput"),
  packageImagePreview: document.getElementById("packageImagePreview"),
  cameraModal: document.getElementById("cameraModal"),
  openCameraButton: document.getElementById("openCameraButton"),
  closeCameraButton: document.getElementById("closeCameraButton"),
  cameraVideo: document.getElementById("cameraVideo"),
  captureCameraButton: document.getElementById("captureCameraButton"),
  cameraCanvas: document.getElementById("cameraCanvas"),
};

function restaurantAuthHeaders() {
  return authHeaders(restaurantState.token);
}

function readStoredRestaurantAuth() {
  try {
    restaurantState.token = localStorage.getItem(RESTAURANT_TOKEN_KEY) || "";
    restaurantState.refreshToken = localStorage.getItem(RESTAURANT_REFRESH_TOKEN_KEY) || "";
  } catch {
    restaurantState.token = "";
    restaurantState.refreshToken = "";
  }
}

function writeStoredRestaurantAuth() {
  try {
    if (restaurantState.token) {
      localStorage.setItem(RESTAURANT_TOKEN_KEY, restaurantState.token);
    } else {
      localStorage.removeItem(RESTAURANT_TOKEN_KEY);
    }
    if (restaurantState.refreshToken) {
      localStorage.setItem(RESTAURANT_REFRESH_TOKEN_KEY, restaurantState.refreshToken);
    } else {
      localStorage.removeItem(RESTAURANT_REFRESH_TOKEN_KEY);
    }
  } catch {}
}

function writeStoredRestaurantAccessInfo() {
  // Keep restaurant ID/API key in memory only. Persistent auth uses session tokens.
}

function clearStoredRestaurantAuth() {
  try {
    localStorage.removeItem(RESTAURANT_TOKEN_KEY);
    localStorage.removeItem(RESTAURANT_REFRESH_TOKEN_KEY);
  } catch {}
}

function safeSetText(element, value) {
  if (!element) {
    return;
  }
  element.textContent = value;
}

function persistRestaurantAccessInfo(payload = {}) {
  const restaurantId = String(payload.restaurantId || payload.id || "").trim();
  const apiKey = String(payload.apiKey || "").trim();
  restaurantState.storedRestaurantId = restaurantId;
  restaurantState.storedApiKey = apiKey;
  writeStoredRestaurantAccessInfo();
}

function clearRestaurantAccessInfo() {
  restaurantState.storedRestaurantId = "";
  restaurantState.storedApiKey = "";
}

function applyRestaurantAccessFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const restaurantId = String(params.get("restaurant_id") || params.get("restaurantId") || "").trim();
  const apiKey = String(params.get("api_key") || params.get("apiKey") || "").trim();
  if (restaurantId && apiKey) {
    persistRestaurantAccessInfo({ restaurantId, apiKey });
  }
}

async function tryRestaurantSessionFromStoredAccess() {
  const restaurantId = restaurantState.storedRestaurantId || "";
  const apiKey = restaurantState.storedApiKey || "";
  if (!restaurantId || !apiKey || restaurantState.token) {
    return false;
  }

  const data = await api("/api/restaurant/session", {
    method: "POST",
    headers: {
      "x-restaurant-id": restaurantId,
      "x-api-key": apiKey,
    },
    body: JSON.stringify({ restaurantId, apiKey }),
  });
  persistRestaurantAuth(data);
  hydrateRestaurant(data.state);
  startRestaurantWorkspacePolling();
  startRestaurantLiveStream();
  return true;
}

function persistRestaurantAuth(auth) {
  restaurantState.token = auth.token;
  restaurantState.refreshToken = auth.refreshToken;
  writeStoredRestaurantAuth();
  const currentRestaurant = auth?.state?.restaurants?.[0];
  if (currentRestaurant) {
    persistRestaurantAccessInfo({
      restaurantId: currentRestaurant.id,
      apiKey: currentRestaurant.apiKey,
    });
  }
}

function clearRestaurantAuth() {
  restaurantState.token = "";
  restaurantState.refreshToken = "";
  clearStoredRestaurantAuth();
  restaurantState.data = null;
  restaurantState.selectedRestaurantId = "";
  stopRestaurantWorkspacePolling();
  restaurantState.liveStream?.close?.();
  restaurantState.liveStream = null;
  clearRestaurantAccessInfo();
}

async function refreshRestaurantAccess() {
  if (!restaurantState.refreshToken) {
    throw new Error("Restoran refresh token bulunamadi.");
  }

  try {
    const auth = await api("/api/restaurant/refresh", {
      method: "POST",
      body: JSON.stringify({
        refreshToken: restaurantState.refreshToken,
      }),
    });
    persistRestaurantAuth(auth);
    return auth;
  } catch (err) {
    if (err.status === 401) {
      clearRestaurantAuth();
      window.location.reload();
    }
    throw err;
  }
}

function setRestaurantWorkspaceVisible(isVisible) {
  const isLoggedIn = !!restaurantState.token;
  const hasRestaurant = isVisible; // isVisible is true when restaurants array is not empty
  
  restaurantRefs.workspace.classList.toggle("hidden", !hasRestaurant);
  restaurantRefs.logoutButton.classList.toggle("hidden", !isLoggedIn);
  restaurantRefs.createSection.classList.toggle("hidden", !(isLoggedIn && !hasRestaurant));
  
  if (restaurantRefs.accessForm) {
    const loginSection = restaurantRefs.accessForm.closest('.topbar');
    if (loginSection) {
      loginSection.classList.toggle("hidden", isLoggedIn);
    }
  }
  
  document.body.classList.toggle("app-unauthenticated", !isLoggedIn);
}

function syncRestaurantWorkspaceCards() {
  const cards = [...document.querySelectorAll(".workspace-collapsible-restaurant")];
  cards.forEach((card) => {
    const isActive = card.dataset.cardKey === restaurantState.activeWorkspaceCard;
    card.classList.toggle("panel-expanded", isActive);
    card.classList.toggle("panel-collapsed", !isActive);
    const header = card.querySelector(".panel-head");
    if (header) {
      header.setAttribute("aria-expanded", isActive ? "true" : "false");
    }
  });
}

function initializeRestaurantWorkspaceCards() {
  const cardMap = [
    ["#restaurantWorkspace > section:nth-of-type(2) > article:nth-of-type(1)", "restaurant-performance"],
    ["#restaurantWorkspace > section:nth-of-type(2) > article:nth-of-type(2)", "restaurant-integration-wizard"],
    ["#restaurantWorkspace > section:nth-of-type(3)", "restaurant-notifications"],
    ["#restaurantWorkspace > section:nth-of-type(4) > article:nth-of-type(3)", "restaurant-payload"],
    ["#restaurantWorkspace > section:nth-of-type(6)", "restaurant-history"],
    ["#restaurantWorkspace > section:nth-of-type(7) > article:nth-of-type(1)", "restaurant-platform-form"],
    ["#restaurantWorkspace > section:nth-of-type(7) > article:nth-of-type(2)", "restaurant-webhook-info"],
    ["#restaurantWorkspace > section:nth-of-type(8)", "restaurant-account"],
    ["#restaurantWorkspace > section:nth-of-type(9)", "restaurant-platform-accounts"],
  ];

  cardMap.forEach(([selector, key]) => {
    const card = document.querySelector(selector);
    if (!card) {
      return;
    }

    card.dataset.cardKey = key;
    card.classList.add("workspace-collapsible", "workspace-collapsible-restaurant");

    const header = card.querySelector(".panel-head");
    if (!header || header.dataset.bound === "1") {
      return;
    }

    header.dataset.bound = "1";
    header.classList.add("panel-toggle-head");
    header.tabIndex = 0;
    header.setAttribute("role", "button");

    const activate = () => {
      restaurantState.activeWorkspaceCard = restaurantState.activeWorkspaceCard === key ? "" : key;
      syncRestaurantWorkspaceCards();
    };

    header.addEventListener("click", (event) => {
      if (event.target.closest("button, select, input, textarea, a, label")) {
        return;
      }
      activate();
    });

    header.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      activate();
    });
  });

  syncRestaurantWorkspaceCards();
}

function stopRestaurantWorkspacePolling() {
  if (restaurantState.workspacePollId !== null) {
    window.clearInterval(restaurantState.workspacePollId);
    restaurantState.workspacePollId = null;
  }
}

function startRestaurantWorkspacePolling() {
  if (restaurantState.workspacePollId !== null || !restaurantState.token) {
    return;
  }

  restaurantState.workspacePollId = window.setInterval(() => {
    loadRestaurantWorkspace({ silent: true });
  }, RESTAURANT_WORKSPACE_REFRESH_MS);
}

function startRestaurantLiveStream() {
  if (restaurantState.liveStream || !restaurantState.token) {
    return;
  }

  restaurantState.liveStream = connectLiveStream("/api/restaurant/stream", restaurantState.token, {
    onMessage(event) {
      if (event?.message) {
        showToast(event.message, notificationTone(event.type));
        if (event.type === "package-created" || event.type === "platform-order" || event.type === "platform-order-pending" || event.type === "integration-order") {
          playSignal("assignment");
        } else if (event.type === "assignment-waiting") {
          playSignal("critical");
        } else if (event.type === "package-status") {
          playSignal("ready");
        }
      }
      loadRestaurantWorkspace({ silent: true });
    },
    onError() {
      if (restaurantRefs.liveBadge) {
        restaurantRefs.liveBadge.textContent = "Canli akis tekrar baglaniyor";
      }
      restaurantState.liveStream?.close?.();
      restaurantState.liveStream = null;
      window.setTimeout(() => startRestaurantLiveStream(), 2000);
    },
  });
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

function setLabelText(label, text) {
  if (!label) {
    return;
  }

  const textNode = [...label.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
  if (textNode) {
    textNode.textContent = `\n              ${text}\n              `;
    return;
  }

  label.prepend(document.createTextNode(`${text} `));
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isGetirPlatform(platform = "") {
  return String(platform).toLowerCase().includes("getir");
}

function isTrendyolPlatform(platform = "") {
  return String(platform).toLowerCase().includes("trendyol");
}

function isYemeksepetiPlatform(platform = "") {
  return String(platform).toLowerCase().includes("yemeksepeti");
}

function platformClientConfig(platform = "") {
  if (isTrendyolPlatform(platform)) {
    return {
      mode: "polling",
      testStrategy: "polling",
      webhookEnabled: false,
      pollingEnabled: true,
      requiredFields: ["externalStoreId", "apiKey", "apiSecret"],
      label: "Polling otomatik aktif",
    };
  }
  if (isGetirPlatform(platform)) {
    return {
      mode: "webhook",
      testStrategy: "local_webhook",
      webhookEnabled: true,
      pollingEnabled: false,
      requiredFields: ["externalStoreId", "staticToken"],
      label: "Webhook otomatik aktif",
    };
  }
  if (isYemeksepetiPlatform(platform)) {
    return {
      mode: "hybrid",
      testStrategy: "auto",
      webhookEnabled: true,
      pollingEnabled: true,
      requiredFields: ["externalStoreId", "staticToken"],
      label: "Webhook/Polling otomatik",
    };
  }
  return {
    mode: "webhook",
    testStrategy: "local_webhook",
    webhookEnabled: true,
    pollingEnabled: false,
    requiredFields: ["externalStoreId", "staticToken"],
    label: "Otomatik mod",
  };
}

function platformFriendlyMessage(message = "", account = null) {
  const text = String(message || "").trim();
  if (!text) {
    return "";
  }
  if (/Restaurant\/platform match failed/i.test(text)) {
    return "Restoran ID bu platformla eşleşmedi. Gerçek Store/Restaurant ID girilmeli.";
  }
  if (/Polling endpoint ayarl[ıi] de[ğg]il|polling endpoint not configured/i.test(text)) {
    return "Bu platform polling desteklemiyor. Webhook modu kullanılacak.";
  }
  if (/API eri|yetki kapal|403/i.test(text)) {
    return "Bu restoran için API yetkisi kapalı. Platform panelinden API/POS entegrasyon izni açılmalı.";
  }
  if (/Unauthorized|401|API Key veya API Secret hatal/i.test(text)) {
    return "API Key, Secret veya Token hatalı olabilir.";
  }
  return text;
}

function isBenignPlatformMessage(message = "", account = null) {
  const text = String(message || "").trim();
  return /Polling kapal[ıi]|polling desteklemiyor|Webhook modu kullanılacak/i.test(text) ||
    (/Polling endpoint/i.test(text) && isGetirPlatform(account?.platform));
}

function isTemporaryPlatformId(value = "") {
  return /(^|[-_])(test|demo|sample|ornek|örnek)([-_]|$)|getir-restaurant-\d+|test-store-\d+/i.test(String(value || "").trim());
}

function platformHintCard(message, tone = "info") {
  if (!message) {
    return "";
  }
  return `<div class="platform-alert platform-alert-${tone}">${escapeHtml(message)}</div>`;
}

function platformStatusChip(text, tone = "neutral", icon = "•") {
  return `<span class="platform-chip platform-chip-${tone}"><span aria-hidden="true">${icon}</span>${escapeHtml(text)}</span>`;
}

function connectionStatusForAccount(account, pollingReady = false, webhookReady = false) {
  if (account?.connectionStatus) {
    return {
      connected: { text: "Bağlantı aktif", tone: "success" },
      warning: { text: "Uyarı var", tone: "warning" },
      error: { text: "Hatalı", tone: "error" },
      disabled: { text: "Devre dışı", tone: "neutral" },
      unknown: { text: "Kontrol edilmedi", tone: "warning" },
    }[account.connectionStatus] || { text: "Kontrol edilmedi", tone: "warning" };
  }
  const errorText = platformFriendlyMessage(account?.lastError || "", account);
  if (errorText && !isBenignPlatformMessage(errorText, account)) {
    if (/API yetkisi/i.test(errorText)) {
      return { text: "API yetkisi bekliyor", tone: "warning" };
    }
    return { text: "Hata var", tone: "error" };
  }
  if (account?.verificationStatus === "verified" || account?.lastVerificationAt || account?.lastWebhookAt || account?.lastPollAt) {
    return { text: "Bağlandı", tone: "success" };
  }
  if (pollingReady || webhookReady) {
    return { text: "Hazır", tone: "success" };
  }
  return { text: "Bağlantı bekliyor", tone: "warning" };
}

function simplifyPlatformAccountForm() {
  const form = restaurantRefs.platformAccountForm;
  if (!form) {
    return;
  }

  const storeInput = form.querySelector('[name="externalStoreId"]');
  const platformSelect = form.querySelector('[name="platform"]');
  const secretInput = form.querySelector('[name="staticToken"], [name="webhookSecret"]');
  const initiallyHiddenFieldNames = [
    "externalMerchantId",
    "webhookAuthType",
    "apiUsername",
    "apiPassword",
    "storeFrontCode",
    "chainId",
    "vendorId",
    "posSecretKey",
  ];

  initiallyHiddenFieldNames.forEach((name) => {
    const field = form.querySelector(`[name="${name}"]`);
    const label = field?.closest("label");
    if (!field || !label) {
      return;
    }
    field.required = false;
    field.disabled = true;
    label.classList.add("hidden");
  });

  if (storeInput) {
    setLabelText(storeInput.closest("label"), "Platform Restaurant ID / Store ID / Vendor ID");
    storeInput.placeholder = "Platformdaki gerçek restoran/store ID";
  }

  if (secretInput) {
    const secretLabel = secretInput.closest("label");
    setLabelText(secretLabel, "Webhook Secret");
    secretInput.type = "password";
    secretInput.placeholder = "Webhook icin gizli anahtar";
    secretInput.required = true;
    if (storeInput?.closest("label") && secretLabel) {
      storeInput.closest("label").insertAdjacentElement("afterend", secretLabel);
    }
  }

  const authTitle = restaurantRefs.platformSetupAuth?.previousElementSibling;
  if (authTitle) {
    authTitle.textContent = "Webhook Secret";
  }
  const storeTitle = restaurantRefs.platformSetupStore?.previousElementSibling;
  if (storeTitle) {
    storeTitle.textContent = "Platform Restaurant ID";
  }

  ["apiKey", "apiSecret", "token"].forEach((name) => {
    const field = form.querySelector(`[name="${name}"]`);
    if (field) {
      field.type = "password";
      field.autocomplete = "new-password";
    }
  });

  if (!form.querySelector(".platform-form-hint")) {
    const hint = document.createElement("div");
    hint.className = "platform-form-hint full-width";
    platformSelect?.closest("label")?.insertAdjacentElement("afterend", hint);
  }

  applyPlatformFormMode();
}

function setFieldVisible(form, name, isVisible) {
  const field = form.querySelector(`[name="${name}"]`);
  const label = field?.closest("label");
  if (!field || !label) {
    return;
  }
  label.classList.toggle("hidden", !isVisible);
  field.disabled = !isVisible;
  field.required = false;
}

function setCheckboxValue(form, name, checked) {
  const field = form.querySelector(`[name="${name}"]`);
  if (field) {
    field.checked = checked;
  }
}

function applyPlatformFormMode() {
  const form = restaurantRefs.platformAccountForm;
  if (!form) {
    return;
  }

  const platform = form.querySelector('[name="platform"]')?.value || "";
  const config = platformClientConfig(platform);
  const isGetir = isGetirPlatform(platform);
  const isTrendyol = isTrendyolPlatform(platform);
  const isYemeksepeti = isYemeksepetiPlatform(platform);
  const storeInput = form.querySelector('[name="externalStoreId"]');
  const secretInput = form.querySelector('[name="staticToken"]');
  const apiSecretInput = form.querySelector('[name="apiSecret"]');
  const apiKeyInput = form.querySelector('[name="apiKey"]');
  const tokenInput = form.querySelector('[name="token"]');
  const hint = form.querySelector(".platform-form-hint");
  const webhookToggleLabel = form.querySelector('[name="webhookEnabled"]')?.closest("label");
  const pollingToggleLabel = form.querySelector('[name="pollingEnabled"]')?.closest("label");
  const activeToggleLabel = form.querySelector('[name="active"]')?.closest("label");

  ["externalStoreId", "staticToken", "apiKey", "apiSecret", "token", "integrationReferenceCode"].forEach((name) => {
    setFieldVisible(form, name, true);
  });
  webhookToggleLabel?.classList.add("hidden");
  pollingToggleLabel?.classList.add("hidden");
  activeToggleLabel?.classList.add("hidden");
  setCheckboxValue(form, "webhookEnabled", config.webhookEnabled);
  setCheckboxValue(form, "pollingEnabled", config.pollingEnabled);
  setCheckboxValue(form, "active", true);

  if (isGetir) {
    setLabelText(storeInput?.closest("label"), "Restaurant ID / Store ID");
    storeInput.placeholder = "Gerçek Getir restoran/store ID";
    storeInput.required = true;
    setLabelText(secretInput?.closest("label"), "Webhook Secret");
    secretInput.placeholder = "Getir webhook secret";
    secretInput.required = true;
    setLabelText(apiSecretInput?.closest("label"), "API Secret (opsiyonel)");
    apiSecretInput.placeholder = "Boş bırakılırsa webhook secret kullanılabilir";
    apiSecretInput.required = false;
    setFieldVisible(form, "apiKey", false);
    setFieldVisible(form, "token", false);
    if (hint) {
      hint.textContent = "Getir Yemek webhook modu ile otomatik çalışır. Store/Restaurant ID ve Webhook Secret girip kaydet.";
    }
  } else if (isTrendyol) {
    setLabelText(storeInput?.closest("label"), "Restaurant ID / Supplier ID");
    storeInput.placeholder = "Trendyol restaurant/supplier ID";
    storeInput.required = true;
    setLabelText(secretInput?.closest("label"), "Webhook Secret");
    secretInput.placeholder = "Webhook kullanılıyorsa secret";
    secretInput.required = false;
    setLabelText(apiKeyInput?.closest("label"), "API Key");
    apiKeyInput.required = true;
    setLabelText(apiSecretInput?.closest("label"), "API Secret");
    apiSecretInput.required = true;
    setLabelText(tokenInput?.closest("label"), "Token (opsiyonel)");
    tokenInput.required = false;
    if (hint) {
      hint.textContent = "Trendyol Yemek polling modu ile otomatik çalışır. Supplier ID, API Key ve API Secret zorunludur.";
    }
  } else if (isYemeksepeti) {
    setLabelText(storeInput?.closest("label"), "Vendor / Restaurant ID");
    storeInput.placeholder = "Yemeksepeti vendor/restaurant ID";
    storeInput.required = true;
    setLabelText(secretInput?.closest("label"), "Webhook Secret");
    secretInput.required = true;
    setLabelText(apiKeyInput?.closest("label"), "API Key (opsiyonel)");
    apiKeyInput.required = false;
    setLabelText(apiSecretInput?.closest("label"), "API Secret (opsiyonel)");
    apiSecretInput.required = false;
    setLabelText(tokenInput?.closest("label"), "Token (opsiyonel)");
    tokenInput.required = false;
    if (hint) {
      hint.textContent = "Yemeksepeti webhook/polling destek durumuna göre otomatik çalışır. API bilgisi yoksa webhook modu kullanılır.";
    }
  } else if (hint) {
    storeInput.required = true;
    secretInput.required = true;
    hint.textContent = "Platforma ait gerçek restoran/store ID ve gerekli secret bilgilerini girin. Mod seçimi otomatik yapılır.";
  }
}

function normalizePlatformSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replaceAll(" ", "_")
    .replaceAll("-", "_");
}

function openPackagePrintWindow(pkg, restaurantName = "Delivera Express") {
  const win = window.open("", "_blank", "width=720,height=840");
  if (!win) {
    showToast("Yazdirma penceresi acilamadi.", "error");
    return;
  }

  const items = Array.isArray(pkg.items) && pkg.items.length
    ? pkg.items.map((item) => `
      <tr>
        <td>${item.name || "-"}</td>
        <td>${item.quantity || 1}</td>
        <td>${formatCurrency(item.price || 0)}</td>
      </tr>
    `).join("")
    : '<tr><td colspan="3">Urun bilgisi paylasilmadi.</td></tr>';

  win.document.write(`
    <html>
      <head>
        <title>${pkg.externalOrderNo} Fis</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 24px; color: #111; }
          h1 { margin: 0 0 12px; font-size: 24px; }
          h2 { margin: 18px 0 8px; font-size: 16px; }
          p { margin: 4px 0; }
          table { width: 100%; border-collapse: collapse; margin-top: 12px; }
          th, td { border-bottom: 1px solid #ddd; padding: 8px 4px; text-align: left; }
        </style>
      </head>
      <body>
        <h1>${restaurantName}</h1>
        <p>Platform: ${pkg.sourcePlatform || "-"}</p>
        <p style="display: flex; align-items: center; gap: 4px;">${SVG_PACKAGE} Siparis No: ${pkg.externalOrderNo || pkg.trackingNo || "-"}</p>
        <p>Musteri: ${pkg.recipient || "-"}</p>
        <p>Telefon: ${pkg.phone || "-"}</p>
        <p>Adres: ${pkg.deliveryAddress || pkg.address || "-"}</p>
        <h2>Urunler</h2>
        <table>
          <thead><tr><th>Urun</th><th>Adet</th><th>Tutar</th></tr></thead>
          <tbody>${items}</tbody>
        </table>
        <h2>Odeme</h2>
        <p>Odeme Tipi: ${pkg.paymentMethod || "-"}</p>
        <p>Toplam Tutar: ${formatCurrency(pkg.orderAmount || 0)}</p>
        <p>Notlar: ${pkg.customerNote || pkg.note || "-"}</p>
        <p>Tarih Saat: ${formatDate(pkg.createdAt)}</p>
      </body>
    </html>
  `);
  win.document.close();
  win.focus();
  window.setTimeout(() => win.print(), 150);
}

function normalizedPasteText(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .trim();
}

function findLabeledValue(text, labels = []) {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = text.match(new RegExp(`${escaped}\\s*[:\\-]?\\s*(.+)`, "i"));
    if (match?.[1]) {
      const value = match[1].split("\n")[0].trim();
      if (value) {
        return value;
      }
    }
  }
  return "";
}

function parseQuickPasteOrder(rawText) {
  const text = normalizedPasteText(rawText);
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const phoneMatch = text.match(/(?:\+?90\s*)?(05\d[\d\s-]{8,})/);
  const phone = phoneMatch
    ? phoneMatch[1].replace(/[^\d]/g, "").replace(/^90(?=5)/, "")
    : "";

  const customerName = findLabeledValue(text, ["Musteri", "MÃ¼ÅŸteri", "Ad Soyad", "AdÄ± SoyadÄ±", "Alici", "AlÄ±cÄ±"]);
  const paymentMethod = (() => {
    const labeled = findLabeledValue(text, ["Odeme", "Ã–deme", "Odeme Tipi", "Ã–deme Tipi"]);
    if (labeled) {
      return labeled;
    }
    if (/nakit kapida|kapida nakit|nakit/i.test(text)) {
      return "Nakit";
    }
    if (/online|kart|kredi karti|kredi kartÄ±|pos/i.test(text)) {
      return "Online Odeme";
    }
    return "";
  })();
  const customerNote = findLabeledValue(text, ["Not", "Aciklama", "AÃ§Ä±klama", "Kurye Notu", "Musteri Notu", "MÃ¼ÅŸteri Notu"]);
  const amountMatch = text.match(/(?:toplam|tutar|odeme|Ã¶deme)\s*[:\-]?\s*[â‚ºâ‚¸]?\s*([\d\.,]+)/i) || text.match(/[â‚ºâ‚¸]\s*([\d\.,]+)/);
  const normalizedAmount = amountMatch?.[1]
    ? Number(String(amountMatch[1]).replace(/\./g, "").replace(",", "."))
    : null;
  const packageType = findLabeledValue(text, ["Paket Tipi", "Urun", "ÃœrÃ¼n", "Siparis", "SipariÅŸ"]) || "Hizli Platform Siparisi";

  const labeledAddress = findLabeledValue(text, ["Adres", "Teslimat Adresi", "Musteri Adresi", "MÃ¼ÅŸteri Adresi"]);
  const longAddressLine = lines
    .filter((line) => line.length >= 18 && !/^(telefon|odeme|Ã¶deme|musteri|mÃ¼ÅŸteri|not|aciklama|aÃ§Ä±klama|toplam|tutar)\b/i.test(line))
    .sort((left, right) => right.length - left.length)[0] || "";
  const customerAddress = labeledAddress || longAddressLine;

  return {
    customerName,
    phone,
    customerAddress,
    paymentMethod,
    customerNote,
    packageType,
    orderAmount: Number.isFinite(normalizedAmount) && normalizedAmount > 0 ? normalizedAmount : "",
  };
}


function getCurrentRestaurant(data) {
  return data.restaurants.find((item) => item.id === restaurantState.selectedRestaurantId) || data.restaurants[0] || null;
}

function getCurrentPlatformAccount(data) {
  return data.platformAccounts?.[0] || null;
}

function currentWebhookUrl() {
  return `${window.location.origin}/api/webhooks/orders`;
}

function getLastWebhookLog(data, account) {
  const logs = Array.isArray(data?.webhookLogs) ? data.webhookLogs : [];
  if (!account) {
    return logs[0] || null;
  }
  return logs.find((log) => log.sourcePlatform === account.platform) || logs[0] || null;
}

function activeOrderPackages(packages) {
  return packages.filter((pkg) => !["delivered", "failed", "cancelled"].includes(pkg.status));
}

function packageSourceLabel(pkg) {
  if (pkg.source === "platform_manual") {
    return "Hizli Yapistir";
  }
  if (pkg.source === "external_manual" || pkg.source === "manual") {
    return "Manuel Paket";
  }
  return pkg.sourcePlatform;
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
    safeSetText(restaurantRefs.integrationRestaurant, "Henuz restoran oturumu acik degil.");
    safeSetText(restaurantRefs.integrationApiKey, "API key panelde gosterilmez");
    safeSetText(restaurantRefs.integrationPortalUsername, "Portal kullanici burada gorunur");
    safeSetText(restaurantRefs.integrationWebhookSecret, "Secret panelde gosterilmez");
    safeSetText(restaurantRefs.integrationEndpoint, "Restoran girisi yapildiginda endpoint gorunur");
    safeSetText(restaurantRefs.platformWebhookUrl, "Platform hesabini kaydedince webhook URL gorunur");
    safeSetText(restaurantRefs.platformSetupName, "Henuz kayitli platform yok.");
    safeSetText(restaurantRefs.platformSetupAuth, "Secret kaydedilmedi");
    safeSetText(restaurantRefs.platformSetupStore, "Store/vendor bilgisi burada gorunur");
    safeSetText(restaurantRefs.platformSetupHint, "Polling API kapalı — webhook ile sipariş bekleniyor");
    safeSetText(restaurantRefs.samplePayload, "Restoran girisi yapildiginda webhook govdesi bilgisi gorunecek.");
    return;
  }

  restaurantState.selectedRestaurantId = restaurant.id;

  const integration = explicitIntegration || {
    restaurantId: restaurant.id,
    restaurantName: restaurant.name,
    portalUsername: restaurant.username,
    apiKey: restaurant.apiKey ? "Kayitli" : "Eksik",
    webhookSecret: restaurant.webhookSecret ? "Kayitli" : "Eksik",
    endpoint: currentWebhookUrl(),
    samplePayload: {
      platform: normalizePlatformSlug(restaurant.platforms[0] || "Trendyol Yemek"),
      platformRestaurantId: restaurant.id,
      orderId: "PLATFORM-ORDER-ID",
      customerName: "Musteri Adi",
      phone: "05555555555",
      address: "Mersin teslimat adresi",
      totalPrice: 250,
      items: [{ id: "item-1", name: "Urun", quantity: 1, price: 250 }],
      paymentMethod: "Online Odeme",
      customerNote: "Kapidan ara",
    },
  };

  safeSetText(restaurantRefs.integrationRestaurant, `${integration.restaurantName} - ${restaurant.zone}`);
  safeSetText(restaurantRefs.integrationApiKey, integration.apiKey ? "Kayitli, panelde gosterilmez" : "Eksik");
  safeSetText(restaurantRefs.integrationPortalUsername, integration.portalUsername || restaurant.username || "-");
  safeSetText(restaurantRefs.integrationWebhookSecret, integration.webhookSecret ? "Kayitli, panelde gosterilmez" : "Eksik");
  safeSetText(restaurantRefs.integrationEndpoint, integration.endpoint);
  safeSetText(restaurantRefs.samplePayload, JSON.stringify(integration.samplePayload, null, 2));
  if (restaurantRefs.packageRestaurantId) {
    restaurantRefs.packageRestaurantId.value = restaurant.id;
  }
}

function setPlatformSetup(data) {
  const account = getCurrentPlatformAccount(data);

  if (!account) {
    safeSetText(restaurantRefs.platformWebhookUrl, currentWebhookUrl());
    safeSetText(restaurantRefs.platformSetupName, "Henuz kayitli platform yok.");
    safeSetText(restaurantRefs.platformSetupAuth, "Secret kaydedilmedi");
    safeSetText(restaurantRefs.platformSetupStore, "Platform restoran bilgisi burada gorunur");
    safeSetText(restaurantRefs.platformSetupHint, "Polling API kapalı — webhook ile sipariş bekleniyor");
    return;
  }

  const lastWebhook = getLastWebhookLog(data, account);
  const accountConfig = platformClientConfig(account.platform);
  const modeText = accountConfig.mode === "hybrid"
    ? "Webhook/Polling otomatik"
    : (accountConfig.mode === "polling" ? "Polling otomatik" : "Webhook otomatik");
  safeSetText(restaurantRefs.platformWebhookUrl, currentWebhookUrl());
  safeSetText(restaurantRefs.platformSetupName, `${account.platform} - ${modeText}`);
  safeSetText(restaurantRefs.platformSetupStore, account.externalStoreId ? `ID kayitli: ${account.externalStoreId}` : "ID eksik");
  safeSetText(restaurantRefs.platformSetupAuth, account.hasWebhookSecret || account.webhookSecret ? "Secret kayitli" : "Secret eksik");
  safeSetText(
    restaurantRefs.platformSetupHint,
    [
      `${modeText} mod seçildi.`,
      account.lastWebhookAt ? `Son webhook: ${formatDate(account.lastWebhookAt)}` : (lastWebhook ? `Son webhook: ${formatDate(lastWebhook.createdAt)}` : "Son webhook: henuz yok"),
      account.lastPollAt ? `Son polling: ${formatDate(account.lastPollAt)}` : "Son polling: henuz yok",
      account.lastWebhookAt ? "Son doğrulama: gerçek webhook alındı" : "Son doğrulama: ilk gerçek sipariş bekleniyor",
      account.lastError ? `Son hata: ${platformFriendlyMessage(account.lastError, account)}` : "Son hata: yok",
    ].join(" ")
  );
}

function renderRestaurantList(restaurants) {
  const signature = listRenderSignature(restaurants, ["id", "name", "zone", "latitude", "longitude"]);
  if (restaurantRefs.restaurantList.__deliveraRenderSignature === signature) {
    return;
  }
  restaurantRefs.restaurantList.__deliveraRenderSignature = signature;
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
  const signature = listRenderSignature(accounts || [], ["id", "platform", "externalStoreId", "active", "lastWebhookAt", "lastPollAt", "lastVerificationAt", "verifiedAt", "lastError", "connectionStatus", "lastCheckAt", "lastSuccessAt", "lastErrorAt", "lastErrorCode", "lastErrorMessage", "lastHttpStatus", "lastLatencyMs", "consecutiveFailures", "hasApiKey", "hasApiSecret", "hasWebhookSecret", "pollingEnabled", "webhookEnabled"]);
  if (restaurantRefs.platformAccountList.__deliveraRenderSignature === signature) {
    return;
  }
  restaurantRefs.platformAccountList.__deliveraRenderSignature = signature;
  restaurantRefs.platformAccountList.innerHTML = "";

  if (!accounts || accounts.length === 0) {
    restaurantRefs.platformAccountList.innerHTML = '<div class="empty-state">Bu restorana bagli platform hesabi yok.</div>';
    return;
  }

  accounts.forEach((account) => {
    const card = document.createElement("article");
    card.className = "stack-card platform-account-card";
    const lastWebhook = getLastWebhookLog(restaurantState.data, account);
    const accountConfig = platformClientConfig(account.platform);
    const pollingCredentialsReady = Boolean(account.hasApiKey && account.hasApiSecret);
    const pollingReady = Boolean(accountConfig.mode !== "webhook" && account.pollingEnabled && pollingCredentialsReady);
    const isGetir = isGetirPlatform(account.platform);
    const hasWebhookSecret = Boolean(account.hasWebhookSecret || account.webhookSecret);
    const hasTemporaryId = isTemporaryPlatformId(account.externalStoreId);
    const friendlyLastError = platformFriendlyMessage(account.lastError, account);
    const benignLastError = isBenignPlatformMessage(account.lastError, account);
    const readyForWebhook = Boolean(accountConfig.mode !== "polling" && account.webhookEnabled && hasWebhookSecret && account.externalStoreId);
    const connectionStatus = connectionStatusForAccount(account, pollingReady, readyForWebhook);
    const health = account.connectionHealth || {};
    const healthMessage = health.publicMessage || friendlyLastError || "Bağlantı henuz dogrulanmadi. Son durumu kontrol edin.";
    const modeText = account.mode === "hybrid" || accountConfig.mode === "hybrid"
      ? "Otomatik hybrid"
      : (accountConfig.mode === "polling" ? "Polling otomatik" : "Webhook otomatik");
    const credentialText = pollingReady || readyForWebhook ? "Bilgiler kayıtlı" : "Bağlantı bilgisi bekliyor";
    const lastWebhookText = account.lastWebhookAt ? formatDate(account.lastWebhookAt) : (lastWebhook ? formatDate(lastWebhook.createdAt) : "Henüz yok");
    const lastPollText = account.lastPollAt ? formatDate(account.lastPollAt) : "Henüz yok";
    const lastVerificationTime = account.lastVerificationAt || account.verifiedAt || account.lastPollAt || account.lastWebhookAt || "";
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <div class="platform-card-title">
            <span class="platform-logo-dot">${escapeHtml(String(account.platform || "?").slice(0, 1))}</span>
            <div>
              <strong>${escapeHtml(account.platform)}</strong>
              <p>${escapeHtml(modeText)} çalışma modu</p>
            </div>
          </div>
          <div class="platform-chip-row">
            ${platformStatusChip(modeText, "success", "↯")}
            ${platformStatusChip(credentialText, (pollingReady || readyForWebhook) ? "success" : "warning", "●")}
            ${platformStatusChip(account.externalStoreId ? "Restoran ID kayıtlı" : "Restoran ID eksik", account.externalStoreId ? "success" : "warning", "#")}
          </div>
          <div class="platform-meta-grid">
            <span>Platform Restaurant ID<strong>${account.externalStoreId ? escapeHtml(account.externalStoreId) : "Eksik"}</strong></span>
            <span>Çalışma modu<strong>${escapeHtml(modeText)}</strong></span>
            <span>Son doğrulama<strong>${lastVerificationTime ? escapeHtml(formatDate(lastVerificationTime)) : "İlk gerçek sipariş bekleniyor"}</strong></span>
            <span>Son webhook<strong>${lastWebhookText}</strong></span>
          </div>
          ${hasTemporaryId ? platformHintCard(`${account.externalStoreId} geçici ID gibi görünüyor. Platformdaki gerçek restoran/store ID ile değiştirin.`, "warning") : ""}
          ${platformHintCard(healthMessage, connectionStatus.tone === "error" ? "error" : connectionStatus.tone === "warning" ? "warning" : "success")}
        </div>
        <span class="platform-live-badge platform-live-${connectionStatus.tone}">${connectionStatus.text}</span>
      </div>
      <div class="card-actions">
        <button class="ghost-btn" type="button" data-platform-check="${account.id}">Bağlantıyı Kontrol Et</button>
        <button class="ghost-btn" type="button" data-platform-refresh="${account.id}">Son Durumu Yenile</button>
      </div>
    `;
    restaurantRefs.platformAccountList.appendChild(card);
  });
}

function renderRestaurantPerformance(performance) {
  if (!restaurantRefs.performanceBoard) {
    return;
  }

  const data = performance || {
    todayOrderCount: 0,
    deliveredTodayCount: 0,
    averageAssignmentMinutes: 0,
    averageDeliveryMinutes: 0,
    failedDeliveryRate: 0,
  };
  const signature = listRenderSignature([data], ["todayOrderCount", "deliveredTodayCount", "averageAssignmentMinutes", "averageDeliveryMinutes", "failedDeliveryRate"]);
  if (restaurantRefs.performanceBoard.__deliveraRenderSignature === signature) {
    return;
  }
  restaurantRefs.performanceBoard.__deliveraRenderSignature = signature;

  restaurantRefs.performanceBoard.innerHTML = `
    <article class="mini-stat-card">
      <span>Bugun Siparis</span>
      <strong>${data.todayOrderCount}</strong>
    </article>
    <article class="mini-stat-card">
      <span>Teslim Edilen</span>
      <strong>${data.deliveredTodayCount}</strong>
    </article>
    <article class="mini-stat-card">
      <span>Ort. Atama</span>
      <strong>${data.averageAssignmentMinutes} dk</strong>
    </article>
    <article class="mini-stat-card">
      <span>Ort. Teslim</span>
      <strong>${data.averageDeliveryMinutes} dk</strong>
    </article>
    <article class="mini-stat-card">
      <span>Basarisiz Oran</span>
      <strong>%${data.failedDeliveryRate}</strong>
    </article>
  `;
}

function renderIntegrationWizard(wizard) {
  if (!restaurantRefs.integrationWizardSteps) {
    return;
  }

  const safeWizard = wizard || {
    webhookUrl: currentWebhookUrl(),
    verificationStatus: "pending",
    helpText: "Webhook modu icin once platformRestaurantId ve secret kaydet.",
    steps: [],
  };
  const signature = [
    safeWizard.webhookUrl,
    safeWizard.verificationStatus,
    safeWizard.helpText,
    listRenderSignature(safeWizard.steps || [], ["title", "label", "done"]),
  ].join("||");
  if (restaurantRefs.integrationWizardSteps.__deliveraRenderSignature === signature) {
    return;
  }
  restaurantRefs.integrationWizardSteps.__deliveraRenderSignature = signature;

  restaurantRefs.integrationWizardSteps.innerHTML = safeWizard.steps.map((step) => `
    <article class="stack-card wizard-step-card ${step.done ? "wizard-step-done" : ""}">
      <div class="stack-top">
        <div>
          <strong>${step.title} - ${step.label}</strong>
          <p>${step.done ? "Hazir" : "Siradaki adim bekliyor"}</p>
        </div>
        <span class="soft-badge">${step.done ? "Tamam" : "Bekliyor"}</span>
      </div>
    </article>
  `).join("") || '<div class="empty-state">Entegrasyon sihirbazi icin once restoran oturumu ac.</div>';

  restaurantRefs.integrationWizardWebhook.textContent = safeWizard.webhookUrl;
  restaurantRefs.integrationWizardStatus.textContent = `${safeWizard.helpText} Durum: Webhook modu aktif.`;
}

function renderRecentOrders(packages) {
  const list = packages.slice(0, 8);
  const signature = listRenderSignature(list, ["id", "trackingNo", "externalOrderNo", "status", "assignedCourierId", "assignedCourierName", "paymentStatus", "updatedAt"]);
  if (restaurantRefs.recentOrders.__deliveraRenderSignature === signature) {
    return;
  }
  restaurantRefs.recentOrders.__deliveraRenderSignature = signature;
  restaurantRefs.recentOrders.innerHTML = "";

  if (list.length === 0) {
    restaurantRefs.recentOrders.innerHTML = '<div class="empty-state">Bu restorana ait aktif siparis veya manuel paket yok.</div>';
    return;
  }

  list.forEach((pkg) => {
    const card = document.createElement("article");
    card.className = `stack-card order-summary-card ${!pkg.assignedCourierId ? "priority-alert-card" : ""}`;
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <strong class="entity-line">${SVG_PACKAGE} ${pkg.packageType || "Standart Paket"} - ${pkg.externalOrderNo}</strong>
          <p class="entity-line">${SVG_MOTO} ${pkg.restaurantName} - ${pkg.recipient}</p>
          <p>Kaynak: ${packageSourceLabel(pkg)}</p>
        </div>
        <span class="status-badge ${statusClassName(pkg.status)}">${statusLabel(pkg.status)}</span>
      </div>
      <div class="meta-grid compact-meta-grid">
        <div>
          <span>Adres</span>
          <strong class="entity-line">${SVG_PIN} ${pkg.deliveryAddress || pkg.address}</strong>
        </div>
        <div>
          <span>Kurye</span>
          <strong class="entity-line">${SVG_COURIER} ${pkg.assignedCourierName || "Kurye bekleniyor"}</strong>
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
      <div style="margin-top: 12px; border-top: 1px solid var(--line); padding-top: 12px; text-align: right;">
        <button class="ghost-btn details-btn" type="button" aria-label="${pkg.trackingNo || "Siparis"} detayini goruntule" style="padding: 6px 16px; font-size: 0.85rem; border-radius: 8px;">Detayı Görüntüle</button>
      </div>
    `;
    card.querySelector('.details-btn')?.addEventListener('click', () => {
      if (typeof showPackageDetailsModal === 'function') showPackageDetailsModal(pkg);
    });
    restaurantRefs.recentOrders.appendChild(card);
  });
}

function renderActiveOrders(data) {
  const packageList = [...data.packages].sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
  const courierById = courierMap(data);
  const restaurantName = data.restaurants?.[0]?.name || "Delivera Express";
  const signature = [
    restaurantName,
    listRenderSignature(packageList, ["id", "trackingNo", "externalOrderNo", "status", "assignedCourierId", "assignedCourierName", "paymentStatus", "lastAssignmentError", "updatedAt"]),
    listRenderSignature(data.couriers || [], ["id", "status", "lastLocationAt"]),
  ].join("||");
  if (restaurantRefs.activeOrders.__deliveraRenderSignature === signature) {
    return;
  }
  restaurantRefs.activeOrders.__deliveraRenderSignature = signature;
  restaurantRefs.activeOrders.innerHTML = "";

  if (packageList.length === 0) {
    restaurantRefs.activeOrders.innerHTML = '<div class="empty-state">Bu restorana ait siparis yok. Manuel paket veya webhook siparisi geldiginde burada gorunecek.</div>';
    return;
  }

  packageList.forEach((pkg) => {
    const courier = pkg.assignedCourierId ? courierById.get(pkg.assignedCourierId) : null;
    const sourceLabel = packageSourceLabel(pkg);
    const assignmentBadge = pkg.status === "pending_approval"
      ? "Restoran Onayi Bekliyor"
      : pkg.assignedCourierId
        ? "Kurye Atandi"
        : pkg.status === "preparing"
          ? "Kurye Araniyor"
          : "Atama Bekliyor";
    const assignmentTone = pkg.assignedCourierId ? "soft-badge" : "soft-badge status-awaiting-assignment";
    const prepCode = `DLV-${String(pkg.id || "").slice(-4).toUpperCase()}`;
    const isPlatformOrder = pkg.source !== "external_manual" && pkg.source !== "manual";
    const isConfirmed = String(pkg.assignmentReason || "").toLowerCase().includes("onay");

    const card = document.createElement("article");
    card.className = `stack-card order-summary-card modern-card ${pkg.status === "preparing" ? "anim-pulse-preparing" : ""}`;
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <strong style="display: flex; align-items: center; gap: 4px;">${SVG_PACKAGE} ${pkg.trackingNo} - ${pkg.externalOrderNo}</strong>
          <p>Kaynak: ${sourceLabel} - Musteri: ${pkg.recipient}</p>
          <p>Olusturulma: ${formatDate(pkg.createdAt)}</p>
        </div>
        <div class="badge-row">
          <span class="${assignmentTone}">${assignmentBadge}</span>
          <span class="status-badge ${statusClassName(pkg.status)}">${statusLabel(pkg.status)}</span>
          <span class="soft-badge">${paymentStatusLabel(pkg.paymentStatus)}</span>
        </div>
      </div>
      <div class="meta-grid compact-meta-grid">
        <div>
          <span>Paket ID</span>
          <strong>${pkg.id}</strong>
        </div>
        <div>
          <span>Hazirlik Kodu</span>
          <strong>${prepCode}</strong>
        </div>
        <div>
          <span>Adres</span>
          <strong class="entity-line">${SVG_PIN} ${pkg.deliveryAddress || pkg.address}</strong>
        </div>
        <div>
          <span>Not</span>
          <strong>${pkg.customerNote || pkg.note || "-"}</strong>
        </div>
        <div>
          <span>Odeme</span>
          <strong>${pkg.paymentMethod} - ${paymentStatusLabel(pkg.paymentStatus)} - ${formatCurrency(pkg.orderAmount)}</strong>
        </div>
        <div>
          <span>Kurye</span>
          <strong class="entity-line">${SVG_MOTO} ${pkg.assignedCourierName || "Henüz atanmadı"}</strong>
        </div>
        <div>
          <span>Kurye Durumu</span>
          <strong class="entity-line">${SVG_COURIER} ${courier ? courierStatusLabel(courier.status) : "-"}</strong>
        </div>
        <div>
          <span>Kurye Telefon</span>
          <strong>-</strong>
        </div>
        <div>
          <span>Atama Zamani</span>
          <strong>${pkg.assignedAt ? formatDate(pkg.assignedAt) : "-"}</strong>
        </div>
        <div>
          <span>Hazirlik Sayaci</span>
          <strong>${pkg.eta || "5 dk"}</strong>
        </div>
      </div>
      ${Array.isArray(pkg.items) && pkg.items.length ? `<p>Urunler: ${pkg.items.map((item) => `${item.quantity || 1}x ${item.name}`).join(", ")}</p>` : ""}
      ${pkg.lastAssignmentError ? `<p>Son Atama Notu: ${pkg.lastAssignmentError}</p>` : ""}
    `;

    if (pkg.status === "pending_approval" || isPlatformOrder) {
      const actions = document.createElement("div");
      actions.className = "card-actions";

      if (pkg.status === "pending_approval") {
        const confirmButton = document.createElement("button");
        confirmButton.type = "button";
        confirmButton.className = "ghost-btn";
        confirmButton.textContent = "Siparisi Onayla";
        confirmButton.addEventListener("click", async () => {
          try {
            const next = await api(`/api/restaurant/packages/${pkg.id}/action`, {
              method: "POST",
              headers: restaurantAuthHeaders(),
              retryWithRefresh: refreshRestaurantAccess,
              body: JSON.stringify({ action: "confirm" }),
            });
            hydrateRestaurant(next);
            showToast("Siparis onaylandi.");
          } catch (error) {
            showToast(error.message || "Siparis onaylanamadi.", "error");
          }
        });
        actions.appendChild(confirmButton);

        const rejectButton = document.createElement("button");
        rejectButton.type = "button";
        rejectButton.className = "ghost-btn";
        rejectButton.textContent = "Siparisi Reddet";
        rejectButton.addEventListener("click", async () => {
          const reason = window.prompt("Red nedeni", "Restoran kapasitesi uygun degil") || "Restoran reddetti.";
          try {
            const next = await api(`/api/restaurant/packages/${pkg.id}/action`, {
              method: "POST",
              headers: restaurantAuthHeaders(),
              retryWithRefresh: refreshRestaurantAccess,
              body: JSON.stringify({ action: "reject", reason }),
            });
            hydrateRestaurant(next);
            showToast("Siparis reddedildi.");
          } catch (error) {
            showToast(error.message || "Siparis reddedilemedi.", "error");
          }
        });
        actions.appendChild(rejectButton);
      }

      const printButton = document.createElement("button");
      printButton.type = "button";
      printButton.className = "primary-btn";
      printButton.textContent = "Yazdir";
      printButton.addEventListener("click", () => openPackagePrintWindow(pkg, restaurantName));
      actions.appendChild(printButton);

      card.appendChild(actions);
    }
    restaurantRefs.activeOrders.appendChild(card);
  });
}

function renderOrderHistory(packages) {
  const filteredHistory = [...packages]
    .filter((pkg) => ["delivered", "failed", "cancelled"].includes(pkg.status))
    .filter((pkg) => packageMatchesHistoryRange(pkg, restaurantState.historyRange))
    .sort((left, right) => new Date(right.updatedAt || right.createdAt) - new Date(left.updatedAt || left.createdAt))
  const list = filteredHistory.slice(0, restaurantState.historyVisibleCount);
  const signature = [
    restaurantState.historyRange,
    restaurantState.historyVisibleCount,
    filteredHistory.length,
    listRenderSignature(list, ["id", "trackingNo", "externalOrderNo", "status", "assignedCourierName", "paymentStatus", "updatedAt", "deliveredAt", "failedAt"]),
  ].join("||");
  if (restaurantRefs.orderHistory.__deliveraRenderSignature === signature) {
    return;
  }
  restaurantRefs.orderHistory.__deliveraRenderSignature = signature;
  restaurantRefs.orderHistory.innerHTML = "";

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
    card.className = `stack-card order-summary-card modern-card ${pkg.status === "preparing" ? "anim-pulse-preparing" : ""}`;
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <strong style="display: flex; align-items: center; gap: 4px;">${SVG_PACKAGE} ${pkg.trackingNo} - ${pkg.externalOrderNo}</strong>
          <p class="entity-line">${SVG_PIN} ${pkg.packageType || "Standart Paket"} - ${pkg.deliveryAddress || pkg.address}</p>
          <p>Guncelleme: ${formatDate(pkg.updatedAt || pkg.createdAt)}</p>
        </div>
        <span class="status-badge ${statusClassName(pkg.status)}">${statusLabel(pkg.status)}</span>
      </div>
      <div class="meta-grid compact-meta-grid">
        <div>
          <span>Kaynak</span>
          <strong>${packageSourceLabel(pkg)}</strong>
        </div>
        <div>
          <span>Kurye</span>
          <strong class="entity-line">${SVG_MOTO} ${pkg.assignedCourierName || "Atama yok"}</strong>
        </div>
        <div>
          <span>Odeme</span>
          <strong>${pkg.paymentMethod || "-"} - ${paymentStatusLabel(pkg.paymentStatus)} - ${formatCurrency(pkg.orderAmount)}</strong>
        </div>
      </div>
      <div style="margin-top: 12px; border-top: 1px solid var(--line); padding-top: 12px; text-align: right;">
        <button class="ghost-btn details-btn" type="button" aria-label="${pkg.trackingNo || "Siparis"} detayini goruntule" style="padding: 6px 16px; font-size: 0.85rem; border-radius: 8px;">Detayı Görüntüle</button>
      </div>
    `;
    card.querySelector('.details-btn')?.addEventListener('click', () => {
      if (typeof showPackageDetailsModal === 'function') showPackageDetailsModal(pkg);
    });
    restaurantRefs.orderHistory.appendChild(card);
  });
}

function renderRestaurantNotifications(notifications) {
  renderNotificationCenter(restaurantRefs.notificationCenter, notifications || [], "Restoran icin bildirim yok.");
}

function hydrateRestaurant(data, explicitIntegration = null) {
  restaurantState.data = data;
  restaurantState.selectedRestaurantId = data.restaurants[0]?.id || restaurantState.selectedRestaurantId;
  if (data.restaurants?.[0]) {
    persistRestaurantAccessInfo({
      restaurantId: data.restaurants[0].id,
      apiKey: data.restaurants[0].apiKey,
    });
  }
  initializeRestaurantWorkspaceCards();
  const activePackages = activeOrderPackages(data.packages || []);
  const awaitingPackages = activePackages.filter((pkg) => pkg.status === "pending" || pkg.status === "awaiting_assignment");
  const inTransitPackages = activePackages.filter((pkg) => pkg.status === "accepted_by_courier" || pkg.status === "on_route");
  const activeCourierIds = [...new Set(activePackages.filter((pkg) => pkg.assignedCourierId).map((pkg) => pkg.assignedCourierId))];

  if (data.restaurants.length === 0) {
    setRestaurantWorkspaceVisible(false);
    restaurantRefs.summary.textContent = "Restoran oturumu acik degil. Yeni restoran olusturabilir veya mevcut restoranla giris yapabilirsin.";
    restaurantRefs.packageRestaurantId.value = "";
    if (restaurantRefs.liveBadge) {
      restaurantRefs.liveBadge.textContent = "Canli akis kapali";
    }
  } else {
    setRestaurantWorkspaceVisible(true);
    restaurantRefs.summary.textContent =
      `${data.restaurants[0].name} icin ${data.packages.length} siparis gorunuyor. Bu panel yalnizca bu restoranin verilerini gosterir.`;
    if (restaurantRefs.liveBadge) {
      restaurantRefs.liveBadge.textContent = "Canli akis acik";
    }
  }

  restaurantRefs.totalPackages.textContent = activePackages.length;
  restaurantRefs.waitingPackages.textContent = awaitingPackages.length;
  restaurantRefs.inTransitPackages.textContent = inTransitPackages.length;
  restaurantRefs.activeCouriers.textContent = activeCourierIds.length;

  renderRestaurantList(data.restaurants);
  renderPlatformAccounts(data.platformAccounts || []);
  renderRestaurantPerformance(data.restaurantPerformance);
  renderIntegrationWizard(data.integrationWizard);
  renderRecentOrders(data.packages);
  renderActiveOrders(data);
  renderOrderHistory(data.packages);
  renderRestaurantNotifications(data.notifications || []);
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

async function loadRestaurantWorkspace(options = {}) {
  if (!restaurantState.token) {
    if (restaurantState.refreshToken) {
      try {
        await refreshRestaurantAccess();
      } catch {
        clearRestaurantAuth();
      }
    }
  }

  if (!restaurantState.token) {
    try {
      const restored = await tryRestaurantSessionFromStoredAccess();
      if (restored) {
        return;
      }
    } catch (error) {
      if (!options.silent) {
        restaurantRefs.summary.textContent = "Restoran oturumu bulunamadi, lutfen tekrar giris yapin";
      }
    }
    stopRestaurantWorkspacePolling();
    hydrateRestaurant({
      zones: [],
      restaurants: [],
      couriers: [],
      packages: [],
      webhookLogs: [],
      restaurantPerformance: null,
      integrationWizard: null,
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
    const params = new URLSearchParams({
      limit: String(restaurantState.packageLimit),
      cursor: restaurantState.packageCursor || "0",
    });
    const data = await api(`/api/restaurant/bootstrap?${params.toString()}`, {
      headers: restaurantAuthHeaders(),
      retryWithRefresh: refreshRestaurantAccess,
    });
    hydrateRestaurant(data);
    startRestaurantWorkspacePolling();
    startRestaurantLiveStream();
  } catch (error) {
    if (!options.silent) {
      clearRestaurantAuth();
      restaurantRefs.summary.textContent = error.message.includes("oturumu")
        ? "Restoran oturumu bulunamadi, lutfen tekrar giris yapin"
        : error.message;
    }
  }
}

restaurantRefs.accessForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(restaurantRefs.accessForm);
  try {
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
    startRestaurantLiveStream();
  } catch (error) {
    restaurantRefs.summary.textContent = error.message.includes("Restoran kimligi")
      ? "Restoran oturumu bulunamadi, lutfen tekrar giris yapin"
      : error.message;
    showToast(restaurantRefs.summary.textContent, "error");
  }
});

restaurantRefs.platformAccountForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!restaurantState.token || !restaurantState.data?.restaurants?.[0]) {
    restaurantRefs.summary.textContent = "Restoran oturumu bulunamadi, lutfen restoran paneline gecerli restoran baglantisiyla girin.";
    showToast("Restoran oturumu bulunamadi, lutfen restoran paneline gecerli restoran baglantisiyla girin.", "error");
    return;
  }

  const restaurant = restaurantState.data.restaurants[0];
  const formData = new FormData(restaurantRefs.platformAccountForm);
  const selectedPlatform = String(formData.get("platform") || "").trim();
  const config = platformClientConfig(selectedPlatform);
  const staticToken = String(formData.get("staticToken") || formData.get("webhookSecret") || "").trim();
  const externalStoreId = String(formData.get("externalStoreId") || "").trim();
  if (isTemporaryPlatformId(externalStoreId)) {
    const warning = `${externalStoreId} geçici ID gibi görünüyor. Platformdaki gerçek restoran/store ID girilmeli.`;
    restaurantRefs.summary.textContent = warning;
    showToast(warning, "error");
  }
  const platformRequestBody = {
    restaurantId: restaurant.id,
    platform: selectedPlatform,
    platformRestaurantId: externalStoreId,
    externalStoreId,
    externalMerchantId: formData.get("externalMerchantId"),
    apiUsername: formData.get("apiUsername"),
    apiPassword: formData.get("apiPassword"),
    apiKey: formData.get("apiKey"),
    apiSecret: formData.get("apiSecret"),
    token: formData.get("token"),
    integrationReferenceCode: formData.get("integrationReferenceCode"),
    posSecretKey: formData.get("posSecretKey"),
    storeFrontCode: formData.get("storeFrontCode"),
    chainId: formData.get("chainId"),
    vendorId: formData.get("vendorId"),
    active: true,
    webhookEnabled: config.webhookEnabled,
    pollingEnabled: config.pollingEnabled,
    webhookSecret: staticToken,
    authType: "static_token",
    staticToken,
    settings: {
      platformMode: config.mode,
      verificationStrategy: config.testStrategy,
      requiredFields: config.requiredFields,
    },
  };

  try {
    const data = await api("/api/restaurant/platform-accounts", {
      method: "POST",
      headers: restaurantAuthHeaders(),
      retryWithRefresh: refreshRestaurantAccess,
      body: JSON.stringify(platformRequestBody),
    });

    restaurantRefs.platformAccountForm.reset();
    restaurantRefs.platformSelect.innerHTML = createPlatformOptions();
    simplifyPlatformAccountForm();
    applyPlatformFormMode();
    hydrateRestaurant(data);
    const savedAccount = (data.platformAccounts || []).find((item) =>
      item.platform === selectedPlatform && item.externalStoreId === externalStoreId
    );
    restaurantRefs.summary.textContent = savedAccount?.id
      ? "Platform hesabı kaydedildi. İlk gerçek platform siparişi geldiğinde bağlantı otomatik doğrulanacak."
      : "Platform hesabı kaydedildi.";
    showToast(restaurantRefs.summary.textContent, "success");
  } catch (error) {
    const message = platformFriendlyMessage(error.message) || "Platform hesabı kaydedilemedi.";
    restaurantRefs.summary.textContent = message;
    showToast(message, "error");
  }
});

restaurantRefs.platformAccountList?.addEventListener("click", async (event) => {
  const checkButton = event.target.closest("[data-platform-check]");
  const refreshButton = event.target.closest("[data-platform-refresh]");
  const accountId = checkButton?.dataset.platformCheck || refreshButton?.dataset.platformRefresh || "";
  if (!accountId) {
    return;
  }
  const button = checkButton || refreshButton;
  button.disabled = true;
  button.textContent = checkButton ? "Kontrol ediliyor" : "Yenileniyor";
  try {
    const data = checkButton
      ? await api(`/api/restaurant/platform-accounts/${accountId}/check-connection`, {
          method: "POST",
          headers: restaurantAuthHeaders(),
          retryWithRefresh: refreshRestaurantAccess,
        })
      : await api(`/api/restaurant/platform-accounts/${accountId}/health`, {
          headers: restaurantAuthHeaders(),
          retryWithRefresh: refreshRestaurantAccess,
        });
    await loadRestaurantWorkspace();
    showToast(data.publicMessage || data.health?.publicMessage || "Platform bağlantı durumu güncellendi.", data.health?.status === "connected" ? "success" : "warning");
  } finally {
    button.disabled = false;
    button.textContent = checkButton ? "Bağlantıyı Kontrol Et" : "Son Durumu Yenile";
  }
});

restaurantRefs.copyWebhookButton?.addEventListener("click", async () => {
  const text = restaurantRefs.integrationWizardWebhook?.textContent || "";
  if (!text) {
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast("API bilgisi kopyalandi.");
  } catch {
    showToast("API bilgisi kopyalanamadi.", "error");
  }
});

restaurantRefs.manualPlatformOrderForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!restaurantState.token) {
    showToast("Once restoran girisi yapmalisin.", "error");
    return;
  }
  const formData = new FormData(restaurantRefs.manualPlatformOrderForm);
  try {
    const response = await api("/api/restaurant/platform-orders/manual", {
      method: "POST",
      headers: restaurantAuthHeaders(),
      retryWithRefresh: refreshRestaurantAccess,
      body: JSON.stringify({
        platform: formData.get("platform"),
        customerName: formData.get("customerName"),
        phone: formData.get("phone"),
        address: formData.get("address"),
        totalPrice: formData.get("totalPrice"),
        note: formData.get("note"),
      }),
    });
    if (!response.package?.id || !response.platformOrder?.id) {
      throw new Error("API platform siparisinin veritabanina yazildigini dogrulayan cevap dondurmedi.");
    }
    restaurantRefs.manualPlatformOrderForm.reset();
    hydrateRestaurant(response.state || response);
    showToast(`Manuel platform siparisi kaydedildi. ID: ${response.platformOrder.id}`);
  } catch (error) {
    showToast(error.message || "Manuel platform siparisi kaydedilemedi.", "error");
  }
});

restaurantRefs.quickPasteButton?.addEventListener("click", () => {
  setQuickPasteModalVisible(true);
});

restaurantRefs.quickPasteClose?.addEventListener("click", () => {
  setQuickPasteModalVisible(false);
});

restaurantRefs.quickPasteModal?.addEventListener("click", (event) => {
  if (event.target?.dataset?.modalClose === "quick-paste") {
    setQuickPasteModalVisible(false);
  }
});

restaurantRefs.mainQuickPasteParseButton?.addEventListener("click", () => {
  const rawText = restaurantRefs.mainQuickPasteRawText?.value || "";
  if (!rawText.trim()) {
    showToast("Lutfen once siparis metnini yapistirin.", "error");
    return;
  }
  const parsed = parseQuickPasteOrder(rawText);
  
  if (restaurantRefs.packageForm) {
    const elements = restaurantRefs.packageForm.elements;
    if (elements["customerName"]) elements["customerName"].value = parsed.customerName || "";
    if (elements["phone"]) elements["phone"].value = parsed.phone || "";
    if (elements["deliveryAddress"]) elements["deliveryAddress"].value = parsed.customerAddress || "";
    if (elements["customerNote"]) elements["customerNote"].value = parsed.customerNote || "";
    if (parsed.packageType && elements["packageType"]) elements["packageType"].value = parsed.packageType;
    if (parsed.orderAmount && elements["orderAmount"]) elements["orderAmount"].value = parsed.orderAmount;
  }
  
  showToast("Form otomatik dolduruldu. Lutfen kontrol edip Paket Olustur'a basin.");
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
    restaurantPerformance: null,
    integrationWizard: null,
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

let customerSearchTimer = null;
restaurantRefs.customerPhoneSearch?.addEventListener("input", () => {
  clearTimeout(customerSearchTimer);
  const phone = restaurantRefs.customerPhoneSearch.value.trim();
  if (restaurantRefs.restaurantCustomerId) {
    restaurantRefs.restaurantCustomerId.value = "";
  }
  if (!phone || phone.replace(/\D/g, "").length < 5) {
    if (restaurantRefs.customerSearchHint) restaurantRefs.customerSearchHint.textContent = "Telefon yazinca kayitli musteri aranir.";
    return;
  }
  customerSearchTimer = setTimeout(async () => {
    try {
      const data = await api(`/api/restaurant/customers?phone=${encodeURIComponent(phone)}`, {
        headers: restaurantAuthHeaders(),
        retryWithRefresh: refreshRestaurantAccess,
      });
      const customer = data.customers?.[0];
      if (!customer) {
        if (restaurantRefs.customerSearchHint) restaurantRefs.customerSearchHint.textContent = "Kayitli musteri bulunamadi; bilgileri girersen yeni kayit acilir.";
        return;
      }
      const elements = restaurantRefs.packageForm.elements;
      if (restaurantRefs.restaurantCustomerId) restaurantRefs.restaurantCustomerId.value = customer.id;
      if (elements["customerName"]) elements["customerName"].value = customer.name || "";
      if (elements["phone"]) elements["phone"].value = customer.phone || "";
      if (elements["deliveryAddress"]) elements["deliveryAddress"].value = customer.address || "";
      if (restaurantRefs.customerSearchHint) restaurantRefs.customerSearchHint.textContent = `${customer.name} bulundu; adres forma dolduruldu.`;
    } catch (error) {
      if (restaurantRefs.customerSearchHint) restaurantRefs.customerSearchHint.textContent = error.message || "Musteri aramasi basarisiz.";
    }
  }, 350);
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
  const payload = {
    deliveryAddress: formData.get("deliveryAddress"),
    packageType: formData.get("packageType"),
    orderAmount: formData.get("orderAmount"),
    customerName: formData.get("customerName"),
    phone: formData.get("phone"),
    customerNote: formData.get("customerNote"),
    paymentMethod: formData.get("paymentMethod"),
    restaurantCustomerId: formData.get("restaurantCustomerId"),
  };

  const file = restaurantRefs.packageImageInput?.files?.[0] || null;
  if (file) {
    if (file.size > 10 * 1024 * 1024) {
      showToast("Fotograf 10MB'dan kucuk olmalidir.", "error");
      return;
    }
    try {
      payload.photoBase64 = await compressImage(file);
    } catch (err) {
      console.error("Image compression error:", err);
      showToast("Fotograf islenemedi: " + (err.message || "Bilinmeyen hata"), "error");
      return;
    }
  }

  try {
    const data = await api("/api/restaurant/packages", {
      method: "POST",
      headers: restaurantAuthHeaders(),
      retryWithRefresh: refreshRestaurantAccess,
      body: JSON.stringify(payload),
    });

    if (!data.createdPackage?.id) {
      throw new Error("API paketin veritabanina yazildigini dogrulayan createdPackage cevabi dondurmedi.");
    }
    restaurantRefs.packageForm.reset();
    if (restaurantRefs.restaurantCustomerId) restaurantRefs.restaurantCustomerId.value = "";
    if (restaurantRefs.customerSearchHint) restaurantRefs.customerSearchHint.textContent = "Telefon yazinca kayitli musteri aranir.";
    if (restaurantRefs.packageImagePreview) {
      restaurantRefs.packageImagePreview.style.display = "none";
      restaurantRefs.packageImagePreview.src = "";
    }
    if (restaurantRefs.mainQuickPasteRawText) {
      restaurantRefs.mainQuickPasteRawText.value = "";
    }
    hydrateRestaurant(data);
    restaurantRefs.summary.textContent = `${currentRestaurant.name} icin paket olusturuldu ve dogrudan havuza iletildi.`;
    showToast("Paket kaydedildi ve dogrudan kurye havuzuna iletildi.");
  } catch (error) {
    restaurantRefs.summary.textContent = error.message || "Manuel paket kaydedilemedi.";
    showToast(error.message || "Manuel paket kaydedilemedi.", "error");
  }
});

restaurantRefs.platformSelect.innerHTML = createPlatformOptions();
if (restaurantRefs.manualPlatformSelect) {
  restaurantRefs.manualPlatformSelect.innerHTML = createPlatformOptions();
}
restaurantRefs.platformSelect?.addEventListener("change", applyPlatformFormMode);
if (restaurantRefs.samplePaymentMethod) {
  restaurantRefs.samplePaymentMethod.innerHTML = PAYMENT_OPTIONS.map((item) => `<option value="${item}">${item}</option>`).join("");
}
simplifyPlatformAccountForm();
restaurantRefs.samplePaymentMethod?.addEventListener("change", () => {
  if (restaurantState.data) {
    setIntegrationInfo(restaurantState.data);
  }
});

function compressImage(file, maxSize = 1200, quality = 0.7) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error("Dosya bulunamadi."));
    
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target.result;
      const img = new Image();
      
      img.onload = () => {
        let width = img.width;
        let height = img.height;
        
        if (width > maxSize || height > maxSize) {
          if (width > height) {
            height = Math.round(height * (maxSize / width));
            width = maxSize;
          } else {
            width = Math.round(width * (maxSize / height));
            height = maxSize;
          }
        }
        
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        
        try {
          resolve(canvas.toDataURL("image/jpeg", quality));
        } catch (err) {
          // Fallback to raw dataUrl if canvas compression fails
          resolve(dataUrl);
        }
      };
      
      img.onerror = () => {
        // If the browser cannot render this image type (e.g., raw HEIC),
        // fallback to uploading the raw base64 file without compression.
        resolve(dataUrl);
      };
      
      img.src = dataUrl;
    };
    
    reader.onerror = () => reject(new Error("Dosya okunamadi."));
    reader.readAsDataURL(file);
  });
}

function handleImagePreview(inputElement, previewElement) {
  if (!inputElement || !previewElement) return;
  inputElement.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        previewElement.src = ev.target.result;
        previewElement.style.display = "block";
      };
      reader.readAsDataURL(file);
    } else {
      previewElement.src = "";
      previewElement.style.display = "none";
    }
  });
}
handleImagePreview(restaurantRefs.packageImageInput, restaurantRefs.packageImagePreview);
  restaurantRefs.openCameraButton?.addEventListener("click", () => {
    if (restaurantRefs.packageImageInput) {
      // Force mobile browsers to open camera directly
      restaurantRefs.packageImageInput.setAttribute("capture", "environment");
      restaurantRefs.packageImageInput.click();
      
      // Remove the capture attribute after a short delay so manual file selection still works
      setTimeout(() => {
        restaurantRefs.packageImageInput.removeAttribute("capture");
      }, 500);
    }
  });

readStoredRestaurantAuth();
applyRestaurantAccessFromQuery();
setRestaurantWorkspaceVisible(Boolean(restaurantState.token || restaurantState.refreshToken));

api("/api/bootstrap")
  .then((data) => {
    return loadRestaurantWorkspace();
  })
  .catch((error) => {
    restaurantRefs.summary.textContent = error.message;
  });

window.addEventListener("beforeunload", stopRestaurantWorkspacePolling);

// ── Report module state ──────────────────────────────────────────────
let _lastReportData = null;
let _lastDetailData = null;
let _lastDetailDate = null;

const _reportDetailRefs = {
  section: restaurantRefs.reportDetailSection,
  title: restaurantRefs.reportDetailTitle,
  subtitle: restaurantRefs.reportDetailSubtitle,
  courierSummary: restaurantRefs.reportCourierSummary,
  detailBody: restaurantRefs.reportDetailTableBody,
  exportBtn: restaurantRefs.exportDetailExcel,
  closeBtn: restaurantRefs.closeReportDetail,
  exportSummaryBtn: restaurantRefs.exportReportExcel,
};

const _formatTRY = (val) =>
  new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY" }).format(val || 0);

// ── CSV / Excel Export Utility ───────────────────────────────────────
function exportToExcel(rows, filename) {
  // BOM for Turkish character support in Excel
  const BOM = "\uFEFF";
  const csv = rows.map((r) => r.join(";")).join("\r\n");
  const blob = new Blob([BOM + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Summary Report Loader (click-to-detail rows) ────────────────────
async function loadRestaurantReports() {
  if (!restaurantRefs.reportTableBody) return;

  if (_reportDetailRefs.section) _reportDetailRefs.section.style.display = "none";

  restaurantRefs.reportTableBody.innerHTML =
    '<tr><td colspan="6" style="text-align:center;">Raporlar yükleniyor...</td></tr>';

  try {
    const data = await api("/api/restaurant/reports/daily", {
      method: "GET",
      headers: restaurantAuthHeaders(),
      retryWithRefresh: refreshRestaurantAccess,
    });

    _lastReportData = data;

    if (!data.reports || data.reports.length === 0) {
      restaurantRefs.reportTableBody.innerHTML =
        '<tr><td colspan="6" style="text-align:center;">Geçmişe dönük gün sonu verisi bulunamadı.</td></tr>';
      return;
    }

    const rowsHTML = data.reports
      .map(
        (r) => `
      <tr data-report-date="${r.date}" style="cursor:pointer;transition:background .15s;"
          onmouseenter="this.style.background='rgba(255,255,255,.06)'"
          onmouseleave="this.style.background=''">
        <td>
          <strong>${r.date}</strong>
          <span class="report-detail-hint" style="margin-left:6px;font-size:11px;opacity:.45;transition:opacity .15s;">▸ Detay</span>
        </td>
        <td style="text-align:center;">${r.package_count} Paket</td>
        <td style="text-align:right;color:#4ade80;">${_formatTRY(r.cash_revenue)}</td>
        <td style="text-align:right;color:#60a5fa;">${_formatTRY(r.card_revenue)}</td>
        <td style="text-align:right;color:#a78bfa;">${_formatTRY(r.online_revenue)}</td>
        <td style="text-align:right;font-weight:700;">${_formatTRY(r.total_revenue)}</td>
      </tr>`
      )
      .join("");

    restaurantRefs.reportTableBody.innerHTML = rowsHTML;

    restaurantRefs.reportTableBody.querySelectorAll("tr[data-report-date]").forEach((tr) => {
      tr.addEventListener("click", () => {
        loadReportDetail(tr.dataset.reportDate);
      });
      tr.addEventListener("mouseenter", () => {
        const hint = tr.querySelector(".report-detail-hint");
        if (hint) hint.style.opacity = "1";
      });
      tr.addEventListener("mouseleave", () => {
        const hint = tr.querySelector(".report-detail-hint");
        if (hint) hint.style.opacity = ".45";
      });
    });
  } catch (err) {
    console.error("loadRestaurantReports error", err);
    restaurantRefs.reportTableBody.innerHTML =
      '<tr><td colspan="6" style="text-align:center;color:var(--coral);">Bağlantı hatası oluştu.</td></tr>';
  }
}

// ── Daily Detail Loader ──────────────────────────────────────────────
async function loadReportDetail(date) {
  if (!_reportDetailRefs.section) return;

  _lastDetailDate = date;
  _reportDetailRefs.section.style.display = "block";
  _reportDetailRefs.title.textContent = date + " — Günlük Detay";
  _reportDetailRefs.subtitle.textContent = "Yükleniyor...";
  _reportDetailRefs.courierSummary.innerHTML = "";
  _reportDetailRefs.detailBody.innerHTML =
    '<tr><td colspan="9" style="text-align:center;">Detay yükleniyor...</td></tr>';

  _reportDetailRefs.section.scrollIntoView({ behavior: "smooth", block: "start" });

  try {
    const data = await api("/api/restaurant/reports/daily-detail?date=" + date, {
      method: "GET",
      headers: restaurantAuthHeaders(),
      retryWithRefresh: refreshRestaurantAccess,
    });

    _lastDetailData = data;

    _reportDetailRefs.subtitle.textContent = `${data.summary.total_packages} Paket · ${data.couriers.length} Kurye · ${_formatTRY(data.summary.total_revenue)} Toplam Ciro`;

    if (data.couriers && data.couriers.length > 0) {
      _reportDetailRefs.courierSummary.innerHTML = data.couriers
        .map(
          (c) => `
        <div style="background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); padding:8px 12px; border-radius:8px;">
          <div style="font-size:12px; opacity:0.7;">${c.name}</div>
          <div style="font-weight:600; font-size:14px; margin-top:2px;">
            ${c.package_count} Pkt <span style="opacity:0.4; margin:0 4px;">|</span> <span style="color:var(--primary);">${_formatTRY(c.total_revenue)}</span>
          </div>
        </div>`
        )
        .join("");
    }

    if (!data.packages || data.packages.length === 0) {
      _reportDetailRefs.detailBody.innerHTML =
        '<tr><td colspan="9" style="text-align:center;">Kayıt bulunamadı.</td></tr>';
      return;
    }

    const rowsHTML = data.packages
      .map((pkg) => {
        const timeObj = pkg.delivered_at ? new Date(pkg.delivered_at) : null;
        const timeStr = timeObj
          ? timeObj.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })
          : "—";
        const addrShort = (pkg.delivery_address || pkg.address || "").substring(0, 40) + "…";

        return `
        <tr>
          <td><span style="font-family:monospace;opacity:.8;">${pkg.tracking_no || pkg.id}</span></td>
          <td><strong>${pkg.assigned_courier_name || "—"}</strong></td>
          <td>${pkg.recipient || "—"}</td>
          <td title="${pkg.delivery_address || pkg.address || ""}">${addrShort}</td>
          <td>${pkg.source_platform || "—"}</td>
          <td>${pkg.payment_method || "—"}</td>
          <td style="text-align:right;font-weight:600;">${_formatTRY(pkg.order_amount)}</td>
          <td>${timeStr}</td>
          <td style="text-align:right;">${pkg.distance_km ? pkg.distance_km + " km" : "—"}</td>
        </tr>`;
      })
      .join("");

    _reportDetailRefs.detailBody.innerHTML = rowsHTML;
  } catch (err) {
    console.error("loadReportDetail error", err);
    _reportDetailRefs.detailBody.innerHTML =
      '<tr><td colspan="9" style="text-align:center;color:var(--coral);">Bağlantı hatası oluştu.</td></tr>';
    _reportDetailRefs.subtitle.textContent = "Hata oluştu.";
  }
}

// ── Event Listeners ──────────────────────────────────────────────────
const reportsTab = document.querySelector('.tree-link[data-section="restaurantWorkspace_reports"]');
if (reportsTab) {
  reportsTab.addEventListener("click", () => {
    loadRestaurantReports();
  });
}

if (restaurantRefs.printReportButton) {
  restaurantRefs.printReportButton.addEventListener("click", () => {
    window.print();
  });
}

if (_reportDetailRefs.closeBtn) {
  _reportDetailRefs.closeBtn.addEventListener("click", () => {
    _reportDetailRefs.section.style.display = "none";
  });
}

if (_reportDetailRefs.exportSummaryBtn) {
  _reportDetailRefs.exportSummaryBtn.addEventListener("click", () => {
    if (!_lastReportData || !_lastReportData.reports) return;
    const rows = [
      ["Tarih", "Paket Sayisi", "Nakit", "Kredi Karti", "Online", "Toplam Ciro"],
    ];
    for (const r of _lastReportData.reports) {
      rows.push([
        r.date,
        r.package_count,
        r.cash_revenue,
        r.card_revenue,
        r.online_revenue,
        r.total_revenue,
      ]);
    }
    exportToExcel(rows, "delivera-z-raporu-ozet.csv");
  });
}

if (_reportDetailRefs.exportBtn) {
  _reportDetailRefs.exportBtn.addEventListener("click", () => {
    if (!_lastDetailData || !_lastDetailData.packages) return;
    const rows = [
      [
        "Takip No",
        "Kurye",
        "Alici",
        "Telefon",
        "Adres",
        "Platform",
        "Siparis No",
        "Odeme Yontemi",
        "Tutar",
        "Teslim Saati",
        "Mesafe (km)",
        "Not",
      ],
    ];
    for (const p of _lastDetailData.packages) {
      rows.push([
        p.tracking_no || p.id,
        p.assigned_courier_name || "",
        p.recipient || "",
        p.phone || "",
        (p.delivery_address || p.address || "").replace(/;/g, ",").replace(/\n/g, " "),
        p.source_platform || "",
        p.external_order_no || "",
        p.payment_method || "",
        p.order_amount || 0,
        p.delivered_at || "",
        p.distance_km || "",
        (p.note || "").replace(/;/g, ",").replace(/\n/g, " "),
      ]);
    }
    exportToExcel(rows, `delivera-detay-${_lastDetailDate}.csv`);
  });
}
