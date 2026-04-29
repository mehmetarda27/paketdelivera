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
  const CONTROL_STORAGE_KEYS = [
    STORAGE_KEYS.backendUrl,
    STORAGE_KEYS.restaurantToken,
    STORAGE_KEYS.platform,
    STORAGE_KEYS.autoEnabled,
    STORAGE_KEYS.testMode,
  ];
  const AUTO_DEBOUNCE_MS = 3000;
  const STATUS_ATTRIBUTE_KEYWORDS = ["status", "durum", "state", "onay", "hazir", "hazır", "kabul"];
  const WATCHER_BLOCK_MESSAGE = "Otomatik izleme desteklenmeyen sayfada kapali";

  let observer = null;
  let debounceId = null;
  let currentAutoEnabled = false;
  let lastAnalysisSignature = "";
  let lastCandidatePreview = "";
  let lastStatusWritten = "";
  let lastErrorWritten = "";

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

  async function writeStatus(settings, statusMessage, errorMessage = "") {
    if (lastStatusWritten === statusMessage && lastErrorWritten === errorMessage) {
      return;
    }
    lastStatusWritten = statusMessage;
    lastErrorWritten = errorMessage;
    await setStorageIfChanged(settings, {
      [STORAGE_KEYS.lastPostStatus]: statusMessage,
      [STORAGE_KEYS.lastError]: errorMessage,
    });
  }

  function getSelectedPlatform(settings) {
    const manualPlatform = String(settings[STORAGE_KEYS.platform] || "").trim();
    return manualPlatform || shared.detectPlatformFromUrl(location.href);
  }

  async function readResponseBodySafe(response) {
    try {
      return await response.text();
    } catch {
      return "";
    }
  }

  function buildFetchErrorDetails(backendUrl, token, requestUrl, responseBody, status, error) {
    const detail = shared.buildFetchErrorDetails({
      backendUrl,
      requestUrl,
      token,
      status,
      responseBody,
      exceptionMessage: error?.message || String(error || ""),
    });
    console.log("fetch error details", detail);
    return detail;
  }

  async function postToDelivera(candidate, settings) {
    const backendUrl = String(settings[STORAGE_KEYS.backendUrl] || "").trim();
    const token = String(settings[STORAGE_KEYS.restaurantToken] || "").trim().replace(/^Bearer\s+/i, "");
    const platform = getSelectedPlatform(settings);

    if (!backendUrl) {
      throw new Error("Backend URL gerekli");
    }
    if (!token) {
      throw new Error("Restaurant Token gerekli");
    }

    const requestUrl = shared.buildQuickPasteUrl(backendUrl);
    const payload = {
      source: "platform_extension_auto",
      sourcePlatform: platform,
      rawText: candidate.rawText,
      dedupeKey: candidate.autoDedupeKey,
    };

    console.log("auto posting to Delivera", { platform, dedupeKey: candidate.autoDedupeKey });
    console.log("post url", requestUrl);

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
        throw new Error(buildFetchErrorDetails(
          backendUrl,
          token,
          requestUrl,
          responseBody || data.error || "",
          response.status,
          new Error(data.error || `HTTP ${response.status}`)
        ));
      }
      console.log("post success", data);
      return data;
    } catch (error) {
      const detail = error?.message?.includes("backendUrl=")
        ? error.message
        : buildFetchErrorDetails(backendUrl, token, requestUrl, "", "", error);
      console.log("post failed", detail);
      throw new Error(detail);
    }
  }

  async function updateLastCandidate(settings, candidate) {
    const preview = candidate.preview.slice(0, 4).join(" | ") || "Siparis sinyali zayif";
    if (preview === lastCandidatePreview) {
      return;
    }
    lastCandidatePreview = preview;
    await setStorageIfChanged(settings, {
      [STORAGE_KEYS.lastCandidate]: preview,
    });
  }

  async function handleAutoAnalyze() {
    const settings = await getSettings();
    const backendUrl = String(settings[STORAGE_KEYS.backendUrl] || "").trim();
    const token = String(settings[STORAGE_KEYS.restaurantToken] || "").trim();
    const autoEnabled = Boolean(settings[STORAGE_KEYS.autoEnabled]);
    const testMode = Boolean(settings[STORAGE_KEYS.testMode]);
    const allowed = shared.isAllowedAutoWatchUrl(location.href, testMode);

    if (!autoEnabled || !backendUrl || !token || !allowed) {
      return;
    }

    const rawText = collectVisibleText();
    if (!rawText || rawText.length < 40) {
      return;
    }

    const statusText = collectStatusText();
    const analysisSignature = shared.simpleHash(`${shared.simplifyText(statusText)}|${shared.simplifyText(rawText)}`);
    if (analysisSignature === lastAnalysisSignature) {
      return;
    }
    lastAnalysisSignature = analysisSignature;

    const candidate = shared.analyzeOrderText({
      rawText,
      statusText,
      url: location.href,
    });
    console.log("text analyzed", candidate);

    if (!candidate.meetsMinimumSignal) {
      return;
    }

    await updateLastCandidate(settings, candidate);
    console.log("order candidate found", candidate);

    if (!candidate.hasAcceptedSignal) {
      console.log("order ignored (not accepted yet)");
      await writeStatus(settings, "Kabul edilmedi, beklemede", "");
      return;
    }

    if (!candidate.autoDedupeKey) {
      await writeStatus(settings, "Minimum veride otomatik unique key uretilemedi", "");
      return;
    }

    const sentKeys = settings[STORAGE_KEYS.sentKeys] || {};
    const duplicateCount = Number(settings[STORAGE_KEYS.duplicateCount] || 0);
    if (sentKeys[candidate.autoDedupeKey]) {
      console.log("duplicate skipped", candidate.autoDedupeKey);
      await setStorageIfChanged(settings, {
        [STORAGE_KEYS.duplicateCount]: duplicateCount + 1,
        [STORAGE_KEYS.lastPostStatus]: "Tekrar siparis engellendi",
        [STORAGE_KEYS.lastError]: "",
      });
      lastStatusWritten = "Tekrar siparis engellendi";
      lastErrorWritten = "";
      return;
    }

    console.log("order accepted, sending", {
      dedupeKey: candidate.autoDedupeKey,
      acceptedSignal: candidate.acceptedKeyword,
    });

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
        lastStatusWritten = "Tekrar siparis engellendi";
        lastErrorWritten = "";
        return;
      }

      const nextCount = Number(settings[STORAGE_KEYS.sentCount] || 0) + 1;
      console.log("auto post success", result);
      await setStorage({
        [STORAGE_KEYS.sentKeys]: sentKeys,
        [STORAGE_KEYS.sentCount]: nextCount,
        [STORAGE_KEYS.lastPostStatus]: "Otomatik gonderim basarili",
        [STORAGE_KEYS.lastError]: "",
      });
      lastStatusWritten = "Otomatik gonderim basarili";
      lastErrorWritten = "";
    } catch (error) {
      console.log("auto post failed", error.message || error);
      await writeStatus(settings, "Otomatik gonderim hata verdi", error.message || "Otomatik gonderim basarisiz");
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

    console.log("current url", location.href);
    console.log("testMode value", testMode);
    console.log("supported platform result", supported);

    currentAutoEnabled = enabled && Boolean(token) && Boolean(backendUrl) && supported;

    if (enabled && !backendUrl) {
      await writeStatus(settings, "Otomatik izleme baslatilamadi", "Backend URL gerekli");
    } else if (enabled && !token) {
      await writeStatus(settings, "Otomatik izleme baslatilamadi", "Restaurant Token gerekli");
    } else if (enabled && !supported) {
      await writeStatus(settings, WATCHER_BLOCK_MESSAGE, "Bu sayfa desteklenen platform degil");
    } else if (enabled && supported && (settings[STORAGE_KEYS.lastPostStatus] === WATCHER_BLOCK_MESSAGE || settings[STORAGE_KEYS.lastError] === "Bu sayfa desteklenen platform degil")) {
      await writeStatus(settings, "Otomatik izleme acildi", "");
    }

    if (currentAutoEnabled) {
      startWatcher();
    } else {
      stopWatcher();
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") {
      return;
    }
    const hasControlChange = CONTROL_STORAGE_KEYS.some((key) => Object.prototype.hasOwnProperty.call(changes, key));
    if (hasControlChange) {
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
