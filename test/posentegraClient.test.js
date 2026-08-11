const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const client = require("../services/posentegraClient");

function startMock() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk.toString(); });
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, headers: req.headers, raw });
      res.setHeader("Content-Type", "application/json");
      if (req.url.endsWith("/pid-error")) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: "temporary" }));
        return;
      }
      res.end(JSON.stringify({ success: true, data: { oldStatus: 500, newStatus: 600 } }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    server,
    calls,
    origin: `http://127.0.0.1:${server.address().port}`,
  })));
}

test("change-status follows the Postman contract without body, duplicate prefix, or automatic retry", async () => {
  const mock = await startMock();
  const previousBase = process.env.POSENTEGRA_API_BASE_URL;
  const previousKey = process.env.POSENTEGRA_API_KEY;
  process.env.POSENTEGRA_API_BASE_URL = `${mock.origin}/web-api/v1`;
  process.env.POSENTEGRA_API_KEY = "unit-test-key";
  try {
    const result = await client.changeOrderStatus("pid-ok", "delivered", { packageId: "pkg-1" });
    assert.equal(result.status, 200);
    assert.equal(mock.calls[0].method, "POST");
    assert.equal(mock.calls[0].url, "/web-api/v1/orders/change-status/pid-ok");
    assert.equal(mock.calls[0].raw, "");
    assert.equal(mock.calls[0].headers["content-type"], undefined);
    assert.equal(mock.calls[0].headers.authorization, "Bearer unit-test-key");
    assert.equal(mock.calls[0].headers["idempotency-key"], "status:pid-ok:delivered:pkg-1");

    await assert.rejects(
      client.changeOrderStatus("pid-error", "delivered", { packageId: "pkg-2" }),
      (error) => error.code === "POSENTEGRA_HTTP_ERROR" && error.result?.status === 503
    );
    assert.equal(mock.calls.filter((call) => call.url.endsWith("/pid-error")).length, 1);
  } finally {
    if (previousBase === undefined) delete process.env.POSENTEGRA_API_BASE_URL;
    else process.env.POSENTEGRA_API_BASE_URL = previousBase;
    if (previousKey === undefined) delete process.env.POSENTEGRA_API_KEY;
    else process.env.POSENTEGRA_API_KEY = previousKey;
    await new Promise((resolve) => mock.server.close(resolve));
  }
});
