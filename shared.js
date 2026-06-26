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
  paid_online: "Online",
  cash_expected: "Nakit Bekleniyor",
  cash_collected: "Nakit",
  credit_card: "Kredi Kart\u0131",
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

function workspaceMemoryKey(suffix) {
  const bodyClass = document.body?.classList || { contains: () => false };
  const panelName = bodyClass.contains("theme-admin")
    ? "admin"
    : bodyClass.contains("theme-restaurant")
      ? "restaurant"
      : bodyClass.contains("theme-courier")
        ? "courier"
        : window.location.pathname.replace(/[^a-z0-9]+/gi, "-") || "workspace";
  return `deliveraWorkspace:${panelName}:${suffix}`;
}

function setActiveWorkspaceSection(sectionId, options = {}) {
  const target = document.getElementById(sectionId);
  if (!target) {
    return false;
  }

  document.querySelectorAll(".tree-link[data-section]").forEach((link) => {
    const isActive = link.getAttribute("data-section") === sectionId;
    link.classList.toggle("active-link", isActive);
    if (isActive) {
      const group = link.closest(".tree-group");
      const header = group?.querySelector(".tree-header");
      document.querySelectorAll(".tree-header").forEach((item) => item.classList.remove("active-header"));
      group?.classList.add("open");
      header?.classList.add("active-header");
    }
  });

  document.querySelectorAll(".content-section").forEach((section) => {
    section.classList.toggle("active-section", section.id === sectionId);
  });

  if (options.persist !== false) {
    localStorage.setItem(workspaceMemoryKey("activeSection"), sectionId);
  }
  return true;
}

function restoreWorkspaceScroll() {
  const rawPosition = localStorage.getItem(workspaceMemoryKey("scrollY"));
  const scrollY = Number(rawPosition);
  if (Number.isFinite(scrollY) && scrollY >= 0) {
    window.scrollTo(0, scrollY);
  }
}

function rememberWorkspaceScroll() {
  localStorage.setItem(workspaceMemoryKey("scrollY"), String(Math.max(0, Math.round(window.scrollY || 0))));
}

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
  let requestPath = String(path || "").replace(/^https:\/\/paketdelivera\.onrender\.com(?=\/api\/)/i, "");
  if (requestPath.startsWith("/api/") && (window.location.port === "5500" || window.location.port === "8080" || window.location.protocol === "file:")) {
    requestPath = "http://localhost:3000" + requestPath;
  }

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
    const refreshedAuth = await options.retryWithRefresh();
    if (refreshedAuth?.token) {
      options.headers = {
        ...(options.headers || {}),
        Authorization: `Bearer ${refreshedAuth.token}`,
      };
    }
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
    if (typeof console !== "undefined" && typeof console.error === "function") {
      console.error("API request failed", {
        path: requestPath,
        status: error.status,
        code: error.code,
        requestId: error.requestId,
        message: error.message,
      });
    }
    throw error;
  }

  return result.data;
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (isNaN(date.getTime())) return "-";

  return new Intl.DateTimeFormat("tr-TR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatCurrency(value) {
  return new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency: "TRY",
    maximumFractionDigits: 2,
  }).format(Number(value || 0));
}

