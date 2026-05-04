const RESTAURANT_TOKEN_KEY = "deliveraRestaurantToken";
const RESTAURANT_REFRESH_TOKEN_KEY = "deliveraRestaurantRefreshToken";
const RESTAURANT_ID_KEY = "deliveraRestaurantId";
const RESTAURANT_API_KEY_KEY = "deliveraRestaurantApiKey";
const RESTAURANT_WORKSPACE_REFRESH_MS = 12_000;

console.log("restaurant.js loaded");

const restaurantState = {
  data: null,
  token: localStorage.getItem(RESTAURANT_TOKEN_KEY) || "",
  refreshToken: localStorage.getItem(RESTAURANT_REFRESH_TOKEN_KEY) || "",
  selectedRestaurantId: "",
  historyRange: "7d",
  historyVisibleCount: 50,
  workspacePollId: null,
  liveStream: null,
  activeWorkspaceCard: "restaurant-integration-wizard",
};

const restaurantRefs = {
  summary: document.getElementById("restaurantSummary"),
  accessForm: document.getElementById("restaurantAccessForm"),
  logoutButton: document.getElementById("restaurantLogoutButton"),
  copyExtensionTokenButton: document.getElementById("copyExtensionTokenButton"),
  createSection: document.getElementById("restaurantCreateSection"),
  workspace: document.getElementById("restaurantWorkspace"),
  platformAccountForm: document.getElementById("platformAccountForm"),
  manualPlatformOrderForm: document.getElementById("manualPlatformOrderForm"),
  packageForm: document.getElementById("packageForm"),
  packageRestaurantId: document.getElementById("packageRestaurantId"),
  platformSelect: document.getElementById("platformSelect"),
  manualPlatformSelect: document.getElementById("manualPlatformSelect"),
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
  integrationWizardWebhook: document.getElementById("integrationWizardWebhook"),
  integrationWizardStatus: document.getElementById("integrationWizardStatus"),
  copyWebhookButton: document.getElementById("copyWebhookButton"),
  testIntegrationButton: document.getElementById("testIntegrationButton"),
  quickPasteButton: document.getElementById("quickPasteButton"),
  quickPasteModal: document.getElementById("quickPasteModal"),
  quickPasteClose: document.getElementById("quickPasteClose"),
  quickPasteRawText: document.getElementById("quickPasteRawText"),
  quickPasteParseButton: document.getElementById("quickPasteParseButton"),
  quickPasteCustomerName: document.getElementById("quickPasteCustomerName"),
  quickPastePhone: document.getElementById("quickPastePhone"),
  quickPasteAddress: document.getElementById("quickPasteAddress"),
  quickPastePaymentMethod: document.getElementById("quickPastePaymentMethod"),
  quickPastePackageType: document.getElementById("quickPastePackageType"),
  quickPasteOrderAmount: document.getElementById("quickPasteOrderAmount"),
  quickPasteCustomerNote: document.getElementById("quickPasteCustomerNote"),
  quickPasteCreateButton: document.getElementById("quickPasteCreateButton"),
};

function restaurantAuthHeaders() {
  return authHeaders(restaurantState.token);
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

  if (restaurantId) {
    localStorage.setItem(RESTAURANT_ID_KEY, restaurantId);
  }
  if (apiKey) {
    localStorage.setItem(RESTAURANT_API_KEY_KEY, apiKey);
  }
}

function clearRestaurantAccessInfo() {
  localStorage.removeItem(RESTAURANT_ID_KEY);
  localStorage.removeItem(RESTAURANT_API_KEY_KEY);
}

