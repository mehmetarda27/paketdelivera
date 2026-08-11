const crypto = require("crypto");

const EVENT_TYPES = Object.freeze({
  PACKAGE_ASSIGN: "package.assign",
  ORDER_STATUS: "order.status",
  ORDER_CANCEL: "order.cancel",
});

function nowIso() {
  return new Date().toISOString();
}

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(value || "");
  } catch {
    return fallback;
  }
}

function trimmed(value) {
  return String(value ?? "").trim();
}

function statusRank(status) {
  const normalized = trimmed(status).toLowerCase();
  if (normalized === "accepted") return 1;
  if (normalized === "on_the_way") return 2;
  if (normalized === "delivered" || normalized === "failed") return 3;
  return 99;
}

function responseId(result) {
  const body = result?.responseBody || {};
  return trimmed(body.id || body.pid || body.orderId || body.order_id || body.data?.id || body.data?.pid);
}

function createPosentegraOutboxService({ db, client, logger, maxAttempts = 10 } = {}) {
  let processing = false;
  let rerunRequested = false;

  function enqueue(eventType, aggregateId, payload, dedupeKey) {
    const createdAt = nowIso();
    const id = `pob_${crypto.randomBytes(16).toString("hex")}`;
    db.prepare(`
      INSERT INTO posentegra_outbox (
        id, event_type, aggregate_id, dedupe_key, payload_json, status, attempts,
        next_attempt_at, last_error, locked_at, completed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, ?, ?)
      ON CONFLICT(dedupe_key) DO UPDATE SET
        payload_json = excluded.payload_json,
        status = CASE
          WHEN posentegra_outbox.status IN ('completed', 'processing', 'dead_letter') THEN posentegra_outbox.status
          ELSE 'pending'
        END,
        next_attempt_at = CASE
          WHEN posentegra_outbox.status IN ('completed', 'processing', 'dead_letter') THEN posentegra_outbox.next_attempt_at
          ELSE excluded.next_attempt_at
        END,
        last_error = CASE
          WHEN posentegra_outbox.status IN ('completed', 'processing', 'dead_letter') THEN posentegra_outbox.last_error
          ELSE NULL
        END,
        locked_at = CASE WHEN posentegra_outbox.status = 'processing' THEN posentegra_outbox.locked_at ELSE NULL END,
        updated_at = excluded.updated_at
    `).run(id, eventType, aggregateId, dedupeKey, JSON.stringify(payload || {}), createdAt, createdAt, createdAt);
    return db.prepare("SELECT * FROM posentegra_outbox WHERE dedupe_key = ?").get(dedupeKey);
  }

  function enqueuePackageAssignment({ packageId, restaurantPosentegraId, packagePayload }) {
    if (!client.configured() || !trimmed(restaurantPosentegraId) || !trimmed(packageId)) {
      return null;
    }
    return enqueue(EVENT_TYPES.PACKAGE_ASSIGN, packageId, {
      restaurantPosentegraId,
      packagePayload: { ...packagePayload, id: packageId, packageId },
    }, `package.assign:${packageId}`);
  }

  function enqueueStatus({ packageId, orderId, status, meta = {} }) {
    if (!client.configured() || !trimmed(packageId) || !trimmed(orderId) || !trimmed(status)) {
      return null;
    }
    return enqueue(EVENT_TYPES.ORDER_STATUS, packageId, { orderId, status, meta }, `order.status:${packageId}:${status}`);
  }

  function enqueueCancellation({ packageId, orderId, reason, meta = {} }) {
    if (!client.configured() || !trimmed(packageId) || !trimmed(orderId)) {
      return null;
    }
    return enqueue(EVENT_TYPES.ORDER_CANCEL, packageId, {
      orderId,
      reason: trimmed(reason) || "Restoran siparişi reddetti.",
      meta,
    }, `order.cancel:${packageId}`);
  }

  async function deliver(row) {
    const payload = parseJson(row.payload_json, {});
    if (row.event_type === EVENT_TYPES.PACKAGE_ASSIGN) {
      const result = await client.assignPackageToRestaurant(payload.restaurantPosentegraId, payload.packagePayload || {});
      const remoteId = responseId(result);
      if (remoteId) {
        db.prepare("UPDATE packages SET posentegra_id = ?, updated_at = ? WHERE id = ?").run(remoteId, nowIso(), row.aggregate_id);
      }
      return result;
    }
    if (row.event_type === EVENT_TYPES.ORDER_STATUS) {
      const packageRow = db.prepare("SELECT posentegra_id FROM packages WHERE id = ?").get(row.aggregate_id);
      const currentOrderId = trimmed(packageRow?.posentegra_id || payload.orderId);
      if (!currentOrderId) {
        throw new Error("Posentegra order pid bulunamadi.");
      }
      return client.changeOrderStatus(currentOrderId, payload.status, {
        ...(payload.meta || {}),
        packageId: row.aggregate_id,
      });
    }
    if (row.event_type === EVENT_TYPES.ORDER_CANCEL) {
      const packageRow = db.prepare("SELECT posentegra_id FROM packages WHERE id = ?").get(row.aggregate_id);
      const currentOrderId = trimmed(packageRow?.posentegra_id || payload.orderId);
      if (!currentOrderId) {
        throw new Error("Posentegra order pid bulunamadi.");
      }
      return client.cancelOrder(currentOrderId, payload.reason, {
        ...(payload.meta || {}),
        packageId: row.aggregate_id,
      });
    }
    throw new Error(`Desteklenmeyen Posentegra outbox olayi: ${row.event_type}`);
  }

  async function processDue(limit = 20) {
    if (!client.configured()) {
      return { processed: 0, skipped: true };
    }
    if (processing) {
      rerunRequested = true;
      return { processed: 0, skipped: true, rerunRequested: true };
    }
    processing = true;
    let processed = 0;
    let selected = 0;
    try {
      do {
        rerunRequested = false;
        const staleLock = new Date(Date.now() - 5 * 60_000).toISOString();
        // Paket atama istekleri idempotent oldugu icin eski kilitler tekrar alinabilir.
        db.prepare(`
          UPDATE posentegra_outbox
          SET status = 'pending', locked_at = NULL, updated_at = ?
          WHERE status = 'processing' AND event_type = ? AND locked_at < ?
        `).run(nowIso(), EVENT_TYPES.PACKAGE_ASSIGN, staleLock);
        // change-status uzak siparisi bir adim ilerlettigi icin, istekten sonra proses
        // kapanmis olabilecegi belirsiz durumda otomatik tekrar guvenli degildir.
        db.prepare(`
          UPDATE posentegra_outbox
          SET status = 'dead_letter', next_attempt_at = NULL, locked_at = NULL,
              last_error = COALESCE(last_error, 'Belirsiz onceki gonderim; cift durum ilerletmeyi onlemek icin manuel kontrol gerekli.'),
              updated_at = ?
          WHERE status = 'processing' AND event_type IN (?, ?) AND locked_at < ?
        `).run(nowIso(), EVENT_TYPES.ORDER_STATUS, EVENT_TYPES.ORDER_CANCEL, staleLock);
        const rows = db.prepare(`
          SELECT * FROM posentegra_outbox
          WHERE status IN ('pending', 'failed')
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          ORDER BY created_at ASC
          LIMIT ?
        `).all(nowIso(), Math.max(1, Math.min(100, Number(limit) || 20)));
        selected += rows.length;
        for (const row of rows) {
          if (row.event_type === EVENT_TYPES.ORDER_STATUS) {
            const currentPayload = parseJson(row.payload_json, {});
            const currentRank = statusRank(currentPayload.status);
            const earlierRows = db.prepare(`
              SELECT id, payload_json, status
              FROM posentegra_outbox
              WHERE aggregate_id = ? AND event_type = ? AND id != ? AND status != 'completed'
            `).all(row.aggregate_id, EVENT_TYPES.ORDER_STATUS, row.id);
            const blocked = earlierRows.some((candidate) => {
              const candidateRank = statusRank(parseJson(candidate.payload_json, {}).status);
              return candidateRank < currentRank;
            });
            if (blocked) {
              continue;
            }
          }
          const lockedAt = nowIso();
          const lockResult = db.prepare(`
            UPDATE posentegra_outbox SET status = 'processing', locked_at = ?, updated_at = ?
            WHERE id = ? AND status IN ('pending', 'failed')
          `).run(lockedAt, lockedAt, row.id);
          if (!lockResult.changes) {
            continue;
          }
          try {
            await deliver(row);
            db.prepare(`
              UPDATE posentegra_outbox
              SET status = 'completed', completed_at = ?, locked_at = NULL, last_error = NULL, updated_at = ?
              WHERE id = ?
            `).run(nowIso(), nowIso(), row.id);
            logger?.info?.("Posentegra outbox delivery completed", {
              outboxId: row.id,
              eventType: row.event_type,
              aggregateId: row.aggregate_id,
            });
            processed += 1;
          } catch (error) {
            const attempts = Number(row.attempts || 0) + 1;
            const nonIdempotent = row.event_type === EVENT_TYPES.ORDER_STATUS;
            const dead = nonIdempotent || attempts >= maxAttempts;
            const delayMs = Math.min(30 * 60_000, 30_000 * (2 ** Math.min(6, attempts - 1)));
            const nextAttemptAt = dead ? null : new Date(Date.now() + delayMs).toISOString();
            db.prepare(`
              UPDATE posentegra_outbox
              SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, locked_at = NULL, updated_at = ?
              WHERE id = ?
            `).run(dead ? "dead_letter" : "failed", attempts, nextAttemptAt, String(error.message || error).slice(0, 1000), nowIso(), row.id);
            logger?.warn?.("Posentegra outbox delivery failed", {
              outboxId: row.id,
              eventType: row.event_type,
              aggregateId: row.aggregate_id,
              attempts,
              deadLettered: dead,
              automaticRetryDisabled: nonIdempotent,
              nextAttemptAt,
              error: error.message,
            });
          }
        }
      } while (rerunRequested);
      return { processed, selected };
    } finally {
      processing = false;
    }
  }

  function health() {
    const counts = db.prepare(`
      SELECT status, COUNT(*) AS count FROM posentegra_outbox GROUP BY status
    `).all();
    return {
      processing,
      counts: Object.fromEntries(counts.map((row) => [row.status, Number(row.count || 0)])),
    };
  }

  return {
    EVENT_TYPES,
    enqueuePackageAssignment,
    enqueueStatus,
    enqueueCancellation,
    processDue,
    health,
  };
}

module.exports = { createPosentegraOutboxService, EVENT_TYPES };
