const DEFAULT_BACKEND_URL = "https://paketdelivera.onrender.com";
const shared = globalThis.DeliveraExtensionShared;
const STORAGE_KEYS = {
  backendUrl: "deliveraBackendUrl",
  restaurantToken: "deliveraRestaurantToken",
  platform: "deliveraPlatform",
  autoEnabled: "deliveraAutoEnabled",
  testMode: "deliveraTestMode",
  lastCandidate: "deliveraAutoLastCandidate",
  lastPostStatus: "deliveraAutoLastStatus",
  lastError: "deliveraAutoLastError",
  sentCount: "deliveraSentCount",
  duplicateCount: "deliveraAutoDuplicateCount",
};

const refs = {
  backendUrl: document.getElementById("backendUrl"),
  restaurantToken: document.getElementById("restaurantToken"),
  platformSelect: document.getElementById("platformSelect"),
  autoWatchToggle: document.getElementById("autoWatchToggle"),
  testModeToggle: document.getElementById("testModeToggle"),
  sendButton: document.getElementById("sendButton"),
  copyButton: document.getElementById("copyButton"),
  statusText: document.getElementById("statusText"),
  detectedPlatformText: document.getElementById("detectedPlatformText"),
  testModeCard: document.getElementById("testModeCard"),
  testModeText: document.getElementById("testModeText"),
  lastCandidateText: document.getElementById("lastCandidateText"),
  lastPostStatus: document.getElementById("lastPostStatus"),
  lastErrorText: document.getElementById("lastErrorText"),
  sentCountText: document.getElementById("sentCountText"),
  duplicateCountText: document.getElementById("duplicateCountText"),
};

console.log("extension popup loaded");

function setStatus(message, tone = "info") {
  refs.statusText.textContent = message;
  refs.statusText.dataset.tone = tone;
}

function normalizeToken(value) {
  const token = String(value || "").trim();
  if (!token) {
    return "";
  }
  return token.toLowerCase().startsWith("bearer ") ? token.slice(7).trim() : token;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("Aktif sekme bulunamadi.");
  }
  return tab;
}

async function saveSettings() {
  await chrome.storage.local.set({
    [STORAGE_KEYS.backendUrl]: refs.backendUrl.value.trim() || DEFAULT_BACKEND_URL,
    [STORAGE_KEYS.restaurantToken]: refs.restaurantToken.value.trim(),
    [STORAGE_KEYS.platform]: refs.platformSelect.value,
    [STORAGE_KEYS.autoEnabled]: Boolean(refs.autoWatchToggle.checked),
    [STORAGE_KEYS.testMode]: Boolean(refs.testModeToggle.checked),
  });
}

function renderTestMode(enabled) {
  refs.testModeToggle.checked = Boolean(enabled);
  refs.testModeCard.hidden = !enabled;
  refs.testModeText.textContent = enabled ? "Test modu aktif" : "";
}

function renderAutoState(saved = {}) {
  refs.lastCandidateText.textContent = saved[STORAGE_KEYS.lastCandidate] || "Henuz yok";
  refs.lastPostStatus.textContent = saved[STORAGE_KEYS.lastPostStatus] || "Henuz yok";
  refs.lastErrorText.textContent = saved[STORAGE_KEYS.lastError] || "Yok";
  refs.sentCountText.textContent = String(saved[STORAGE_KEYS.sentCount] || 0);
  refs.duplicateCountText.textContent = String(saved[STORAGE_KEYS.duplicateCount] || 0);
}

function renderDetectedPlatform(url = "") {
  const detectedPlatform = shared.detectPlatformFromUrl(url);
  refs.detectedPlatformText.textContent = detectedPlatform;
  return detectedPlatform;
}

async function loadSettings() {
  const saved = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
  const activeTab = await getActiveTab().catch(() => null);
  const detectedPlatform = renderDetectedPlatform(activeTab?.url || "");

  refs.backendUrl.value = saved[STORAGE_KEYS.backendUrl] || DEFAULT_BACKEND_URL;
  refs.restaurantToken.value = saved[STORAGE_KEYS.restaurantToken] || "";
  refs.platformSelect.value = saved[STORAGE_KEYS.platform] || detectedPlatform;
  refs.autoWatchToggle.checked = Boolean(saved[STORAGE_KEYS.autoEnabled]);
  renderTestMode(Boolean(saved[STORAGE_KEYS.testMode]));
  renderAutoState(saved);

  if (refs.autoWatchToggle.checked && !shared.isAllowedAutoWatchUrl(activeTab?.url || "", refs.testModeToggle.checked)) {
    setStatus("Bu sayfa desteklenen platform degil", "warn");
  }
}

async function extractOrderPayload(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["shared.js", "content.js"],
  });
  const response = await chrome.tabs.sendMessage(tabId, { type: "DELIVERA_EXTRACT_ORDER" });
  if (!response?.ok || !response.rawText) {
    throw new Error(response?.error || "Sayfadan siparis metni alinamadi.");
  }
  return response;
}

async function copyText(text) {
  await navigator.clipboard.writeText(text);
}

