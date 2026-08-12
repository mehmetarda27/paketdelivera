const logger = require("./logger");

const TELEGRAM_API_ROOT = "https://api.telegram.org";

function trimmed(value) {
  return String(value || "").trim();
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTelegramService(options = {}) {
  const token = trimmed(options.token ?? process.env.TELEGRAM_BOT_TOKEN);
  const chatId = trimmed(options.chatId ?? process.env.TELEGRAM_ALERT_CHAT_ID);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const log = options.logger || logger;
  const timeoutMs = positiveNumber(options.timeoutMs ?? process.env.TELEGRAM_REQUEST_TIMEOUT_MS, 8_000);
  const maxAttempts = Math.max(1, Math.min(4, positiveNumber(options.maxAttempts ?? process.env.TELEGRAM_SEND_ATTEMPTS, 3)));

  function configured() {
    return Boolean(token && chatId && typeof fetchImpl === "function");
  }

  async function sendMessage(text, sendOptions = {}) {
    const message = trimmed(text);
    if (!message) return { ok: false, skipped: true, reason: "empty_message" };
    if (!configured()) return { ok: false, skipped: true, reason: "not_configured" };

    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${TELEGRAM_API_ROOT}/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: message.slice(0, 4096),
            disable_web_page_preview: true,
            ...(sendOptions.parseMode ? { parse_mode: sendOptions.parseMode } : {}),
          }),
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => ({}));
        if (response.ok && payload.ok !== false) {
          return { ok: true, messageId: payload.result?.message_id || null };
        }
        lastError = new Error(`telegram_http_${response.status}`);
        if (response.status >= 400 && response.status < 500 && response.status !== 429) break;
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timer);
      }
      if (attempt < maxAttempts) await sleep(Math.min(2_000, 300 * (2 ** (attempt - 1))));
    }

    log.warn("Telegram notification failed", {
      error: lastError?.name === "AbortError" ? "timeout" : lastError?.message || "unknown",
      attempts: maxAttempts,
    });
    return { ok: false, error: lastError?.message || "telegram_send_failed" };
  }

  return { configured, sendMessage };
}

module.exports = { createTelegramService };
