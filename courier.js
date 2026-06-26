const STORAGE_TOKEN_KEY = "kuryeTakipCourierToken";
const STORAGE_REFRESH_TOKEN_KEY = "kuryeTakipCourierRefreshToken";
const LOCATION_PUSH_MS = 2_000;
const WORKSPACE_POLL_MS = 12_000;

const courierState = {
  token: window.__deliveraInitialCourierAuth?.token || "",
  refreshToken: window.__deliveraInitialCourierAuth?.refreshToken || "",
  data: null,
  watchId: null,
  lastCoords: null,
  heartbeatId: null,
  workspacePollId: null,
  historyRange: "7d",
  historyVisibleCount: 50,
  packageLimit: 100,
  packageCursor: "0",
  lastPackageSnapshot: new Map(),
  packageActionDrafts: new Map(),
  liveStream: null,
  lastWorkspaceLoadAt: 0,
  connectionBusy: false,
  focusPackage: null,
  activeProfileSection: "",
};

const COURIER_FAILURE_REASON_OPTIONS = [
  { value: "musteri_yok", label: "Musteri yok" },
  { value: "adres_bulunamadi", label: "Adres bulunamadi" },
  { value: "restoran_hazir_degil", label: "Restoran hazir degil" },
  { value: "teknik_sorun", label: "Teknik sorun" },
  { value: "diger", label: "Diger" },
];
const COURIER_CLOSED_STATUSES = ["delivered", "failed", "cancelled"];

const COURIER_PACKAGE_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"></line><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>`;
const COURIER_MOTO_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#64748B" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 16A3 3 0 1 0 5 22A3 3 0 1 0 5 16Z"></path><path d="M19 16A3 3 0 1 0 19 22A3 3 0 1 0 19 16Z"></path><path d="M5 19H19"></path><path d="M8 15L10 9H15L17 15"></path><path d="M14 9L13 5H17"></path></svg>`;
const COURIER_PIN_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#EF4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>`;
const COURIER_PERSON_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6366F1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`;

function escapeCourierHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function courierFailureReasonLabel(reason) {
  return COURIER_FAILURE_REASON_OPTIONS.find((item) => item.value === reason)?.label || reason || "Sorun yok";
}

function isActiveCourierPackage(pkg) {
  return pkg && !COURIER_CLOSED_STATUSES.includes(pkg.status);
}

function historyDateForPackage(pkg) {
  return new Date(pkg.updatedAt || pkg.deliveredAt || pkg.failedAt || pkg.createdAt);
}

function packageMatchesHistoryRange(pkg, range) {
  const targetDate = historyDateForPackage(pkg);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const sevenDayStart = new Date(todayStart);
  sevenDayStart.setDate(sevenDayStart.getDate() - 6);
  const thirtyDayStart = new Date(todayStart);
  thirtyDayStart.setDate(thirtyDayStart.getDate() - 29);

  if (range === "today") {
    return targetDate >= todayStart;
  }
  if (range === "yesterday") {
    return targetDate >= yesterdayStart && targetDate < todayStart;
  }
  if (range === "30d") {
    return targetDate >= thirtyDayStart;
  }
  if (range === "all") {
    return true;
  }

  return targetDate >= sevenDayStart;
}

const courierRefs = {
  summary: document.getElementById("courierSummary"),
  loginPanel: document.getElementById("loginPanel"),
  workspacePanel: document.getElementById("workspacePanel"),
  loginForm: document.getElementById("loginForm"),
  logoutButton: document.getElementById("logoutButton"),
  connectionSwitch: document.getElementById("courierConnectionSwitch"),
  connectionLabel: document.getElementById("courierConnectionLabel"),
  locationStatus: document.getElementById("locationStatus"),
  name: document.getElementById("courierName"),
  focusCard: document.querySelector(".courier-focus-card"),
  focusLabel: document.querySelector(".courier-focus-card .eyebrow"),
  focusTitle: document.getElementById("courierFocusTitle"),
  focusText: document.getElementById("courierFocusText"),
  missionMeta: document.getElementById("courierMissionMeta"),
  destinationMap: document.getElementById("courierDestinationMap"),
  mapTitle: document.getElementById("courierMapTitle"),
  mapAddress: document.getElementById("courierMapAddress"),
  mapButton: document.getElementById("courierMapButton"),
  stats: document.getElementById("courierStats"),
  dayMetrics: document.getElementById("courierDayMetrics"),
  earningsMetrics: document.getElementById("courierEarningsMetrics"),
  shiftMetrics: document.getElementById("courierShiftMetrics"),
  liveBadge: document.getElementById("courierLiveBadge"),
  dayCloseButton: document.getElementById("courierDayCloseButton"),
  notificationCenter: document.getElementById("courierNotificationCenter"),
  announcementList: document.getElementById("courierAnnouncementList"),
  packages: document.getElementById("courierPackages"),
  history: document.getElementById("courierHistory"),
  historyMeta: document.getElementById("courierHistoryMeta"),
  historyMore: document.getElementById("courierHistoryMore"),
  historyFilters: document.getElementById("courierHistoryFilters"),
  template: document.getElementById("courierPackageTemplate"),
  profileSettingsButton: document.getElementById("profileSettingsButton"),
  profileModal: document.getElementById("courierProfileModal"),
  profileForm: document.getElementById("courierProfileForm"),
};

function persistCourierAuth(auth) {
  courierState.token = auth.token;
  courierState.refreshToken = auth.refreshToken;
}

function clearCourierAuth() {
  courierState.token = "";
  courierState.refreshToken = "";
  courierState.data = null;
  courierState.lastCoords = null;
  courierState.lastPackageSnapshot = new Map();
  courierState.packageActionDrafts = new Map();
  courierState.liveStream?.close?.();
  courierState.liveStream = null;
}

async function refreshCourierAccess() {
  if (!courierState.refreshToken) {
    throw new Error("Kurye refresh token bulunamadi.");
  }

  try {
    const auth = await api("/api/courier/refresh", {
      method: "POST",
      body: JSON.stringify({
        refreshToken: courierState.refreshToken,
      }),
    });
    persistCourierAuth(auth);
    return auth;
  } catch (err) {
    if (err.status === 401) {
      clearCourierAuth();
      window.location.reload();
    }
    throw err;
  }
}

function setLoggedIn(isLoggedIn) {
  document.body.classList.toggle("app-unauthenticated", !isLoggedIn);
  courierRefs.loginPanel.classList.toggle("hidden", isLoggedIn);
}

function setLocationStatus(message) {
  if (courierRefs.locationStatus) courierRefs.locationStatus.textContent = message;
}

function setShiftGreetingStatus(available = courierState.data?.courier?.available) {
  setLocationStatus(available ? "Hayırlı günler" : "Hayırlı akşamlar");
}

function hasMapTarget(latitudeValue, longitudeValue, addressValue) {
  const latitude = Number(latitudeValue);
  const longitude = Number(longitudeValue);
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    return true;
  }
  return Boolean(String(addressValue || "").trim());
}

function buildOrderMapUrl(order, target = "customer") {
  const latitude = Number(target === "restaurant" ? (order?.restaurantLat ?? order?.latitude) : (order?.customerLat ?? order?.customerLatitude));
  const longitude = Number(target === "restaurant" ? (order?.restaurantLng ?? order?.longitude) : (order?.customerLng ?? order?.customerLongitude));
  const address = String(
    target === "restaurant"
      ? (order?.restaurantAddress || order?.restaurantName || order?.zone || "")
      : (order?.customerAddress || order?.deliveryAddress || order?.address || "")
  ).trim();

  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    return `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
  }

  if (!address) {
    return "";
  }

  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