async function postToDelivera(rawText, source = "platform_extension", dedupeKey = "") {
  const backendUrl = (refs.backendUrl.value.trim() || DEFAULT_BACKEND_URL).replace(/\/+$/, "");
  const token = normalizeToken(refs.restaurantToken.value);
  if (!token) {
    throw new Error("Restaurant token gerekli.");
  }

  const payload = {
    source,
    sourcePlatform: refs.platformSelect.value,
    rawText,
    ...(dedupeKey ? { dedupeKey } : {}),
  };

  console.log(source === "platform_extension_auto" ? "auto posting to Delivera" : "posting to Delivera", { backendUrl, payload });
  const response = await fetch(`${backendUrl}/api/restaurant/packages/quick-paste`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Delivera gonderimi basarisiz.");
  }
  console.log(source === "platform_extension_auto" ? "auto post success" : "post success", data);
  return data;
}

async function handleSend() {
  try {
    await saveSettings();
    setStatus("Sayfadaki siparis okunuyor...");
    const tab = await getActiveTab();
    const extracted = await extractOrderPayload(tab.id);
    await postToDelivera(extracted.rawText, "platform_extension", extracted.manualDedupeKey);
    setStatus("Delivera'ya gonderildi", "success");
  } catch (error) {
    try {
      const tab = await getActiveTab();
      const extracted = await extractOrderPayload(tab.id);
      await copyText(extracted.rawText);
      console.log("post failed copied fallback", error);
      setStatus("API'ye gonderilemedi ama metin kopyalandi. Delivera paneline yapistirabilirsin.", "warn");
    } catch (fallbackError) {
      setStatus(fallbackError.message || error.message || "Islem basarisiz.", "error");
    }
  }
}

async function handleCopyOnly() {
  try {
    await saveSettings();
    const tab = await getActiveTab();
    const extracted = await extractOrderPayload(tab.id);
    await copyText(extracted.rawText);
    setStatus("Siparis metni kopyalandi", "success");
  } catch (error) {
    setStatus(error.message || "Metin kopyalanamadi.", "error");
  }
}

async function handleAutoToggle() {
  const token = normalizeToken(refs.restaurantToken.value);
  const backendUrl = refs.backendUrl.value.trim();
  const activeTab = await getActiveTab().catch(() => null);
  const isSupportedPlatform = shared.isAllowedAutoWatchUrl(activeTab?.url || "", refs.testModeToggle.checked);
  renderDetectedPlatform(activeTab?.url || "");

  if (refs.autoWatchToggle.checked && (!token || !backendUrl)) {
    refs.autoWatchToggle.checked = false;
    setStatus("Backend URL ve token gerekli", "error");
    await chrome.storage.local.set({
      [STORAGE_KEYS.lastError]: "Backend URL ve token gerekli",
      [STORAGE_KEYS.lastPostStatus]: "Otomatik izleme baslatilamadi",
    });
    return;
  }

  if (refs.autoWatchToggle.checked && !isSupportedPlatform) {
    refs.autoWatchToggle.checked = false;
    setStatus("Bu sayfa desteklenen platform degil", "warn");
    await chrome.storage.local.set({
      [STORAGE_KEYS.lastError]: "Bu sayfa desteklenen platform degil",
      [STORAGE_KEYS.lastPostStatus]: "Otomatik izleme desteklenmeyen sayfada kapali",
    });
    return;
  }

  await saveSettings();
  setStatus(refs.autoWatchToggle.checked ? "Otomatik izleme acildi." : "Otomatik izleme kapatildi.", refs.autoWatchToggle.checked ? "success" : "info");
}

async function handleTestModeToggle() {
  const activeTab = await getActiveTab().catch(() => null);
  const isAllowedInCurrentPage = shared.isAllowedAutoWatchUrl(activeTab?.url || "", refs.testModeToggle.checked);
  renderTestMode(refs.testModeToggle.checked);
  await saveSettings();
  if (refs.testModeToggle.checked) {
    if (refs.autoWatchToggle.checked && isAllowedInCurrentPage) {
      await chrome.storage.local.set({
        [STORAGE_KEYS.lastError]: "",
        [STORAGE_KEYS.lastPostStatus]: "Otomatik izleme acildi.",
      });
    }
    setStatus("Test modu aktif", "info");
    return;
  }
  if (refs.autoWatchToggle.checked) {
    await handleAutoToggle();
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") {
    return;
  }
  const snapshot = {};
  Object.keys(changes).forEach((key) => {
    snapshot[key] = changes[key].newValue;
  });
  renderAutoState({
    [STORAGE_KEYS.lastCandidate]: snapshot[STORAGE_KEYS.lastCandidate] ?? refs.lastCandidateText.textContent,
    [STORAGE_KEYS.lastPostStatus]: snapshot[STORAGE_KEYS.lastPostStatus] ?? refs.lastPostStatus.textContent,
    [STORAGE_KEYS.lastError]: snapshot[STORAGE_KEYS.lastError] ?? refs.lastErrorText.textContent,
    [STORAGE_KEYS.sentCount]: snapshot[STORAGE_KEYS.sentCount] ?? Number(refs.sentCountText.textContent || 0),
    [STORAGE_KEYS.duplicateCount]: snapshot[STORAGE_KEYS.duplicateCount] ?? Number(refs.duplicateCountText.textContent || 0),
  });
});

refs.sendButton.addEventListener("click", handleSend);
refs.copyButton.addEventListener("click", handleCopyOnly);
refs.autoWatchToggle.addEventListener("change", handleAutoToggle);
refs.testModeToggle.addEventListener("change", handleTestModeToggle);
refs.backendUrl.addEventListener("change", saveSettings);
refs.restaurantToken.addEventListener("change", saveSettings);
refs.platformSelect.addEventListener("change", saveSettings);

loadSettings().catch(() => {
  setStatus("Ayarlar yuklenemedi.", "warn");
});
