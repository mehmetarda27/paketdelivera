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
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

function previousIstanbulDate(date) {
  return istanbulParts(new Date(date.getTime() - 8 * 60 * 60 * 1000)).date;
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

function severity(level, message) {
  const labels = { info: "BİLGİ", warning: "UYARI", critical: "KRİTİK", emergency: "ACİL" };
  return `[${labels[level] || labels.info}] ${message}`;
}

function dailyReport(summary, reportDate, title = "Sabah operasyon raporu") {
  return [
    severity("info", `${title} (${reportDate})`),
    `• Gelen paket: ${summary.total || 0}`,
    `• Teslim edilen: ${summary.delivered || 0}`,
    `• İptal/reddedilen: ${summary.cancelled || 0}`,
    `• Şu an aktif paket: ${summary.active || 0}`,
    `• Atama bekleyen: ${summary.waiting || 0}`,
    `• Canlı kurye: ${summary.onlineCouriers || 0}`,
  ].join("\n");
}

function createOperationsSupervisor(options = {}) {
  const getSnapshot = options.getSnapshot;
  const getDailySummary = options.getDailySummary || null;
  const getHealthSnapshot = options.getHealthSnapshot || null;
  const findPackage = options.findPackage || null;
  const retryPackage = options.retryPackage || null;
  const rebalance = options.rebalance || (() => {});
  const telegram = options.telegram;
  const log = options.logger || logger;
  const now = options.now || (() => new Date());
  const intervalMs = positiveNumber(options.intervalMs ?? process.env.DELIVERA_SUPERVISOR_INTERVAL_MS, 60_000);
  const commandPollMs = positiveNumber(options.commandPollMs ?? process.env.TELEGRAM_COMMAND_POLL_MS, 5_000);
  const healthCheckIntervalMs = positiveNumber(options.healthCheckIntervalMs ?? process.env.DELIVERA_HEALTH_CHECK_INTERVAL_MS, 300_000);
  const waitingAlertMinutes = positiveNumber(options.waitingAlertMinutes ?? process.env.DELIVERA_WAITING_ALERT_MINUTES, 5);
  const acceptedAlertMinutes = positiveNumber(options.acceptedAlertMinutes ?? process.env.DELIVERA_ACCEPTED_ALERT_MINUTES, 20);
  const routeAlertMinutes = positiveNumber(options.routeAlertMinutes ?? process.env.DELIVERA_ROUTE_ALERT_MINUTES, 60);
  const staleLocationMinutes = positiveNumber(options.staleLocationMinutes ?? process.env.DELIVERA_STALE_LOCATION_ALERT_MINUTES, 30);
  const repeatMinutes = positiveNumber(options.repeatMinutes ?? process.env.DELIVERA_ALERT_REPEAT_MINUTES, 60);
  const dailyReportHour = Math.max(0, Math.min(23, Number(options.dailyReportHour ?? process.env.DELIVERA_DAILY_REPORT_HOUR ?? 9)));
  const dayCloseHour = Math.max(0, Math.min(23, Number(options.dayCloseHour ?? process.env.DELIVERA_DAY_CLOSE_REPORT_HOUR ?? 0)));
  const dayCloseMinute = Math.max(0, Math.min(59, Number(options.dayCloseMinute ?? process.env.DELIVERA_DAY_CLOSE_REPORT_MINUTE ?? 5)));
  const alertState = new Map();
  let timer = null;
  let commandTimer = null;
  let running = false;
  let commandRunning = false;
  let commandOffset = null;
  let lastDailyReportDate = "";
  let lastDayCloseReportDate = "";
  let lastHealthCheckAt = 0;

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
      if (!activeKeys.has(key) && !key.startsWith("daily:") && !key.startsWith("health:")) alertState.delete(key);
    }
  }

  function healthIssues(health) {
    const issues = [];
    if (!health?.database?.ok) issues.push(["critical", "Veritabanı sağlık kontrolü başarısız."]);
    if (health?.database?.postgresRequired && !health?.database?.postgresUrlConfigured) {
      issues.push(["emergency", "Canlı ortamda PostgreSQL bağlantısı yapılandırılmamış."]);
    }
    if (health?.integrations?.incomingWebhook?.enabled && !health?.integrations?.incomingWebhook?.secretConfigured) {
      issues.push(["critical", "Sipariş webhook'u açık fakat güvenlik anahtarı eksik."]);
    }
    const outbox = health?.integrations?.posentegra?.outbox?.counts || {};
    if (Number(outbox.failed || 0) > 0) issues.push(["critical", `Posentegra geri bildirim kuyruğunda ${outbox.failed} başarısız kayıt var.`]);
    if (Number(health?.platformHealth?.error || 0) > 0) issues.push(["warning", `${health.platformHealth.error} platform hesabı hata durumunda.`]);
    if (Number(health?.platformHealth?.webhookErrorsLast24h || 0) > 0) {
      issues.push(["warning", `Son 24 saatte ${health.platformHealth.webhookErrorsLast24h} webhook hatası oluştu.`]);
    }
    const queue = health?.queues?.queueService;
    if (queue?.initError) issues.push(["warning", `Kuyruk servisi Redis yerine güvenli yerel modda: ${queue.initError}`]);
    return issues;
  }

  async function inspectHealth(current, activeKeys) {
    if (!getHealthSnapshot || current.getTime() - lastHealthCheckAt < healthCheckIntervalMs) return;
    lastHealthCheckAt = current.getTime();
    try {
      const health = await getHealthSnapshot();
      const issues = healthIssues(health);
      for (const [level, text] of issues) {
        const key = `health:${level}:${text}`;
        activeKeys.add(key);
        await alert(key, severity(level, text), current.getTime());
      }
    } catch (error) {
      const key = "health:emergency:check-failed";
      activeKeys.add(key);
      await alert(key, severity("emergency", `Sistem sağlık kontrolü çalıştırılamadı: ${error.message}`), current.getTime());
    }
  }

  async function sendScheduledReports(current, packages, couriers, waitingPackages) {
    if (!getDailySummary) return;
    const local = istanbulParts(current);
    if (local.hour >= dailyReportHour && lastDailyReportDate !== local.date) {
      const summary = await getDailySummary(local.date);
      const result = await telegram.sendMessage(dailyReport(summary, local.date));
      if (result.ok) lastDailyReportDate = local.date;
    }
    // Kapanış yalnız gece/sabah penceresinde gönderilir. Uygulama öğleden sonra
    // yeniden başlarsa geçmiş raporu tekrar Telegram'a yağdırmaz.
    const closeReached = local.hour < dailyReportHour
      && (local.hour > dayCloseHour || (local.hour === dayCloseHour && local.minute >= dayCloseMinute));
    if (closeReached && lastDayCloseReportDate !== local.date) {
      const reportDate = previousIstanbulDate(current);
      const summary = await getDailySummary(reportDate);
      const result = await telegram.sendMessage(dailyReport(summary, reportDate, "Gün sonu kapanış raporu"));
      if (result.ok) lastDayCloseReportDate = local.date;
    }
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
      const waitingPackages = packages.filter((pkg) => WAITING_STATUSES.has(pkg.status) && !pkg.assignedCourierId);
      const overdueWaiting = waitingPackages.filter((pkg) => minutesSince(pkg.createdAt || pkg.updatedAt, nowMs) >= waitingAlertMinutes);

      if (overdueWaiting.length) {
        const key = "waiting-packages";
        activeKeys.add(key);
        // Müdahale ikinci bir atama motoru oluşturmaz. Var olan kilitli ve
        // idempotent motoru, bildirim tekrar süresinde yalnız bir kez uyandırır.
        if (shouldSend(key, nowMs)) await rebalance();
        await alert(key, [
          severity("critical", `${overdueWaiting.length} paket atama bekliyor.`),
          summarizeItems(overdueWaiting, (pkg) => `• ${packageLabel(pkg)} · ${restaurantLabel(pkg)} · ${minutesSince(pkg.createdAt || pkg.updatedAt, nowMs)} dk · ${pkg.lastAssignmentError || pkg.assignmentReason || "uygun canlı kurye yok"}`),
        ].join("\n"), nowMs);
      }

      const inactiveCourierPackages = [];
      const acceptedStuck = [];
      const routeStuck = [];
      for (const pkg of packages) {
        if (!ACTIVE_STATUSES.has(pkg.status) || !pkg.assignedCourierId) continue;
        const courier = courierById.get(pkg.assignedCourierId);
        if (!courier || !["online", "busy"].includes(courier.status)) inactiveCourierPackages.push(pkg);
        if (pkg.status === "accepted_by_courier" && minutesSince(pkg.acceptedAt || pkg.updatedAt, nowMs) >= acceptedAlertMinutes) acceptedStuck.push(pkg);
        if (pkg.status === "on_route" && minutesSince(pkg.onRouteAt || pkg.updatedAt, nowMs) >= routeAlertMinutes) routeStuck.push(pkg);
      }

      const grouped = [
        ["inactive-couriers", inactiveCourierPackages, "critical", "Aktif paket çevrimdışı kuryede", (pkg) => `• ${packageLabel(pkg)} · ${pkg.assignedCourierName || pkg.assignedCourierId} · ${pkg.status}`],
        ["accepted-stuck", acceptedStuck, "warning", "Kurye kabul etti fakat yola çıkmadı", (pkg) => `• ${packageLabel(pkg)} · ${pkg.assignedCourierName || pkg.assignedCourierId} · ${minutesSince(pkg.acceptedAt || pkg.updatedAt, nowMs)} dk`],
        ["route-stuck", routeStuck, "critical", "Uzun süredir yolda olan paket", (pkg) => `• ${packageLabel(pkg)} · ${pkg.assignedCourierName || pkg.assignedCourierId} · ${minutesSince(pkg.onRouteAt || pkg.updatedAt, nowMs)} dk`],
      ];
      for (const [key, items, level, title, formatter] of grouped) {
        if (!items.length) continue;
        activeKeys.add(key);
        await alert(key, `${severity(level, `${title} (${items.length})`)}\n${summarizeItems(items, formatter)}`, nowMs);
      }

      const staleCouriers = couriers.filter((courier) => ["online", "busy"].includes(courier.status) && minutesSince(courier.lastLocationAt, nowMs) >= staleLocationMinutes);
      if (staleCouriers.length) {
        const key = "stale-locations";
        activeKeys.add(key);
        await alert(key, [
          severity("warning", `${staleCouriers.length} kuryenin konumu güncel değil.`),
          summarizeItems(staleCouriers, (courier) => `• ${courier.name || courier.id} · ${minutesSince(courier.lastLocationAt, nowMs)} dk · ${courier.status}`),
        ].join("\n"), nowMs);
      }

      await inspectHealth(current, activeKeys);
      await sendScheduledReports(current, packages, couriers, waitingPackages);
      cleanResolvedAlerts(activeKeys);
      return { ok: true, waiting: waitingPackages.length, activeAlerts: activeKeys.size };
    } catch (error) {
      log.warn("Operations supervisor inspection failed", { error });
      await alert("health:emergency:inspection", severity("emergency", `Operasyon gözcüsü veri okuyamadı: ${error.message}`), now().getTime()).catch(() => {});
      return { ok: false, error: error.message };
    } finally {
      running = false;
    }
  }

  function commandHelp() {
    return [
      "Delivera güvenli komutları:",
      "/durum — sistem ve operasyon özeti",
      "/bekleyenler — atama bekleyen paketler",
      "/kuryeler — canlı kurye özeti",
      "/platformlar — entegrasyon sağlığı",
      "/gunsonu — bugünün raporu",
      "/paket PKT-123 — paket durumu",
      "/tekrarla PKT-123 — bekleyen pakette güvenli atama denemesi",
    ].join("\n");
  }

  async function executeCommand(text) {
    const [rawCommand, ...args] = String(text || "").trim().split(/\s+/);
    const command = rawCommand.toLocaleLowerCase("tr-TR").split("@")[0];
    const snapshot = await getSnapshot();
    const packages = snapshot?.packages || [];
    const couriers = snapshot?.couriers || [];
    if (["/start", "/yardim", "/help"].includes(command)) return commandHelp();
    if (command === "/durum") {
      const waiting = packages.filter((pkg) => WAITING_STATUSES.has(pkg.status) && !pkg.assignedCourierId).length;
      const active = packages.filter((pkg) => ACTIVE_STATUSES.has(pkg.status)).length;
      return severity("info", `Sistem çalışıyor. Aktif paket: ${active}, bekleyen: ${waiting}, canlı kurye: ${couriers.filter((c) => ["online", "busy"].includes(c.status)).length}.`);
    }
    if (command === "/bekleyenler") {
      const waiting = packages.filter((pkg) => WAITING_STATUSES.has(pkg.status) && !pkg.assignedCourierId);
      return waiting.length ? `${severity("warning", `${waiting.length} paket bekliyor.`)}\n${summarizeItems(waiting, (pkg) => `• ${packageLabel(pkg)} · ${restaurantLabel(pkg)}`, 10)}` : severity("info", "Atama bekleyen paket yok.");
    }
    if (command === "/kuryeler") {
      const online = couriers.filter((c) => ["online", "busy"].includes(c.status));
      return online.length ? `${severity("info", `${online.length} canlı kurye.`)}\n${summarizeItems(online, (c) => `• ${c.name || c.id} · ${c.status}`, 15)}` : severity("warning", "Şu anda canlı kurye yok.");
    }
    if (command === "/platformlar") {
      if (!getHealthSnapshot) return severity("warning", "Platform sağlık bilgisi kullanılamıyor.");
      const health = await getHealthSnapshot();
      const platform = health.platformHealth || {};
      const outbox = health.integrations?.posentegra?.outbox?.counts || {};
      return severity("info", `Platform hesapları: ${platform.connected || 0} bağlı, ${platform.warning || 0} uyarı, ${platform.error || 0} hata. Posentegra kuyruğu: ${outbox.pending || 0} bekleyen, ${outbox.failed || 0} başarısız.`);
    }
    if (command === "/gunsonu") {
      if (!getDailySummary) return severity("warning", "Gün sonu raporu kullanılamıyor.");
      const date = istanbulParts(now()).date;
      return dailyReport(await getDailySummary(date), date, "Anlık gün sonu raporu");
    }
    if (command === "/paket") {
      if (!args[0]) return "Kullanım: /paket PKT-123";
      const pkg = findPackage ? await findPackage(args[0]) : packages.find((item) => packageLabel(item).toLowerCase() === args[0].toLowerCase());
      return pkg ? severity("info", `${packageLabel(pkg)} · ${restaurantLabel(pkg)} · ${pkg.status} · kurye: ${pkg.assignedCourierName || pkg.assignedCourierId || "atanmadı"}`) : severity("warning", "Paket bulunamadı.");
    }
    if (command === "/tekrarla") {
      if (!args[0]) return "Kullanım: /tekrarla PKT-123";
      if (!retryPackage) return severity("warning", "Güvenli tekrar deneme kullanılamıyor.");
      const result = await retryPackage(args[0]);
      return severity(result.ok ? "info" : "warning", result.message || "İşlem tamamlandı.");
    }
    return commandHelp();
  }

  async function pollCommands() {
    if (commandRunning || !telegram?.configured?.() || typeof telegram.getUpdates !== "function") return { skipped: true };
    commandRunning = true;
    try {
      const result = await telegram.getUpdates({ offset: commandOffset ?? undefined, timeoutSeconds: 0 });
      if (!result.ok) return result;
      const updates = result.updates || [];
      // İlk bağlantıda eski komutları çalıştırma; sadece imleci güncele taşı.
      if (commandOffset === null) {
        if (updates.length) commandOffset = Math.max(...updates.map((item) => Number(item.update_id) || 0)) + 1;
        else commandOffset = 0;
        return { ok: true, initialized: true };
      }
      for (const update of updates) {
        commandOffset = Math.max(commandOffset, Number(update.update_id || 0) + 1);
        const message = update.message;
        if (!message?.text?.startsWith("/")) continue;
        if (String(message.chat?.id || "") !== String(telegram.authorizedChatId?.() || "")) continue;
        try {
          await telegram.sendMessage(await executeCommand(message.text));
        } catch (error) {
          await telegram.sendMessage(severity("critical", `Komut çalıştırılamadı: ${error.message}`));
        }
      }
      return { ok: true, processed: updates.length };
    } finally {
      commandRunning = false;
    }
  }

  function start() {
    if (timer || process.env.DELIVERA_SUPERVISOR_ENABLED === "false") return;
    timer = setInterval(() => void inspect(), intervalMs);
    timer.unref?.();
    if (telegram?.configured?.() && typeof telegram.getUpdates === "function") {
      commandTimer = setInterval(() => void pollCommands(), commandPollMs);
      commandTimer.unref?.();
      void pollCommands();
    }
    void inspect();
    log.info("Operations supervisor started", { intervalMs, commandPollMs, telegramConfigured: telegram.configured() });
  }

  function stop() {
    if (timer) clearInterval(timer);
    if (commandTimer) clearInterval(commandTimer);
    timer = null;
    commandTimer = null;
  }

  return { inspect, pollCommands, executeCommand, start, stop };
}

module.exports = { createOperationsSupervisor, istanbulParts, severity };
