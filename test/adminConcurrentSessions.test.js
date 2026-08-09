const assert = require("node:assert/strict");
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
      const response = await fetch(`${baseUrl}/api/bootstrap`);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error("Test server did not start in time.");
}

async function jsonRequest(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  await new Promise((resolve) => {
    server.once("exit", resolve);
    server.kill();
    setTimeout(resolve, 2000).unref();
  });
}

test("admin account keeps four independent sessions and logout frees one slot", { timeout: 30000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivera-admin-sessions-"));
  const dbFile = path.join(tempDir, "delivera.sqlite");
  const port = 35000 + (process.pid % 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const username = `admin_sessions_${Date.now()}`;
  const password = "Delivera123!";
  const server = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "test",
      TRUST_PROXY: "true",
      DATABASE_URL: "",
      POSTGRES_URL: "",
      DATABASE_PATH: dbFile,
      DB_PATH: dbFile,
      DELIVERA_DB_FILE: dbFile,
      DELIVERA_ADMIN_USERNAME: username,
      DELIVERA_ADMIN_PASSWORD: password,
      DELIVERA_ASSIGNMENT_RETRY_MS: "60000",
      DELIVERA_COURIER_OFFER_TIMEOUT_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));

  const login = (ip) => jsonRequest(baseUrl, "/api/admin/login", {
    method: "POST",
    headers: { "X-Forwarded-For": ip },
    body: JSON.stringify({ username, password }),
  });
  const bootstrap = (token) => jsonRequest(baseUrl, "/api/admin/bootstrap", {
    headers: { Authorization: `Bearer ${token}` },
  });

  try {
    await waitForServer(baseUrl);

    const sessions = [];
    for (let index = 1; index <= 4; index += 1) {
      const result = await login(`198.51.100.${index}`);
      assert.equal(result.response.status, 200);
      sessions.push(result.body);
    }

    for (const session of sessions) {
      assert.equal((await bootstrap(session.token)).response.status, 200);
    }

    const fifth = await login("198.51.100.5");
    assert.equal(fifth.response.status, 409);
    assert.match(fifth.body.error, /en fazla 4 cihazda/i);

    const refreshed = await jsonRequest(baseUrl, "/api/admin/refresh", {
      method: "POST",
      headers: { Authorization: `Bearer ${sessions[1].token}` },
      body: JSON.stringify({ refreshToken: sessions[1].refreshToken }),
    });
    assert.equal(refreshed.response.status, 200);
    assert.equal((await bootstrap(sessions[1].token)).response.status, 401);
    assert.equal((await bootstrap(refreshed.body.token)).response.status, 200);
    assert.equal((await bootstrap(sessions[2].token)).response.status, 200);

    const logout = await jsonRequest(baseUrl, "/api/admin/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${sessions[0].token}` },
      body: JSON.stringify({ refreshToken: sessions[0].refreshToken }),
    });
    assert.equal(logout.response.status, 200);
    assert.equal((await bootstrap(sessions[0].token)).response.status, 401);
    assert.equal((await bootstrap(sessions[3].token)).response.status, 200);

    const replacement = await login("198.51.100.6");
    assert.equal(replacement.response.status, 200);
    assert.equal((await bootstrap(replacement.body.token)).response.status, 200);
    assert.equal((await bootstrap(refreshed.body.token)).response.status, 200);
  } finally {
    await stopServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("admin bridge refreshes and logs out the exact browser session on the server", () => {
  const bridge = fs.readFileSync(path.join(__dirname, "..", "admin-design-bridge.js"), "utf8");
  assert.match(bridge, /fetch\("\/api\/admin\/refresh"[\s\S]*refreshHeaders/);
  assert.match(bridge, /refreshHeaders\.Authorization = `Bearer \$\{state\.token\}`/);
  assert.match(bridge, /fetch\("\/api\/admin\/logout"/);
  assert.match(bridge, /body: JSON\.stringify\(\{ refreshToken \}\)/);
});
