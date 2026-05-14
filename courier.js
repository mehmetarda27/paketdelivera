const STORAGE_TOKEN_KEY = "kuryeTakipCourierToken";
const STORAGE_REFRESH_TOKEN_KEY = "kuryeTakipCourierRefreshToken";
const LOCATION_PUSH_MS = 2_000;
const WORKSPACE_POLL_MS = 12_000;

const courierState = {
  token: localStorage.getItem(STORAGE_TOKEN_KEY) || "",
  refreshToken: localStorage.getItem(STORAGE_REFRESH_TOKEN_KEY) || "",
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
  activeProfileSection: "day-close",
};

const COURIER_FAILURE_REASON_OPTIONS = [
  { value: "musteri_yok", label: "Musteri yok" },
  { value: "adres_bulunamadi", label: "Adres bulunamadi" },
  { value: "restoran_hazir_degil", label: "Restoran hazir degil" },
  { value: "teknik_sorun", label: "Teknik sorun" },
  { value: "diger", label: "Diger" },
];

function courierFailureReasonLabel(reason) {
  return COURIER_FAILURE_REASON_OPTIONS.find((item) => item.value === reason)?.label || reason || "Sorun yok";
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
  shareLocationButton: document.getElementById("shareLocationButton"),
  availabilityButton: document.getElementById("availabilityButton"),
  locationStatus: document.getElementById("locationStatus"),
  name: document.getElementById("courierName"),
  focusTitle: document.getElementById("courierFocusTitle"),
  focusText: document.getElementById("courierFocusText"),
  missionMeta: document.getElementById("courierMissionMeta"),
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
};

function persistCourierAuth(auth) {
  courierState.token = auth.token;
  courierState.refreshToken = auth.refreshToken;
  localStorage.setItem(STORAGE_TOKEN_KEY, auth.token);
  localStorage.setItem(STORAGE_REFRESH_TOKEN_KEY, auth.refreshToken);
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
  localStorage.removeItem(STORAGE_TOKEN_KEY);
  localStorage.removeItem(STORAGE_REFRESH_TOKEN_KEY);
}

async function refreshCourierAccess() {
  if (!courierState.refreshToken) {
    throw new Error("Kurye refresh token bulunamadi.");
  }

  const auth = await api("/api/courier/refresh", {
    method: "POST",
    body: JSON.stringify({
      refreshToken: courierState.refreshToken,
    }),
  });
  persistCourierAuth(auth);
}

function setLoggedIn(isLoggedIn) {
  courierRefs.loginPanel.classList.toggle("hidden", isLoggedIn);
  courierRefs.workspacePanel.classList.toggle("hidden", !isLoggedIn);
}

function setLocationStatus(message) {
  courierRefs.locationStatus.textContent = message;
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
  const activePackages = packages.filter((pkg) => !["delivered", "failed", "cancelled"].includes(pkg.status));

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
  const activeIds = new Set((packages || []).filter((pkg) => !["delivered", "failed", "cancelled"].includes(pkg.status)).map((pkg) => pkg.id));
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
  courierRefs.stats.innerHTML = "";

  const delivered = packages.filter((pkg) => pkg.status === "delivered").length;
  const inTransit = packages.filter((pkg) => pkg.status === "accepted_by_courier" || pkg.status === "on_route").length;

  courierRefs.stats.innerHTML = `
    <article class="mini-stat-card">
      <span>Bolge</span>
      <strong>${courier.zone}</strong>
    </article>
    <article class="mini-stat-card">
      <span>Kullanici</span>
      <strong>${courier.username}</strong>
    </article>
    <article class="mini-stat-card">
      <span>Aktif Yuk</span>
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
      <span>Durum</span>
      <strong>${courierStatusLabel(courier.status)}</strong>
    </article>
    <article class="mini-stat-card">
      <span>Canli GPS</span>
      <strong class="gps-stat">${locationLabel(courier)}</strong>
    </article>
  `;
}

