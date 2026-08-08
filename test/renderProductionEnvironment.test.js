const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawn } = require("node:child_process");

test("Render runtime defaults NODE_ENV to production when the variable is omitted", async () => {
  const root = path.join(__dirname, "..");
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivera-render-env-"));
  const env = { ...process.env, RENDER: "true", PORT: "0", DELIVERA_SKIP_BACKGROUND_JOBS: "1" };
  delete env.NODE_ENV;
  ["DATABASE_URL", "POSTGRES_URL", "DATABASE_PRIVATE_URL", "POSTGRES_PRIVATE_URL", "INTERNAL_DATABASE_URL", "DATABASE_INTERNAL_URL", "RENDER_DATABASE_URL", "RENDER_POSTGRES_URL"].forEach((name) => delete env[name]);

  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "server.js")], { cwd: runtimeDir, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Server startup timed out. stdout=${stdout} stderr=${stderr}`));
    }, 12000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/http:\/\/[^:]+:(\d+)/);
      if (!match) return;
      fetch(`http://127.0.0.1:${match[1]}/api/admin/system-status`).catch(() => null);
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    setTimeout(() => child.kill(), 1800);
  });

  fs.rmSync(runtimeDir, { recursive: true, force: true });
  assert.match(`${output.stdout}\n${output.stderr}`, /"nodeEnv":"production"/);
});
