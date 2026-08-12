const STATUS_MAP = new Map([
  ["100", { status: "pending", statusText: "new" }],
  ["200", { status: "preparing", statusText: "accepted" }],
  ["300", { status: "preparing", statusText: "preparing" }],
  // FastSiparis ilerletme akisi platforma gore ara kodlar icerebilir.
  // Canli API'de teslim terminali 900, iptal terminali 1600'dur.
  ["400", { status: "accepted_by_courier", statusText: "accepted_by_courier" }],
  ["500", { status: "on_route", statusText: "on_the_way" }],
  ["600", { status: "on_route", statusText: "on_the_way" }],
  ["700", { status: "on_route", statusText: "on_the_way" }],
  ["800", { status: "on_route", statusText: "on_the_way" }],
  ["1600", { status: "cancelled", statusText: "cancelled" }],
  // Canli FastSiparis yaniti, kaynak platformda Delivered olduktan sonra 900 donuyor.
  // Iptal ayri ve kesin olarak 1600 koduyla temsil ediliyor.
  ["900", { status: "delivered", statusText: "delivered" }],
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
