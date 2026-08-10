const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer(baseUrl, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error("System curtain test server did not start.");
}

async function stopServer(server) {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  await new Promise((resolve) => {
    server.once("exit", resolve);
    server.kill();
    setTimeout(resolve, 2000).unref();
  });
}

function startServer({ port, dbFile, tokenHash }) {
  const server = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "test",
      DATABASE_URL: "",
      POSTGRES_URL: "",
      DATABASE_PATH: dbFile,
      DB_PATH: dbFile,
      DELIVERA_DB_FILE: dbFile,
      DELIVERA_CURTAIN_TOKEN_SHA256: tokenHash,
      DELIVERA_ASSIGNMENT_RETRY_MS: "60000",
      DELIVERA_COURIER_OFFER_TIMEOUT_MS: "60000",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));
  return server;
}

async function stateRequest(baseUrl) {
  const response = await fetch(`${baseUrl}/api/system-curtain/status`, { cache: "no-store" });
  return { response, body: await response.json() };
}

async function controlRequest(baseUrl, token, active) {
  const response = await fetch(`${baseUrl}/api/system-curtain/control`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Delivera-Curtain-Control": token,
    },
    body: JSON.stringify({ active }),
  });
  return { response, body: await response.json().catch(() => ({})) };
}

test("global curtain is reversible, persistent and never blocks backend health", { timeout: 40000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivera-curtain-"));
  const dbFile = path.join(tempDir, "delivera.sqlite");
  const token = "test-curtain-token-with-enough-entropy";
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const port = 39000 + (process.pid % 500);
  const baseUrl = `http://127.0.0.1:${port}`;
  let server = startServer({ port, dbFile, tokenHash });

  try {
    await waitForServer(baseUrl);

    const initial = await stateRequest(baseUrl);
    assert.equal(initial.response.status, 200);
    assert.equal(initial.body.active, false);

    const invalidPage = await fetch(`${baseUrl}/_delivera-control/wrong-token`);
    assert.equal(invalidPage.status, 404);
    const validPage = await fetch(`${baseUrl}/_delivera-control/${encodeURIComponent(token)}`);
    assert.equal(validPage.status, 200);
    assert.match(await validPage.text(), /Erişim kontrolü/);

    const invalidControl = await controlRequest(baseUrl, "wrong-token", true);
    assert.equal(invalidControl.response.status, 404);

    const activated = await controlRequest(baseUrl, token, true);
    assert.equal(activated.response.status, 200);
    assert.equal(activated.body.active, true);
    assert.equal((await stateRequest(baseUrl)).body.active, true);

    assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/ready`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/bootstrap`)).status, 200);

    await stopServer(server);
    server = startServer({ port, dbFile, tokenHash });
    await waitForServer(baseUrl);
    assert.equal((await stateRequest(baseUrl)).body.active, true);

    const deactivated = await controlRequest(baseUrl, token, false);
    assert.equal(deactivated.response.status, 200);
    assert.equal(deactivated.body.active, false);
    assert.equal((await stateRequest(baseUrl)).body.active, false);
    assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
  } finally {
    await stopServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("all public panel entry points load the isolated curtain client", () => {
  const root = path.join(__dirname, "..");
  const panelFiles = [
    "index.html",
    "admin-design-source/code.html",
    "restaurant-design-source/code.html",
    "courier.html",
    "courier-design-source/vardiya_y_netimi/code.html",
    "courier-design-source/performans_raporlar/code.html",
    "courier-design-source/profil_ve_ayarlar/code.html",
  ];
  for (const relativeFile of panelFiles) {
    const source = fs.readFileSync(path.join(root, relativeFile), "utf8");
    assert.match(source, /\/system-curtain\.js\?v=/, `${relativeFile} curtain istemcisini yüklemeli`);
  }

  const curtainSource = fs.readFileSync(path.join(root, "system-curtain.js"), "utf8");
  assert.match(curtainSource, /position:\s*fixed/);
  assert.match(curtainSource, /z-index:\s*2147483647/);
  assert.match(curtainSource, /Fail open/);
  assert.doesNotMatch(curtainSource, /location\.replace|location\.assign|window\.location\s*=/);
});
