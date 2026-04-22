const PLATFORM_OPTIONS = [
  "Trendyol Go",
  "GetirYemek",
  "Yemeksepeti",
  "Migros Yemek",
];

const PAYMENT_OPTIONS = [
  "Online \u00d6deme",
  "Nakit",
  "POS",
  "Sodexo",
  "Yemek Kart\u0131",
];

const STATUS_LABELS = {
  pending: "Haz\u0131rlan\u0131yor",
  awaiting_assignment: "Atama Bekliyor",
  assigned: "Kuryeye Atand\u0131",
  accepted_by_courier: "Kurye Kabul Etti",
  on_route: "Yolda",
  delivered: "Teslim Edildi",
  failed: "Ba\u015far\u0131s\u0131z",
  cancelled: "\u0130ptal Edildi",
};

const STATUS_OPTIONS = ["pending", "awaiting_assignment", "assigned", "accepted_by_courier", "on_route", "delivered", "failed", "cancelled"];

const PAYMENT_STATUS_LABELS = {
  unpaid: "\u00d6deme Bekliyor",
  paid_online: "Online \u00d6dendi",
  cash_expected: "Nakit Bekleniyor",
  cash_collected: "Nakit Al\u0131nd\u0131",
  payment_issue: "\u00d6deme Sorunu",
};

const COURIER_STATUS_LABELS = {
  offline: "Offline",
  online: "Online",
  busy: "Me\u015fgul",
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
    throw new Error(result.data.error || "Bir hata olu\u015ftu.");
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
    return "Hen\u00fcz yok";
  }

  const diffMs = Date.now() - new Date(value).getTime();
  const diffSeconds = Math.max(0, Math.floor(diffMs / 1000));

  if (diffSeconds < 10) {
    return "\u015fimdi";
  }
  if (diffSeconds < 60) {
    return `${diffSeconds} sn \u00f6nce`;
  }

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes} dk \u00f6nce`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours} sa \u00f6nce`;
  }

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} g\u00fcn \u00f6nce`;
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
    return '<span class="soft-badge">Platform tan\u0131ml\u0131 de\u011fil</span>';
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

function connectLiveStream(path, token, handlers = {}) {
  if (!token || typeof EventSource === "undefined") {
    return { close() {} };
  }

  const stream = new EventSource(`${path}?token=${encodeURIComponent(token)}`);
  if (typeof handlers.onOpen === "function") {
    stream.addEventListener("ready", (event) => handlers.onOpen(event));
  }
  if (typeof handlers.onMessage === "function") {
    [
      "workspace-update",
      "package-created",
      "package-assigned",
      "assignment-waiting",
      "package-status",
      "package-reassign",
      "package-override",
      "package-unassign",
      "integration-order",
      "platform-order",
      "courier-online",
      "courier-location",
      "courier-day-close",
      "courier-shift-ended",
      "courier-availability",
      "platform-account-saved",
      "platform-test",
      "restaurant-created",
      "courier-created",
    ].forEach((type) => {
      stream.addEventListener(type, (event) => {
        try {
          handlers.onMessage(JSON.parse(event.data || "{}"));
        } catch {
          handlers.onMessage({});
        }
      });
    });
  }
  if (typeof handlers.onError === "function") {
    stream.addEventListener("error", handlers.onError);
  }

  return {
    close() {
      stream.close();
    },
  };
}
