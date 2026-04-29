(function initDeliveraContent() {
  if (window.__deliveraQuickPasteInstalled) {
    return;
  }
  window.__deliveraQuickPasteInstalled = true;

  const STORAGE_KEYS = {
    backendUrl: "deliveraBackendUrl",
    restaurantToken: "deliveraRestaurantToken",
    platform: "deliveraPlatform",
    autoEnabled: "deliveraAutoEnabled",
    sentKeys: "deliveraSentOrderKeys",
    sentCount: "deliveraSentCount",
    lastCandidate: "deliveraAutoLastCandidate",
    lastPostStatus: "deliveraAutoLastStatus",
    lastError: "deliveraAutoLastError",
  };
  const AUTO_DEBOUNCE_MS = 1500;
  let observer = null;
  let debounceId = null;
  let currentAutoEnabled = false;

  function normalizeText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function detectPlatformFromUrl(url = location.href) {
    const lowered = String(url || "").toLowerCase();
    if (lowered.includes("getir")) {
      return "Getir";
    }
    if (lowered.includes("trendyol")) {
      return "Trendyol Yemek";
    }
    if (lowered.includes("yemeksepeti")) {
      return "Yemeksepeti";
    }
    if (lowered.includes("migros")) {
      return "Migros Yemek";
    }
    return "Diger";
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
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") {
        return;
      }
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        return;
      }
      pushValue(node.getAttribute("aria-label"));
      pushValue(node.getAttribute("title"));
      pushValue(node.innerText || node.textContent || "");
    });

    return normalizeText(parts.join("\n"));
  }

  function prioritizeOrderLines(lines) {
    return lines
      .filter(Boolean)
      .map((line) => ({
        line,
        score:
          (/05\d{2}/.test(line) ? 5 : 0) +
          (/(adres|mahalle|sokak|cadde|no|kat|daire)/i.test(line) ? 4 : 0) +
          (/(₺|tl|tutar|toplam|odenecek|ödenecek|odeme|ödeme)/i.test(line) ? 3 : 0) +
          (/(musteri|müşteri|ad|isim|alici|alıcı)/i.test(line) ? 2 : 0) +
          (/(siparis no|sipariş no|order id|teslimat no)/i.test(line) ? 4 : 0),
      }))
      .sort((left, right) => right.score - left.score)
      .map((item) => item.line);
  }

  function simpleHash(text) {
    let hash = 5381;
    for (let index = 0; index < text.length; index += 1) {
      hash = ((hash << 5) + hash) + text.charCodeAt(index);
      hash |= 0;
    }
    return `h${Math.abs(hash)}`;
  }

  function analyzeText(rawText) {
    const text = normalizeText(rawText);
    const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
    const prioritized = prioritizeOrderLines(lines);

    const phoneMatch = text.match(/(?:\+?90\s*)?(05\d[\d\s-]{8,})/);
    const amountMatch = text.match(/(?:₺|\btl\b|toplam|tutar|ödenecek|odenecek)\s*[:\-]?\s*([\d\.,]+)/i);
    const orderIdMatch = text.match(/(?:siparis no|sipariş no|order id|teslimat no)\s*[:\-]?\s*([A-Z0-9\-_]+)/i);
    const addressLine = prioritized.find((line) => /(adres|mahalle|sokak|cadde|no|kat|daire)/i.test(line)) || "";
    const hasPhone = Boolean(phoneMatch);
    const hasAmount = Boolean(amountMatch);
    const hasAddress = Boolean(addressLine);
    const hasOrderId = Boolean(orderIdMatch);
    const meetsSignalThreshold =
      (hasPhone && hasAmount) ||
      (hasPhone && hasAddress) ||
      (hasOrderId && hasAmount);

    const normalizedPhone = phoneMatch ? phoneMatch[1].replace(/[^\d]/g, "").replace(/^90(?=5)/, "") : "";
    const normalizedAmount = amountMatch?.[1] ? String(amountMatch[1]).replace(/\s+/g, "") : "";
    const dedupeKey = orderIdMatch?.[1]
      ? `order:${orderIdMatch[1]}`
      : normalizedPhone && normalizedAmount
        ? `phone-amount:${normalizedPhone}:${normalizedAmount}`
        : normalizedPhone && addressLine
          ? `phone-address:${normalizedPhone}:${addressLine.slice(0, 40).toLowerCase()}`
          : `hash:${simpleHash(text)}`;

    const candidate = {
      rawText: normalizeText([...prioritized, ...lines].join("\n")),
      preview: prioritized.slice(0, 12),
      phone: normalizedPhone,
      amount: normalizedAmount,
      orderId: orderIdMatch?.[1] || "",
      address: addressLine,
      dedupeKey,
      meetsSignalThreshold,
    };
    console.log("text analyzed", candidate);
    return candidate;
  }

  async function getSettings() {
    return chrome.storage.local.get(Object.values(STORAGE_KEYS));
  }

  async function setStorage(values) {
    return chrome.storage.local.set(values);
  }

  async function postToDelivera(candidate, settings) {
    const backendUrl = String(settings[STORAGE_KEYS.backendUrl] || "").trim().replace(/\/+$/, "");
    const token = String(settings[STORAGE_KEYS.restaurantToken] || "").trim().replace(/^Bearer\s+/i, "");
    const platform = settings[STORAGE_KEYS.platform] || detectPlatformFromUrl(location.href);

    console.log("auto posting to Delivera", { platform, dedupeKey: candidate.dedupeKey });
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
        dedupeKey: candidate.dedupeKey,
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

    if (!autoEnabled || !backendUrl || !token) {
      return;
    }

    const rawText = collectVisibleText();
    if (!rawText || rawText.length < 40) {
      return;
    }

    const candidate = analyzeText(rawText);
    await setStorage({
      [STORAGE_KEYS.lastCandidate]: candidate.preview.slice(0, 4).join(" | ") || "Siparis sinyali zayif",
    });

    if (!candidate.meetsSignalThreshold) {
      return;
    }

    console.log("order candidate found", candidate);
    const sentKeys = settings[STORAGE_KEYS.sentKeys] || {};
    if (sentKeys[candidate.dedupeKey]) {
      console.log("duplicate skipped", candidate.dedupeKey);
      await setStorage({
        [STORAGE_KEYS.lastPostStatus]: "Ayni siparis tekrar gonderilmedi",
      });
      return;
    }

    try {
      await postToDelivera(candidate, settings);
      sentKeys[candidate.dedupeKey] = new Date().toISOString();
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
    const token = String(settings[STORAGE_KEYS.restaurantToken] || "").trim();
    const backendUrl = String(settings[STORAGE_KEYS.backendUrl] || "").trim();
    currentAutoEnabled = enabled && Boolean(token) && Boolean(backendUrl);
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
      const candidate = analyzeText(collectVisibleText());
      console.log("page text extracted", { length: candidate.rawText.length });
      sendResponse({ ok: true, ...candidate, url: location.href, title: document.title || "" });
    } catch (error) {
      sendResponse({ ok: false, error: error.message || "Metin okunamadi." });
    }
    return true;
  });

  syncWatcherState().catch(() => {});
})();
