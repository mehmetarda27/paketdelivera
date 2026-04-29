(function initDeliveraContent() {
  if (window.__deliveraQuickPasteInstalled) {
    return;
  }
  window.__deliveraQuickPasteInstalled = true;

  function normalizeText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function prioritizeOrderLines(lines) {
    return lines
      .filter(Boolean)
      .map((line) => ({ line, score:
        (/05\d{2}/.test(line) ? 5 : 0) +
        (/(adres|mahalle|sokak|cadde|apt|daire|kat)/i.test(line) ? 4 : 0) +
        (/(₺|tl|tutar|toplam|odeme|ödeme)/i.test(line) ? 3 : 0) +
        (/(musteri|müşteri|ad soyad|alici|alıcı|not)/i.test(line) ? 2 : 0)
      }))
      .sort((left, right) => right.score - left.score)
      .map((item) => item.line);
  }

  function extractPageText() {
    const bodyText = document.body?.innerText || document.documentElement?.innerText || "";
    const normalized = normalizeText(bodyText);
    const lines = normalized.split("\n").map((line) => line.trim()).filter(Boolean);
    const prioritized = prioritizeOrderLines(lines);
    const rawText = normalizeText([...prioritized, ...lines].join("\n"));
    console.log("page text extracted", { length: rawText.length });
    return {
      rawText,
      preview: prioritized.slice(0, 12),
      url: location.href,
      title: document.title || ""
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "DELIVERA_EXTRACT_ORDER") {
      return false;
    }

    try {
      sendResponse({ ok: true, ...extractPageText() });
    } catch (error) {
      sendResponse({ ok: false, error: error.message || "Metin okunamadi." });
    }
    return true;
  });
})();
