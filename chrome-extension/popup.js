const DEFAULT_BACKEND_URL = "https://paketdelivera.onrender.com";

const refs = {
  backendUrl: document.getElementById("backendUrl"),
  restaurantToken: document.getElementById("restaurantToken"),
  platformSelect: document.getElementById("platformSelect"),
  sendButton: document.getElementById("sendButton"),
  copyButton: document.getElementById("copyButton"),
  statusText: document.getElementById("statusText"),
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

function saveSettings() {
  chrome.storage.local.set({
    deliveraBackendUrl: refs.backendUrl.value.trim() || DEFAULT_BACKEND_URL,
    deliveraRestaurantToken: refs.restaurantToken.value.trim(),
    deliveraPlatform: refs.platformSelect.value,
  });
}

async function loadSettings() {
  const saved = await chrome.storage.local.get([
    "deliveraBackendUrl",
    "deliveraRestaurantToken",
    "deliveraPlatform",
  ]);
  refs.backendUrl.value = saved.deliveraBackendUrl || DEFAULT_BACKEND_URL;
  refs.restaurantToken.value = saved.deliveraRestaurantToken || "";
  refs.platformSelect.value = saved.deliveraPlatform || "Getir";
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("Aktif sekme bulunamadi.");
  }
  return tab;
}

async function extractPageText(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });

  const response = await chrome.tabs.sendMessage(tabId, { type: "DELIVERA_EXTRACT_ORDER" });
  if (!response?.ok || !response.rawText) {
    throw new Error(response?.error || "Sayfadan siparis metni alinamadi.");
  }
  console.log("page text extracted", response);
  return response.rawText;
}

async function copyText(text) {
  await navigator.clipboard.writeText(text);
}

async function postToDelivera(rawText) {
  const backendUrl = (refs.backendUrl.value.trim() || DEFAULT_BACKEND_URL).replace(/\/+$/, "");
  const token = normalizeToken(refs.restaurantToken.value);
  if (!token) {
    throw new Error("Restaurant token gerekli.");
  }

  const payload = {
    source: "platform_extension",
    sourcePlatform: refs.platformSelect.value,
    rawText,
  };

  console.log("posting to Delivera", { backendUrl, payload });
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
  console.log("post success", data);
  return data;
}

async function handleSend() {
  try {
    saveSettings();
    setStatus("Sayfadaki siparis okunuyor...");
    const tab = await getActiveTab();
    const rawText = await extractPageText(tab.id);
    await postToDelivera(rawText);
    setStatus("Delivera'ya gonderildi", "success");
  } catch (error) {
    try {
      const tab = await getActiveTab();
      const rawText = await extractPageText(tab.id);
      await copyText(rawText);
      console.log("post failed copied fallback", error);
      setStatus("API'ye gonderilemedi ama metin kopyalandi. Delivera paneline yapistirabilirsin.", "warn");
    } catch (fallbackError) {
      setStatus(fallbackError.message || error.message || "Islem basarisiz.", "error");
    }
  }
}

async function handleCopyOnly() {
  try {
    saveSettings();
    const tab = await getActiveTab();
    const rawText = await extractPageText(tab.id);
    await copyText(rawText);
    setStatus("Siparis metni kopyalandi", "success");
  } catch (error) {
    setStatus(error.message || "Metin kopyalanamadi.", "error");
  }
}

refs.sendButton.addEventListener("click", handleSend);
refs.copyButton.addEventListener("click", handleCopyOnly);
refs.backendUrl.addEventListener("change", saveSettings);
refs.restaurantToken.addEventListener("change", saveSettings);
refs.platformSelect.addEventListener("change", saveSettings);

loadSettings().catch(() => {
  setStatus("Ayarlar yuklenemedi.", "warn");
});
