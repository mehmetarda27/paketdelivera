const STORAGE_KEYS = {
  backendUrl: "deliveraBackendUrl",
  restaurantToken: "deliveraRestaurantToken",
  platform: "deliveraPlatform",
  sentKeys: "deliveraSentOrderKeys",
  sentCount: "deliveraSentCount",
  duplicateCount: "deliveraAutoDuplicateCount",
  lastPostStatus: "deliveraAutoLastStatus",
  lastError: "deliveraAutoLastError",
  lastRawText: "deliveraAutoLastRawText",
  lastDedupeKey: "deliveraAutoLastDedupeKey",
};

function normalizeToken(value) {
  const token = String(value || "").trim();
  if (!token) {
    return "";
  }
  return token.toLowerCase().startsWith("bearer ") ? token.slice(7).trim() : token;
}

function buildQuickPasteUrl(backendUrl = "") {
  return `${String(backendUrl || "").trim().replace(/\/+$/, "")}/api/restaurant/packages/quick-paste`;
}

function shortenText(value, maxLength = 180) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function buildFetchErrorDetails(details = {}) {
  const backendUrl = String(details.backendUrl || "").trim();
  const endpoint = "/api/restaurant/packages/quick-paste";
  const requestUrl = String(details.requestUrl || buildQuickPasteUrl(backendUrl));
  const token = String(details.token || "").trim();
  const status = details.status ? `status=${details.status}` : "status=yok";
  const responseBody = shortenText(details.responseBody || "", 160);
  const exceptionMessage = details.exceptionMessage || details.message || "Bilinmeyen fetch hatasi";
  const lines = [
    "background fetch failed",
    `requestUrl=${requestUrl || "(bos)"}`,
    `tokenVarMi=${token ? "evet" : "hayir"}`,
    status,
  ];
  if (responseBody) {
    lines.push(`response=${responseBody}`);
  }
  lines.push(`exception=${exceptionMessage}`);
  return lines.join(" | ");
}

async function readResponseBodySafe(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

async function getStorageSnapshot() {
  return chrome.storage.local.get(Object.values(STORAGE_KEYS));
}

async function setStorageIfChanged(values) {
  const current = await getStorageSnapshot();
  const nextValues = {};
  Object.entries(values).forEach(([key, value]) => {
    if (current[key] !== value) {
      nextValues[key] = value;
    }
  });
  if (Object.keys(nextValues).length > 0) {
    await chrome.storage.local.set(nextValues);
  }
}

async function postToDelivera(rawText, source, sourcePlatform, dedupeKey = "", mode = "auto") {
  const settings = await getStorageSnapshot();
  const backendUrl = String(settings[STORAGE_KEYS.backendUrl] || "").trim();
  const token = normalizeToken(settings[STORAGE_KEYS.restaurantToken] || "");
  const platform = String(sourcePlatform || settings[STORAGE_KEYS.platform] || "Diger").trim() || "Diger";

  if (!backendUrl) {
    throw new Error("Backend URL gerekli");
  }
  if (!token) {
    throw new Error("Restaurant Token gerekli");
  }

  const requestUrl = buildQuickPasteUrl(backendUrl);
  const payload = {
    source,
    sourcePlatform: platform,
    rawText,
    ...(dedupeKey ? { dedupeKey } : {}),
  };

  console.log("background post url", requestUrl);

  try {
    const response = await fetch(requestUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    const responseBody = await readResponseBodySafe(response);
    let data = {};
    try {
      data = responseBody ? JSON.parse(responseBody) : {};
    } catch {
      data = {};
    }
    if (!response.ok) {
      throw new Error(buildFetchErrorDetails({
        backendUrl,
        requestUrl,
        token,
        status: response.status,
        responseBody: responseBody || data.error || "",
        exceptionMessage: `${mode}: ${data.error || `HTTP ${response.status}`}`,
      }));
    }
    return data;
  } catch (error) {
    throw new Error(
      error?.message?.includes("background fetch failed")
        ? error.message
        : buildFetchErrorDetails({
            backendUrl,
            requestUrl,
            token,
            responseBody: "",
            exceptionMessage: `${mode}: ${error?.message || String(error || "")}`,
          })
    );
  }
}

async function handleBackgroundPost(message) {
  const payload = message?.payload || {};
  const source = String(payload.source || "platform_extension_auto");
  const sourcePlatform = String(payload.sourcePlatform || "Diger");
  const rawText = String(payload.rawText || "");
  const dedupeKey = String(payload.dedupeKey || "");
  const mode = message.type === "DELIVERA_MANUAL_POST" ? "manual" : "auto";

  if (!rawText.trim()) {
    throw new Error("rawText zorunludur.");
  }

  const result = await postToDelivera(rawText, source, sourcePlatform, dedupeKey, mode);
  const settings = await getStorageSnapshot();
  const sentKeys = settings[STORAGE_KEYS.sentKeys] || {};
  const sentCount = Number(settings[STORAGE_KEYS.sentCount] || 0);
  const duplicateCount = Number(settings[STORAGE_KEYS.duplicateCount] || 0);

  if (dedupeKey) {
    sentKeys[dedupeKey] = new Date().toISOString();
  }

  if (result?.duplicate) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.sentKeys]: sentKeys,
      [STORAGE_KEYS.duplicateCount]: duplicateCount + 1,
      [STORAGE_KEYS.lastPostStatus]: mode === "auto" ? "duplicate skipped" : "manual duplicate skipped",
      [STORAGE_KEYS.lastError]: "",
      [STORAGE_KEYS.lastRawText]: rawText,
      [STORAGE_KEYS.lastDedupeKey]: dedupeKey,
    });
    return result;
  }

  await chrome.storage.local.set({
    [STORAGE_KEYS.sentKeys]: sentKeys,
    [STORAGE_KEYS.sentCount]: sentCount + 1,
    [STORAGE_KEYS.lastPostStatus]: mode === "auto" ? "auto post success" : "manual post success",
    [STORAGE_KEYS.lastError]: "",
    [STORAGE_KEYS.lastRawText]: rawText,
    [STORAGE_KEYS.lastDedupeKey]: dedupeKey,
  });
  return result;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "DELIVERA_AUTO_POST" && message?.type !== "DELIVERA_MANUAL_POST") {
    return false;
  }

  if (message.type === "DELIVERA_AUTO_POST") {
    console.log("background auto post received", message.payload || {});
  }

  handleBackgroundPost(message)
    .then((result) => {
      if (message.type === "DELIVERA_AUTO_POST") {
        console.log("background auto post success", result);
      }
      sendResponse({ ok: true, data: result });
    })
    .catch(async (error) => {
      const detail = error.message || "background fetch failed";
      if (message.type === "DELIVERA_AUTO_POST") {
        console.log("background auto post failed", detail);
      }
      await setStorageIfChanged({
        [STORAGE_KEYS.lastPostStatus]: message.type === "DELIVERA_AUTO_POST" ? "auto post failed" : "manual post failed",
        [STORAGE_KEYS.lastError]: detail,
      });
      sendResponse({ ok: false, error: detail });
    });

  return true;
});