function formatMoney(amount) {
  return new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY" }).format(amount);
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

function clearToasts() {
  const host = toastHost && document.body.contains(toastHost)
    ? toastHost
    : document.querySelector(".toast-host");
  if (!host) {
    return;
  }

  host.querySelectorAll(".toast").forEach((toast) => toast.remove());
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

let audioUnlocked = false;
function unlockAudioContext() {
  if (audioUnlocked) return;
  const ctx = getAudioContext();
  if (!ctx) return;
  
  const unlock = () => {
    audioUnlocked = true;
    document.removeEventListener("click", unlockAudioContext);
    document.removeEventListener("touchstart", unlockAudioContext);
    document.removeEventListener("keydown", unlockAudioContext);
    
    // Play silent oscillator to fully unlock iOS Safari
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(0);
    osc.stop(ctx.currentTime + 0.01);
  };

  if (ctx.state === "suspended") {
    ctx.resume().then(unlock).catch(() => {});
  } else {
    unlock();
  }
}

document.addEventListener("click", unlockAudioContext);
document.addEventListener("touchstart", unlockAudioContext);
document.addEventListener("keydown", unlockAudioContext);

let titleFlashInterval = null;
let originalTitle = document.title;

function flashDocumentTitle(message) {
  if (titleFlashInterval) clearInterval(titleFlashInterval);
  const baseTitle = document.title.replace(/^\(\!+\) /, "");
  let isFlash = false;
  let flashCount = 0;
  
  titleFlashInterval = setInterval(() => {
    document.title = isFlash ? `(!!!) ${message}` : baseTitle;
    isFlash = !isFlash;
    flashCount++;
    if (flashCount > 10) { // 5 flashes
      clearInterval(titleFlashInterval);
      document.title = baseTitle;
    }
  }, 1000);
}

function clearAttentionAlerts() {
  if (titleFlashInterval) {
    clearInterval(titleFlashInterval);
    titleFlashInterval = null;
  }
  document.title = originalTitle || document.title.replace(/^\(\!+\) /, "");
  clearToasts();
}

window.addEventListener("focus", clearAttentionAlerts);
window.addEventListener("pageshow", clearAttentionAlerts);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    clearAttentionAlerts();
  }
});

