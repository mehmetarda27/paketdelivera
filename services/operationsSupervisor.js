const logger = require("./logger");

const TERMINAL_STATUSES = new Set(["delivered", "cancelled", "rejected"]);
const WAITING_STATUSES = new Set(["pending", "preparing", "awaiting_assignment", "failed"]);
const ACTIVE_STATUSES = new Set(["assigned", "accepted_by_courier", "on_route"]);

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function timestamp(value) {
  const parsed = new Date(value || "").getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function minutesSince(value, nowMs) {
  const then = timestamp(value);
  return then ? Math.max(0, Math.floor((nowMs - then) / 60_000)) : 0;
}

function istanbulParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, hour: Number(values.hour) };
}

function packageLabel(pkg) {
  return pkg.trackingNo || pkg.externalOrderNo || pkg.id || "bilinmeyen paket";
}

function restaurantLabel(pkg) {
  return pkg.restaurantName || pkg.restaurantId || "bilinmeyen işletme";
}

function summarizeItems(items, formatter, maxItems = 5) {
  const sample = items.slice(0, maxItems).map(formatter);
  if (items.length > maxItems) sample.push(`… ve ${items.length - maxItems} kayıt daha`);
  return sample.join("\n");
}

function createOperationsSupervisor(options = {}) {
  const getSnapshot = options.getSnapshot;
  const getDailySummary = options.getDailySummary || null;
  const rebalance = options.rebalance || (() => {});
  const telegram = options.telegram;
  const log = options.logger || logger;
  const now = options.now || (() => new Date());
  const intervalMs = positiveNumber(options.intervalMs ?? process.env.DELIVERA_SUPERVISOR_INTERVAL_MS, 60_000);
  const waitingAlertMinutes = positiveNumber(options.waitingAlertMinutes ?? process.env.DELIVERA_WAITING_ALERT_MINUTES, 5);
  const acceptedAlertMinutes = positiveNumber(options.acceptedAlertMinutes ?? process.env.DELIVERA_ACCEPTED_ALERT_MINUTES, 20);
  const routeAlertMinutes = positiveNumber(options.routeAlertMinutes ?? process.env.DELIVERA_ROUTE_ALERT_MINUTES, 60);
  const staleLocationMinutes = positiveNumber(options.staleLocationMinutes ?? process.env.DELIVERA_STALE_LOCATION_ALERT_MINUTES, 30);
  const repeatMinutes = positiveNumber(options.repeatMinutes ?? process.env.DELIVERA_ALERT_REPEAT_MINUTES, 60);
  const dailyReportHour = Math.max(0, Math.min(23, Number(options.dailyReportHour ?? process.env.DELIVERA_DAILY_REPORT_HOUR ?? 9)));
  const alertState = new Map();
  let timer = null;
  let running = false;
  let lastDailyReportDate = "";

  function shouldSend(key, nowMs) {
    return nowMs - (alertState.get(key) || 0) >= repeatMinutes * 60_000;
  }

  async function alert(key, message, nowMs) {
    if (!shouldSend(key, nowMs)) return false;
    const result = await telegram.sendMessage(message);
    if (result.ok) alertState.set(key, nowMs);
    return Boolean(result.ok);
  }

  function cleanResolvedAlerts(activeKeys) {
    for (const key of alertState.keys()) {
      if (!activeKeys.has(key) && !key.startsWith("daily:")) alertState.delete(key);
    }
  }

  function dailyReport(summary, reportDate) {
    return [
      `📊 Delivera günlük operasyon özeti (${reportDate})`,
      `• Bugün gelen paket: ${summary.total || 0}`,
      `• Teslim edilen: ${summary.delivered || 0}`,
      `• İptal/reddedilen: ${summary.cancelled || 0}`,
      `• Şu an aktif paket: ${summary.active || 0}`,
      `• Atama bekleyen: ${summary.waiting || 0}`,
      `• Canlı kurye: ${summary.onlineCouriers || 0}`,
    ].join("\n");
  }

  async function inspect() {
    if (running) return { skipped: true, reason: "already_running" };
    running = true;
    try {
      const current = now();
      const nowMs = current.getTime();
      const snapshot = await getSnapshot();
      const packages = snapshot?.packages || [];
      const couriers = snapshot?.couriers || [];
      const courierById = new Map(couriers.map((courier) => [courier.id, courier]));
      const activeKeys = new Set();

      const waitingPackages = packages.filter((pkg) =>
        WAITING_STATUSES.has(pkg.status) && !pkg.assignedCourierId && !TERMINAL_STATUSES.has(pkg.status)
      );
      const overdueWaiting = waitingPackages.filter((pkg) =>
        minutesSince(pkg.createdAt || pkg.updatedAt, nowMs) >= waitingAlertMinutes
      );
      if (overdueWaiting.length > 0) {
        const key = "waiting-packages";
        activeKeys.add(key);
        // Var olan idempotent atama motoru tek yazıcı olarak kalır. Gözcü,
        // tekrar aralığında yalnız bir kez güvenli yeniden deneme tetikler.
        if (shouldSend(key, nowMs)) await rebalance();
        await alert(key, [
          `🚨 ${overdueWaiting.length} paket atama bekliyor`,
          summarizeItems(overdueWaiting, (pkg) =>
            `• ${packageLabel(pkg)} · ${restaurantLabel(pkg)} · ${minutesSince(pkg.createdAt || pkg.updatedAt, nowMs)} dk · ${pkg.lastAssignmentError || pkg.assignmentReason || "uygun canlı kurye yok"}`
          ),
        ].join("\n"), nowMs);
      }

      const inactiveCourierPackages = [];
      const acceptedStuck = [];
      const routeStuck = [];
      for (const pkg of packages) {
        if (!ACTIVE_STATUSES.has(pkg.status) || !pkg.assignedCourierId) continue;
        const courier = courierById.get(pkg.assignedCourierId);
        if (!courier || !["online", "busy"].includes(courier.status)) inactiveCourierPackages.push(pkg);
        if (pkg.status === "accepted_by_courier" && minutesSince(pkg.acceptedAt || pkg.updatedAt, nowMs) >= acceptedAlertMinutes) {
          acceptedStuck.push(pkg);
        }
        if (pkg.status === "on_route" && minutesSince(pkg.onRouteAt || pkg.updatedAt, nowMs) >= routeAlertMinutes) {
          routeStuck.push(pkg);
        }
      }

      const groupedPackageAlerts = [
        ["inactive-couriers", inactiveCourierPackages, "⚠️ Aktif paket çevrimdışı kuryede", (pkg) => `• ${packageLabel(pkg)} · ${pkg.assignedCourierName || pkg.assignedCourierId} · ${pkg.status}`],
        ["accepted-stuck", acceptedStuck, "⚠️ Kurye kabul etti fakat yola çıkmadı", (pkg) => `• ${packageLabel(pkg)} · ${pkg.assignedCourierName || pkg.assignedCourierId} · ${minutesSince(pkg.acceptedAt || pkg.updatedAt, nowMs)} dk`],
        ["route-stuck", routeStuck, "🚨 Uzun süredir yolda olan paket", (pkg) => `• ${packageLabel(pkg)} · ${pkg.assignedCourierName || pkg.assignedCourierId} · ${minutesSince(pkg.onRouteAt || pkg.updatedAt, nowMs)} dk`],
      ];
      for (const [key, items, title, formatter] of groupedPackageAlerts) {
        if (!items.length) continue;
        activeKeys.add(key);
        await alert(key, `${title} (${items.length})\n${summarizeItems(items, formatter)}`, nowMs);
      }

      const staleCouriers = couriers.filter((courier) =>
        ["online", "busy"].includes(courier.status) && minutesSince(courier.lastLocationAt, nowMs) >= staleLocationMinutes
      );
      if (staleCouriers.length) {
        const key = "stale-locations";
        activeKeys.add(key);
        await alert(key, [
          `📍 ${staleCouriers.length} kuryenin konumu güncel değil`,
          summarizeItems(staleCouriers, (courier) =>
            `• ${courier.name || courier.id} · ${minutesSince(courier.lastLocationAt, nowMs)} dk · ${courier.status}`
          ),
        ].join("\n"), nowMs);
      }

      const local = istanbulParts(current);
      if (local.hour >= dailyReportHour && lastDailyReportDate !== local.date) {
        const summary = getDailySummary
          ? await getDailySummary(local.date)
          : {
              total: packages.length,
              delivered: packages.filter((pkg) => pkg.status === "delivered").length,
              cancelled: packages.filter((pkg) => ["cancelled", "rejected"].includes(pkg.status)).length,
              active: packages.filter((pkg) => ACTIVE_STATUSES.has(pkg.status)).length,
              waiting: waitingPackages.length,
              onlineCouriers: couriers.filter((courier) => ["online", "busy"].includes(courier.status)).length,
            };
        const result = await telegram.sendMessage(dailyReport(summary, local.date));
        if (result.ok) {
          lastDailyReportDate = local.date;
          alertState.set(`daily:${local.date}`, nowMs);
        }
      }
      cleanResolvedAlerts(activeKeys);
      return { ok: true, waiting: waitingPackages.length, activeAlerts: activeKeys.size };
    } catch (error) {
      log.warn("Operations supervisor inspection failed", { error });
      return { ok: false, error: error.message };
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer || process.env.DELIVERA_SUPERVISOR_ENABLED === "false") return;
    timer = setInterval(() => void inspect(), intervalMs);
    timer.unref?.();
    void inspect();
    log.info("Operations supervisor started", { intervalMs, telegramConfigured: telegram.configured() });
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { inspect, start, stop };
}

module.exports = { createOperationsSupervisor, istanbulParts };
