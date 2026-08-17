const test = require("node:test");
const assert = require("node:assert/strict");
const { createOperationsSupervisor } = require("../services/operationsSupervisor");

test("supervisor reuses rebalance engine and deduplicates alerts", async () => {
  const messages = [];
  let rebalanceCalls = 0;
  const fixedNow = new Date("2026-08-13T07:00:00.000Z");
  const snapshot = {
    couriers: [],
    packages: [{
      id: "pkg_waiting",
      trackingNo: "PKT-100",
      restaurantName: "Test Restoran",
      status: "awaiting_assignment",
      assignedCourierId: null,
      createdAt: "2026-08-13T06:50:00.000Z",
      lastAssignmentError: "uygun kurye yok",
    }],
  };
  const supervisor = createOperationsSupervisor({
    getSnapshot: async () => snapshot,
    rebalance: async () => { rebalanceCalls += 1; },
    telegram: {
      configured: () => true,
      sendMessage: async (message) => { messages.push(message); return { ok: true }; },
    },
    now: () => fixedNow,
    waitingAlertMinutes: 5,
    repeatMinutes: 60,
    dailyReportHour: 23,
  });

  await supervisor.inspect();
  await supervisor.inspect();
  assert.equal(rebalanceCalls, 1);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /PKT-100/);
  assert.match(messages[0], /uygun kurye yok/);
});

test("supervisor sends severity health alerts and a non-mutating day-close report", async () => {
  const messages = [];
  const fixedNow = new Date("2026-08-12T21:10:00.000Z");
  const reportDates = [];
  const supervisor = createOperationsSupervisor({
    getSnapshot: async () => ({ couriers: [], packages: [] }),
    getDailySummary: async (date) => {
      reportDates.push(date);
      return { total: 12, delivered: 10, cancelled: 2, active: 0, waiting: 0, onlineCouriers: 0 };
    },
    getHealthSnapshot: async () => ({
      database: { ok: true },
      integrations: { incomingWebhook: { enabled: true, secretConfigured: true }, posentegra: { outbox: { counts: { failed: 2 } } } },
      platformHealth: { error: 0, webhookErrorsLast24h: 0 },
      queues: { queueService: { initError: null } },
    }),
    telegram: {
      configured: () => true,
      sendMessage: async (message) => { messages.push(message); return { ok: true }; },
    },
    now: () => fixedNow,
    dailyReportHour: 9,
    dayCloseHour: 0,
    dayCloseMinute: 5,
    healthCheckIntervalMs: 1,
  });

  await supervisor.inspect();
  assert.deepEqual(reportDates, ["2026-08-12"]);
  assert.ok(messages.some((message) => message.includes("[KRİTİK]") && message.includes("Posentegra")));
  assert.ok(messages.some((message) => message.includes("Gün sonu kapanış raporu") && message.includes("2026-08-12")));
});

test("Telegram commands accept only the authorized chat and retry through supplied safe callback", async () => {
  const sent = [];
  let updates = [{ update_id: 10, message: { chat: { id: "42" }, text: "/start" } }];
  let retryCalls = 0;
  const telegram = {
    configured: () => true,
    authorizedChatId: () => "42",
    getUpdates: async () => ({ ok: true, updates }),
    sendMessage: async (message) => { sent.push(message); return { ok: true }; },
  };
  const supervisor = createOperationsSupervisor({
    getSnapshot: async () => ({ couriers: [], packages: [] }),
    retryPackage: async (reference) => { retryCalls += 1; return { ok: true, message: `${reference} yeniden denendi.` }; },
    telegram,
  });

  await supervisor.pollCommands();
  assert.equal(sent.length, 0);
  updates = [
    { update_id: 11, message: { chat: { id: "999" }, text: "/tekrarla PKT-1" } },
    { update_id: 12, message: { chat: { id: "42" }, text: "/tekrarla PKT-2" } },
  ];
  await supervisor.pollCommands();
  assert.equal(retryCalls, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /PKT-2 yeniden denendi/);
});

test("supervisor reports stale couriers and stuck active packages", async () => {
  const messages = [];
  const fixedNow = new Date("2026-08-13T07:00:00.000Z");
  const supervisor = createOperationsSupervisor({
    getSnapshot: async () => ({
      couriers: [{ id: "cr_1", name: "Kurye Bir", status: "online", lastLocationAt: "2026-08-13T05:00:00.000Z" }],
      packages: [{
        id: "pkg_route",
        trackingNo: "PKT-200",
        status: "on_route",
        assignedCourierId: "cr_1",
        assignedCourierName: "Kurye Bir",
        onRouteAt: "2026-08-13T05:30:00.000Z",
      }],
    }),
    rebalance: async () => {},
    telegram: {
      configured: () => true,
      sendMessage: async (message) => { messages.push(message); return { ok: true }; },
    },
    now: () => fixedNow,
    routeAlertMinutes: 60,
    staleLocationMinutes: 30,
    dailyReportHour: 23,
  });

  await supervisor.inspect();
  assert.equal(messages.length, 2);
  assert.ok(messages.some((message) => message.includes("PKT-200")));
  assert.ok(messages.some((message) => message.includes("konumu güncel değil")));
});