function openOrderMap(order, target = "customer") {
  const url = buildOrderMapUrl(order, target);
  if (!url) {
    showToast("Adres bulunamadi.", "error");
    return;
  }
  window.open(url, "_blank");
}

window.openCourierPackageDetailsById = function(packageId) {
  const pkg = courierState.data?.packages?.find(p => p.id === packageId) ||
              courierState.data?.historyPackages?.find(p => p.id === packageId);
  if (pkg) {
    window.openCourierPackageDetails(pkg);
  }
}

window.openCourierPackageDetails = function(pkg) {
  if (typeof window.showPackageDetailsModal === "function") {
    window.showPackageDetailsModal(pkg);
    return;
  }
  showToast("Siparis detaylari su anda acilamiyor.", "error");
};

function stopLocationWatch() {
  if (courierState.watchId !== null) {
    navigator.geolocation.clearWatch(courierState.watchId);
    courierState.watchId = null;
  }

  if (courierState.heartbeatId !== null) {
    window.clearInterval(courierState.heartbeatId);
    courierState.heartbeatId = null;
  }
}

function stopWorkspacePolling() {
  if (courierState.workspacePollId !== null) {
    window.clearInterval(courierState.workspacePollId);
    courierState.workspacePollId = null;
  }
}

function startWorkspacePolling() {
  if (courierState.workspacePollId !== null || !courierState.token) {
    return;
  }

  courierState.workspacePollId = window.setInterval(() => {
    loadCourierWorkspace({ silent: true });
  }, WORKSPACE_POLL_MS);
}

function startCourierLiveStream() {
  if (courierState.liveStream || !courierState.token) {
    return;
  }

  courierState.liveStream = connectLiveStream("/api/courier/stream", courierState.token, {
    onMessage(event) {
      const toastableTypes = new Set([
        "package-created",
        "package-assigned",
        "assignment-waiting",
        "package-status",
        "package-reassign",
        "package-override",
        "package-unassign",
        "integration-order",
        "platform-order",
        "courier-day-close",
        "courier-availability",
        "shift-plan-offer",
        "shift-plan-accepted",
      ]);
      if (event?.message && toastableTypes.has(event.type)) {
        showToast(event.message, notificationTone(event.type));
        if (event.type === "package-assigned") {
          playSignal("assignment-long");
        } else if (event.type === "shift-plan-offer") {
          playSignal("assignment-long");
        } else if (event.type === "assignment-waiting") {
          playSignal("critical");
        } else if (event.type === "package-status") {
          playSignal("ready");
        }
      }
      if (event?.type !== "courier-location") {
        loadCourierWorkspace({ silent: true, force: true });
      }
    },
    onError() {
      if (courierRefs.liveBadge) {
        courierRefs.liveBadge.textContent = "Canli akis tekrar baglaniyor";
      }
      courierState.liveStream?.close?.();
      courierState.liveStream = null;
      window.setTimeout(() => startCourierLiveStream(), 2000);
    },
  });
}

function requestNotificationPermission() {
  if (typeof Notification === "undefined") {
    return;
  }

  if (Notification.permission === "default") {
    Notification.requestPermission().catch(() => {
      // Ignore permission request errors.
    });
  }
}

let screenWakeLock = null;

async function requestScreenWakeLock() {
  if (!courierState.token) return;
  if ("wakeLock" in navigator) {
    try {
      if (screenWakeLock !== null) {
        return; // Already active
      }
      screenWakeLock = await navigator.wakeLock.request("screen");
      screenWakeLock.addEventListener("release", () => {
        screenWakeLock = null;
      });
    } catch (err) {
      // Ignore wake lock errors
    }
  }
}

function notifyNewAssignment(pkg) {
  showToast(`${pkg.restaurantName} tarafindan yeni paket dustu: ${pkg.recipient}`, "success");
  playSignal("assignment-long");

  if (typeof Notification === "undefined" || Notification.permission !== "granted") {
    return;
  }

  try {
    new Notification("Delivera Express - Yeni Paket", {
      body: `${pkg.restaurantName} - ${pkg.deliveryAddress || pkg.address}`,
      tag: `delivera-package-${pkg.id}`,
    });
  } catch {
    // Ignore browser notification errors.
  }
}

function processIncomingPackageNotifications(packages) {
  const nextSnapshot = new Map();
  const activePackages = packages.filter(isActiveCourierPackage);

  activePackages.forEach((pkg) => {
    const signature = `${pkg.status}|${pkg.assignedAt || ""}`;
    nextSnapshot.set(pkg.id, signature);
    const previous = courierState.lastPackageSnapshot.get(pkg.id);

    if (!previous && pkg.status === "assigned") {
      notifyNewAssignment(pkg);
      return;
    }

    if (previous && previous !== signature && pkg.status === "assigned") {
      notifyNewAssignment(pkg);
    }
  });

  courierState.lastPackageSnapshot = nextSnapshot;
}

function packageRenderSignature(pkg) {
  return [
    pkg.id,
    pkg.status,
    pkg.paymentStatus,
    pkg.failureReason,
    pkg.assignedAt,
    pkg.acceptedAt,
    pkg.onRouteAt,
    pkg.deliveredAt,
    pkg.failedAt,
    pkg.updatedAt,
    pkg.lastAssignmentError,
  ].join("|");
}

function getPackageDraft(pkgId) {
  return courierState.packageActionDrafts.get(pkgId) || { paymentStatus: "", failureReason: "" };
}

function setPackageDraft(pkgId, nextDraft) {
  courierState.packageActionDrafts.set(pkgId, {
    ...getPackageDraft(pkgId),
    ...nextDraft,
  });
}

function clearResolvedPackageDrafts(packages) {
  const activeIds = new Set((packages || []).filter(isActiveCourierPackage).map((pkg) => pkg.id));
  [...courierState.packageActionDrafts.keys()].forEach((pkgId) => {
    if (!activeIds.has(pkgId)) {
      courierState.packageActionDrafts.delete(pkgId);
    }
  });
}

function locationLabel(courier) {
  const gps = `${Number(courier.latitude).toFixed(5)}, ${Number(courier.longitude).toFixed(5)}`;
  const freshness = courier.lastLocationAt ? formatTimeAgo(courier.lastLocationAt) : "Konum daha paylasilmadi";
  return `${gps} - ${freshness}`;
}

