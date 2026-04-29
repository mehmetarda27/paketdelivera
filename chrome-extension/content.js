(function initDeliveraContent() {
  if (window.__deliveraQuickPasteInstalled) {
    return;
  }
  window.__deliveraQuickPasteInstalled = true;

  const shared = window.DeliveraExtensionShared;
  const STORAGE_KEYS = {
    backendUrl: "deliveraBackendUrl",
    restaurantToken: "deliveraRestaurantToken",
    platform: "deliveraPlatform",
    autoEnabled: "deliveraAutoEnabled",
    testMode: "deliveraTestMode",
    sentKeys: "deliveraSentOrderKeys",
    sentCount: "deliveraSentCount",
    duplicateCount: "deliveraAutoDuplicateCount",
    lastCandidate: "deliveraAutoLastCandidate",
    lastPostStatus: "deliveraAutoLastStatus",
    lastError: "deliveraAutoLastError",
  };
  const AUTO_DEBOUNCE_MS = 1500;
  const STATUS_ATTRIBUTE_KEYWORDS = ["status", "durum", "state", "onay", "hazir", "hazır", "kabul"];

  let observer = null;
  let debounceId = null;
  let currentAutoEnabled = false;

  function normalizeText(value) {
    return shared.normalizeText(value);
  }

  function isVisible(node) {
    if (!node || !(node instanceof Element)) {
      return false;
    }
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getAttributeSignature(node) {
    return [
      node.getAttribute("data-status"),
      node.getAttribute("data-state"),
      node.getAttribute("aria-label"),
      node.getAttribute("title"),
      node.id,
      typeof node.className === "string" ? node.className : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  function collectVisibleText() {
    const parts = [];
    const pushValue = (value) => {
      const text = normalizeText(value);
      if (text && text.length > 2) {
        parts.push(text);
      }
    };

    pushValue(document.title || "");
    pushValue(document.body?.innerText || document.documentElement?.innerText || "");

    const candidates = document.querySelectorAll("button, a, [role='button'], [aria-label], [title], article, section, div, span, p, li, h1, h2, h3, h4");
    candidates.forEach((node) => {
      if (!isVisible(node)) {
        return;
      }
      pushValue(node.getAttribute("aria-label"));
      pushValue(node.getAttribute("title"));
      pushValue(node.innerText || node.textContent || "");
    });

    return normalizeText(parts.join("\n"));
  }

  function collectStatusText() {
    const statusParts = [];
    const seen = new Set();
    const pushStatus = (value) => {
      const text = normalizeText(value);
      const simplified = shared.simplifyText(text);
      if (!text || text.length > 80 || seen.has(simplified)) {
        return;
      }
      seen.add(simplified);
      statusParts.push(text);
    };

    const candidates = document.querySelectorAll("[data-status], [data-state], [aria-label], [title], [class], [id], span, div, p, strong, button, h1, h2, h3");
    candidates.forEach((node) => {
      if (!isVisible(node)) {
        return;
      }
      const text = normalizeText(node.innerText || node.textContent || "");
      if (!text || text.length > 80) {
        return;
      }
      const signature = shared.simplifyText(getAttributeSignature(node));
      const markedAsStatus = STATUS_ATTRIBUTE_KEYWORDS.some((keyword) => signature.includes(shared.simplifyText(keyword)));
      const hasSignal = shared.SIGNAL_KEYWORDS.some((keyword) => shared.simplifyText(text).includes(shared.simplifyText(keyword)));
      if (markedAsStatus || hasSignal) {
        pushStatus(text);
      }
    });

    return normalizeText(statusParts.join("\n"));
  }

  async function getSettings() {
    return chrome.storage.local.get(Object.values(STORAGE_KEYS));
  }

  async function setStorage(values) {
    return chrome.storage.local.set(values);
  }

  async function setStorageIfChanged(currentSettings, values) {
    const nextValues = {};
    Object.entries(values).forEach(([key, value]) => {
      if (currentSettings[key] !== value) {
        nextValues[key] = value;
      }
    });
    if (Object.keys(nextValues).length > 0) {
      await setStorage(nextValues);
    }
  }

  function getSelectedPlatform(settings) {
    const manualPlatform = String(settings[STORAGE_KEYS.platform] || "").trim();
    return manualPlatform || shared.detectPlatformFromUrl(location.href);
  }

  async function postToDelivera(candidate, settings) {
    const backendUrl = String(settings[STORAGE_KEYS.backendUrl] || "").trim().replace(/\/+$/, "");
    const token = String(settings[STORAGE_KEYS.restaurantToken] || "").trim().replace(/^Bearer\s+/i, "");
    const platform = getSelectedPlatform(settings);

    console.log("auto posting to Delivera", { platform, dedupeKey: candidate.autoDedupeKey });
    const response = await fetch(`${backendUrl}/api/restaurant/packages/quick-paste`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({
        source: "platform_extension_auto",
        sourcePlatform: platform,
        rawText: candidate.rawText,
        dedupeKey: candidate.autoDedupeKey,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || "Delivera otomatik gonderimi basarisiz.");
    }
    console.log("auto post success", data);
    return data;
  }

  async function handleAutoAnalyze() {
    const settings = await getSettings();
    const backendUrl = String(settings[STORAGE_KEYS.backendUrl] || "").trim();
    const token = String(settings[STORAGE_KEYS.restaurantToken] || "").trim();
    const autoEnabled = Boolean(settings[STORAGE_KEYS.autoEnabled]);
    const testMode = Boolean(settings[STORAGE_KEYS.testMode]);

    if (!autoEnabled || !backendUrl || !token) {
      return;
    }
    if (!shared.isAllowedAutoWatchUrl(location.href, testMode)) {
      console.log("unsupported platform for auto watcher");
      return;
    }

    const rawText = collectVisibleText();
    if (!rawText || rawText.length < 40) {
      return;
    }

    const candidate = shared.analyzeOrderText({
      rawText,
      statusText: collectStatusText(),
      url: location.href,
    });
    console.log("text analyzed", candidate);
    await setStorageIfChanged(settings, {
      [STORAGE_KEYS.lastCandidate]: candidate.preview.slice(0, 4).join(" | ") || "Siparis sinyali zayif",
    });

    if (!candidate.meetsMinimumSignal) {
      return;
    }

    console.log("order candidate found", candidate);

    if (!candidate.hasAcceptedSignal) {
      console.log("order ignored (not accepted yet)", {
        pendingSignal: candidate.pendingKeyword || null,
      });
      await setStorageIfChanged(settings, {
        [STORAGE_KEYS.lastPostStatus]: "Kabul edilmedi, beklemede",
        [STORAGE_KEYS.lastError]: "",
      });
      return;
    }

    if (!candidate.autoDedupeKey) {
      await setStorageIfChanged(settings, {
        [STORAGE_KEYS.lastPostStatus]: "Minimum veride otomatik unique key uretilemedi",
        [STORAGE_KEYS.lastError]: "",
      });
      return;
    }

    console.log("order accepted, sending", {
      dedupeKey: candidate.autoDedupeKey,
      acceptedSignal: candidate.acceptedKeyword,
    });

    const sentKeys = settings[STORAGE_KEYS.sentKeys] || {};
    const duplicateCount = Number(settings[STORAGE_KEYS.duplicateCount] || 0);
    if (sentKeys[candidate.autoDedupeKey]) {
      console.log("duplicate skipped", candidate.autoDedupeKey);
      await setStorage({
        [STORAGE_KEYS.duplicateCount]: duplicateCount + 1,
        [STORAGE_KEYS.lastPostStatus]: "Tekrar siparis engellendi",
        [STORAGE_KEYS.lastError]: "",
      });
      return;
    }

    try {
      const result = await postToDelivera(candidate, settings);
      sentKeys[candidate.autoDedupeKey] = new Date().toISOString();
      if (result?.duplicate) {
        console.log("duplicate skipped", candidate.autoDedupeKey);
        await setStorage({
          [STORAGE_KEYS.sentKeys]: sentKeys,
          [STORAGE_KEYS.duplicateCount]: duplicateCount + 1,
          [STORAGE_KEYS.lastPostStatus]: "Tekrar siparis engellendi",
          [STORAGE_KEYS.lastError]: "",
        });
        return;
      }

      const nextCount = Number(settings[STORAGE_KEYS.sentCount] || 0) + 1;
      await setStorage({
        [STORAGE_KEYS.sentKeys]: sentKeys,
        [STORAGE_KEYS.sentCount]: nextCount,
        [STORAGE_KEYS.lastPostStatus]: "Otomatik gonderim basarili",
        [STORAGE_KEYS.lastError]: "",
      });
    } catch (error) {
      console.log("auto post failed", error);
      await setStorage({
        [STORAGE_KEYS.lastError]: error.message || "Otomatik gonderim basarisiz",
        [STORAGE_KEYS.lastPostStatus]: "Otomatik gonderim hata verdi",
      });
    }
  }

  function scheduleAnalyze() {
    if (debounceId) {
      window.clearTimeout(debounceId);
    }
    debounceId = window.setTimeout(() => {
      handleAutoAnalyze().catch(() => {});
    }, AUTO_DEBOUNCE_MS);
  }

  function startWatcher() {
    if (observer || !currentAutoEnabled) {
      return;
    }
    observer = new MutationObserver(() => {
      console.log("mutation detected");
      scheduleAnalyze();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    console.log("watcher started");
    scheduleAnalyze();
  }

  function stopWatcher() {
    if (debounceId) {
      window.clearTimeout(debounceId);
      debounceId = null;
    }
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    console.log("watcher stopped");
  }

  async function syncWatcherState() {
    const settings = await getSettings();
    const enabled = Boolean(settings[STORAGE_KEYS.autoEnabled]);
    const testMode = Boolean(settings[STORAGE_KEYS.testMode]);
    const token = String(settings[STORAGE_KEYS.restaurantToken] || "").trim();
    const backendUrl = String(settings[STORAGE_KEYS.backendUrl] || "").trim();
    const supported = shared.isAllowedAutoWatchUrl(location.href, testMode);
    currentAutoEnabled = enabled && Boolean(token) && Boolean(backendUrl) && supported;

    if (enabled && (!token || !backendUrl)) {
      await setStorageIfChanged(settings, {
        [STORAGE_KEYS.lastError]: "Backend URL ve token gerekli",
        [STORAGE_KEYS.lastPostStatus]: "Otomatik izleme baslatilamadi",
      });
    } else if (enabled && !supported) {
      console.log("unsupported platform for auto watcher");
      await setStorageIfChanged(settings, {
        [STORAGE_KEYS.lastError]: "Bu sayfa desteklenen platform degil",
        [STORAGE_KEYS.lastPostStatus]: "Otomatik izleme desteklenmeyen sayfada kapali",
      });
    } else if (enabled && supported) {
      await setStorageIfChanged(settings, {
        [STORAGE_KEYS.lastError]: "",
        [STORAGE_KEYS.lastPostStatus]: "Otomatik izleme acildi.",
      });
    }

    if (currentAutoEnabled) {
      startWatcher();
    } else {
      stopWatcher();
    }
  }

  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === "local") {
      syncWatcherState().catch(() => {});
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "DELIVERA_EXTRACT_ORDER") {
      return false;
    }

    try {
      const candidate = shared.analyzeOrderText({
        rawText: collectVisibleText(),
        statusText: collectStatusText(),
        url: location.href,
      });
      console.log("text analyzed", candidate);
      sendResponse({ ok: true, ...candidate, url: location.href, title: document.title || "" });
    } catch (error) {
      sendResponse({ ok: false, error: error.message || "Metin okunamadi." });
    }
    return true;
  });

  syncWatcherState().catch(() => {});
})();
