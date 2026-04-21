const PLATFORM_OPTIONS = [
  "Trendyol Go",
  "GetirYemek",
  "Yemeksepeti",
  "Migros Yemek",
];

const PAYMENT_OPTIONS = [
  "Online Odeme",
  "Nakit",
  "POS",
  "Sodexo",
  "Yemek Karti",
];
const STATUS_LABELS = {
  pending: "Hazirlaniyor",
  awaiting_assignment: "Atama Bekliyor",
  assigned: "Kuryeye Atandi",
  accepted_by_courier: "Kurye Kabul Etti",
  on_route: "Yolda",
  delivered: "Teslim Edildi",
  failed: "Basarisiz",
  cancelled: "Iptal Edildi",
};
const STATUS_OPTIONS = ["pending", "awaiting_assignment", "assigned", "accepted_by_courier", "on_route", "delivered", "failed", "cancelled"];
const PAYMENT_STATUS_LABELS = {
  unpaid: "Odeme Bekliyor",
  paid_online: "Online Odendi",
  cash_expected: "Nakit Bekleniyor",
  cash_collected: "Nakit Alindi",
  payment_issue: "Odeme Sorunu",
};
const COURIER_STATUS_LABELS = {
  offline: "Offline",
  online: "Online",
  busy: "Mesgul",
};
let toastHost = null;

async function api(path, options = {}) {
  async function runRequest() {
    const mergedHeaders = {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    };

    const response = await fetch(path, {
      ...options,
      headers: mergedHeaders,
    });

    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("application/json")
      ? await response.json()
      : { error: await response.text() };

    return { response, data };
  }

  let result = await runRequest();

  if (result.response.status === 401 && typeof options.retryWithRefresh === "function") {
    await options.retryWithRefresh();
    result = await runRequest();
  }

  if (!result.response.ok) {
    throw new Error(result.data.error || "Bir hata olustu.");
  }

  return result.data;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("tr-TR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatCurrency(value) {
  return new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency: "TRY",
    maximumFractionDigits: 2,
  }).format(Number(value || 0));
}

function formatTimeAgo(value) {
  if (!value) {
    return "Henuz yok";
  }

  const diffMs = Date.now() - new Date(value).getTime();
  const diffSeconds = Math.max(0, Math.floor(diffMs / 1000));

  if (diffSeconds < 10) {
    return "simdi";
  }
  if (diffSeconds < 60) {
    return `${diffSeconds} sn once`;
  }

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes} dk once`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours} sa once`;
  }

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} gun once`;
}

function statusClassName(status) {
  return `status-${String(status || "").replaceAll("_", "-")}`;
}

function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

function paymentStatusLabel(status) {
  return PAYMENT_STATUS_LABELS[status] || status || "-";
}

function courierStatusLabel(status) {
  return COURIER_STATUS_LABELS[status] || status || "-";
}

function createStatusOptions(selected = "", allowedOptions = STATUS_OPTIONS) {
  return allowedOptions.map((status) =>
    `<option value="${status}"${status === selected ? " selected" : ""}>${statusLabel(status)}</option>`
  ).join("");
}

function createPlatformBadges(platforms) {
  if (!platforms || platforms.length === 0) {
    return '<span class="soft-badge">Platform tanimli degil</span>';
  }

  return platforms.map((platform) => `<span class="soft-badge">${platform}</span>`).join("");
}

function createPlatformOptions(selected = "") {
  return PLATFORM_OPTIONS.map((platform) =>
    `<option value="${platform}"${platform === selected ? " selected" : ""}>${platform}</option>`
  ).join("");
}

function setZoneOptions(select, zones) {
  select.innerHTML = zones.map((zone) => `<option value="${zone.name || zone}">${zone.name || zone}</option>`).join("");
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
  };
}

function ensureToastHost() {
  if (toastHost && document.body.contains(toastHost)) {
    return toastHost;
  }

  toastHost = document.createElement("div");
  toastHost.className = "toast-host";
  document.body.appendChild(toastHost);
  return toastHost;
}

function showToast(message, tone = "success") {
  if (!message) {
    return;
  }

  const host = ensureToastHost();
  const toast = document.createElement("div");
  toast.className = `toast toast-${tone}`;
  toast.textContent = message;
  host.appendChild(toast);

  window.setTimeout(() => {
    toast.classList.add("toast-visible");
  }, 10);

  window.setTimeout(() => {
    toast.classList.remove("toast-visible");
    window.setTimeout(() => {
      toast.remove();
    }, 220);
  }, 2600);
}
