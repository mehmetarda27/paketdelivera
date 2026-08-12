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
