const PLATFORM_OPTIONS = [
  "Trendyol Yemek",
  "Yemeksepeti",
  "Getir Yemek",
];

const PAYMENT_OPTIONS = [
  "Online \u00d6deme",
  "Nakit",
  "POS",
  "Sodexo",
  "Yemek Kart\u0131",
];

const STATUS_LABELS = {
  pending_approval: "Restoran Onayi Bekliyor",
  pending: "Haz\u0131rlan\u0131yor",
  preparing: "Hazirlaniyor",
  awaiting_assignment: "Atama Bekliyor",
  assigned: "Kuryeye Atand\u0131",
  accepted_by_courier: "Kurye Kabul Etti",
  on_route: "Yolda",
  delivered: "Teslim Edildi",
  failed: "Ba\u015far\u0131s\u0131z",
  rejected: "Reddedildi",
  cancelled: "\u0130ptal Edildi",
};

const STATUS_OPTIONS = ["pending_approval", "pending", "preparing", "awaiting_assignment", "assigned", "accepted_by_courier", "on_route", "delivered", "failed", "rejected", "cancelled"];

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
let audioContextRef = null;
const signalCooldowns = new Map();
const RESTAURANT_ID_STORAGE_KEY = "deliveraRestaurantId";
const RESTAURANT_API_KEY_STORAGE_KEY = "deliveraRestaurantApiKey";

function renderIfChanged(target, signature, renderCallback) {
  if (!target || typeof renderCallback !== "function") {
    return false;
  }

  const nextSignature = String(signature ?? "");
  if (target.__deliveraRenderSignature === nextSignature) {
    return false;
  }

  target.__deliveraRenderSignature = nextSignature;
  renderCallback();
  return true;
}

function resetRenderSignature(target) {
  if (target) {
    target.__deliveraRenderSignature = "";
  }
}

function listRenderSignature(items = [], fields = []) {
  return JSON.stringify((items || []).map((item) => {
    if (!fields.length) {
      return item;
    }
    return fields.map((field) => item?.[field] ?? "");
  }));
}

async function api(path, options = {}) {
  const requestPath = String(path || "").replace(/^https:\/\/paketdelivera\.onrender\.com(?=\/api\/)/i, "");

  async function runRequest() {
    const mergedHeaders = {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    };

    if (requestPath.startsWith("/api/restaurant")) {
      const restaurantId = localStorage.getItem(RESTAURANT_ID_STORAGE_KEY) || "";
      const apiKey = localStorage.getItem(RESTAURANT_API_KEY_STORAGE_KEY) || "";
      if (restaurantId && !mergedHeaders["x-restaurant-id"]) {
        mergedHeaders["x-restaurant-id"] = restaurantId;
      }
      if (apiKey && !mergedHeaders["x-api-key"]) {
        mergedHeaders["x-api-key"] = apiKey;
      }
    }

    let response;
    try {
      response = await fetch(requestPath, {
        ...options,
        headers: mergedHeaders,
      });
    } catch (error) {
      showToast("Baglanti kurulamadı. Interneti veya sunucu durumunu kontrol et.", "error");
      throw error;
    }

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
    const message = result.response.status === 429 && result.data.retryAfter
      ? `Cok hizli istek gonderildi. ${result.data.retryAfter} sn sonra tekrar dene.`
      : result.data.error || "Bir hata olu\u015ftu.";
    const error = new Error(message);
    error.status = result.response.status;
    error.code = result.data.code || "";
    error.requestId = result.data.requestId || result.response.headers.get("x-request-id") || "";
    throw error;
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

function notificationTone(eventType = "") {
  if (["assignment-waiting"].includes(eventType)) {
    return "error";
  }
  if (["package-assigned", "package-created", "platform-order", "integration-order", "shift-plan-offer", "shift-plan-accepted"].includes(eventType)) {
    return "success";
  }
  return "info";
}

function getAudioContext() {
  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtor) {
    return null;
  }
  if (!audioContextRef) {
    audioContextRef = new AudioCtor();
  }
  return audioContextRef;
}

function playSignal(kind = "default") {
  const now = Date.now();
  const cooldown = signalCooldowns.get(kind) || 0;
  if (cooldown > now) {
    return;
  }
  const cooldownMs = kind === "assignment-long" ? 6500 : 2200;
  signalCooldowns.set(kind, now + cooldownMs);

  const ctx = getAudioContext();
  if (!ctx) {
    return;
  }
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }

  const profile = {
    assignment: [880, 1174, 1320],
    "assignment-long": [880, 1174, 1320, 1174, 880, 1320, 1174, 880, 1320, 1174, 880, 1320],
    critical: [320, 260, 320, 260],
    ready: [640, 880, 980],
    default: [720, 860],
  }[kind] || [720];

  const stepSeconds = kind === "assignment-long" ? 0.5 : 0.18;
  const rampUpSeconds = kind === "assignment-long" ? 0.04 : 0.02;
  const noteLengthSeconds = kind === "assignment-long" ? 0.42 : 0.16;
  const peakGain = kind === "assignment-long" ? 0.16 : 0.12;

  const startAt = ctx.currentTime;
  profile.forEach((freq, index) => {
    const osc = ctx.createOscillator();
    const support = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = kind === "critical" ? "square" : "sine";
    support.type = "triangle";
    osc.frequency.value = freq;
    support.frequency.value = freq * 0.5;
    gain.gain.setValueAtTime(0.0001, startAt + index * stepSeconds);
    gain.gain.exponentialRampToValueAtTime(peakGain, startAt + index * stepSeconds + rampUpSeconds);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + index * stepSeconds + noteLengthSeconds);
    osc.connect(gain);
    support.connect(gain);
    gain.connect(ctx.destination);
    osc.start(startAt + index * stepSeconds);
    support.start(startAt + index * stepSeconds);
    osc.stop(startAt + index * stepSeconds + noteLengthSeconds);
    support.stop(startAt + index * stepSeconds + noteLengthSeconds);
  });
}

function renderNotificationCenter(target, notifications = [], emptyText = "Bildirim yok.") {
  if (!target) {
    return;
  }

  const visibleNotifications = (notifications || []).slice(0, 8);
  const signature = listRenderSignature(visibleNotifications, ["id", "eventType", "message", "createdAt"]);
  if (!renderIfChanged(target, signature || `empty:${emptyText}`, () => {
  target.innerHTML = "";
  if (!visibleNotifications.length) {
    target.innerHTML = `<div class="empty-state compact-empty-state">${emptyText}</div>`;
    return;
  }

  visibleNotifications.forEach((item) => {
    const titleMap = {
      "package-created": "Yeni Paket",
      "package-assigned": "Kurye Atamasi",
      "assignment-waiting": "Kritik Bekleme",
      "package-status": "Durum Guncellemesi",
      "platform-order": "Platform Siparisi",
      "integration-order": "Entegrasyon Siparisi",
      "courier-day-close": "Gun Sonu",
      "courier-availability": "Kurye Durumu",
      "workspace-update": "Sistem Bildirimi",
    };
    const card = document.createElement("article");
    card.className = "stack-card notification-card";
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <strong>${titleMap[item.eventType] || "Sistem Bildirimi"}</strong>
          <p>${item.message || "-"}</p>
        </div>
        <span class="soft-badge">${formatTimeAgo(item.createdAt)}</span>
      </div>
    `;
    target.appendChild(card);
  });
  })) {
    return;
  }
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
