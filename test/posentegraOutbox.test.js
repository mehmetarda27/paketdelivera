const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { createPosentegraOutboxService } = require("../services/posentegraOutboxService");

function testDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE packages (id TEXT PRIMARY KEY, posentegra_id TEXT, status TEXT, failure_reason TEXT, updated_at TEXT);
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

test("Posentegra status outbox does not automatically repeat an ambiguous status advance", async () => {
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
  assert.equal(row.status, "dead_letter");
  assert.equal(row.attempts, 1);
  assert.match(row.last_error, /temporary outage/);

  await outbox.processDue();
  assert.equal(calls, 1);

  // Yalnizca operator uzak durumu kontrol ettikten sonra bilincli tekrar acar.
  db.prepare("UPDATE posentegra_outbox SET status = 'pending', next_attempt_at = ?, last_error = NULL").run(new Date(Date.now() - 1000).toISOString());
  await outbox.processDue();
  row = db.prepare("SELECT * FROM posentegra_outbox").get();
  assert.equal(row.status, "completed");
  assert.equal(calls, 2);
  db.close();
});

test("Posentegra completed status dedupe key is never sent twice", async () => {
  const db = testDb();
  db.prepare("INSERT INTO packages (id, posentegra_id, updated_at) VALUES (?, ?, ?)").run("pkg_once", "pid_once", new Date().toISOString());
  let calls = 0;
  const client = {
    configured: () => true,
    async changeOrderStatus() {
      calls += 1;
      return { ok: true, status: 200 };
    },
  };
  const outbox = createPosentegraOutboxService({ db, client, logger: { warn() {} } });
  outbox.enqueueStatus({ packageId: "pkg_once", orderId: "pid_once", status: "delivered" });
  await outbox.processDue();
  outbox.enqueueStatus({ packageId: "pkg_once", orderId: "pid_once", status: "delivered" });
  await outbox.processDue();

  assert.equal(calls, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM posentegra_outbox").get().count, 1);
  assert.equal(db.prepare("SELECT status FROM posentegra_outbox").get().status, "completed");
  db.close();
});

test("Posentegra later status waits when an earlier status needs manual review", async () => {
  const db = testDb();
  db.prepare("INSERT INTO packages (id, posentegra_id, updated_at) VALUES (?, ?, ?)").run("pkg_ordered", "pid_ordered", new Date().toISOString());
  const statuses = [];
  const client = {
    configured: () => true,
    async changeOrderStatus(orderId, status) {
      assert.equal(orderId, "pid_ordered");
      statuses.push(status);
      if (status === "accepted") throw new Error("ambiguous timeout");
      return { ok: true, status: 200 };
    },
  };
  const outbox = createPosentegraOutboxService({ db, client, logger: { warn() {} } });
  outbox.enqueueStatus({ packageId: "pkg_ordered", orderId: "pid_ordered", status: "accepted" });
  outbox.enqueueStatus({ packageId: "pkg_ordered", orderId: "pid_ordered", status: "delivered" });
  await outbox.processDue();

  assert.deepEqual(statuses, ["accepted"]);
  assert.equal(db.prepare("SELECT status FROM posentegra_outbox WHERE dedupe_key = ?").get("order.status:pkg_ordered:accepted").status, "dead_letter");
  assert.equal(db.prepare("SELECT status FROM posentegra_outbox WHERE dedupe_key = ?").get("order.status:pkg_ordered:delivered").status, "pending");

  // Ayni yerel olay yeniden uretilse bile belirsiz uzak istek otomatik acilmaz.
  outbox.enqueueStatus({ packageId: "pkg_ordered", orderId: "pid_ordered", status: "accepted" });
  await outbox.processDue();
  assert.deepEqual(statuses, ["accepted"]);
  assert.equal(db.prepare("SELECT status FROM posentegra_outbox WHERE dedupe_key = ?").get("order.status:pkg_ordered:accepted").status, "dead_letter");
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

test("Posentegra restaurant rejection is idempotent and retries through the durable outbox", async () => {
  const db = testDb();
  db.prepare("INSERT INTO packages (id, posentegra_id, updated_at) VALUES (?, ?, ?)").run("pkg_reject", "pid_reject", new Date().toISOString());
  let calls = 0;
  const client = {
    configured: () => true,
    async cancelOrder(orderId, reason, meta) {
      calls += 1;
      assert.equal(orderId, "pid_reject");
      assert.equal(reason, "Ürün tükendi.");
      assert.equal(meta.sourcePlatform, "Trendyol Yemek");
      if (calls === 1) throw new Error("temporary cancellation outage");
      return { ok: true, status: 200 };
    },
    async changeOrderStatus() {
      throw new Error("not expected");
    },
    async assignPackageToRestaurant() {
      throw new Error("not expected");
    },
  };
  const outbox = createPosentegraOutboxService({ db, client, logger: { warn() {} } });
  outbox.enqueueCancellation({ packageId: "pkg_reject", orderId: "pid_reject", reason: "Ürün tükendi.", meta: { sourcePlatform: "Trendyol Yemek" } });
  outbox.enqueueCancellation({ packageId: "pkg_reject", orderId: "pid_reject", reason: "Ürün tükendi.", meta: { sourcePlatform: "Trendyol Yemek" } });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM posentegra_outbox").get().count, 1);

  await outbox.processDue();
  let row = db.prepare("SELECT * FROM posentegra_outbox WHERE dedupe_key = ?").get("order.cancel:pkg_reject");
  assert.equal(row.status, "failed");
  assert.equal(row.attempts, 1);
  assert.match(row.last_error, /temporary cancellation outage/);

  db.prepare("UPDATE posentegra_outbox SET next_attempt_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), row.id);
  await outbox.processDue();
  row = db.prepare("SELECT * FROM posentegra_outbox WHERE id = ?").get(row.id);
  assert.equal(row.status, "completed");
  assert.equal(calls, 2);
  db.close();
});

test("Posentegra outbox immediately drains work queued during an active sweep", async () => {
  const db = testDb();
  const stamp = new Date().toISOString();
  db.prepare("INSERT INTO packages (id, posentegra_id, updated_at) VALUES (?, ?, ?)").run("pkg_fast", "pid_fast", stamp);
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const statuses = [];
  const client = {
    configured: () => true,
    async changeOrderStatus(orderId, status) {
      assert.equal(orderId, "pid_fast");
      statuses.push(status);
      if (status === "accepted") await firstGate;
      return { ok: true, status: 200 };
    },
    async assignPackageToRestaurant() {
      throw new Error("not expected");
    },
  };
  const outbox = createPosentegraOutboxService({ db, client, logger: { warn() {} } });
  outbox.enqueueStatus({ packageId: "pkg_fast", orderId: "pid_fast", status: "accepted" });
  const activeSweep = outbox.processDue();
  await new Promise((resolve) => setImmediate(resolve));
  outbox.enqueueStatus({ packageId: "pkg_fast", orderId: "pid_fast", status: "delivered" });
  const overlappingSweep = await outbox.processDue();
  assert.equal(overlappingSweep.rerunRequested, true);
  releaseFirst();
  await activeSweep;
  assert.deepEqual(statuses, ["accepted", "delivered"]);
  assert.equal(
    db.prepare("SELECT status FROM posentegra_outbox WHERE dedupe_key = ?").get("order.status:pkg_fast:delivered").status,
    "completed"
  );
  db.close();
});

test("Posentegra reconciliation skips remote-completed steps and sends only the missing delivered step", async () => {
  const db = testDb();
  db.prepare("INSERT INTO packages (id, posentegra_id, status, updated_at) VALUES (?, ?, ?, ?)")
    .run("pkg_reconcile", "pid_reconcile", "delivered", new Date().toISOString());
  const sent = [];
  let remoteCode = 500;
  const client = {
    configured: () => true,
    async getOrder(orderId) {
      assert.equal(orderId, "pid_reconcile");
      return { responseBody: { data: { status: remoteCode } } };
    },
    async changeOrderStatus(orderId, status) {
      assert.equal(orderId, "pid_reconcile");
      sent.push(status);
      remoteCode = 600;
      return { ok: true, status: 200 };
    },
  };
  const outbox = createPosentegraOutboxService({ db, client, logger: { warn() {} } });
  outbox.enqueueStatus({ packageId: "pkg_reconcile", orderId: "pid_reconcile", status: "accepted" });
  outbox.enqueueStatus({ packageId: "pkg_reconcile", orderId: "pid_reconcile", status: "on_the_way" });
  outbox.enqueueStatus({ packageId: "pkg_reconcile", orderId: "pid_reconcile", status: "delivered" });
  db.prepare("UPDATE posentegra_outbox SET status = 'dead_letter' WHERE dedupe_key = ?")
    .run("order.status:pkg_reconcile:accepted");

  const result = await outbox.reconcilePackage("pkg_reconcile");

  assert.deepEqual(sent, ["delivered"]);
  assert.equal(result.remoteBefore, 500);
  assert.equal(result.remoteAfter, 600);
  assert.equal(result.action, "advanced_and_verified");
  assert.deepEqual(
    db.prepare("SELECT DISTINCT status FROM posentegra_outbox WHERE aggregate_id = ?").all("pkg_reconcile").map((row) => row.status),
    ["completed"]
  );
  db.close();
});

test("Posentegra reconciliation cancels a locally cancelled package without advancing pending status rows", async () => {
  const db = testDb();
  db.prepare("INSERT INTO packages (id, posentegra_id, status, failure_reason, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run("pkg_cancelled", "pid_cancelled", "cancelled", "Admin iptal etti", new Date().toISOString());
  let remoteCode = 400;
  let cancelCalls = 0;
  let statusCalls = 0;
  const client = {
    configured: () => true,
    async getOrder(orderId) {
      assert.equal(orderId, "pid_cancelled");
      return { responseBody: { data: { status: remoteCode } } };
    },
    async cancelOrder(orderId, reason, meta) {
      assert.equal(orderId, "pid_cancelled");
      assert.equal(reason, "TECHNICAL_PROBLEM");
      assert.equal(meta.note, "Admin iptal etti");
      assert.equal(meta.reconciliation, true);
      cancelCalls += 1;
      remoteCode = 1600;
      return { ok: true, status: 200 };
    },
    async changeOrderStatus() {
      statusCalls += 1;
    },
  };
  const outbox = createPosentegraOutboxService({ db, client, logger: { warn() {} } });
  outbox.enqueueStatus({ packageId: "pkg_cancelled", orderId: "pid_cancelled", status: "accepted" });
  outbox.enqueueStatus({ packageId: "pkg_cancelled", orderId: "pid_cancelled", status: "on_the_way" });
  db.prepare("UPDATE posentegra_outbox SET status = 'dead_letter' WHERE dedupe_key = ?")
    .run("order.status:pkg_cancelled:accepted");

  const result = await outbox.reconcilePackage("pkg_cancelled");

  assert.equal(cancelCalls, 1);
  assert.equal(statusCalls, 0);
  assert.equal(result.remoteAfter, 1600);
  assert.equal(result.action, "cancelled");
  assert.deepEqual(
    db.prepare("SELECT DISTINCT status FROM posentegra_outbox WHERE aggregate_id = ?").all("pkg_cancelled").map((row) => row.status),
    ["completed"]
  );
  db.close();
});

test("Posentegra reconciliation treats provider terminal 900 as delivered without sending again", async () => {
  const db = testDb();
  db.prepare("INSERT INTO packages (id, posentegra_id, status, updated_at) VALUES (?, ?, ?, ?)")
    .run("pkg_terminal_900", "pid_terminal_900", "delivered", new Date().toISOString());
  let statusCalls = 0;
  const client = {
    configured: () => true,
    async getOrder() {
      return { responseBody: { data: { status: 900, providerResponse: { packageStatus: "Delivered" } } } };
    },
    async changeOrderStatus() {
      statusCalls += 1;
    },
  };
  const outbox = createPosentegraOutboxService({ db, client, logger: { warn() {} } });
  outbox.enqueueStatus({ packageId: "pkg_terminal_900", orderId: "pid_terminal_900", status: "accepted" });
  outbox.enqueueStatus({ packageId: "pkg_terminal_900", orderId: "pid_terminal_900", status: "on_the_way" });
  outbox.enqueueStatus({ packageId: "pkg_terminal_900", orderId: "pid_terminal_900", status: "delivered" });

  const result = await outbox.reconcilePackage("pkg_terminal_900");

  assert.equal(statusCalls, 0);
  assert.equal(result.remoteBefore, 900);
  assert.equal(result.remoteAfter, 900);
  assert.equal(result.action, "already_reconciled");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM posentegra_outbox WHERE status != 'completed'").get().count, 0);
  db.close();
});