function renderCourierStats(courier, packages) {
  const signature = [
    courier.id,
    courier.zone,
    courier.username,
    courier.activeLoad,
    courier.status,
    courier.available,
    courier.latitude,
    courier.longitude,
    courier.lastLocationAt,
    listRenderSignature(packages, ["id", "status", "updatedAt"]),
  ].join("||");
  if (courierRefs.stats.__deliveraRenderSignature === signature) {
    return;
  }
  courierRefs.stats.__deliveraRenderSignature = signature;
  courierRefs.stats.innerHTML = "";

  const delivered = packages.filter((pkg) => pkg.status === "delivered").length;
  const inTransit = packages.filter((pkg) => pkg.status === "accepted_by_courier" || pkg.status === "on_route").length;

  courierRefs.stats.innerHTML = `
    <article class="mini-stat-card">
      <span class="entity-line">${COURIER_PIN_ICON} Bolge</span>
      <strong>${courier.zone}</strong>
    </article>
    <article class="mini-stat-card">
      <span class="entity-line">${COURIER_PERSON_ICON} Kullanici</span>
      <strong>${courier.username}</strong>
    </article>
    <article class="mini-stat-card">
      <span class="entity-line">${COURIER_MOTO_ICON} Aktif Yuk</span>
      <strong>${courier.activeLoad}</strong>
    </article>
    <article class="mini-stat-card">
      <span>Teslim</span>
      <strong>${delivered}</strong>
    </article>
    <article class="mini-stat-card">
      <span>Sahada</span>
      <strong>${inTransit}</strong>
    </article>
    <article class="mini-stat-card">
      <span class="entity-line">${COURIER_PERSON_ICON} Durum</span>
      <strong>${courierStatusLabel(courier.status)}</strong>
    </article>
    <article class="mini-stat-card">
      <span class="entity-line">${COURIER_PIN_ICON} Canli GPS</span>
      <strong class="gps-stat">${locationLabel(courier)}</strong>
    </article>
  `;
}

function renderCourierDayMetrics(dayMetrics) {
  const metrics = dayMetrics || {
    deliveredCount: 0,
    totalAmount: 0,
    paidOnlineAmount: 0,
    cashCollectedAmount: 0,
    courierEarnings: 0,
    hasClosedDay: false,
    closedAt: null,
  };
  const signature = listRenderSignature([metrics], ["deliveredCount", "totalAmount", "paidOnlineAmount", "cashCollectedAmount", "courierEarnings", "hasClosedDay", "closedAt"]);
  if (courierRefs.dayMetrics.__deliveraRenderSignature === signature) {
    return;
  }
  courierRefs.dayMetrics.__deliveraRenderSignature = signature;
  courierRefs.dayMetrics.innerHTML = "";

  courierRefs.dayMetrics.innerHTML = `
    <article class="mini-stat-card">
      <span>Bugun Teslim</span>
      <strong>${metrics.deliveredCount}</strong>
    </article>
    <article class="mini-stat-card">
      <span>Gunluk Ciro</span>
      <strong>${formatCurrency(metrics.totalAmount)}</strong>
    </article>
    <article class="mini-stat-card">
      <span>Gunluk Kazanc</span>
      <strong>${formatCurrency(metrics.courierEarnings || 0)}</strong>
    </article>
    <article class="mini-stat-card">
      <span>Online</span>
      <strong>${formatCurrency(metrics.paidOnlineAmount)}</strong>
    </article>
    <article class="mini-stat-card">
      <span>Nakit</span>
      <strong>${formatCurrency(metrics.cashCollectedAmount)}</strong>
    </article>
    <article class="mini-stat-card">
      <span>Rapor</span>
      <strong>${metrics.hasClosedDay ? `Kapandi ${formatTimeAgo(metrics.closedAt)}` : "Henuz kapanmadi"}</strong>
    </article>
  `;
}

function renderCourierEarnings(earningsSummary) {
  if (!courierRefs.earningsMetrics) {
    return;
  }

  const data = earningsSummary || {
    today: { deliveredCount: 0, totalAmount: 0, paidOnlineAmount: 0, cashAmount: 0, courierEarnings: 0 },
    yesterday: { deliveredCount: 0, totalAmount: 0, paidOnlineAmount: 0, cashAmount: 0, courierEarnings: 0 },
    last7Days: { deliveredCount: 0, totalAmount: 0, paidOnlineAmount: 0, cashAmount: 0, courierEarnings: 0 },
    total: { deliveredCount: 0, totalAmount: 0, paidOnlineAmount: 0, cashAmount: 0, courierEarnings: 0 },
  };
  const signature = JSON.stringify(data);
  if (courierRefs.earningsMetrics.__deliveraRenderSignature === signature) {
    return;
  }
  courierRefs.earningsMetrics.__deliveraRenderSignature = signature;

  courierRefs.earningsMetrics.innerHTML = `
    <article class="mini-stat-card">
      <span>Bugunku Kazanc</span>
      <strong>${formatCurrency(data.today.courierEarnings || 0)}</strong>
    </article>
    <article class="mini-stat-card">
      <span>Dun</span>
      <strong>${formatCurrency(data.yesterday.courierEarnings || 0)}</strong>
    </article>
    <article class="mini-stat-card">
      <span>Son 7 Gun</span>
      <strong>${formatCurrency(data.last7Days.courierEarnings || 0)}</strong>
    </article>
    <article class="mini-stat-card">
      <span>Toplam Teslimat</span>
      <strong>${data.total.deliveredCount}</strong>
    </article>
    <article class="mini-stat-card">
      <span>Toplam Kazanc</span>
      <strong>${formatCurrency(data.total.courierEarnings || 0)}</strong>
    </article>
  `;
}

function syncCourierProfilePanels() {
  const panels = [...document.querySelectorAll(".courier-profile-panel .inner-day-panel")];
  panels.forEach((panel, index) => {
    const sectionKey = panel.dataset.section || `panel-${index}`;
    const isActive = sectionKey === courierState.activeProfileSection;
    panel.classList.toggle("panel-expanded", isActive);
    panel.classList.toggle("panel-collapsed", !isActive);
  });
}

function initializeCourierProfilePanels() {
  const sectionKeys = ["day-close", "earnings", "notifications", "announcements"];
  const panels = [...document.querySelectorAll(".courier-profile-panel .inner-day-panel")];

  panels.forEach((panel, index) => {
    panel.dataset.section = sectionKeys[index] || `panel-${index}`;
    const header = panel.querySelector(".panel-head");
    if (!header || header.dataset.bound === "1") {
      return;
    }

    header.dataset.bound = "1";
    header.classList.add("panel-toggle-head");
    header.tabIndex = 0;
    header.setAttribute("role", "button");
    header.setAttribute("aria-expanded", panel.dataset.section === courierState.activeProfileSection ? "true" : "false");

    const togglePanel = () => {
      courierState.activeProfileSection = courierState.activeProfileSection === panel.dataset.section
        ? ""
        : panel.dataset.section;
      syncCourierProfilePanels();
      panels.forEach((item) => {
        const itemHeader = item.querySelector(".panel-head");
        if (itemHeader) {
          itemHeader.setAttribute("aria-expanded", item.dataset.section === courierState.activeProfileSection ? "true" : "false");
        }
      });
    };

    header.addEventListener("click", (event) => {
      if (event.target.closest("button, select, input, textarea, a, label")) {
        return;
      }
      togglePanel();
    });

    header.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      togglePanel();
    });
  });

  syncCourierProfilePanels();
}