test("onaylı müdahale paketi onaydan önce değiştirmez ve yalnız bir kez çalışır", async () => {
  let retryCalls = 0;
  const audit = [];
  const pkg = {
    id: "pkg_approval",
    trackingNo: "PKT-300",
    status: "awaiting_assignment",
    assignedCourierId: null,
    restaurantName: "Test Restoran",
  };
  const supervisor = createOperationsSupervisor({
    getSnapshot: async () => ({ couriers: [], packages: [pkg] }),
    findPackage: async () => pkg,
    retryPackage: async () => {
      retryCalls += 1;
      return { ok: true, message: "Güvenli motor çalıştırıldı." };
    },
    recordAction: async (entry) => audit.push(entry),
    createApprovalCode: () => "654321",
    telegram: { configured: () => true, sendMessage: async () => ({ ok: true }) },
  });

  const request = await supervisor.executeCommand("/yenidenata PKT-300");
  assert.equal(retryCalls, 0);
  assert.match(request, /onayla 654321/);
  assert.equal(supervisor.getState().pendingApprovals.length, 1);

  const approved = await supervisor.executeCommand("/onayla 654321");
  assert.equal(retryCalls, 1);
  assert.match(approved, /Güvenli motor çalıştırıldı/);

  const duplicate = await supervisor.executeCommand("/onayla 654321");
  assert.equal(retryCalls, 1);
  assert.match(duplicate, /ikinci kez çalıştırılmadı/);
  assert.ok(audit.some((entry) => entry.action === "telegram_approval_requested"));
  assert.ok(audit.some((entry) => entry.action === "telegram_approval_executed"));
});

test("açık olay yükseltilir ve düzelince tek çözüm bildirimi gönderilir", async () => {
  const messages = [];
  let current = new Date("2026-08-13T07:00:00.000Z");
  let packages = [{
    id: "pkg_escalation",
    trackingNo: "PKT-400",
    restaurantName: "Test Restoran",
    status: "awaiting_assignment",
    assignedCourierId: null,
    createdAt: "2026-08-13T06:30:00.000Z",
  }];
  const supervisor = createOperationsSupervisor({
    getSnapshot: async () => ({ couriers: [], packages }),
    rebalance: async () => {},
    telegram: {
      configured: () => true,
      sendMessage: async (message) => { messages.push(message); return { ok: true }; },
    },
    now: () => current,
    waitingAlertMinutes: 5,
    escalationMinutes: 10,
    repeatMinutes: 60,
    dailyReportHour: 23,
  });

  await supervisor.inspect();
  current = new Date("2026-08-13T07:11:00.000Z");
  await supervisor.inspect();
  assert.ok(messages.some((message) => message.includes("hâlâ çözülmedi")));

  packages = [];
  current = new Date("2026-08-13T07:12:00.000Z");
  await supervisor.inspect();
  assert.equal(messages.filter((message) => message.includes("ÇÖZÜLDÜ")).length, 1);
  assert.equal(supervisor.getState().incidents.length, 0);
});

test("güvenli otomatik iyileştirme cooldown boyunca atama motorunu sıkıştırmaz", async () => {
  let current = new Date("2026-08-13T07:00:00.000Z");
  let rebalanceCalls = 0;
  const supervisor = createOperationsSupervisor({
    getSnapshot: async () => ({
      couriers: [],
      packages: [{
        id: "pkg_cooldown",
        trackingNo: "PKT-500",
        status: "awaiting_assignment",
        assignedCourierId: null,
        createdAt: "2026-08-13T06:30:00.000Z",
      }],
    }),
    rebalance: async () => { rebalanceCalls += 1; },
    telegram: { configured: () => true, sendMessage: async () => ({ ok: true }) },
    now: () => current,
    waitingAlertMinutes: 5,
    remediationCooldownMinutes: 5,
    repeatMinutes: 60,
    dailyReportHour: 23,
  });

  await supervisor.inspect();
  current = new Date("2026-08-13T07:03:00.000Z");
  await supervisor.inspect();
  assert.equal(rebalanceCalls, 1);
  current = new Date("2026-08-13T07:06:00.000Z");
  await supervisor.inspect();
  assert.equal(rebalanceCalls, 2);
});

test("analiz, tahmin, restoran ve kurye komutları salt okunur veri üretir", async () => {
  const snapshot = {
    couriers: [{ id: "cr_1", name: "Arda", zone: "Akdeniz", status: "online", lastLocationAt: "2026-08-13T06:59:00.000Z" }],
    packages: [{
      id: "pkg_live",
      trackingNo: "PKT-600",
      restaurantId: "rst_1",
      restaurantName: "Örnek Restoran",
      status: "assigned",
      assignedCourierId: "cr_1",
      assignedCourierName: "Arda",
    }],
  };
  let analyticsCalls = 0;
  const supervisor = createOperationsSupervisor({
    getSnapshot: async () => snapshot,
    getAnalyticsSnapshot: async () => {
      analyticsCalls += 1;
      return {
        totals: { total: 30, delivered: 25, cancelled: 3, deliveryRate: 83.3, avgAssignmentMinutes: 2.5, avgDeliveryMinutes: 21.4 },
        restaurants: [{ id: "rst_1", name: "Örnek Restoran", total: 30, delivered: 25, cancelled: 3 }],
        couriers: [{ id: "cr_1", name: "Arda", total: 20, delivered: 18 }],
        forecast: { expectedToday: 40, todaySoFar: 18, changePercent: 12.5 },
      };
    },
    telegram: { configured: () => true, sendMessage: async () => ({ ok: true }) },
    now: () => new Date("2026-08-13T07:00:00.000Z"),
  });

  assert.match(await supervisor.executeCommand("/rapor hafta"), /Son 7 günlük operasyon analizi/);
  assert.match(await supervisor.executeCommand("/tahmin"), /Bugün beklenen paket: 40/);
  assert.match(await supervisor.executeCommand("/restoran Örnek"), /7 günlük paket: 30/);
  assert.match(await supervisor.executeCommand("/kurye Arda"), /Aktif paket: 1/);
  assert.equal(analyticsCalls, 3);
});