function scanStorageForToken() {
  const matches = [];
  const scan = (storage, storageName) => {
    if (!storage) {
      return;
    }
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      const value = key ? storage.getItem(key) : "";
      const haystack = `${key || ""} ${value || ""}`.toLowerCase();
      if (!/(token|auth|jwt|access)/i.test(haystack)) {
        continue;
      }
      matches.push({ key, value, storageName });
    }
  };

  scan(window.localStorage, "localStorage");
  scan(window.sessionStorage, "sessionStorage");

  return matches.sort((left, right) => {
    if (left.key === RESTAURANT_TOKEN_KEY) {
      return -1;
    }
    if (right.key === RESTAURANT_TOKEN_KEY) {
      return 1;
    }
    return 0;
  });
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
  const restaurantId = localStorage.getItem(RESTAURANT_ID_KEY) || "";
  const apiKey = localStorage.getItem(RESTAURANT_API_KEY_KEY) || "";
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
  localStorage.setItem(RESTAURANT_TOKEN_KEY, auth.token);
  localStorage.setItem(RESTAURANT_REFRESH_TOKEN_KEY, auth.refreshToken);
  sessionStorage.setItem(RESTAURANT_TOKEN_KEY, auth.token);
  sessionStorage.setItem(RESTAURANT_REFRESH_TOKEN_KEY, auth.refreshToken);
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
  restaurantState.data = null;
  restaurantState.selectedRestaurantId = "";
  stopRestaurantWorkspacePolling();
  restaurantState.liveStream?.close?.();
  restaurantState.liveStream = null;
  localStorage.removeItem(RESTAURANT_TOKEN_KEY);
  localStorage.removeItem(RESTAURANT_REFRESH_TOKEN_KEY);
  sessionStorage.removeItem(RESTAURANT_TOKEN_KEY);
  sessionStorage.removeItem(RESTAURANT_REFRESH_TOKEN_KEY);
  clearRestaurantAccessInfo();
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