function shiftPlanStatusLabel(status) {
  if (status === "accepted") {
    return "Onaylandi";
  }
  if (status === "awaiting_courier_acceptance") {
    return "Onay Bekliyor";
  }
  if (status === "expired") {
    return "Sure Doldu";
  }
  return status || "Planlandi";
}

function shiftDeadlineText(value) {
  if (!value) {
    return "Sure bilgisi yok";
  }
  const diffMs = new Date(value).getTime() - Date.now();
  if (diffMs <= 0) {
    return "Onay suresi doldu";
  }
  const totalMinutes = Math.max(1, Math.ceil(diffMs / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) {
    return `${hours} sa ${minutes} dk kaldi`;
  }
  return `${minutes} dk kaldi`;
}

function renderCourierShiftSummary(shiftSummary) {
  if (!courierRefs.shiftMetrics) {
    return;
  }

  const currentShift = shiftSummary?.currentShift || null;
  const recentShifts = shiftSummary?.recentShifts || [];
  const shiftPlans = shiftSummary?.shiftPlans || [];
  const signature = [
    currentShift?.id,
    currentShift?.startedAt,
    listRenderSignature(recentShifts.slice(0, 3), ["id", "startedAt", "endedAt"]),
    listRenderSignature(shiftPlans.slice(0, 3), ["id", "planDate", "startTime", "endTime", "zone", "status", "acceptedAt", "offerExpiresAt"]),
  ].join("||");
  if (courierRefs.shiftMetrics.__deliveraRenderSignature === signature) {
    return;
  }
  courierRefs.shiftMetrics.__deliveraRenderSignature = signature;
  const items = [];

  items.push(`
    <article class="stack-card">
      <div class="stack-top">
        <div>
          <strong>Vardiya Baslangici</strong>
          <p>${currentShift?.startedAt ? formatDate(currentShift.startedAt) : "Acik vardiya yok"}</p>
        </div>
        <span class="soft-badge">${currentShift ? "Aktif" : "Kapali"}</span>
      </div>
    </article>
  `);

  items.push(`
    <article class="stack-card">
      <div class="stack-top">
        <div>
          <strong>Vardiya Bitisi</strong>
          <p>${currentShift ? "Henuz kapanmadi" : (recentShifts[0]?.endedAt ? formatDate(recentShifts[0].endedAt) : "Kayit yok")}</p>
        </div>
        <span class="soft-badge">${recentShifts.length} kayit</span>
      </div>
    </article>
  `);

  shiftPlans.slice(0, 3).forEach((plan) => {
    items.push(`
      <article class="stack-card shift-offer-card ${plan.status === "awaiting_courier_acceptance" ? "shift-offer-pending" : ""}">
        <div class="stack-top">
          <div>
            <strong>${plan.planDate} - ${plan.startTime} / ${plan.endTime}</strong>
            <p>${plan.zone} bolgesi vardiya plani</p>
            <p>${plan.status === "awaiting_courier_acceptance" ? shiftDeadlineText(plan.offerExpiresAt) : (plan.acceptedAt ? `Onay ${formatDate(plan.acceptedAt)}` : shiftPlanStatusLabel(plan.status))}</p>
          </div>
          <span class="soft-badge">${shiftPlanStatusLabel(plan.status)}</span>
        </div>
        ${plan.status === "awaiting_courier_acceptance" ? `<div class="stack-actions"><button class="primary-btn" type="button" data-shift-accept="${plan.id}">Vardiyayi Onayla</button></div>` : ""}
      </article>
    `);
  });

  courierRefs.shiftMetrics.innerHTML = items.join("");
  [...courierRefs.shiftMetrics.querySelectorAll("[data-shift-accept]")].forEach((button) => {
    button.addEventListener("click", async () => {
      const data = await api(`/api/courier/shift-plans/${button.dataset.shiftAccept}/accept`, {
        method: "POST",
        headers: authHeaders(courierState.token),
        body: "{}",
        retryWithRefresh: refreshCourierAccess,
      });
      hydrateCourierWorkspace(data);
      showToast("Vardiya plani onaylandi.");
    });
  });
}

function renderPackages(packages) {
  const activePackages = packages.filter(isActiveCourierPackage);
  const signature = listRenderSignature(activePackages, ["id", "trackingNo", "externalOrderNo", "status", "assignedAt", "paymentStatus", "failureReason", "updatedAt", "eta", "lastAssignmentError"]);
  if (courierRefs.packages.__deliveraRenderSignature === signature) {
    return;
  }
  courierRefs.packages.__deliveraRenderSignature = signature;
  courierRefs.packages.innerHTML = "";

  if (activePackages.length === 0) {
    return;
  }

  const fragment = document.createDocumentFragment();

  activePackages.forEach((pkg) => {
    const node = courierRefs.template.content.cloneNode(true);
    const badge = node.querySelector(".status-badge");
    const actions = node.querySelector(".card-actions");
    const assignedAtBadge = node.querySelector(".assigned-at-badge");
    const etaBadge = node.querySelector(".eta-badge");
    const failureBadge = node.querySelector(".failure-badge");
    const currentDraft = getPackageDraft(pkg.id);
    let selectedPaymentStatus = currentDraft.paymentStatus || pkg.paymentStatus || "";
    let selectedFailureReason = currentDraft.failureReason || "";

    node.querySelector(".tracking-no").innerHTML = `${COURIER_PACKAGE_ICON} ${escapeCourierHtml(pkg.trackingNo)} - ${escapeCourierHtml(pkg.platformOrderId || pkg.externalOrderNo)}`;
    node.querySelector(".recipient-name").textContent = `${pkg.recipient} - ${pkg.phone}`;
    node.querySelector(".platform-name").innerHTML = `${COURIER_PACKAGE_ICON} ${escapeCourierHtml(pkg.source === "external_manual" || pkg.source === "manual" ? "Manuel Paket" : (pkg.platform || pkg.sourcePlatform || "-"))} - Restoran Platform ID: ${escapeCourierHtml(pkg.platformRestaurantId || "-")}`;
    node.querySelector(".restaurant-name").innerHTML = `${COURIER_MOTO_ICON} ${escapeCourierHtml(pkg.restaurantName)} - ${escapeCourierHtml(pkg.restaurantId || "-")}`;
    node.querySelector(".zone-name").innerHTML = `${COURIER_PIN_ICON} ${escapeCourierHtml(pkg.zone)}`;
    node.querySelector(".eta-value").textContent = pkg.eta;
    node.querySelector(".payment-method").textContent = `${pkg.paymentMethod} - ${paymentStatusLabel(pkg.paymentStatus)} - ${formatCurrency(pkg.orderAmount)}`;
    node.querySelector(".address-value").innerHTML = `${COURIER_PIN_ICON} ${escapeCourierHtml(pkg.deliveryAddress || pkg.address)}`;
    node.querySelector(".note-text").textContent =
      `${pkg.note || "Ek not yok."} - Kayit ${formatDate(pkg.createdAt)}${pkg.failureReason ? ` - Sorun: ${pkg.failureReason}` : ""}`;

    const photoEl = node.querySelector(".order-photo");
    if (pkg.rawPayload && pkg.rawPayload.photoUrl) {
      photoEl.src = pkg.rawPayload.photoUrl;
      photoEl.classList.remove("hidden");
      photoEl.addEventListener("click", () => {
        const overlay = document.createElement("div");
        overlay.style.position = "fixed";
        overlay.style.top = "0";
        overlay.style.left = "0";
        overlay.style.width = "100%";
        overlay.style.height = "100%";
        overlay.style.backgroundColor = "rgba(0,0,0,0.8)";
        overlay.style.display = "flex";
        overlay.style.alignItems = "center";
        overlay.style.justifyContent = "center";
        overlay.style.zIndex = "9999";
        overlay.style.cursor = "pointer";
        
        const img = document.createElement("img");
        img.src = pkg.rawPayload.photoUrl;
        img.style.maxWidth = "90%";
        img.style.maxHeight = "90%";
        img.style.borderRadius = "8px";
        img.style.boxShadow = "0 4px 12px rgba(0,0,0,0.5)";
        
        overlay.appendChild(img);
        overlay.addEventListener("click", () => document.body.removeChild(overlay));
        document.body.appendChild(overlay);
      });
    }

    const offerWindowSeconds = pkg.status === "assigned" && pkg.assignedAt
      ? Math.max(0, 25 - Math.floor((Date.now() - new Date(pkg.assignedAt).getTime()) / 1000))
      : 0;
    assignedAtBadge.textContent = pkg.status === "assigned"
      ? `Teklif ${offerWindowSeconds} sn`
      : `Atama ${pkg.assignedAt ? formatTimeAgo(pkg.assignedAt) : "bekliyor"}`;
    etaBadge.textContent = `Teslim hedefi ${pkg.eta || "-"}`;

    if (pkg.failureReason) {
      failureBadge.textContent = `Sorun: ${courierFailureReasonLabel(pkg.failureReason)}`;
      failureBadge.classList.remove("hidden");
    } else {
      failureBadge.classList.add("hidden");
    }

    badge.textContent = statusLabel(pkg.status);
    badge.className = `status-badge ${statusClassName(pkg.status)}`;

    const submitStatus = async (status, failureReason = "", paymentStatus = "") => {
      if (status === "failed" && !failureReason) {
        showToast("Lutfen sorun nedenini sec.", "error");
        return;
      }
      try {
        const updatedWorkspace = await api(`/api/courier/packages/${pkg.id}/status`, {
          method: "PATCH",
          headers: authHeaders(courierState.token),
          body: JSON.stringify({ status, failureReason, paymentStatus }),
          retryWithRefresh: refreshCourierAccess,
        });
        courierState.packageActionDrafts.delete(pkg.id);
        hydrateCourierWorkspace(updatedWorkspace);
        showToast("Paket durumu güncellendi.");
      } catch (error) {
        showToast(error.message || "Durum güncellenemedi.", "error");
      }
    };

    actions.innerHTML = "";

    if (hasMapTarget(pkg.restaurantLat ?? pkg.latitude, pkg.restaurantLng ?? pkg.longitude, pkg.restaurantAddress || pkg.restaurantName || pkg.zone)) {
      const restaurantMapButton = document.createElement("button");
      restaurantMapButton.type = "button";
      restaurantMapButton.className = "ghost-btn courier-action-secondary courier-map-action";
      restaurantMapButton.textContent = "Restoran";
      restaurantMapButton.addEventListener("click", () => {
        openOrderMap(pkg, "restaurant");
      });
      actions.appendChild(restaurantMapButton);
    }

    if (hasMapTarget(pkg.customerLat ?? pkg.customerLatitude, pkg.customerLng ?? pkg.customerLongitude, pkg.customerAddress || pkg.deliveryAddress || pkg.address)) {
      const customerMapButton = document.createElement("button");
      customerMapButton.type = "button";
      customerMapButton.className = "ghost-btn courier-action-secondary courier-map-action";
      customerMapButton.textContent = "Musteri";
      customerMapButton.addEventListener("click", () => {
        openOrderMap(pkg, "customer");
      });
      actions.appendChild(customerMapButton);
    }

    if (pkg.status === "assigned") {
      const acceptButton = document.createElement("button");
      acceptButton.type = "button";
      acceptButton.className = "primary-btn courier-action-main";
      acceptButton.textContent = "Kabul Et";
      acceptButton.addEventListener("click", async () => {
        await submitStatus("accepted_by_courier");
      });
      actions.appendChild(acceptButton);
    }

    if (pkg.status === "accepted_by_courier") {
      const routeButton = document.createElement("button");
      routeButton.type = "button";
      routeButton.className = "primary-btn courier-action-main";
      routeButton.textContent = "Yola Ciktim";
      routeButton.addEventListener("click", async () => {
        await submitStatus("on_route");
      });
      actions.appendChild(routeButton);
    }

    if (pkg.status === "on_route") {
      const paymentSelect = document.createElement("select");
      paymentSelect.className = "status-select courier-action-select";
      paymentSelect.innerHTML = [
        '<option value="">Odeme durumunu sec</option>',
        '<option value="cash_collected">Nakit</option>',
        '<option value="credit_card">Kredi Kartı</option>',
        '<option value="paid_online">Online</option>',
      ].join("");
      if (["cash_collected", "credit_card", "paid_online"].includes(selectedPaymentStatus)) {
        paymentSelect.value = selectedPaymentStatus;
      }
      paymentSelect.addEventListener("change", () => {
        selectedPaymentStatus = paymentSelect.value;
        setPackageDraft(pkg.id, { paymentStatus: selectedPaymentStatus });
      });

      const deliveredButton = document.createElement("button");
      deliveredButton.type = "button";
      deliveredButton.className = "primary-btn delivered-action courier-action-delivered";
      deliveredButton.textContent = "Teslim Edildi";
      deliveredButton.addEventListener("click", async () => {
        if (!selectedPaymentStatus) {
          showToast("Teslim oncesi odeme durumunu sec.", "error");
          return;
        }
        await submitStatus("delivered", "", selectedPaymentStatus);
      });
      actions.appendChild(paymentSelect);
      actions.appendChild(deliveredButton);
    }

    if (["assigned", "accepted_by_courier", "on_route"].includes(pkg.status)) {
      const failureSelect = document.createElement("select");
      failureSelect.className = "status-select courier-action-select";
      failureSelect.innerHTML = ['<option value="">Sorun nedeni sec</option>']
        .concat(COURIER_FAILURE_REASON_OPTIONS.map((item) => `<option value="${item.value}">${item.label}</option>`))
        .join("");
      failureSelect.value = selectedFailureReason;
      failureSelect.addEventListener("change", () => {
        selectedFailureReason = failureSelect.value;
        setPackageDraft(pkg.id, { failureReason: selectedFailureReason });
      });

      const failureButton = document.createElement("button");
      failureButton.type = "button";
      failureButton.className = "ghost-btn courier-action-danger";
      failureButton.textContent = "Sorun Bildir";
      failureButton.addEventListener("click", async () => {
        await submitStatus("failed", selectedFailureReason);
      });

      actions.appendChild(failureSelect);
      actions.appendChild(failureButton);
    }

    fragment.appendChild(node);
  });

  courierRefs.packages.appendChild(fragment);
}

function renderCourierHistory(packages, historySource = null) {
  const sourcePackages = Array.isArray(historySource) ? historySource : packages;
  const filteredHistory = [...sourcePackages]
    .filter((pkg) => ["delivered", "failed", "cancelled"].includes(pkg.status))
    .filter((pkg) => packageMatchesHistoryRange(pkg, courierState.historyRange))
    .sort((left, right) => new Date(right.updatedAt || right.createdAt) - new Date(left.updatedAt || left.createdAt))
  const visibleHistoryPackages = filteredHistory.slice(0, courierState.historyVisibleCount);
  const signature = [
    courierState.historyRange,
    courierState.historyVisibleCount,
    filteredHistory.length,
    listRenderSignature(visibleHistoryPackages, ["id", "trackingNo", "recipient", "restaurantName", "deliveryAddress", "address", "status", "paymentStatus", "failureReason", "updatedAt", "deliveredAt", "failedAt"]),
  ].join("||");
  if (courierRefs.history.__deliveraRenderSignature === signature) {
    return;
  }
  courierRefs.history.__deliveraRenderSignature = signature;
  courierRefs.history.innerHTML = "";

  courierRefs.historyMeta.textContent = `${filteredHistory.length} kapanan teslimattan ${visibleHistoryPackages.length} kayit gorunuyor.`;
  courierRefs.historyMore.classList.toggle("hidden", visibleHistoryPackages.length >= filteredHistory.length);
  [...courierRefs.historyFilters.querySelectorAll("[data-range]")].forEach((button) => {
    button.classList.toggle("active", button.dataset.range === courierState.historyRange);
  });

  if (visibleHistoryPackages.length === 0) {
    courierRefs.history.innerHTML = '<div class="empty-state">Dun ve onceki gunlerden kapanan teslimat kaydi yok.</div>';
    return;
  }

  visibleHistoryPackages.forEach((pkg) => {
    const card = document.createElement("article");
    card.className = "stack-card courier-history-card";
    card.innerHTML = `
      <div class="stack-top courier-history-card__top">
        <div class="courier-history-card__summary">
          <strong>${pkg.trackingNo} - ${pkg.recipient}</strong>
          <p class="entity-line">${COURIER_MOTO_ICON} ${escapeCourierHtml(pkg.restaurantName)}</p>
          <p class="entity-line">${COURIER_PIN_ICON} ${escapeCourierHtml(pkg.deliveryAddress || pkg.address)}</p>
          <p>Kapanis: ${formatDate(pkg.updatedAt || pkg.deliveredAt || pkg.failedAt || pkg.createdAt)}</p>
        </div>
        <div class="courier-history-card__actions">
          <span class="soft-badge ${statusClassName(pkg.status)}">${statusLabel(pkg.status)}</span>
          <button class="primary-btn details-btn courier-history-card__details" type="button" data-package-id="${pkg.id}" aria-label="${pkg.trackingNo || "Siparis"} detayini goruntule">
            ${COURIER_PACKAGE_ICON} Detay
          </button>
        </div>
      </div>
      <div class="meta-grid compact-meta-grid">
        <div>
          <span>Odeme</span>
          <strong>${pkg.paymentMethod} - ${paymentStatusLabel(pkg.paymentStatus)} - ${formatCurrency(pkg.orderAmount)}</strong>
        </div>
        <div>
          <span>Sorun</span>
          <strong>${pkg.failureReason || "-"}</strong>
        </div>
      </div>
    `;
    card.querySelectorAll('.details-btn').forEach((button) => button.addEventListener('click', () => {
      window.openCourierPackageDetails(pkg);
    }));
    courierRefs.history.appendChild(card);
  });
}

function renderCourierNotifications(notifications) {
  renderNotificationCenter(courierRefs.notificationCenter, notifications || [], "Kurye icin bildirim yok.");
}

function renderCourierAnnouncements(items) {
  const announcements = (items || []).filter((item) => item.targetRole === "courier");
  const signature = listRenderSignature(announcements, ["id", "targetRole", "title", "message", "updatedAt", "createdAt"]);
  if (courierRefs.announcementList.__deliveraRenderSignature === signature) {
    return;
  }
  courierRefs.announcementList.__deliveraRenderSignature = signature;
  courierRefs.announcementList.innerHTML = "";

  if (!announcements.length) {
    courierRefs.announcementList.innerHTML = '<div class="empty-state compact-empty-state">Aktif admin duyurusu yok.</div>';
    return;
  }

  announcements.forEach((item) => {
    const card = document.createElement("article");
    card.className = "stack-card notification-card";
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <strong>${item.title}</strong>
          <p>${item.message}</p>
          <p>Yayin zamani ${formatDate(item.updatedAt || item.createdAt)}</p>
        </div>
        <span class="soft-badge">Aktif</span>
      </div>
    `;
    courierRefs.announcementList.appendChild(card);
  });
}

function renderCourierFocus(courier, packages) {
  const activePackages = packages.filter(isActiveCourierPackage);
  const priority = activePackages.find((pkg) => pkg.status === "on_route") || activePackages.find((pkg) => pkg.status === "accepted_by_courier") || activePackages[0] || null;
  courierState.focusPackage = priority;

  if (!priority) {
    courierRefs.focusCard?.classList.add("hidden");
    courierRefs.destinationMap?.classList.add("hidden");
    if (courierRefs.focusLabel) courierRefs.focusLabel.textContent = "Yeni Paket";
    courierRefs.focusTitle.textContent = courier.available ? "Yeni Paket Bekleniyor" : "Vardiya Kapali";
    courierRefs.focusText.textContent = courier.available
      ? "Paket dustugunde burada tek kart olarak gorunecek."
      : "Hazir oldugunda baglan, yeni paketler burada gorunsun.";
    if (courierRefs.mapTitle) courierRefs.mapTitle.textContent = "Harita bekleniyor";
    if (courierRefs.mapAddress) courierRefs.mapAddress.textContent = "Yeni paket geldiginde gidecegin adres burada gorunecek.";
    courierRefs.destinationMap?.classList.add("map-empty");
    courierRefs.mapButton?.setAttribute("disabled", "disabled");
    if (courierRefs.missionMeta) courierRefs.missionMeta.textContent = "Henuz aktif paket yok.";
    return;
  }

  courierRefs.focusCard?.classList.remove("hidden");
  courierRefs.destinationMap?.classList.remove("hidden");
  if (courierRefs.focusLabel) courierRefs.focusLabel.textContent = "Yeni Paket Dustu";
  courierRefs.focusTitle.textContent = `${priority.trackingNo} - ${priority.recipient}`;
  courierRefs.focusText.textContent = `${statusLabel(priority.status)} - ${priority.restaurantName} cikisli paket.`;
  if (courierRefs.mapTitle) courierRefs.mapTitle.textContent = priority.recipient || "Teslimat";
  if (courierRefs.mapAddress) courierRefs.mapAddress.textContent = priority.deliveryAddress || priority.address || "Adres bilgisi bekleniyor.";
  courierRefs.destinationMap?.classList.remove("map-empty");
  courierRefs.mapButton?.removeAttribute("disabled");
  if (courierRefs.missionMeta) courierRefs.missionMeta.textContent = `${activePackages.length} aktif paket, ${activePackages.filter((pkg) => pkg.status === "on_route").length} sahada.`;
}

function syncConnectionSwitch(courier = courierState.data?.courier) {
  if (!courierRefs.connectionSwitch) {
    return;
  }

  const connected = Boolean(courier?.available);
  courierRefs.connectionSwitch.checked = connected;
  courierRefs.connectionSwitch.disabled = courierState.connectionBusy;
  courierRefs.connectionSwitch.setAttribute("aria-checked", String(connected));
  if (courierRefs.connectionLabel) {
    courierRefs.connectionLabel.textContent = courierState.connectionBusy
      ? "İşleniyor..."
      : connected
        ? "Bağlantıyı Kes"
        : "Bağlan";
  }
}

function restoreCourierConnectionFromWorkspace(courier = courierState.data?.courier) {
  if (!courier || courierState.connectionBusy) {
    return;
  }

  if (courier.available) {
    startLocationWatch({
      latitude: courier.latitude,
      longitude: courier.longitude,
    });
    return;
  }

  stopLocationWatch();
}

function hydrateCourierWorkspace(data) {
  initializeCourierProfilePanels();
  processIncomingPackageNotifications(data.packages);
  clearResolvedPackageDrafts(data.packages);
  courierState.data = data;
  setLoggedIn(true);
  requestNotificationPermission();
  requestScreenWakeLock();
  startWorkspacePolling();
  startCourierLiveStream();
  courierRefs.name.textContent = data.courier.name;
  if (courierRefs.summary) {
    courierRefs.summary.textContent =
      `${data.courier.name} hesabinda ${data.packages.filter(isActiveCourierPackage).length} aktif paket var.`;
  }
  if (courierRefs.liveBadge) {
    courierRefs.liveBadge.textContent = "Canli akis acik";
  }
  restoreCourierConnectionFromWorkspace(data.courier);
  setShiftGreetingStatus(data.courier.available);
  syncConnectionSwitch(data.courier);
  renderCourierStats(data.courier, data.packages);
  renderCourierDayMetrics(data.dayMetrics);
  renderCourierEarnings(data.earningsSummary);
  renderCourierShiftSummary(data.shiftSummary);
  renderCourierFocus(data.courier, data.packages);
  renderPackages(data.packages);
  renderCourierHistory(data.packages, data.historyPackages);
  renderCourierNotifications(data.notifications || []);
  renderCourierAnnouncements(data.announcements || []);
}

courierRefs.historyFilters?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-range]");
  if (!button) {
    return;
  }
  courierState.historyRange = button.dataset.range;
  courierState.historyVisibleCount = 50;
  if (courierState.data) {
    renderCourierHistory(courierState.data.packages || [], courierState.data.historyPackages || null);
  }
});

courierRefs.historyMore?.addEventListener("click", () => {
  courierState.historyVisibleCount += 50;
  if (courierState.data) {
    renderCourierHistory(courierState.data.packages || [], courierState.data.historyPackages || null);
  }
});

courierRefs.mapButton?.addEventListener("click", () => {
  if (!courierState.focusPackage) {
    showToast("Once aktif paket gelsin.", "error");
    return;
  }
  openOrderMap(courierState.focusPackage, "customer");
});

async function pushCourierLocation(payload) {
  const isLocationOnlyUpdate =
    (typeof payload.latitude === "number" || typeof payload.longitude === "number") &&
    typeof payload.available !== "boolean";
  const data = await api("/api/courier/location", {
    method: "PATCH",
    headers: authHeaders(courierState.token),
    body: JSON.stringify(payload),
    retryWithRefresh: refreshCourierAccess,
  });
  if (isLocationOnlyUpdate) {
    if (courierState.data?.courier && data?.courier) {
      courierState.data = {
        ...courierState.data,
        courier: data.courier,
      };
    }
  } else {
    hydrateCourierWorkspace(data);
  }
  return data;
}

async function heartbeatCourierLocation() {
  if (!courierState.token || !courierState.data?.courier) {
    return;
  }

  const coords = courierState.lastCoords || {
    latitude: courierState.data.courier.latitude,
    longitude: courierState.data.courier.longitude,
  };

  try {
    await pushCourierLocation({
      ...coords,
      available: courierState.data.courier.available,
    });
    setShiftGreetingStatus(courierState.data?.courier?.available);
  } catch (error) {
    setLocationStatus(error.message);
  }
}

function handleLocationError(error) {
  const message = error?.code === 1
    ? "Konum izni reddedildi. Adminde canli takip icin tarayici izni vermen gerekiyor."
    : "Konum alinamadi. GPS veya tarayici ayarlarini kontrol et.";
  setLocationStatus(message);
}

function getCurrentCourierPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Bu cihazda konum desteği bulunmuyor."));
      return;
    }

    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      maximumAge: 1_000,
      timeout: 12_000,
    });
  });
}

function startLocationWatch(initialCoords = null) {
  if (!courierState.token) {
    return;
  }

  if (!navigator.geolocation) {
    setLocationStatus("Bu cihazda geolocation desteklenmiyor.");
    return false;
  }

  if (courierState.watchId !== null) {
    setShiftGreetingStatus(true);
    return true;
  }

  if (initialCoords) {
    courierState.lastCoords = initialCoords;
  }

  courierState.watchId = navigator.geolocation.watchPosition(
    async (position) => {
      const coords = {
        latitude: Number(position.coords.latitude.toFixed(6)),
        longitude: Number(position.coords.longitude.toFixed(6)),
      };
      const last = courierState.lastCoords;
      const moved =
        !last ||
        Math.abs(last.latitude - coords.latitude) > 0.00005 ||
        Math.abs(last.longitude - coords.longitude) > 0.00005;

      courierState.lastCoords = coords;
      setShiftGreetingStatus(courierState.data?.courier?.available ?? true);
      try {
        await pushCourierLocation({
          ...coords,
          available: courierState.data?.courier?.available ?? true,
        });
      } catch (error) {
        setLocationStatus(error.message);
      }
    },
    handleLocationError,
    {
      enableHighAccuracy: true,
      maximumAge: 1_000,
      timeout: 12_000,
    }
  );

  courierState.heartbeatId = window.setInterval(() => {
    heartbeatCourierLocation();
  }, LOCATION_PUSH_MS);
  return true;
}

async function setCourierConnection(connected) {
  if (courierState.connectionBusy || !courierState.data?.courier) {
    syncConnectionSwitch();
    return;
  }

  courierState.connectionBusy = true;
  syncConnectionSwitch();

  try {
    if (connected) {
      setLocationStatus("Konum izni isteniyor...");
      const position = await getCurrentCourierPosition();
      const coords = {
        latitude: Number(position.coords.latitude.toFixed(6)),
        longitude: Number(position.coords.longitude.toFixed(6)),
      };
      courierState.lastCoords = coords;
      const data = await pushCourierLocation({ ...coords, available: true });
      startLocationWatch(coords);
      hydrateCourierWorkspace(data);
      setShiftGreetingStatus(true);
      showToast("Baglanti acildi. Konum ve vardiya aktif.", "success");
    } else {
      stopLocationWatch();
      const courier = courierState.data.courier;
      const coords = courierState.lastCoords || {
        latitude: courier.latitude,
        longitude: courier.longitude,
      };
      const data = await pushCourierLocation({ ...coords, available: false });
      hydrateCourierWorkspace(data);
      setShiftGreetingStatus(false);
      showToast("Baglanti kapatildi. Vardiya bitirildi.", "success");
    }
  } catch (error) {
    if (connected) {
      stopLocationWatch();
    } else if (courierState.data?.courier?.available) {
      startLocationWatch(courierState.lastCoords);
    }
    const message = error?.code === 1
      ? "Konum izni reddedildi. Baglanti acilamadi."
      : error.message || "Baglanti durumu degistirilemedi.";
    setLocationStatus(message);
    showToast(message, "error");
  } finally {
    courierState.connectionBusy = false;
    syncConnectionSwitch();
  }
}

async function loadCourierWorkspace(options = {}) {
  if (!courierState.token) {
    if (courierState.refreshToken) {
      try {
        await refreshCourierAccess();
      } catch {
        clearCourierAuth();
      }
    }
  }

  if (!courierState.token) {
    setLoggedIn(false);
    return;
  }

  const now = Date.now();
  if (options.silent && !options.force && now - courierState.lastWorkspaceLoadAt < 1500) {
    return;
  }
  courierState.lastWorkspaceLoadAt = now;

  try {
    const params = new URLSearchParams({
      limit: String(courierState.packageLimit),
      cursor: courierState.packageCursor || "0",
    });
    const data = await api(`/api/courier/me?${params.toString()}`, {
      headers: authHeaders(courierState.token),
      retryWithRefresh: refreshCourierAccess,
    });
    hydrateCourierWorkspace(data);
  } catch (error) {
    if (error.message.includes("Oturum") || error.message.includes("Kurye bulunamadi") || error.message.includes("refresh")) {
      clearCourierAuth();
      stopWorkspacePolling();
      setLoggedIn(false);
      if (!options.silent && courierRefs.summary) {
        courierRefs.summary.textContent = error.message;
      }
    }
    if (courierRefs.liveBadge) {
      courierRefs.liveBadge.textContent = "Bağlantı koptu, tekrar deneniyor...";
    }
  }
}

courierRefs.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const formData = new FormData(courierRefs.loginForm);
    const data = await api("/api/courier/login", {
      method: "POST",
      body: JSON.stringify({
        username: formData.get("username"),
        password: formData.get("password"),
      }),
    });
    persistCourierAuth(data);
    const workspace = await api("/api/courier/me", {
      headers: authHeaders(courierState.token),
      retryWithRefresh: refreshCourierAccess,
    });
    courierRefs.loginForm.reset();
    hydrateCourierWorkspace(workspace);
  } catch (error) {
    showToast(error.message || "Giris basarisiz oldu.", "error");
  }
});

courierRefs.connectionSwitch?.addEventListener("change", async (event) => {
  await setCourierConnection(event.currentTarget.checked);
});

courierRefs.dayCloseButton?.addEventListener("click", async () => {
  if (!courierState.token) {
    return;
  }
  const data = await api("/api/courier/day-close", {
    method: "POST",
    headers: authHeaders(courierState.token),
    body: "{}",
    retryWithRefresh: refreshCourierAccess,
  });
  hydrateCourierWorkspace(data);
  showToast(`Gun sonu raporu olustu. Toplam ciro ${formatCurrency(data.dayCloseReport?.totalAmount)}.`, "success");
});

courierRefs.logoutButton?.addEventListener("click", async () => {
  try {
    if (courierState.token) {
      await pushCourierLocation({
        available: false,
        latitude: courierState.data?.courier?.latitude,
        longitude: courierState.data?.courier?.longitude,
      });
    }
  } catch {
    // Logout should still continue even if the network write fails.
  }

  stopLocationWatch();
  stopWorkspacePolling();
  if (courierState.refreshToken) {
    api("/api/courier/logout", {
      method: "POST",
      headers: authHeaders(courierState.token),
      body: JSON.stringify({ refreshToken: courierState.refreshToken }),
    }).catch(() => {
      // Local cleanup should still continue.
    });
  }
  clearCourierAuth();
  setLoggedIn(false);
  setShiftGreetingStatus(false);
  if (courierRefs.summary) {
    courierRefs.summary.textContent = "Cikis yapildi.";
  }
  if (courierRefs.liveBadge) {
    courierRefs.liveBadge.textContent = "Canli akis kapali";
  }
});

if (courierRefs.profileSettingsButton) {
  courierRefs.profileSettingsButton.addEventListener("click", () => {
    if (courierState.data?.courier) {
      courierRefs.profileForm.elements["username"].value = courierState.data.courier.username;
      courierRefs.profileForm.elements["password"].value = "";
    }
    courierRefs.profileModal?.showModal();
  });
}

if (courierRefs.profileModal) {
  courierRefs.profileModal.querySelector(".close-modal-btn").addEventListener("click", () => {
    courierRefs.profileModal.close();
  });
}

if (courierRefs.profileForm) {
  courierRefs.profileForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(courierRefs.profileForm);
    const payload = {
      username: formData.get("username"),
      password: formData.get("password"),
    };
    try {
      await api("/api/courier/me/credentials", {
        method: "PUT",
        headers: authHeaders(courierState.token),
        body: JSON.stringify(payload),
        retryWithRefresh: refreshCourierAccess,
      });
      courierRefs.profileModal.close();
      showToast("Profil basariyla guncellendi.");
      if (payload.username && courierState.data?.courier) {
        courierState.data.courier.username = payload.username;
      }
    } catch (err) {
      showToast(err.message || "Guncellenirken hata olustu", "error");
    }
  });
}

window.addEventListener("beforeunload", stopLocationWatch);
window.addEventListener("beforeunload", stopWorkspacePolling);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    requestScreenWakeLock();
  }
});

loadCourierWorkspace();
