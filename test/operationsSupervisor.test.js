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
