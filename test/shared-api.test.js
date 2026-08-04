const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadSharedContext(fetchImpl) {
  const context = {
    fetch: fetchImpl,
    document: {
      body: {
        classList: { contains: () => false },
        contains: () => false,
        appendChild: () => {},
      },
      createElement: () => ({ className: "", textContent: "", classList: { add: () => {} }, addEventListener: () => {} }),
      getElementById: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
    localStorage: {
      getItem: () => "",
      setItem: () => {},
      removeItem: () => {},
    },
    window: {
      location: { pathname: "/admin.html" },
      scrollY: 0,
      scrollTo: () => {},
      setTimeout,
      addEventListener: () => {},
    },
    navigator: {},
    setTimeout,
    clearTimeout,
    Intl,
    URLSearchParams,
    Error,
  };
  vm.createContext(context);
  const sharedSource = fs.readFileSync(path.join(__dirname, "..", "shared.js"), "utf8");
  vm.runInContext(sharedSource, context, { filename: "shared.js" });
  return context;
}

test("api refresh retry sends the refreshed bearer token", async () => {
  const seenAuthorizations = [];
  const context = loadSharedContext(async (_path, options) => {
    seenAuthorizations.push(options.headers.Authorization);
    if (seenAuthorizations.length === 1) {
      return {
        ok: false,
        status: 401,
        headers: { get: () => "application/json" },
        json: async () => ({ error: "expired" }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ ok: true }),
    };
  });

  const data = await context.api("/api/admin/bootstrap", {
    headers: { Authorization: "Bearer old-token" },
    retryWithRefresh: async () => ({ token: "new-token" }),
  });

  assert.deepEqual(data, { ok: true });
  assert.deepEqual(seenAuthorizations, ["Bearer old-token", "Bearer new-token"]);
});

test("package detail modal renders raw platform payload safely", () => {
  const context = loadSharedContext(async () => ({ ok: true }));
  const shell = {
    className: "",
    innerHTML: "",
    querySelector: () => ({ addEventListener: () => {} }),
    remove: () => {},
  };
  context.document.createElement = () => shell;

  assert.doesNotThrow(() => context.window.showPackageDetailsModal({
    id: "<img src=x onerror=unsafe()>",
    trackingNo: "<svg onload=unsafe()>",
    status: "awaiting_assignment",
    sourcePlatform: "<script>platformUnsafe()</script>",
    recipient: "<img src=x onerror=customerUnsafe()>",
    phone: "<b>0555</b>",
    deliveryAddress: "<iframe srcdoc='<script>addressUnsafe()</script>'></iframe>",
    customerNote: "<script>noteUnsafe()</script>",
    items: [{ name: "<img src=x onerror=itemUnsafe()>", quantity: 2, price: 125 }],
    rawPayload: { customerNote: "<script>unsafe()</script>" },
  }));
  assert.match(shell.innerHTML, /&lt;script&gt;unsafe\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(shell.innerHTML, /<script>unsafe\(\)<\/script>/);
  assert.doesNotMatch(shell.innerHTML, /<script>platformUnsafe\(\)<\/script>/);
  assert.doesNotMatch(shell.innerHTML, /<img src=x onerror=/);
  assert.doesNotMatch(shell.innerHTML, /<svg onload=/);
  assert.doesNotMatch(shell.innerHTML, /<iframe srcdoc=/);
  assert.match(shell.innerHTML, /&lt;img src=x onerror=itemUnsafe\(\)&gt;/);
  assert.doesNotMatch(shell.innerHTML, /<img src=x onerror=itemUnsafe/);
});