function simplifyPlatformAccountForm() {
  const form = restaurantRefs.platformAccountForm;
  if (!form) {
    return;
  }

  const storeInput = form.querySelector('[name="externalStoreId"]');
  const secretInput = form.querySelector('[name="staticToken"], [name="webhookSecret"]');
  const hiddenFieldNames = [
    "externalMerchantId",
    "webhookAuthType",
    "apiUsername",
    "apiPassword",
    "apiKey",
    "apiSecret",
    "storeFrontCode",
    "chainId",
    "vendorId",
  ];

  hiddenFieldNames.forEach((name) => {
    const field = form.querySelector(`[name="${name}"]`);
    const label = field?.closest("label");
    if (!field || !label) {
      return;
    }
    field.required = false;
    label.classList.add("hidden");
  });

  if (storeInput) {
    setLabelText(storeInput.closest("label"), "Platform Restaurant ID / Store ID / Vendor ID");
    storeInput.placeholder = "Ornek: TEST-STORE-1";
  }

  if (secretInput) {
    const secretLabel = secretInput.closest("label");
    setLabelText(secretLabel, "Webhook Secret");
    secretInput.type = "text";
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
        <p>Siparis No: ${pkg.externalOrderNo || pkg.trackingNo || "-"}</p>
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

function setQuickPasteModalVisible(isVisible) {
  if (!restaurantRefs.quickPasteModal) {
    return;
  }
  restaurantRefs.quickPasteModal.classList.toggle("hidden", !isVisible);
  restaurantRefs.quickPasteModal.setAttribute("aria-hidden", isVisible ? "false" : "true");
  if (isVisible) {
    console.log("quick paste modal opened");
  }
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
    const match = text.match(new RegExp(`${escaped}\\s*[:\\-]\\s*(.+)`, "i"));
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

  const customerName = findLabeledValue(text, ["Musteri", "Müşteri", "Ad Soyad", "Adı Soyadı", "Alici", "Alıcı"]);
  const paymentMethod = (() => {
    const labeled = findLabeledValue(text, ["Odeme", "Ödeme", "Odeme Tipi", "Ödeme Tipi"]);
    if (labeled) {
      return labeled;
    }
    if (/nakit kapida|kapida nakit|nakit/i.test(text)) {
      return "Nakit";
    }
    if (/online|kart|kredi karti|kredi kartı|pos/i.test(text)) {
      return "Online Odeme";
    }
    return "";
  })();
  const customerNote = findLabeledValue(text, ["Not", "Aciklama", "Açıklama", "Kurye Notu", "Musteri Notu", "Müşteri Notu"]);
  const amountMatch = text.match(/(?:toplam|tutar|odeme|ödeme)\s*[:\-]?\s*[₺₸]?\s*([\d\.,]+)/i) || text.match(/[₺₸]\s*([\d\.,]+)/);
  const normalizedAmount = amountMatch?.[1]
    ? Number(String(amountMatch[1]).replace(/\./g, "").replace(",", "."))
    : null;
  const packageType = findLabeledValue(text, ["Paket Tipi", "Urun", "Ürün", "Siparis", "Sipariş"]) || "Hizli Platform Siparisi";

  const labeledAddress = findLabeledValue(text, ["Adres", "Teslimat Adresi", "Musteri Adresi", "Müşteri Adresi"]);
  const longAddressLine = lines
    .filter((line) => line.length >= 18 && !/^(telefon|odeme|ödeme|musteri|müşteri|not|aciklama|açıklama|toplam|tutar)\b/i.test(line))
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

function fillQuickPasteFields(parsed) {
  if (restaurantRefs.quickPasteCustomerName) {
    restaurantRefs.quickPasteCustomerName.value = parsed.customerName || "";
  }
  if (restaurantRefs.quickPastePhone) {
    restaurantRefs.quickPastePhone.value = parsed.phone || "";
  }
  if (restaurantRefs.quickPasteAddress) {
    restaurantRefs.quickPasteAddress.value = parsed.customerAddress || "";
  }
  if (restaurantRefs.quickPastePaymentMethod) {
    restaurantRefs.quickPastePaymentMethod.value = parsed.paymentMethod || "";
  }
  if (restaurantRefs.quickPasteCustomerNote) {
    restaurantRefs.quickPasteCustomerNote.value = parsed.customerNote || "";
  }
  if (restaurantRefs.quickPastePackageType) {
    restaurantRefs.quickPastePackageType.value = parsed.packageType || "";
  }
  if (restaurantRefs.quickPasteOrderAmount) {
    restaurantRefs.quickPasteOrderAmount.value = parsed.orderAmount || "";
  }
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
    safeSetText(restaurantRefs.platformWebhookUrl, "Platform hesabini kaydedince API polling bilgisi gorunur");
    safeSetText(restaurantRefs.platformSetupName, "Henuz kayitli platform yok.");
    safeSetText(restaurantRefs.platformSetupAuth, "Auth bilgisi burada gorunur");
    safeSetText(restaurantRefs.platformSetupStore, "Store/vendor bilgisi burada gorunur");
    safeSetText(restaurantRefs.platformSetupHint, "Baglanti testi basarili olursa polling siparis cekmeye baslar.");
    safeSetText(restaurantRefs.samplePayload, "Restoran girisi yapildiginda ornek payload gorunecek.");
    return;
  }

  restaurantState.selectedRestaurantId = restaurant.id;

  const integration = explicitIntegration || {
    restaurantId: restaurant.id,
    restaurantName: restaurant.name,
    portalUsername: restaurant.username,
    apiKey: restaurant.apiKey ? "Kayitli" : "Eksik",
    webhookSecret: restaurant.webhookSecret ? "Kayitli" : "Eksik",
    endpoint: "Platform order API polling",
    samplePayload: {
      platform: normalizePlatformSlug(restaurant.platforms[0] || "Trendyol Go"),
      platformRestaurantId: "TEST-STORE-1",
      orderId: "TEST-ORDER-1",
      customerName: "Test Musteri",
      phone: "05555555555",
      address: "Mersin Test Adresi",
      totalPrice: 250,
      items: [{ id: "item-1", name: "Test Menu", quantity: 1, price: 250 }],
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
    safeSetText(restaurantRefs.platformWebhookUrl, "Platform hesabini kaydedince API polling testi hazir olur");
    safeSetText(restaurantRefs.platformSetupName, "Henuz kayitli platform yok.");
    safeSetText(restaurantRefs.platformSetupAuth, "API bilgisi burada gorunur");
    safeSetText(restaurantRefs.platformSetupStore, "Platform restoran bilgisi burada gorunur");
    safeSetText(restaurantRefs.platformSetupHint, "Baglanti testi basarili olursa polling siparis cekmeye baslar.");
    return;
  }

  safeSetText(restaurantRefs.platformWebhookUrl, "API polling: Created siparisler 10 saniyede bir cekilir");
  safeSetText(restaurantRefs.platformSetupName, `${account.platform} - ${account.active ? "aktif" : "pasif"}`);
  safeSetText(restaurantRefs.platformSetupStore, account.externalStoreId || "-");
  safeSetText(restaurantRefs.platformSetupAuth, account.hasApiKey && account.hasApiSecret ? "API key/secret kayitli" : "API bilgisi eksik");
  safeSetText(
    restaurantRefs.platformSetupHint,
    `${account.verificationStatus === "verified" ? "API aktif." : "API baglanti testi bekleniyor."} ${account.verificationNote || ""}`
  );
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
    const verificationText = account.verificationStatus === "verified"
      ? "API aktif"
      : account.verificationStatus === "failed"
        ? "API baglanti hatasi"
        : "API baglanti testi bekliyor";
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <strong>${account.platform}</strong>
          <p>Platform Restaurant ID: ${account.externalStoreId}</p>
          <p>Polling: 10 saniyede bir Created siparisler</p>
          <p>Son senkron: ${account.lastSyncAt || "Henuz yok"}</p>
          <p>${verificationText}${account.verificationNote ? ` - ${account.verificationNote}` : ""}</p>
        </div>
        <span class="soft-badge">${account.active ? "Canli" : "Pasif"}</span>
      </div>
      <div class="button-row">
        <button class="ghost-btn" type="button" data-platform-test-connection="${account.id}">Baglantiyi Test Et</button>
        <button class="ghost-btn" type="button" data-platform-sync="${account.id}">Simdi Siparis Cek</button>
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
    webhookUrl: "Platform hesabi kaydedince API polling bilgisi burada gorunur.",
    verificationStatus: "pending",
    helpText: "Platform entegrasyonu icin once hesap bilgilerini kaydet.",
    steps: [],
  };

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
  restaurantRefs.integrationWizardStatus.textContent = `${safeWizard.helpText} Durum: ${safeWizard.verificationStatus}.`;
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
    card.className = `stack-card order-summary-card ${!pkg.assignedCourierId ? "priority-alert-card" : ""}`;
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <strong>${pkg.packageType || "Standart Paket"} - ${pkg.externalOrderNo}</strong>
          <p>${pkg.restaurantName} - ${pkg.recipient}</p>
          <p>Kaynak: ${packageSourceLabel(pkg)}</p>
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
  const restaurantName = data.restaurants?.[0]?.name || "Delivera Express";

  if (packageList.length === 0) {
    restaurantRefs.activeOrders.innerHTML = '<div class="empty-state">Bu restorana ait siparis yok. Manuel paket veya API polling siparisi geldiginde burada gorunecek.</div>';
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
          <span>Hazirlik Kodu</span>
          <strong>${prepCode}</strong>
        </div>
        <div>
          <span>Adres</span>
          <strong>${pkg.deliveryAddress || pkg.address}</strong>
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
          <strong>${packageSourceLabel(pkg)}</strong>
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
    const data = await api("/api/restaurant/bootstrap", {
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
    restaurantRefs.summary.textContent = "Restoran oturumu bulunamadı, lütfen restoran paneline geçerli restoran bağlantısıyla girin.";
    showToast("Restoran oturumu bulunamadı, lütfen restoran paneline geçerli restoran bağlantısıyla girin.", "error");
    return;
  }

  const restaurant = restaurantState.data.restaurants[0];
  const formData = new FormData(restaurantRefs.platformAccountForm);
  const staticToken = String(formData.get("staticToken") || formData.get("webhookSecret") || "").trim();
  const platformRequestBody = {
    restaurantId: restaurant.id,
    platform: formData.get("platform"),
    platformRestaurantId: formData.get("externalStoreId"),
    externalStoreId: formData.get("externalStoreId"),
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
    active: formData.has("active"),
    webhookSecret: staticToken || String(formData.get("apiKey") || formData.get("apiPassword") || "").trim(),
    authType: "static_token",
    staticToken,
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
    hydrateRestaurant(data);
    restaurantRefs.summary.textContent = "Platform hesabı kaydedildi";
    showToast("Platform hesabi kaydedildi");
  } catch (error) {
    restaurantRefs.summary.textContent = error.message || "Platform hesabi kaydedilemedi.";
    showToast(error.message || "Platform hesabi kaydedilemedi.", "error");
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

restaurantRefs.testIntegrationButton?.addEventListener("click", async () => {
  const accountId = restaurantState.data?.integrationWizard?.currentAccountId;
  if (!accountId) {
    showToast("Test icin once platform hesabi kaydet.", "error");
    return;
  }
  try {
    const response = await api("/api/restaurant/platform-accounts/test-connection", {
      method: "POST",
      headers: restaurantAuthHeaders(),
      retryWithRefresh: refreshRestaurantAccess,
      body: JSON.stringify({ accountId }),
    });
    hydrateRestaurant(response.state);
    showToast(
      response.verification.status === "verified" ? "Baglanti basarili." : "API bilgileri eksik, manuel paket sistemi kullanilabilir.",
      response.verification.status === "verified" ? "success" : "error"
    );
  } catch (error) {
    showToast(error.message || "API bilgileri eksik, manuel paket sistemi kullanilabilir.", "error");
  }
});

restaurantRefs.platformAccountList?.addEventListener("click", async (event) => {
  const testConnectionButton = event.target.closest("[data-platform-test-connection]");
  const syncButton = event.target.closest("[data-platform-sync]");
  const accountId = testConnectionButton?.dataset.platformTestConnection || syncButton?.dataset.platformSync;
  if (!accountId) {
    return;
  }
  try {
    const endpoint = testConnectionButton
      ? "/api/restaurant/platform-accounts/test-connection"
      : "/api/restaurant/platform-accounts/sync";
    const response = await api(endpoint, {
      method: "POST",
      headers: restaurantAuthHeaders(),
      retryWithRefresh: refreshRestaurantAccess,
      body: JSON.stringify({ accountId }),
    });
    hydrateRestaurant(response.state || response);
    showToast(
      response.message || response.error || response.result?.reason || (testConnectionButton ? "Baglanti kontrol edildi." : "Siparis cekme kontrol edildi."),
      response.ok ? "success" : "error"
    );
  } catch (error) {
    showToast(error.message || "Platform islemi tamamlanamadi.", "error");
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
    restaurantRefs.manualPlatformOrderForm.reset();
    hydrateRestaurant(response.state || response);
    showToast("Manuel platform siparisi sisteme dustu.");
  } catch (error) {
    showToast(error.message || "Manuel platform siparisi kaydedilemedi.", "error");
  }
});

restaurantRefs.quickPasteButton?.addEventListener("click", () => {
  setQuickPasteModalVisible(true);
});

if (restaurantRefs.quickPasteButton) {
  console.log("quick paste button found");
}

restaurantRefs.quickPasteClose?.addEventListener("click", () => {
  setQuickPasteModalVisible(false);
});

restaurantRefs.quickPasteModal?.addEventListener("click", (event) => {
  if (event.target?.dataset?.modalClose === "quick-paste") {
    setQuickPasteModalVisible(false);
  }
});

restaurantRefs.quickPasteParseButton?.addEventListener("click", () => {
  const parsed = parseQuickPasteOrder(restaurantRefs.quickPasteRawText?.value || "");
  fillQuickPasteFields(parsed);
  console.log("quick paste parsed", parsed);
  showToast("Siparis metni ayiklandi. Eksik alan varsa duzeltebilirsin.");
});

restaurantRefs.quickPasteCreateButton?.addEventListener("click", async () => {
  if (!restaurantState.token) {
    showToast("Once restoran girisi yapmalisin.", "error");
    return;
  }

  const currentRestaurant = restaurantState.data?.restaurants?.[0];
  if (!currentRestaurant) {
    showToast("Aktif restoran oturumu bulunamadi.", "error");
    return;
  }

  const payload = {
    restaurantId: currentRestaurant.id,
    deliveryAddress: restaurantRefs.quickPasteAddress?.value || "",
    packageType: restaurantRefs.quickPastePackageType?.value || "Hizli Platform Siparisi",
    orderAmount: restaurantRefs.quickPasteOrderAmount?.value || "",
    customerName: restaurantRefs.quickPasteCustomerName?.value || "",
    phone: restaurantRefs.quickPastePhone?.value || "",
    customerAddress: restaurantRefs.quickPasteAddress?.value || "",
    paymentMethod: restaurantRefs.quickPastePaymentMethod?.value || "Panel Kaydi",
    customerNote: restaurantRefs.quickPasteCustomerNote?.value || "",
    source: "platform_manual",
    status: "preparing",
    sourcePlatform: "Hizli Yapistir",
    rawText: restaurantRefs.quickPasteRawText?.value || "",
  };

  if (!payload.deliveryAddress.trim()) {
    showToast("Musteri adresi gerekli.", "error");
    return;
  }
  if (!payload.orderAmount || Number(payload.orderAmount) <= 0) {
    showToast("Tutar bilgisi gerekli.", "error");
    return;
  }

  const data = await api("/api/restaurant/packages", {
    method: "POST",
    headers: restaurantAuthHeaders(),
    retryWithRefresh: refreshRestaurantAccess,
    body: JSON.stringify(payload),
  });
  console.log("quick paste submitted", payload);

  hydrateRestaurant(data);
  setQuickPasteModalVisible(false);
  if (restaurantRefs.quickPasteRawText) {
    restaurantRefs.quickPasteRawText.value = "";
  }
  fillQuickPasteFields({
    customerName: "",
    phone: "",
    customerAddress: "",
    paymentMethod: "",
    customerNote: "",
    packageType: "",
    orderAmount: "",
  });
  restaurantRefs.summary.textContent = `${currentRestaurant.name} icin hizli siparis olusturuldu ve kurye atamasi denendi.`;
  showToast("Hizli siparis kaydedildi ve kurye atamasi baslatildi.");
});

restaurantRefs.copyExtensionTokenButton?.addEventListener("click", async () => {
  const matches = scanStorageForToken().filter((item) => String(item.value || "").trim());
  const candidate = matches[0];

  if (!candidate?.value) {
    restaurantRefs.summary.textContent = "Token bulunamadi, lutfen tekrar giris yap";
    showToast("Token bulunamadi, lutfen tekrar giris yap", "error");
    return;
  }

  try {
    await navigator.clipboard.writeText(candidate.value);
    restaurantRefs.summary.textContent = `${candidate.storageName} icindeki ${candidate.key} panoya kopyalandi.`;
    showToast("Extension token panoya kopyalandi.");
  } catch {
    restaurantRefs.summary.textContent = "Token kopyalanamadi, clipboard iznini kontrol et.";
    showToast("Token kopyalanamadi, clipboard iznini kontrol et.", "error");
  }
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
  try {
    const data = await api("/api/restaurant/packages", {
      method: "POST",
      headers: restaurantAuthHeaders(),
      retryWithRefresh: refreshRestaurantAccess,
      body: JSON.stringify({
        restaurantId: currentRestaurant.id,
        deliveryAddress: formData.get("deliveryAddress"),
        packageType: formData.get("packageType"),
        orderAmount: formData.get("orderAmount"),
        customerName: formData.get("customerName"),
        phone: formData.get("phone"),
        customerNote: formData.get("customerNote"),
        paymentMethod: "Panel Kaydi",
      }),
    });

    restaurantRefs.packageForm.reset();
    hydrateRestaurant(data);
    restaurantRefs.summary.textContent = `${currentRestaurant.name} icin manuel paket kaydedildi, restoran onayi bekliyor.`;
    showToast("Manuel paket kaydedildi. Onaylayinca kurye atamasi baslar.");
  } catch (error) {
    restaurantRefs.summary.textContent = error.message || "Manuel paket kaydedilemedi.";
    showToast(error.message || "Manuel paket kaydedilemedi.", "error");
  }
});

restaurantRefs.platformSelect.innerHTML = createPlatformOptions();
if (restaurantRefs.manualPlatformSelect) {
  restaurantRefs.manualPlatformSelect.innerHTML = createPlatformOptions();
}
if (restaurantRefs.samplePaymentMethod) {
  restaurantRefs.samplePaymentMethod.innerHTML = PAYMENT_OPTIONS.map((item) => `<option value="${item}">${item}</option>`).join("");
}
applyRestaurantAccessFromQuery();
simplifyPlatformAccountForm();
restaurantRefs.samplePaymentMethod?.addEventListener("change", () => {
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

window.addEventListener("beforeunload", stopRestaurantWorkspacePolling);
document.querySelector("button").addEventListener("click", async () => {
  const sellerId = document.querySelector("input").value;

  const res = await fetch("/api/platform/account", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      platform: "Trendyol Go",
      platformRestaurantId: sellerId,
      webhookSecret: "delivera-gizli-anahtar-2026"
    })
  });

  const data = await res.json();
  console.log("SAVE RESULT:", data);
});