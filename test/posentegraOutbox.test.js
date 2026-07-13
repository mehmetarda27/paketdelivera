const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { createPosentegraOutboxService } = require("../services/posentegraOutboxService");

function testDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE packages (id TEXT PRIMARY KEY, posentegra_id TEXT, updated_at TEXT);
    CREATE TABLE posentegra_outbox (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_error TEXT,
      locked_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

test("Posentegra status outbox retries without losing the local package state", async () => {
  const db = testDb();
  db.prepare("INSERT INTO packages (id, posentegra_id, updated_at) VALUES (?, ?, ?)").run("pkg_1", "pid_current", new Date().toISOString());
  let calls = 0;
  const client = {
    configured: () => true,
    async changeOrderStatus(orderId, status) {
      calls += 1;
      assert.equal(orderId, "pid_current");
      assert.equal(status, "delivered");
      if (calls === 1) throw new Error("temporary outage");
      return { ok: true, status: 200, responseBody: { ok: true } };
    },
    async assignPackageToRestaurant() {
      throw new Error("not expected");
    },
  };
  const outbox = createPosentegraOutboxService({ db, client, logger: { warn() {} } });
  outbox.enqueueStatus({ packageId: "pkg_1", orderId: "stale_pid", status: "delivered" });

  await outbox.processDue();
  let row = db.prepare("SELECT * FROM posentegra_outbox").get();
  assert.equal(row.status, "failed");
  assert.equal(row.attempts, 1);
  assert.match(row.last_error, /temporary outage/);

  db.prepare("UPDATE posentegra_outbox SET next_attempt_at = ?").run(new Date(Date.now() - 1000).toISOString());
  await outbox.processDue();
  row = db.prepare("SELECT * FROM posentegra_outbox").get();
  assert.equal(row.status, "completed");
  assert.equal(calls, 2);
  db.close();
});

test("Posentegra package assignment is idempotent and stores returned pid", async () => {
  const db = testDb();
  db.prepare("INSERT INTO packages (id, posentegra_id, updated_at) VALUES (?, ?, ?)").run("pkg_2", "local_ref", new Date().toISOString());
  let calls = 0;
  const client = {
    configured: () => true,
    async assignPackageToRestaurant(restaurantId, payload) {
      calls += 1;
      assert.equal(restaurantId, "pos_rest_1");
      assert.equal(payload.packageId, "pkg_2");
      return { ok: true, status: 200, responseBody: { pid: "remote_pid_2" } };
    },
    async changeOrderStatus() {
      throw new Error("not expected");
    },
  };
  const outbox = createPosentegraOutboxService({ db, client, logger: { warn() {} } });
  outbox.enqueuePackageAssignment({ packageId: "pkg_2", restaurantPosentegraId: "pos_rest_1", packagePayload: { trackingNo: "PKT-2" } });
  outbox.enqueuePackageAssignment({ packageId: "pkg_2", restaurantPosentegraId: "pos_rest_1", packagePayload: { trackingNo: "PKT-2" } });

  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM posentegra_outbox").get().count, 1);
  await outbox.processDue();
  assert.equal(db.prepare("SELECT posentegra_id FROM packages WHERE id = ?").get("pkg_2").posentegra_id, "remote_pid_2");
  assert.equal(calls, 1);
  db.close();
});