function renderCourierDayMetrics(dayMetrics) {
  courierRefs.dayMetrics.innerHTML = "";
  const metrics = dayMetrics || {
    deliveredCount: 0,
    totalAmount: 0,
    paidOnlineAmount: 0,
    cashCollectedAmount: 0,
    hasClosedDay: false,
    closedAt: null,
  };

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
    today: { deliveredCount: 0, totalAmount: 0, paidOnlineAmount: 0, cashAmount: 0 },
    yesterday: { deliveredCount: 0, totalAmount: 0, paidOnlineAmount: 0, cashAmount: 0 },
    last7Days: { deliveredCount: 0, totalAmount: 0, paidOnlineAmount: 0, cashAmount: 0 },
    total: { deliveredCount: 0, totalAmount: 0, paidOnlineAmount: 0, cashAmount: 0 },
  };

  courierRefs.earningsMetrics.innerHTML = `
    <article class="mini-stat-card">
      <span>Bugun</span>
      <strong>${formatCurrency(data.today.totalAmount)}</strong>
    </article>
    <article class="mini-stat-card">
      <span>Dun</span>
      <strong>${formatCurrency(data.yesterday.totalAmount)}</strong>
    </article>
    <article class="mini-stat-card">
      <span>Son 7 Gun</span>
      <strong>${formatCurrency(data.last7Days.totalAmount)}</strong>
    </article>
    <article class="mini-stat-card">
      <span>Toplam Teslimat</span>
      <strong>${data.total.deliveredCount}</strong>
    </article>
    <article class="mini-stat-card">
      <span>Nakit / Online</span>
      <strong>${formatCurrency(data.total.cashAmount)} / ${formatCurrency(data.total.paidOnlineAmount)}</strong>
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
  courierRefs.packages.innerHTML = "";
  const activePackages = packages.filter((pkg) => !["delivered", "failed", "cancelled"].includes(pkg.status));

  if (activePackages.length === 0) {
    courierRefs.packages.innerHTML = '<div class="empty-state">Bu kuryeye atanmis paket yok.</div>';
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

    node.querySelector(".tracking-no").textContent = `${pkg.trackingNo} - ${pkg.externalOrderNo}`;
    node.querySelector(".recipient-name").textContent = `${pkg.recipient} - ${pkg.phone}`;
    node.querySelector(".platform-name").textContent = pkg.source === "external_manual" || pkg.source === "manual"
      ? "Manuel Paket"
      : pkg.sourcePlatform;
    node.querySelector(".restaurant-name").textContent = pkg.restaurantName;
    node.querySelector(".zone-name").textContent = `${pkg.zone} - ${pkg.address}`;
    node.querySelector(".eta-value").textContent = pkg.eta;
    node.querySelector(".payment-method").textContent = `${pkg.paymentMethod} - ${paymentStatusLabel(pkg.paymentStatus)} - ${formatCurrency(pkg.orderAmount)}`;
    node.querySelector(".address-value").textContent = pkg.deliveryAddress || pkg.address;
    node.querySelector(".note-text").textContent =
      `${pkg.note || "Ek not yok."} - Kayit ${formatDate(pkg.createdAt)}${pkg.failureReason ? ` - Sorun: ${pkg.failureReason}` : ""}`;
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
      const data = await api(`/api/courier/packages/${pkg.id}/status`, {
        method: "PATCH",
        headers: authHeaders(courierState.token),
        body: JSON.stringify({ status, failureReason, paymentStatus }),
        retryWithRefresh: refreshCourierAccess,
      });
      courierState.packageActionDrafts.delete(pkg.id);
      hydrateCourierWorkspace(data);
    };

    actions.innerHTML = "";

    if (hasMapTarget(pkg.restaurantLat ?? pkg.latitude, pkg.restaurantLng ?? pkg.longitude, pkg.restaurantAddress || pkg.restaurantName || pkg.zone)) {
      const restaurantMapButton = document.createElement("button");
      restaurantMapButton.type = "button";
      restaurantMapButton.className = "ghost-btn";
      restaurantMapButton.textContent = "Restorani Haritada Ac";
      restaurantMapButton.addEventListener("click", () => {
        openOrderMap(pkg, "restaurant");
      });
      actions.appendChild(restaurantMapButton);
    }

    if (hasMapTarget(pkg.customerLat ?? pkg.customerLatitude, pkg.customerLng ?? pkg.customerLongitude, pkg.customerAddress || pkg.deliveryAddress || pkg.address)) {
      const customerMapButton = document.createElement("button");
      customerMapButton.type = "button";
      customerMapButton.className = "ghost-btn";
      customerMapButton.textContent = "Musteriyi Haritada Ac";
      customerMapButton.addEventListener("click", () => {
        openOrderMap(pkg, "customer");
      });
      actions.appendChild(customerMapButton);
    }

    if (pkg.status === "assigned") {
      const acceptButton = document.createElement("button");
      acceptButton.type = "button";
      acceptButton.className = "primary-btn";
      acceptButton.textContent = "Paketi Kabul Et";
      acceptButton.addEventListener("click", async () => {
        await submitStatus("accepted_by_courier");
      });
      actions.appendChild(acceptButton);
    }

    if (pkg.status === "accepted_by_courier") {
      const routeButton = document.createElement("button");
      routeButton.type = "button";
      routeButton.className = "primary-btn";
      routeButton.textContent = "Yola Ciktim";
      routeButton.addEventListener("click", async () => {
        await submitStatus("on_route");
      });
      actions.appendChild(routeButton);
    }

    if (pkg.status === "on_route") {
      const paymentSelect = document.createElement("select");
      paymentSelect.className = "status-select";
      paymentSelect.innerHTML = [
        '<option value="">Odeme durumunu sec</option>',
        '<option value="cash_collected">Nakit Alindi</option>',
        '<option value="paid_online">Online Odendi</option>',
        '<option value="payment_issue">Odeme Sorunu</option>',
      ].join("");
      if (["cash_collected", "paid_online", "payment_issue"].includes(selectedPaymentStatus)) {
        paymentSelect.value = selectedPaymentStatus;
      }
      paymentSelect.addEventListener("change", () => {
        selectedPaymentStatus = paymentSelect.value;
        setPackageDraft(pkg.id, { paymentStatus: selectedPaymentStatus });
      });

      const deliveredButton = document.createElement("button");
      deliveredButton.type = "button";
      deliveredButton.className = "primary-btn";
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
      failureSelect.className = "status-select";
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
      failureButton.className = "ghost-btn";
      failureButton.textContent = "Reddet / Sorun Bildir";
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

function renderCourierHistory(packages) {
  courierRefs.history.innerHTML = "";
  const filteredHistory = [...packages]
    .filter((pkg) => ["delivered", "failed", "cancelled"].includes(pkg.status))
    .filter((pkg) => packageMatchesHistoryRange(pkg, courierState.historyRange))
    .sort((left, right) => new Date(right.updatedAt || right.createdAt) - new Date(left.updatedAt || left.createdAt))
  const historyPackages = filteredHistory.slice(0, courierState.historyVisibleCount);

  courierRefs.historyMeta.textContent = `${filteredHistory.length} kapanan teslimattan ${historyPackages.length} kayit gorunuyor.`;
  courierRefs.historyMore.classList.toggle("hidden", historyPackages.length >= filteredHistory.length);
  [...courierRefs.historyFilters.querySelectorAll("[data-range]")].forEach((button) => {
    button.classList.toggle("active", button.dataset.range === courierState.historyRange);
  });

  if (historyPackages.length === 0) {
    courierRefs.history.innerHTML = '<div class="empty-state">Dun ve onceki gunlerden kapanan teslimat kaydi yok.</div>';
    return;
  }

  historyPackages.forEach((pkg) => {
    const card = document.createElement("article");
    card.className = "stack-card";
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <strong>${pkg.trackingNo} - ${pkg.recipient}</strong>
          <p>${pkg.restaurantName} - ${pkg.deliveryAddress || pkg.address}</p>
          <p>Kapanis: ${formatDate(pkg.updatedAt || pkg.deliveredAt || pkg.failedAt || pkg.createdAt)}</p>
        </div>
        <span class="soft-badge">${statusLabel(pkg.status)}</span>
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
    courierRefs.history.appendChild(card);
  });
}

function renderCourierNotifications(notifications) {
  renderNotificationCenter(courierRefs.notificationCenter, notifications || [], "Kurye icin bildirim yok.");
}

function renderCourierAnnouncements(items) {
  courierRefs.announcementList.innerHTML = "";
  const announcements = (items || []).filter((item) => item.targetRole === "courier");

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
  const priority = packages.find((pkg) => pkg.status === "on_route") || packages.find((pkg) => pkg.status === "accepted_by_courier") || packages[0] || null;

  if (!priority) {
    courierRefs.focusTitle.textContent = courier.available ? "Yeni gorev bekleniyor." : "Kurye pasif durumda.";
    courierRefs.focusText.textContent = courier.available
      ? "Konum acik ve atamaya hazirsin. Yeni paket geldiginde burada ilk durak gorunecek."
      : "Pasif modda oldugun icin yeni paket dusmez. Hazir oldugunda tekrar aktif yap.";
    courierRefs.missionMeta.textContent = "Henuz aktif paket yok.";
    return;
  }

  courierRefs.focusTitle.textContent = `${priority.recipient} - ${statusLabel(priority.status)}`;
  courierRefs.focusText.textContent = `${priority.restaurantName} cikisli teslimat. ${priority.zone} bolgesi, odeme ${priority.paymentMethod}.`;
  courierRefs.missionMeta.textContent = `${packages.length} aktif paket, ${packages.filter((pkg) => pkg.status === "on_route").length} sahada.`;
}

function syncAvailabilityButton(courier) {
  courierRefs.availabilityButton.textContent = courier.available ? "Pasife Al" : "Aktife Al";
}

function hydrateCourierWorkspace(data) {
  initializeCourierProfilePanels();
  processIncomingPackageNotifications(data.packages);
  clearResolvedPackageDrafts(data.packages);
  courierState.data = data;
  setLoggedIn(true);
  requestNotificationPermission();
  startWorkspacePolling();
  startCourierLiveStream();
  courierRefs.name.textContent = data.courier.name;
  courierRefs.summary.textContent =
    `${data.courier.name} hesabinda ${data.packages.filter((pkg) => !["delivered", "failed", "cancelled"].includes(pkg.status)).length} aktif paket var.`;
  if (courierRefs.liveBadge) {
    courierRefs.liveBadge.textContent = "Canli akis acik";
  }
  setLocationStatus(data.courier.lastLocationAt ? `Canli konum aktif. Son guncelleme ${formatTimeAgo(data.courier.lastLocationAt)}.` : "Konum izni verilirse admin paneli seni canli gorur.");
  syncAvailabilityButton(data.courier);
  renderCourierStats(data.courier, data.packages);
  renderCourierDayMetrics(data.dayMetrics);
  renderCourierEarnings(data.earningsSummary);
  renderCourierShiftSummary(data.shiftSummary);
  renderCourierFocus(data.courier, data.packages);
  renderPackages(data.packages);
  renderCourierHistory(data.packages);
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
    renderCourierHistory(courierState.data.packages || []);
  }
});

courierRefs.historyMore?.addEventListener("click", () => {
  courierState.historyVisibleCount += 50;
  if (courierState.data) {
    renderCourierHistory(courierState.data.packages || []);
  }
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
    setLocationStatus(`Canli konum 2 saniyede bir guncelleniyor. Son sinyal ${formatTimeAgo(new Date().toISOString())}.`);
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

function startLocationWatch() {
  if (!courierState.token) {
    return;
  }

  if (!navigator.geolocation) {
    setLocationStatus("Bu cihazda geolocation desteklenmiyor.");
    return;
  }

  if (courierState.watchId !== null) {
    setLocationStatus("Canli konum zaten acik.");
    return;
  }

  setLocationStatus("Konum izni isteniyor...");

  courierState.heartbeatId = window.setInterval(() => {
    heartbeatCourierLocation();
  }, LOCATION_PUSH_MS);

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
      setLocationStatus(moved ? "Canli konum admine gonderiliyor..." : "Konum sabit, heartbeat gonderiliyor...");
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
  clearCourierAuth();
  stopWorkspacePolling();
  setLoggedIn(false);
  if (courierRefs.liveBadge) {
    courierRefs.liveBadge.textContent = "Canli akis kapali";
  }
  if (!options.silent) {
    courierRefs.summary.textContent = error.message;
  }
  }
}

courierRefs.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
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
});

courierRefs.shareLocationButton?.addEventListener("click", () => {
  startLocationWatch();
});

courierRefs.availabilityButton?.addEventListener("click", async () => {
  if (!courierState.data?.courier) {
    return;
  }

  const nextAvailable = !courierState.data.courier.available;
  const data = await pushCourierLocation({
    available: nextAvailable,
    latitude: courierState.data.courier.latitude,
    longitude: courierState.data.courier.longitude,
  });
  setLocationStatus(nextAvailable ? "Kurye atamaya acildi." : "Kurye pasife alindi. Yeni paket dusmeyecek.");
  hydrateCourierWorkspace(data);
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
  setLocationStatus("Konum kapatildi.");
  courierRefs.summary.textContent = "Cikis yapildi.";
  if (courierRefs.liveBadge) {
    courierRefs.liveBadge.textContent = "Canli akis kapali";
  }
});

window.addEventListener("beforeunload", stopLocationWatch);
window.addEventListener("beforeunload", stopWorkspacePolling);

loadCourierWorkspace();
