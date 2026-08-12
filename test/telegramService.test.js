const test = require("node:test");
const assert = require("node:assert/strict");
const { createTelegramService } = require("../services/telegramService");

test("telegram service skips safely when credentials are absent", async () => {
  const service = createTelegramService({ token: "", chatId: "", fetchImpl: async () => { throw new Error("not called"); } });
  assert.equal(service.configured(), false);
  assert.deepEqual(await service.sendMessage("test"), { ok: false, skipped: true, reason: "not_configured" });
});

test("telegram service sends without exposing credentials in payload", async () => {
  let captured;
  const service = createTelegramService({
    token: "secret-token",
    chatId: "12345",
    maxAttempts: 1,
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 7 } }) };
    },
  });
  const result = await service.sendMessage("Operasyon uyarısı");
  assert.equal(result.ok, true);
  assert.equal(result.messageId, 7);
  assert.match(captured.url, /secret-token\/sendMessage$/);
  assert.deepEqual(JSON.parse(captured.options.body), {
    chat_id: "12345",
    text: "Operasyon uyarısı",
    disable_web_page_preview: true,
  });
});