function playSignal(kind = "default") {
  const now = Date.now();
  const cooldown = signalCooldowns.get(kind) || 0;
  if (cooldown > now) {
    return;
  }
  const cooldownMs = kind === "assignment-long" ? 6500 : 2200;
  signalCooldowns.set(kind, now + cooldownMs);

  flashDocumentTitle("Bildirim");

  if (!audioUnlocked) {
    showToast("Sesli bildirimleri duymak için ekrana bir kez dokunun!", "info");
  }

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

// Tree Menu Interaction Logic (Moved from inline HTML to avoid CSP/blocking issues)
document.addEventListener("DOMContentLoaded", function() {
  // Setup tree toggles
  const headers = document.querySelectorAll('.tree-header');
  headers.forEach(header => {
    header.addEventListener('click', function(e) {
      const group = this.closest('.tree-group');
      if (group) {
        if (group.classList.contains('open')) {
          group.classList.remove('open');
          this.classList.remove('active-header');
        } else {
          group.classList.add('open');
          this.classList.add('active-header');
        }
      }
    });
  });

  // Setup section switches
  const links = document.querySelectorAll('.tree-link[data-section]');
  links.forEach(link => {
    link.addEventListener('click', function(e) {
      const sectionId = this.getAttribute('data-section');
      setActiveWorkspaceSection(sectionId);
      rememberWorkspaceScroll();
    });
  });

  const savedSectionId = localStorage.getItem(workspaceMemoryKey("activeSection"));
  if (savedSectionId) {
    setActiveWorkspaceSection(savedSectionId, { persist: false });
  } else {
    const activeLink = document.querySelector(".tree-link.active-link[data-section]");
    const sectionId = activeLink?.getAttribute("data-section");
    if (sectionId) {
      setActiveWorkspaceSection(sectionId, { persist: false });
    }
  }

  let scrollSaveTimer = null;
  window.addEventListener("scroll", () => {
    if (scrollSaveTimer) {
      window.clearTimeout(scrollSaveTimer);
    }
    scrollSaveTimer = window.setTimeout(rememberWorkspaceScroll, 120);
  }, { passive: true });
  window.addEventListener("beforeunload", rememberWorkspaceScroll);
  [0, 250, 1000].forEach((delay) => {
    window.setTimeout(restoreWorkspaceScroll, delay);
  });
  
  // Ensure lucide renders icons (run it here as a fallback)
  if (window.lucide && window.lucide.createIcons) {
    window.lucide.createIcons();
  }
});

window.showPackageDetailsModal = function(pkg) {
  const shell = document.createElement("div");
  shell.className = "modal-shell";
  shell.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal-card glass-panel" style="padding: 24px; max-width: 600px; width: 100%;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; border-bottom: 1px solid var(--line); padding-bottom: 16px;">
        <h3 style="margin: 0; display: flex; align-items: center; gap: 8px;">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#F27A1A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"></line><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>
          Paket Detayı
        </h3>
        <button class="ghost-btn close-modal" style="padding: 6px 12px; color: var(--ink-soft);"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
      </div>

      <div style="display: flex; flex-direction: column; gap: 16px;">
          <div style="display: flex; justify-content: space-between; background: var(--bg); padding: 12px 16px; border-radius: 12px; border: 1px solid var(--line);">
             <div>
               <span style="font-size: 0.8rem; color: var(--ink-soft); display: block; margin-bottom: 4px;">Durum</span>
               <span class="status-badge ${statusClassName(pkg.status)}">${statusLabel(pkg.status)}</span>
             </div>
             <div style="text-align: right;">
               <span style="font-size: 0.8rem; color: var(--ink-soft); display: block; margin-bottom: 4px;">Sipariş Kodu</span>
               <strong style="font-size: 1.1rem;">${pkg.trackingNo || "-"}</strong>
             </div>
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; background: var(--bg); padding: 16px; border-radius: 12px; border: 1px solid var(--line);">
            <div><span style="color: var(--ink-soft); font-size: 0.85rem;">Platform</span><br><strong>${pkg.sourcePlatform || "-"}</strong></div>
            <div><span style="color: var(--ink-soft); font-size: 0.85rem;">Harici No</span><br><strong>${pkg.externalOrderNo || "-"}</strong></div>
            <div><span style="color: var(--ink-soft); font-size: 0.85rem;">Müşteri</span><br><strong>${pkg.recipient || "-"}</strong></div>
            <div><span style="color: var(--ink-soft); font-size: 0.85rem;">Telefon</span><br><strong>${pkg.phone || "-"}</strong></div>
            <div style="grid-column: 1 / -1;"><span style="color: var(--ink-soft); font-size: 0.85rem;">Adres</span><br><strong>${pkg.deliveryAddress || pkg.address || "-"}</strong></div>
            <div><span style="color: var(--ink-soft); font-size: 0.85rem;">Ödeme</span><br><strong>${pkg.paymentMethod || "-"} - ${formatCurrency(pkg.orderAmount)}</strong></div>
            <div><span style="color: var(--ink-soft); font-size: 0.85rem;">Kurye</span><br><strong>${pkg.assignedCourierName || "Atama Bekliyor"}</strong></div>
            <div><span style="color: var(--ink-soft); font-size: 0.85rem;">Oluşturulma</span><br><strong>${formatDate(pkg.createdAt)}</strong></div>
            <div><span style="color: var(--ink-soft); font-size: 0.85rem;">Güncellenme</span><br><strong>${formatDate(pkg.updatedAt || pkg.createdAt)}</strong></div>
          </div>

          ${pkg.customerNote || pkg.note ? `
          <div style="background: rgba(242, 122, 26, 0.08); padding: 16px; border-radius: 12px; border: 1px solid rgba(242, 122, 26, 0.2);">
            <strong style="color: #F27A1A; display: block; margin-bottom: 8px;">Müşteri Notu:</strong>
            <p style="margin: 0; font-size: 0.95rem; color: var(--ink);">${pkg.customerNote || pkg.note}</p>
          </div>
          ` : ""}
      </div>
    </div>
  `;
  document.body.appendChild(shell);

  shell.querySelector('.close-modal').addEventListener('click', () => shell.remove());
  shell.querySelector('.modal-backdrop').addEventListener('click', () => shell.remove());
};
