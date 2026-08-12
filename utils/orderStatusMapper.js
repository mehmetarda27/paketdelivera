const STATUS_MAP = new Map([
  ["100", { status: "pending", statusText: "new" }],
  ["200", { status: "preparing", statusText: "accepted" }],
  ["300", { status: "preparing", statusText: "preparing" }],
  // FastSiparis ilerletme akisi 300 -> 400 -> 500 -> 600 seklindedir.
  // 500 yoldaki, 600 teslim edilen siparistir. Iptal ayri olarak 1600 doner.
  ["400", { status: "accepted_by_courier", statusText: "accepted_by_courier" }],
  ["500", { status: "on_route", statusText: "on_the_way" }],
  ["600", { status: "delivered", statusText: "delivered" }],
  ["1600", { status: "cancelled", statusText: "cancelled" }],
  ["900", { status: "pending", statusText: "completed_or_cancelled_unknown" }],
  ["new", { status: "pending", statusText: "new" }],
  ["accepted", { status: "preparing", statusText: "accepted" }],
  ["preparing", { status: "preparing", statusText: "preparing" }],
  ["on_the_way", { status: "on_route", statusText: "on_the_way" }],
  ["on-route", { status: "on_route", statusText: "on_the_way" }],
  ["delivered", { status: "delivered", statusText: "delivered" }],
  ["cancelled", { status: "cancelled", statusText: "cancelled" }],
  ["canceled", { status: "cancelled", statusText: "cancelled" }],
]);

function mapOrderStatus(value) {
  const rawStatus = value === null || value === undefined ? "" : String(value).trim();
  const mapped = STATUS_MAP.get(rawStatus.toLowerCase()) || STATUS_MAP.get(rawStatus);
  if (mapped) {
    return { ...mapped, rawStatus };
  }
  return {
    status: "pending",
    statusText: rawStatus ? "unknown" : "",
    rawStatus,
  };
}

module.exports = {
  mapOrderStatus,
};
