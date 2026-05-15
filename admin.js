const ADMIN_TOKEN_KEY = "deliveraAdminToken";
const ADMIN_REFRESH_TOKEN_KEY = "deliveraAdminRefreshToken";
const ADMIN_REFRESH_MS = 20_000;

const adminState = {
  data: null,
  token: localStorage.getItem(ADMIN_TOKEN_KEY) || "",
  refreshToken: localStorage.getItem(ADMIN_REFRESH_TOKEN_KEY) || "",
  selectedRestaurantId: "",
  packageLimit: 100,
  packageCursor: "0",
  liveStream: null,
  activeWorkspaceCard: "admin-announcements",
};

const adminRefs = {
  summary: document.getElementById("adminSummary"),
  loginPanel: document.getElementById("adminLoginPanel"),
  workspace: document.getElementById("adminWorkspace"),
  loginForm: document.getElementById("adminLoginForm"),
  logoutButton: document.getElementById("adminLogoutButton"),
  activeCouriers: document.getElementById("activeCouriers"),
  waitingPackages: document.getElementById("waitingPackages"),
  inTransitPackages: document.getElementById("inTransitPackages"),
  totalPackages: document.getElementById("totalPackages"),
  availableCourierCount: document.getElementById("availableCourierCount"),
  busyCourierCount: document.getElementById("busyCourierCount"),
  offlineCourierCount: document.getElementById("offlineCourierCount"),
  queueMode: document.getElementById("queueMode"),
  rateLimitStore: document.getElementById("rateLimitStore"),
  failedWebhookCount: document.getElementById("failedWebhookCount"),
  lastSystemError: document.getElementById("lastSystemError"),
  selectedRestaurantTitle: document.getElementById("selectedRestaurantTitle"),
  packagePanelTitle: document.getElementById("packagePanelTitle"),
  liveBadge: document.getElementById("adminLiveBadge"),
  notificationCenter: document.getElementById("adminNotificationCenter"),
  announcementForm: document.getElementById("announcementForm"),
  clearAnnouncementsButton: document.getElementById("clearAnnouncementsButton"),
  announcementList: document.getElementById("announcementList"),
  restaurantStatsBoard: document.getElementById("restaurantStatsBoard"),
  restaurantForm: document.getElementById("restaurantForm"),
  restaurantZone: document.getElementById("restaurantZone"),
  platformChecks: document.getElementById("platformChecks"),
  courierForm: document.getElementById("courierForm"),
  courierZone: document.getElementById("courierZone"),
  shiftPlanForm: document.getElementById("shiftPlanForm"),
  shiftPlanCourier: document.getElementById("shiftPlanCourier"),
  shiftPlanDate: document.getElementById("shiftPlanDate"),
  shiftPlanSummary: document.getElementById("shiftPlanSummary"),
  shiftPlanList: document.getElementById("shiftPlanList"),
  cashReconciliationList: document.getElementById("cashReconciliationList"),
  courierList: document.getElementById("courierList"),
  zoneBoard: document.getElementById("zoneBoard"),
  zoneAlertList: document.getElementById("zoneAlertList"),
  packageList: document.getElementById("packageList"),
  awaitingPackageList: document.getElementById("awaitingPackageList"),
  activeCourierOpsList: document.getElementById("activeCourierOpsList"),
  webhookLogList: document.getElementById("webhookLogList"),
  platformHealthSummary: document.getElementById("platformHealthSummary"),
  platformHealthList: document.getElementById("platformHealthList"),
  auditLogList: document.getElementById("auditLogList"),
  courierDailyReportList: document.getElementById("courierDailyReportList"),
  restaurantFilter: document.getElementById("restaurantFilter"),
  searchInput: document.getElementById("searchInput"),
  template: document.getElementById("adminPackageTemplate"),
};

function adminHeaders() {
  return authHeaders(adminState.token);
}

function htmlSafe(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function persistAdminAuth(auth) {
  adminState.token = auth.token;
  adminState.refreshToken = auth.refreshToken;
  localStorage.setItem(ADMIN_TOKEN_KEY, auth.token);
  localStorage.setItem(ADMIN_REFRESH_TOKEN_KEY, auth.refreshToken);
}

function clearAdminAuth() {
  adminState.token = "";
  adminState.refreshToken = "";
  adminState.data = null;
  adminState.selectedRestaurantId = "";
  adminState.liveStream?.close?.();
  adminState.liveStream = null;
  localStorage.removeItem(ADMIN_TOKEN_KEY);
  localStorage.removeItem(ADMIN_REFRESH_TOKEN_KEY);
}

async function refreshAdminAccess() {
  if (!adminState.refreshToken) {
    throw new Error("Admin refresh token bulunamadi.");
  }

  const auth = await api("/api/admin/refresh", {
    method: "POST",
    body: JSON.stringify({
      refreshToken: adminState.refreshToken,
    }),
  });
  persistAdminAuth(auth);
}

function renderPlatformChecks() {
  adminRefs.platformChecks.innerHTML = PLATFORM_OPTIONS.map((platform) => `
    <label class="chip-option">
      <input type="checkbox" name="platforms" value="${platform}">
      <span>${platform}</span>
    </label>
  `).join("");
}

function setAdminLoggedIn(isLoggedIn) {
  adminRefs.loginPanel.classList.toggle("hidden", isLoggedIn);
  adminRefs.workspace.classList.toggle("hidden", !isLoggedIn);
}

function syncAdminWorkspaceCards() {
  const cards = [...document.querySelectorAll(".workspace-collapsible-admin")];
  cards.forEach((card) => {
    const isActive = card.dataset.cardKey === adminState.activeWorkspaceCard;
    card.classList.toggle("panel-expanded", isActive);
    card.classList.toggle("panel-collapsed", !isActive);
    const header = card.querySelector(".panel-head");
    if (header) {
      header.setAttribute("aria-expanded", isActive ? "true" : "false");
    }
  });
}

function initializeAdminWorkspaceCards() {
  const cardMap = [
    ["#adminWorkspace > section:nth-of-type(3)", "admin-restaurant-focus"],
    ["#adminWorkspace > section:nth-of-type(4)", "admin-announcements"],
    ["#adminWorkspace > section:nth-of-type(5)", "admin-notifications"],
    ["#adminWorkspace > section:nth-of-type(6) > article:nth-of-type(1)", "admin-restaurant-form"],
    ["#adminWorkspace > section:nth-of-type(6) > article:nth-of-type(2)", "admin-courier-form"],
    ["#adminWorkspace > section:nth-of-type(6) > article:nth-of-type(3)", "admin-zone-board"],
    ["#adminWorkspace > section:nth-of-type(6) > article:nth-of-type(4)", "admin-zone-alerts"],
    ["#adminWorkspace > section:nth-of-type(9) > article:nth-of-type(1)", "admin-shift-plan"],
    ["#adminWorkspace > section:nth-of-type(9) > article:nth-of-type(2)", "admin-cash"],
    ["#adminWorkspace > section:nth-of-type(10)", "admin-webhooks"],
    ["#adminWorkspace > section:nth-of-type(11)", "admin-platform-health"],
    ["#adminWorkspace > section:nth-of-type(12)", "admin-audit"],
    ["#adminWorkspace > section:nth-of-type(13)", "admin-day-close"],
  ];

  cardMap.forEach(([selector, key]) => {
    const card = document.querySelector(selector);
    if (!card) {
      return;
    }

    card.dataset.cardKey = key;
    card.classList.add("workspace-collapsible", "workspace-collapsible-admin");

    const header = card.querySelector(".panel-head");
    if (!header || header.dataset.bound === "1") {
      return;
    }

    header.dataset.bound = "1";
    header.classList.add("panel-toggle-head");
    header.tabIndex = 0;
    header.setAttribute("role", "button");

    const activate = () => {
      adminState.activeWorkspaceCard = adminState.activeWorkspaceCard === key ? "" : key;
      syncAdminWorkspaceCards();
    };

    header.addEventListener("click", (event) => {
      if (event.target.closest("button, select, input, textarea, a, label")) {
        return;
      }
      activate();
    });

    header.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      activate();
    });
  });

  syncAdminWorkspaceCards();
}

function startAdminLiveStream() {
  if (adminState.liveStream || !adminState.token) {
    return;
  }

  adminState.liveStream = connectLiveStream("/api/admin/stream", adminState.token, {
    onMessage(event) {
      if (event?.message) {
        showToast(event.message, notificationTone(event.type));
        if (event.type === "assignment-waiting") {
          playSignal("critical");
        } else if (event.type === "package-assigned" || event.type === "platform-order-pending") {
          playSignal("assignment");
        } else if (event.type === "package-status") {
          playSignal("ready");
        }
      }
      loadAdminState().catch(() => {});
    },
    onError() {
      if (adminRefs.liveBadge) {
        adminRefs.liveBadge.textContent = "Canli akis tekrar baglaniyor";
      }
      adminState.liveStream?.close?.();
      adminState.liveStream = null;
      window.setTimeout(() => startAdminLiveStream(), 2000);
    },
  });
}

function bootstrapPath() {
  const params = new URLSearchParams();
  if (adminState.selectedRestaurantId) {
    params.set("restaurantId", adminState.selectedRestaurantId);
  }
  params.set("limit", String(adminState.packageLimit));
  params.set("cursor", adminState.packageCursor || "0");
  const query = params.toString();
  return query ? `/api/admin/bootstrap?${query}` : "/api/admin/bootstrap";
}

async function loadAdminState(options = {}) {
  if (!adminState.token) {
    if (adminState.refreshToken) {
      try {
        await refreshAdminAccess();
      } catch {
        clearAdminAuth();
      }
    }
  }

  if (!adminState.token) {
    setAdminLoggedIn(false);
    return;
  }

  if (!options.append) {
    adminState.packageCursor = "0";
  }
  const data = await api(bootstrapPath(), {
    headers: adminHeaders(),
    retryWithRefresh: refreshAdminAccess,
  });
  if (options.append && adminState.data?.packages?.length) {
    data.packages = [...adminState.data.packages, ...(data.packages || [])];
  }
  hydrateAdmin(data);
  startAdminLiveStream();
}

function renderAdminStats(stats) {
  const couriers = adminState.data?.couriers || [];
  adminRefs.activeCouriers.textContent = adminState.data?.packages?.filter((pkg) => !["delivered", "failed", "cancelled"].includes(pkg.status)).length || 0;
  adminRefs.waitingPackages.textContent = stats.waitingPackages;
  adminRefs.inTransitPackages.textContent = stats.inTransitPackages;
  adminRefs.totalPackages.textContent = stats.assignedPackages;
  adminRefs.availableCourierCount.textContent = couriers.filter((courier) => courier.status === "online").length;
  adminRefs.busyCourierCount.textContent = couriers.filter((courier) => courier.status === "busy").length;
  adminRefs.offlineCourierCount.textContent = couriers.filter((courier) => courier.status === "offline").length;
  const focusLabel = adminState.selectedRestaurantId ? "Secili restoran filtresi aktif." : "Tum restoranlar gorunuyor.";
  adminRefs.summary.textContent =
    `${stats.totalPackages} siparis, ${stats.assignedPackages} aktif atama, ${stats.waitingPackages} bekleyen. ${focusLabel}`;
}

function renderRestaurantFilter(restaurants) {
  const signature = `${adminState.selectedRestaurantId}|${listRenderSignature(restaurants, ["id", "name"])}`;
  if (adminRefs.restaurantFilter.__deliveraRenderSignature === signature) {
    return;
  }
  adminRefs.restaurantFilter.__deliveraRenderSignature = signature;
  adminRefs.restaurantFilter.innerHTML = ['<option value="">Tum Restoranlar</option>']
    .concat(restaurants.map((restaurant) => `<option value="${restaurant.id}">${restaurant.name}</option>`))
    .join("");
  adminRefs.restaurantFilter.value = adminState.selectedRestaurantId;
}

function renderRestaurantStats(restaurants, stats, packages) {
  const signature = [
    adminState.selectedRestaurantId,
    listRenderSignature(restaurants, ["id", "name", "zone"]),
    stats.totalPackages,
    stats.waitingPackages,
    listRenderSignature(packages, ["id", "status", "assignedCourierId", "updatedAt"]),
  ].join("||");
  if (adminRefs.restaurantStatsBoard.__deliveraRenderSignature === signature) {
    return;
  }
  adminRefs.restaurantStatsBoard.__deliveraRenderSignature = signature;
  adminRefs.restaurantStatsBoard.innerHTML = "";

  const selectedRestaurant = restaurants.find((restaurant) => restaurant.id === adminState.selectedRestaurantId) || null;
  const selectedPlatformAccount = selectedRestaurant
    ? (adminState.data?.platformAccounts || []).find((account) => account.restaurantId === selectedRestaurant.id && account.active)
    : null;
  const title = selectedRestaurant ? `${selectedRestaurant.name} Operasyon Ozet` : "Tum Restoranlar Operasyon Ozet";
  const panelTitle = selectedRestaurant ? `${selectedRestaurant.name} Paketleri` : "Platform Kaynakli Tum Paketler";
  adminRefs.selectedRestaurantTitle.textContent = title;
  adminRefs.packagePanelTitle.textContent = panelTitle;

  const deliveredCount = packages.filter((pkg) => pkg.status === "delivered").length;
  const assignedCount = packages.filter((pkg) => pkg.status === "assigned" || pkg.status === "accepted_by_courier" || pkg.status === "on_route").length;
  const cards = [
    {
      label: "Restoran",
      value: selectedRestaurant ? selectedRestaurant.name : `${restaurants.length} restoran`,
      detail: selectedRestaurant ? `${selectedRestaurant.zone} bolgesi` : "Tum tenant gorunumu",
    },
    {
      label: "Toplam Paket",
      value: stats.totalPackages,
      detail: `${assignedCount} atandi`,
    },
    {
      label: "Havuz Bekleyen",
      value: stats.waitingPackages,
      detail: "Kurye eslesmesi bekliyor",
    },
    {
      label: "Teslim Edilen",
      value: deliveredCount,
      detail: "Filtrelenen listeye gore",
    },
  ];

  cards.forEach((item) => {
    const card = document.createElement("article");
    card.className = "zone-card";
    card.innerHTML = `
      <strong>${item.label}</strong>
      <p>${item.value}</p>
      <p>${item.detail}</p>
    `;
    adminRefs.restaurantStatsBoard.appendChild(card);
  });
}

function renderAdminCouriers(couriers) {
  const signature = listRenderSignature(couriers, ["id", "name", "username", "zone", "status", "available", "activeLoad", "lastLocationAt", "latitude", "longitude"]);
  if (adminRefs.courierList.__deliveraRenderSignature === signature) {
    return;
  }
  adminRefs.courierList.__deliveraRenderSignature = signature;
  adminRefs.courierList.innerHTML = "";

  if (couriers.length === 0) {
    adminRefs.courierList.innerHTML = '<div class="empty-state">Kurye havuzu henuz bos.</div>';
    return;
  }

  const orderedCouriers = [...couriers].sort((left, right) => {
    if (left.available !== right.available) {
      return Number(right.available) - Number(left.available);
    }
    return (right.lastLocationAt || "").localeCompare(left.lastLocationAt || "");
  });

  orderedCouriers.forEach((courier) => {
    const liveLabel = courier.lastLocationAt ? formatTimeAgo(courier.lastLocationAt) : "Konum kapali";
    const motionLabel = courier.lastLocationAt ? "Canli takip acik" : "Konum paylasmiyor";
    const card = document.createElement("article");
    card.className = "stack-card";
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <strong>${courier.name}</strong>
          <p>@${courier.username}</p>
          <p>${courier.zone} bolgesi - GPS ${Number(courier.latitude).toFixed(5)}, ${Number(courier.longitude).toFixed(5)}</p>
          <p>${courier.activeLoad} aktif paket - ${courier.available ? "Atamaya acik" : "Pasif"}</p>
          <p>${motionLabel} - Son sinyal ${liveLabel}</p>
        </div>
        <span class="soft-badge">${courierStatusLabel(courier.status)}</span>
      </div>
    `;

    const actions = document.createElement("div");
    actions.className = "stack-actions";

    const toggleButton = document.createElement("button");
    toggleButton.type = "button";
    toggleButton.className = "ghost-btn";
    toggleButton.textContent = courier.available ? "Pasif Yap" : "Aktif Yap";
    toggleButton.addEventListener("click", async () => {
      const data = await api(`/api/admin/couriers/${courier.id}/availability`, {
        method: "PATCH",
        headers: adminHeaders(),
        body: JSON.stringify({ available: !courier.available }),
        retryWithRefresh: refreshAdminAccess,
      });
      hydrateAdmin(data);
    });

    actions.appendChild(toggleButton);
    card.appendChild(actions);
    adminRefs.courierList.appendChild(card);
  });
}

function renderZoneBoard(zones) {
  const signature = listRenderSignature(zones, ["name", "packageCount", "activeCourierCount", "courierCount", "waitingCount"]);
  if (adminRefs.zoneBoard.__deliveraRenderSignature === signature) {
    return;
  }
  adminRefs.zoneBoard.__deliveraRenderSignature = signature;
  adminRefs.zoneBoard.innerHTML = "";

  if (zones.length === 0) {
    adminRefs.zoneBoard.innerHTML = '<div class="empty-state">Bolge verisi yok.</div>';
    return;
  }

  zones.forEach((zone) => {
    const card = document.createElement("article");
    card.className = "zone-card";
    card.innerHTML = `
      <strong>${zone.name}</strong>
      <p>${zone.packageCount} paket - ${zone.activeCourierCount}/${zone.courierCount} aktif kurye</p>
      <p>${zone.waitingCount} paket bekliyor</p>
    `;
    adminRefs.zoneBoard.appendChild(card);
  });
}

function renderZoneAlerts(zoneAlerts) {
  const signature = listRenderSignature(zoneAlerts || [], ["zone", "message", "waitingCount", "oldestWaitingMinutes", "severity"]);
  if (adminRefs.zoneAlertList.__deliveraRenderSignature === signature) {
    return;
  }
  adminRefs.zoneAlertList.__deliveraRenderSignature = signature;
  adminRefs.zoneAlertList.innerHTML = "";

  if (!zoneAlerts || zoneAlerts.length === 0) {
    adminRefs.zoneAlertList.innerHTML = '<div class="empty-state">Su an kritik bolge yogunlugu yok.</div>';
    return;
  }

  zoneAlerts.forEach((alert) => {
    const card = document.createElement("article");
    card.className = `stack-card ${alert.severity === "critical" ? "priority-alert-card" : ""}`;
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <strong>${alert.zone}</strong>
          <p>${alert.message}</p>
          <p>${alert.waitingCount} bekleyen siparis - en eski bekleme ${alert.oldestWaitingMinutes} dk</p>
        </div>
        <span class="soft-badge">${alert.severity === "critical" ? "Kirmizi Oncelik" : "Yogunluk"}</span>
      </div>
    `;
    adminRefs.zoneAlertList.appendChild(card);
  });
}

function packageVisible(pkg) {
  const query = adminRefs.searchInput.value.trim().toLowerCase();
  if (!query) {
    return true;
  }

  return [
    pkg.sourcePlatform,
    pkg.externalOrderNo,
    pkg.restaurantName,
    pkg.recipient,
    pkg.assignedCourierName || "",
    pkg.status,
  ].join(" ").toLowerCase().includes(query);
}

function normalizeZoneValue(value) {
  return String(value || "").trim().toLowerCase();
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function distanceKm(aLat, aLng, bLat, bLng) {
  const lat1 = Number(aLat);
  const lng1 = Number(aLng);
  const lat2 = Number(bLat);
  const lng2 = Number(bLng);
  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) {
    return null;
  }

  const earthRadiusKm = 6371;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const latA = toRadians(lat1);
  const latB = toRadians(lat2);
  const haversine =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(latA) * Math.cos(latB) * Math.sin(dLng / 2) ** 2;

  return Number((2 * earthRadiusKm * Math.asin(Math.sqrt(haversine))).toFixed(1));
}

function buildCourierOverrideOptions(pkg) {
  const allCouriers = adminState.data?.couriers || [];
  return allCouriers
    .sort((left, right) => {
      const leftEligible = left.status === "online" && Number(left.activeLoad || 0) < 1;
      const rightEligible = right.status === "online" && Number(right.activeLoad || 0) < 1;
      if (leftEligible !== rightEligible) {
        return Number(rightEligible) - Number(leftEligible);
      }
      const leftDistance = distanceKm(pkg.restaurantLat ?? pkg.latitude, pkg.restaurantLng ?? pkg.longitude, left.latitude, left.longitude);
      const rightDistance = distanceKm(pkg.restaurantLat ?? pkg.latitude, pkg.restaurantLng ?? pkg.longitude, right.latitude, right.longitude);
      if (leftDistance !== null && rightDistance !== null && leftDistance !== rightDistance) {
        return leftDistance - rightDistance;
      }
      return left.name.localeCompare(right.name, "tr");
    })
    .map((courier) => {
      const activeLoad = Number(courier.activeLoad || 0);
      const isEligible = courier.status === "online" && activeLoad < 1;
      const distance = distanceKm(pkg.restaurantLat ?? pkg.latitude, pkg.restaurantLng ?? pkg.longitude, courier.latitude, courier.longitude);
      const reason = !isEligible
        ? courier.status !== "online"
          ? courier.status === "busy"
            ? "Mesgul"
            : "Offline"
          : "Aktif paketi var"
        : "Musait";

      return {
        value: courier.id,
        label: `${courier.name} - ${courier.zone} - ${distance === null ? "Mesafe yok" : `${distance} km`} - ${reason}`,
        disabled: !isEligible,
      };
    });
}

function openPackagePrintWindow(pkg) {
  const win = window.open("", "_blank", "width=720,height=840");
  if (!win) {
    showToast("Yazdirma penceresi acilamadi.", "error");
    return;
  }

  const items = Array.isArray(pkg.items) && pkg.items.length
    ? pkg.items.map((item) => `
      <tr>
        <td>${item.name || "-"}</td>
        <td>${item.quantity || 1}</td>
        <td>${formatCurrency(item.price || 0)}</td>
      </tr>
    `).join("")
    : '<tr><td colspan="3">Urun bilgisi paylasilmadi.</td></tr>';

  win.document.write(`
    <html>
      <head>
        <title>${pkg.externalOrderNo} Fis</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 24px; color: #111; }
          table { width: 100%; border-collapse: collapse; margin-top: 12px; }
          th, td { border-bottom: 1px solid #ddd; padding: 8px 4px; text-align: left; }
        </style>
      </head>
      <body>
        <h1>${pkg.restaurantName || "Delivera Express"}</h1>
        <p>Platform: ${pkg.sourcePlatform || "-"}</p>
        <p>Siparis No: ${pkg.externalOrderNo || pkg.trackingNo || "-"}</p>
        <p>Musteri: ${pkg.recipient || "-"}</p>
        <p>Telefon: ${pkg.phone || "-"}</p>
        <p>Adres: ${pkg.deliveryAddress || pkg.address || "-"}</p>
        <table>
          <thead><tr><th>Urun</th><th>Adet</th><th>Tutar</th></tr></thead>
          <tbody>${items}</tbody>
        </table>
        <p>Toplam: ${formatCurrency(pkg.orderAmount || 0)}</p>
        <p>Odeme: ${pkg.paymentMethod || "-"}</p>
        <p>Notlar: ${pkg.customerNote || pkg.note || "-"}</p>
        <p>Tarih Saat: ${formatDate(pkg.createdAt)}</p>
      </body>
    </html>
  `);
  win.document.close();
  win.focus();
  window.setTimeout(() => win.print(), 150);
}

function buildPackageCard(pkg) {
  const node = adminRefs.template.content.cloneNode(true);
  const badge = node.querySelector(".status-badge");
  const select = node.querySelector(".status-select");
  const reassignButton = node.querySelector(".reassign-btn");
  const platformPendingApproval = pkg.status === "pending_approval" || pkg.status === "rejected";

  const wrapper = node.querySelector(".package-card");
  if (!pkg.assignedCourierId && ["pending_approval", "pending", "preparing", "awaiting_assignment"].includes(pkg.status)) {
    wrapper.classList.add("priority-alert-card");
  }
  node.querySelector(".tracking-no").textContent = `${pkg.trackingNo} - ${pkg.externalOrderNo} - ${formatDate(pkg.createdAt)}`;
  node.querySelector(".recipient-name").textContent = `${pkg.recipient} - ${pkg.phone}`;
  node.querySelector(".platform-name").textContent = pkg.sourcePlatform;
  node.querySelector(".restaurant-name").textContent = pkg.restaurantName;
  node.querySelector(".courier-name").textContent = pkg.assignedCourierName || "Kurye bekleniyor";
  node.querySelector(".distance-value").textContent = pkg.distanceKm === null ? "-" : `${pkg.distanceKm} km`;
  node.querySelector(".payment-method").textContent = `${pkg.paymentMethod} - ${paymentStatusLabel(pkg.paymentStatus)} - ${formatCurrency(pkg.orderAmount)}`;
  node.querySelector(".address-value").textContent = pkg.deliveryAddress || pkg.address;
  const platformLogText = Array.isArray(pkg.platformStatusLogs) && pkg.platformStatusLogs.length
    ? ` - Platform: ${pkg.platformStatusLogs.map((item) => item.message).join(" | ")}`
    : "";
  node.querySelector(".assignment-note").textContent = `${pkg.assignmentReason}${pkg.lastAssignmentError ? ` - Son Hata: ${pkg.lastAssignmentError}` : ""}${platformLogText}`;
  node.querySelector(".note-text").textContent = `${pkg.zone} - ${pkg.address}${pkg.customerNote || pkg.note ? ` - ${pkg.customerNote || pkg.note}` : ""}${pkg.assignedAt ? ` - Atama ${formatDate(pkg.assignedAt)}` : ""}`;

  badge.textContent = statusLabel(pkg.status);
  badge.className = `status-badge ${statusClassName(pkg.status)}`;
  select.innerHTML = createStatusOptions(pkg.status);
  select.value = pkg.status;

  select.addEventListener("change", async (event) => {
    const data = await api(`/api/admin/packages/${pkg.id}/status`, {
      method: "PATCH",
      headers: adminHeaders(),
      body: JSON.stringify({ status: event.target.value }),
      retryWithRefresh: refreshAdminAccess,
    });
    hydrateAdmin(data);
  });

  reassignButton.addEventListener("click", async () => {
    const data = await api(`/api/admin/packages/${pkg.id}/reassign`, {
      method: "POST",
      headers: adminHeaders(),
      body: "{}",
      retryWithRefresh: refreshAdminAccess,
    });
    hydrateAdmin(data);
  });
  reassignButton.disabled = platformPendingApproval;

  const actions = node.querySelector(".card-actions");
  const courierSelect = document.createElement("select");
  courierSelect.className = "status-select";
  const courierOptions = buildCourierOverrideOptions(pkg);
  const hasAssignableCourier = courierOptions.some((option) => !option.disabled);
  courierSelect.innerHTML = ['<option value="">Kurye sec</option>']
    .concat(courierOptions.map((option) => `<option value="${option.value}" ${option.disabled ? "disabled" : ""}>${option.label}</option>`))
    .join("");
  courierSelect.disabled = platformPendingApproval;

  const overrideButton = document.createElement("button");
  overrideButton.type = "button";
  overrideButton.className = "ghost-btn";
  overrideButton.textContent = "Kuriyeye Ata";
  overrideButton.disabled = !hasAssignableCourier || platformPendingApproval;
  overrideButton.addEventListener("click", async () => {
    if (!courierSelect.value) {
      showToast("Bu paket icin uygun online kurye bulunamadi.", "warning");
      return;
    }
    const data = await api(`/api/admin/packages/${pkg.id}/override`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ courierId: courierSelect.value }),
      retryWithRefresh: refreshAdminAccess,
    });
    hydrateAdmin(data);
  });

  const unassignButton = document.createElement("button");
  unassignButton.type = "button";
  unassignButton.className = "ghost-btn";
  unassignButton.textContent = "Atamayi Kaldir";
  unassignButton.addEventListener("click", async () => {
    const data = await api(`/api/admin/packages/${pkg.id}/unassign`, {
      method: "POST",
      headers: adminHeaders(),
      body: "{}",
      retryWithRefresh: refreshAdminAccess,
    });
    hydrateAdmin(data);
  });
  unassignButton.disabled = platformPendingApproval;

  actions.appendChild(courierSelect);
  actions.appendChild(overrideButton);
  actions.appendChild(unassignButton);

  const printButton = document.createElement("button");
  printButton.type = "button";
  printButton.className = "primary-btn";
  printButton.textContent = "Yazdir";
  printButton.addEventListener("click", () => openPackagePrintWindow(pkg));
  actions.appendChild(printButton);

  if (!courierOptions.length) {
    const helper = document.createElement("p");
    helper.className = "subtle-text";
    helper.textContent = "Uygun kurye bulunamadi: online kurye yok / mesafe disi / bolge farkli olsa bile musait kurye bulunamadi.";
    actions.appendChild(helper);
  }

  return node;
}

function renderAdminPackages(packages) {
  const visible = packages.filter(packageVisible);
  const packagePage = adminState.data?.pagination?.packages || null;
  const signature = [
    adminRefs.searchInput.value.trim().toLowerCase(),
    packagePage?.hasMore,
    packagePage?.nextCursor,
    packagePage?.total,
    listRenderSignature(visible, ["id", "trackingNo", "externalOrderNo", "status", "assignedCourierId", "assignedCourierName", "lastAssignmentError", "paymentStatus", "updatedAt"]),
  ].join("||");
  if (adminRefs.packageList.__deliveraRenderSignature === signature) {
    return;
  }
  adminRefs.packageList.__deliveraRenderSignature = signature;
  adminRefs.packageList.innerHTML = "";

  if (visible.length === 0) {
    adminRefs.packageList.innerHTML = '<div class="empty-state">Aramana uyan paket bulunamadi.</div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  visible.forEach((pkg) => fragment.appendChild(buildPackageCard(pkg)));
  if (packagePage?.hasMore) {
    const moreButton = document.createElement("button");
    moreButton.className = "ghost-btn";
    moreButton.type = "button";
    moreButton.textContent = `Daha fazla yükle (${packages.length}/${packagePage.total})`;
    moreButton.addEventListener("click", async () => {
      adminState.packageCursor = packagePage.nextCursor;
      await loadAdminState({ append: true });
    });
    fragment.appendChild(moreButton);
  }
  adminRefs.packageList.appendChild(fragment);
}

function renderAwaitingPackages(packages) {
  const waiting = packages.filter((pkg) => ["pending_approval", "pending", "preparing", "awaiting_assignment"].includes(pkg.status));
  const signature = listRenderSignature(waiting, ["id", "trackingNo", "restaurantName", "recipient", "deliveryAddress", "address", "status", "lastAssignmentAttemptAt", "lastAssignmentError", "updatedAt"]);
  if (adminRefs.awaitingPackageList.__deliveraRenderSignature === signature) {
    return;
  }
  adminRefs.awaitingPackageList.__deliveraRenderSignature = signature;
  adminRefs.awaitingPackageList.innerHTML = "";

  if (waiting.length === 0) {
    adminRefs.awaitingPackageList.innerHTML = '<div class="empty-state">Atama bekleyen siparis yok.</div>';
    return;
  }

  waiting.forEach((pkg) => {
    const card = document.createElement("article");
    card.className = "stack-card";
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <strong>${pkg.trackingNo} - ${pkg.restaurantName}</strong>
          <p>${pkg.recipient} - ${pkg.deliveryAddress || pkg.address}</p>
          <p>Son deneme: ${pkg.lastAssignmentAttemptAt ? formatDate(pkg.lastAssignmentAttemptAt) : "-"}</p>
          <p>Hata: ${pkg.lastAssignmentError || "-"}</p>
        </div>
        <span class="soft-badge">${statusLabel(pkg.status)}</span>
      </div>
    `;
    adminRefs.awaitingPackageList.appendChild(card);
  });
}

function renderActiveCourierOps(couriers) {
  const list = couriers.filter((courier) => courier.status === "online" || courier.status === "busy");
  const signature = listRenderSignature(list, ["id", "name", "username", "zone", "activeLoad", "lastLocationAt", "status"]);
  if (adminRefs.activeCourierOpsList.__deliveraRenderSignature === signature) {
    return;
  }
  adminRefs.activeCourierOpsList.__deliveraRenderSignature = signature;
  adminRefs.activeCourierOpsList.innerHTML = "";

  if (list.length === 0) {
    adminRefs.activeCourierOpsList.innerHTML = '<div class="empty-state">Aktif veya musait kurye yok.</div>';
    return;
  }

  list.forEach((courier) => {
    const card = document.createElement("article");
    card.className = "stack-card";
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <strong>${courier.name}</strong>
          <p>@${courier.username} - ${courier.zone}</p>
          <p>${courier.activeLoad} aktif is - Son sinyal ${courier.lastLocationAt ? formatTimeAgo(courier.lastLocationAt) : "yok"}</p>
        </div>
        <span class="soft-badge">${courierStatusLabel(courier.status)}</span>
      </div>
    `;
    adminRefs.activeCourierOpsList.appendChild(card);
  });
}

function renderWebhookLogs(logs) {
  const signature = listRenderSignature((logs || []).slice(0, 10), ["id", "sourcePlatform", "externalOrderNo", "restaurantId", "signatureValid", "responseStatus", "retryCount", "deadLetteredAt", "lastError", "createdAt"]);
  if (adminRefs.webhookLogList.__deliveraRenderSignature === signature) {
    return;
  }
  adminRefs.webhookLogList.__deliveraRenderSignature = signature;
  adminRefs.webhookLogList.innerHTML = "";

  if (!logs || logs.length === 0) {
    adminRefs.webhookLogList.innerHTML = '<div class="empty-state">Henuz webhook log kaydi yok.</div>';
    return;
  }

  logs.slice(0, 10).forEach((log) => {
    const card = document.createElement("article");
    card.className = "stack-card";
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <strong>${log.sourcePlatform || "Platform yok"} - ${log.externalOrderNo || "Siparis no yok"}</strong>
          <p>Restoran: ${log.restaurantId || "-"}</p>
          <p>Imza: ${log.signatureValid ? "Gecerli" : "Hatali"} - HTTP ${log.responseStatus}${log.retryCount ? ` - Retry ${log.retryCount}` : ""}</p>
          ${log.lastError ? `<p>Son hata: ${log.lastError}${log.deadLetteredAt ? " - DLQ" : ""}</p>` : ""}
        </div>
        <span class="soft-badge">${formatDate(log.createdAt)}</span>
      </div>
    `;
    adminRefs.webhookLogList.appendChild(card);
  });
}

function renderAuditLogs(logs) {
  const signature = listRenderSignature((logs || []).slice(0, 12), ["id", "action", "actorRole", "actorId", "restaurantId", "packageId", "createdAt"]);
  if (adminRefs.auditLogList.__deliveraRenderSignature === signature) {
    return;
  }
  adminRefs.auditLogList.__deliveraRenderSignature = signature;
  adminRefs.auditLogList.innerHTML = "";

  if (!logs || logs.length === 0) {
    adminRefs.auditLogList.innerHTML = '<div class="empty-state">Henuz audit log yok.</div>';
    return;
  }

  logs.slice(0, 12).forEach((log) => {
    const card = document.createElement("article");
    card.className = "stack-card";
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <strong>${log.action}</strong>
          <p>${log.actorRole} - ${log.actorId || "anonim"}</p>
          <p>Restoran: ${log.restaurantId || "-"}${log.packageId ? ` - Paket: ${log.packageId}` : ""}</p>
        </div>
        <span class="soft-badge">${formatDate(log.createdAt)}</span>
      </div>
    `;
    adminRefs.auditLogList.appendChild(card);
  });
}

function renderCourierDailyReports(reports) {
  const signature = listRenderSignature((reports || []).slice(0, 20), ["id", "courierName", "reportDate", "zone", "deliveredCount", "totalAmount", "paidOnlineAmount", "cashCollectedAmount", "updatedAt"]);
  if (adminRefs.courierDailyReportList.__deliveraRenderSignature === signature) {
    return;
  }
  adminRefs.courierDailyReportList.__deliveraRenderSignature = signature;
  adminRefs.courierDailyReportList.innerHTML = "";

  if (!reports || reports.length === 0) {
    adminRefs.courierDailyReportList.innerHTML = '<div class="empty-state">Henuz kurye gun sonu raporu yok.</div>';
    return;
  }

  reports.slice(0, 20).forEach((report) => {
    const card = document.createElement("article");
    card.className = "stack-card";
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <strong>${report.courierName} - ${report.reportDate}</strong>
          <p>${report.zone} bolgesi - ${report.deliveredCount} teslimat</p>
          <p>Toplam Ciro: ${formatCurrency(report.totalAmount)}</p>
        </div>
        <span class="soft-badge">${formatDate(report.updatedAt)}</span>
      </div>
      <div class="meta-grid compact-meta-grid">
        <div>
          <span>Online Odeme</span>
          <strong>${formatCurrency(report.paidOnlineAmount)}</strong>
        </div>
        <div>
          <span>Nakit</span>
          <strong>${formatCurrency(report.cashCollectedAmount)}</strong>
        </div>
        <div>
          <span>Paket</span>
          <strong>${report.packageIds.length} kayit</strong>
        </div>
      </div>
    `;
    adminRefs.courierDailyReportList.appendChild(card);
  });
}

function renderSystemSignals(data) {
  const logs = data.webhookLogs || [];
  const failed = logs.filter((log) => Number(log.responseStatus) >= 400 || log.deadLetteredAt).length;
  const lastError = logs.find((log) => log.lastError || Number(log.responseStatus) >= 400);
  if (adminRefs.queueMode) {
    adminRefs.queueMode.textContent = data.systemStatus?.queues?.queueService?.mode || data.queues?.queueService?.mode || "inline";
  }
  if (adminRefs.rateLimitStore) {
    adminRefs.rateLimitStore.textContent = data.systemStatus?.cache?.rateLimitStore?.mode || data.cache?.rateLimitStore?.mode || "memory";
  }
  if (adminRefs.failedWebhookCount) {
    adminRefs.failedWebhookCount.textContent = String(data.systemStatus?.totals?.failedWebhooks ?? failed);
  }
  if (adminRefs.lastSystemError) {
    adminRefs.lastSystemError.textContent = lastError
      ? `${lastError.sourcePlatform || "platform"} ${lastError.lastError || `HTTP ${lastError.responseStatus}`}`.slice(0, 28)
      : "-";
  }
}

function platformHealthLabel(status) {
  return {
    connected: "Bağlı",
    warning: "Uyarı",
    error: "Hatalı",
    disabled: "Devre dışı",
    unknown: "Kontrol edilmedi",
  }[status] || "Kontrol edilmedi";
}

function platformHealthTone(status) {
  return {
    connected: "success",
    warning: "warning",
    error: "error",
    disabled: "neutral",
    unknown: "neutral",
  }[status] || "neutral";
}

function renderPlatformHealth(data) {
  if (!adminRefs.platformHealthSummary || !adminRefs.platformHealthList) {
    return;
  }
  const accounts = data.platformAccounts || [];
  const summary = data.systemStatus?.platformHealth || {};
  const signature = [
    summary.connected, summary.warning, summary.error, summary.disabled, summary.unknown,
    listRenderSignature(accounts, ["id", "platform", "restaurantId", "connectionStatus", "lastSuccessAt", "lastErrorAt", "lastErrorCode", "lastErrorMessage", "lastHttpStatus", "lastLatencyMs", "consecutiveFailures", "lastCheckAt"]),
  ].join("|");
  if (adminRefs.platformHealthList.__deliveraRenderSignature === signature) {
    return;
  }
  adminRefs.platformHealthList.__deliveraRenderSignature = signature;

  adminRefs.platformHealthSummary.innerHTML = [
    ["Bağlı", summary.connected || 0],
    ["Uyarı", summary.warning || 0],
    ["Hatalı", summary.error || 0],
    ["Kontrol edilmedi", summary.unknown || 0],
  ].map(([label, value]) => `
    <article class="mini-stat-card">
      <span>${label}</span>
      <strong>${value}</strong>
    </article>
  `).join("");

  adminRefs.platformHealthList.innerHTML = "";
  if (accounts.length === 0) {
    adminRefs.platformHealthList.innerHTML = '<div class="empty-state">Platform hesabi bulunmuyor.</div>';
    return;
  }

  accounts.forEach((account) => {
    const health = account.connectionHealth || {};
    const status = account.connectionStatus || health.status || "unknown";
    const restaurant = (data.restaurants || []).find((item) => item.id === account.restaurantId);
    const card = document.createElement("article");
    card.className = "stack-card";
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <strong>${htmlSafe(account.platform)} - ${htmlSafe(restaurant?.name || account.restaurantId || "-")}</strong>
          <p>${htmlSafe(health.publicMessage || account.lastErrorMessage || "Son durum bekleniyor.")}</p>
          <p>HTTP ${account.lastHttpStatus || "-"} - ${account.lastLatencyMs ?? "-"} ms - Ardışık hata ${account.consecutiveFailures || 0}</p>
          <details>
            <summary>Son hataları göster</summary>
            <p>Kod: ${htmlSafe(account.lastErrorCode || "-")} - ${htmlSafe(account.lastErrorMessage || "-")}</p>
            <p>Son başarılı: ${account.lastSuccessAt ? formatDate(account.lastSuccessAt) : "-"} | Son hata: ${account.lastErrorAt ? formatDate(account.lastErrorAt) : "-"}</p>
          </details>
        </div>
        <span class="platform-live-badge platform-live-${platformHealthTone(status)}">${platformHealthLabel(status)}</span>
      </div>
      <div class="card-actions">
        <button class="ghost-btn" type="button" data-platform-health-check="${account.id}">Tekrar kontrol et</button>
      </div>
    `;
    adminRefs.platformHealthList.appendChild(card);
  });
}

function renderAdminNotifications(notifications) {
  renderNotificationCenter(adminRefs.notificationCenter, notifications || [], "Bildirim henuz yok.");
}

function renderAnnouncements(items) {
  const courierAnnouncements = (items || []).filter((item) => item.targetRole === "courier");
  const signature = listRenderSignature(courierAnnouncements, ["id", "targetRole", "title", "message", "updatedAt", "createdAt"]);
  if (adminRefs.announcementList.__deliveraRenderSignature === signature) {
    return;
  }
  adminRefs.announcementList.__deliveraRenderSignature = signature;
  adminRefs.announcementList.innerHTML = "";

  if (!courierAnnouncements.length) {
    adminRefs.announcementList.innerHTML = '<div class="empty-state">Aktif kurye duyurusu yok.</div>';
    return;
  }

  courierAnnouncements.forEach((item) => {
    const card = document.createElement("article");
    card.className = "stack-card notification-card";
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <strong>${item.title}</strong>
          <p>${item.message}</p>
          <p>Yayin: ${formatDate(item.updatedAt || item.createdAt)}</p>
        </div>
        <button class="ghost-btn" type="button">Sil</button>
      </div>
    `;
    card.querySelector("button").addEventListener("click", async () => {
      const data = await api(`/api/admin/announcements/${item.id}`, {
        method: "DELETE",
        headers: adminHeaders(),
        retryWithRefresh: refreshAdminAccess,
      });
      hydrateAdmin(data);
      showToast("Duyuru kaldirildi.");
    });
    adminRefs.announcementList.appendChild(card);
  });
}

function renderShiftPlanTools(couriers, plans, summary) {
  if (adminRefs.shiftPlanCourier) {
    const selectedCourier = adminRefs.shiftPlanCourier.value;
    const selectSignature = listRenderSignature(couriers || [], ["id", "name", "zone"]);
    if (adminRefs.shiftPlanCourier.__deliveraRenderSignature !== selectSignature) {
      adminRefs.shiftPlanCourier.__deliveraRenderSignature = selectSignature;
      adminRefs.shiftPlanCourier.innerHTML = ['<option value="">Kurye sec</option>']
        .concat((couriers || []).map((courier) => `<option value="${courier.id}">${courier.name} - ${courier.zone}</option>`))
        .join("");
      adminRefs.shiftPlanCourier.value = selectedCourier;
    }
  }
  if (adminRefs.shiftPlanDate && !adminRefs.shiftPlanDate.value) {
    adminRefs.shiftPlanDate.value = new Date().toISOString().slice(0, 10);
  }

  const summarySignature = listRenderSignature(summary || [], ["zone", "plannedCouriers", "missingCouriers"]);
  if (adminRefs.shiftPlanSummary.__deliveraRenderSignature !== summarySignature) {
    adminRefs.shiftPlanSummary.__deliveraRenderSignature = summarySignature;
    adminRefs.shiftPlanSummary.innerHTML = "";
  (summary || []).forEach((item) => {
    const card = document.createElement("article");
    card.className = "zone-card";
    card.innerHTML = `
      <strong>${item.zone}</strong>
      <p>${item.plannedCouriers} planli kurye</p>
      <p>${item.missingCouriers > 0 ? `${item.missingCouriers} eksik vardiya` : "Kadrolama dengeli"}</p>
    `;
    adminRefs.shiftPlanSummary.appendChild(card);
  });
  }

  const planSignature = listRenderSignature(plans || [], ["id", "courierName", "zone", "planDate", "startTime", "endTime", "status", "acceptedAt", "offerExpiresAt"]);
  if (adminRefs.shiftPlanList.__deliveraRenderSignature === planSignature) {
    return;
  }
  adminRefs.shiftPlanList.__deliveraRenderSignature = planSignature;
  adminRefs.shiftPlanList.innerHTML = "";
  if (!(plans || []).length) {
    adminRefs.shiftPlanList.innerHTML = '<div class="empty-state">Bugun icin vardiya plani kaydi yok.</div>';
    return;
  }

  const acceptedPlans = plans.filter((plan) => plan.status === "accepted");
  if (acceptedPlans.length) {
    const acceptedCard = document.createElement("article");
    acceptedCard.className = "stack-card notification-card";
    acceptedCard.innerHTML = `
      <div class="stack-top">
        <div>
          <strong>Kabul Eden Kuryeler</strong>
          <p>${acceptedPlans.map((plan) => `${plan.courierName} (${plan.startTime}-${plan.endTime})`).join(" - ")}</p>
        </div>
        <span class="soft-badge">${acceptedPlans.length} kabul</span>
      </div>
    `;
    adminRefs.shiftPlanList.appendChild(acceptedCard);
  }

  plans.forEach((plan) => {
    const card = document.createElement("article");
    card.className = "stack-card";
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <strong>${plan.courierName}</strong>
          <p>${plan.zone} - ${plan.planDate}</p>
          <p>${plan.startTime} / ${plan.endTime}</p>
          <p>${plan.status === "accepted"
            ? `Kurye onayi ${formatDate(plan.acceptedAt)}`
            : plan.status === "awaiting_courier_acceptance"
              ? `Kurye onayi bekleniyor. Son sure ${formatDate(plan.offerExpiresAt)}`
              : "Onay suresi doldu"}</p>
        </div>
        <span class="soft-badge">${plan.status === "accepted" ? "Onaylandi" : plan.status === "awaiting_courier_acceptance" ? "Bekliyor" : "Sure Doldu"}</span>
      </div>
    `;
    adminRefs.shiftPlanList.appendChild(card);
  });
}

function renderCashReconciliations(items) {
  const signature = listRenderSignature(items || [], ["id", "courierName", "reportDate", "zone", "expectedCash", "reportedCash", "variance", "status", "updatedAt"]);
  if (adminRefs.cashReconciliationList.__deliveraRenderSignature === signature) {
    return;
  }
  adminRefs.cashReconciliationList.__deliveraRenderSignature = signature;
  adminRefs.cashReconciliationList.innerHTML = "";
  if (!(items || []).length) {
    adminRefs.cashReconciliationList.innerHTML = '<div class="empty-state">Nakit mutabakat kaydi henuz yok.</div>';
    return;
  }

  items.forEach((item) => {
    const card = document.createElement("article");
    card.className = "stack-card";
    const inputId = `cash-${item.id}`;
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <strong>${item.courierName} - ${item.reportDate}</strong>
          <p>${item.zone} bolgesi</p>
          <p>Beklenen ${formatCurrency(item.expectedCash)} - Bildirilen ${formatCurrency(item.reportedCash)}</p>
        </div>
        <span class="soft-badge">${item.status}</span>
      </div>
      <div class="meta-grid compact-meta-grid">
        <div>
          <span>Fark</span>
          <strong>${formatCurrency(item.variance)}</strong>
        </div>
        <div>
          <span>Paket</span>
          <strong>${item.packageIds.length}</strong>
        </div>
      </div>
      <div class="card-actions">
        <input id="${inputId}" class="status-select" type="number" step="0.01" value="${Number(item.reportedCash || 0).toFixed(2)}">
        <button class="ghost-btn" type="button" data-action="approve">Onayla</button>
        <button class="ghost-btn" type="button" data-action="issue">Sorun Isaretle</button>
      </div>
    `;

    card.querySelector('[data-action="approve"]').addEventListener("click", async () => {
      const reportedCash = card.querySelector(`#${inputId}`).value;
      const data = await api(`/api/admin/cash-reconciliations/${item.id}`, {
        method: "PATCH",
        headers: adminHeaders(),
        body: JSON.stringify({ status: "approved", reportedCash }),
        retryWithRefresh: refreshAdminAccess,
      });
      hydrateAdmin(data);
    });

    card.querySelector('[data-action="issue"]').addEventListener("click", async () => {
      const reportedCash = card.querySelector(`#${inputId}`).value;
      const data = await api(`/api/admin/cash-reconciliations/${item.id}`, {
        method: "PATCH",
        headers: adminHeaders(),
        body: JSON.stringify({ status: "issue", reportedCash }),
        retryWithRefresh: refreshAdminAccess,
      });
      hydrateAdmin(data);
    });

    adminRefs.cashReconciliationList.appendChild(card);
  });
}

function hydrateAdmin(data) {
  adminState.data = data;
  setAdminLoggedIn(true);
  initializeAdminWorkspaceCards();
  if (adminRefs.liveBadge) {
    adminRefs.liveBadge.textContent = "Canli akis acik";
  }
  renderAdminStats(data.stats);
  renderSystemSignals(data);
  setZoneOptions(adminRefs.courierZone, data.zones);
  setZoneOptions(adminRefs.restaurantZone, data.zones);
  renderRestaurantFilter(data.restaurants);
  renderRestaurantStats(data.restaurants, data.stats, data.packages);
  renderAdminCouriers(data.couriers);
  renderZoneBoard(data.zones);
  renderZoneAlerts(data.zoneAlerts || []);
  renderAdminPackages(data.packages);
  renderAwaitingPackages(data.packages);
  renderActiveCourierOps(data.couriers);
  renderWebhookLogs(data.webhookLogs);
  renderPlatformHealth(data);
  renderAuditLogs(data.auditLogs || []);
  renderCourierDailyReports(data.courierDailyReports || []);
  renderAdminNotifications(data.notifications || []);
  renderAnnouncements(data.announcements || []);
  renderShiftPlanTools(data.couriers || [], data.shiftPlans || [], data.shiftPlanSummary || []);
  renderCashReconciliations(data.cashReconciliations || []);
}

adminRefs.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(adminRefs.loginForm);
  const login = await api("/api/admin/login", {
    method: "POST",
    body: JSON.stringify({
      username: formData.get("username"),
      password: formData.get("password"),
    }),
  });
  persistAdminAuth(login);
  adminRefs.loginForm.reset();
  await loadAdminState();
  startAdminLiveStream();
});

adminRefs.platformHealthList?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-platform-health-check]");
  if (!button) {
    return;
  }
  button.disabled = true;
  button.textContent = "Kontrol ediliyor";
  try {
    const data = await api(`/api/admin/platform-accounts/${button.dataset.platformHealthCheck}/check-connection`, {
      method: "POST",
      headers: adminHeaders(),
      retryWithRefresh: refreshAdminAccess,
    });
    await loadAdminState();
    showToast(data.health?.publicMessage || "Platform bağlantısı kontrol edildi.", data.health?.status === "connected" ? "success" : "warning");
  } finally {
    button.disabled = false;
    button.textContent = "Tekrar kontrol et";
  }
});

adminRefs.courierForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(adminRefs.courierForm);
  const payload = {
    name: formData.get("name"),
    username: formData.get("username"),
    password: formData.get("password"),
    zone: formData.get("zone"),
    latitude: formData.get("latitude"),
    longitude: formData.get("longitude"),
    available: formData.get("available") === "on",
  };
  await api("/api/admin/couriers", {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify(payload),
    retryWithRefresh: refreshAdminAccess,
  });
  adminRefs.courierForm.reset();
  await loadAdminState();
  showToast(`${payload.name} isimli kurye basariyla kaydedildi.`);
});

adminRefs.restaurantForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(adminRefs.restaurantForm);
  const payload = {
    name: formData.get("name"),
    portalUsername: formData.get("portalUsername"),
    portalPassword: formData.get("portalPassword"),
    zone: formData.get("zone"),
    latitude: formData.get("latitude"),
    longitude: formData.get("longitude"),
    platforms: formData.getAll("platforms"),
  };
  const data = await api("/api/admin/restaurants", {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify(payload),
    retryWithRefresh: refreshAdminAccess,
  });
  adminRefs.restaurantForm.reset();
  renderPlatformChecks();
  hydrateAdmin(data);
  showToast(`${payload.name} restorani basariyla kaydedildi.`);
});

adminRefs.shiftPlanForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(adminRefs.shiftPlanForm);
  const data = await api("/api/admin/shift-plans", {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({
      courierId: formData.get("courierId"),
      planDate: formData.get("planDate"),
      startTime: formData.get("startTime"),
      endTime: formData.get("endTime"),
    }),
    retryWithRefresh: refreshAdminAccess,
  });
  hydrateAdmin(data);
  showToast("Vardiya plani kaydedildi.");
});

adminRefs.announcementForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(adminRefs.announcementForm);
  const data = await api("/api/admin/announcements", {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({
      targetRole: "courier",
      title: formData.get("title"),
      message: formData.get("message"),
    }),
    retryWithRefresh: refreshAdminAccess,
  });
  adminRefs.announcementForm.reset();
  hydrateAdmin(data);
  showToast("Kurye duyurusu yayinlandi.");
});

adminRefs.clearAnnouncementsButton?.addEventListener("click", async () => {
  const data = await api("/api/admin/announcements/clear", {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ targetRole: "courier" }),
    retryWithRefresh: refreshAdminAccess,
  });
  hydrateAdmin(data);
  showToast("Tum kurye duyurulari sifirlandi.");
});

adminRefs.searchInput.addEventListener("input", () => {
  if (adminState.data) {
    renderAdminPackages(adminState.data.packages);
  }
});

adminRefs.restaurantFilter.addEventListener("change", async (event) => {
  adminState.selectedRestaurantId = event.target.value;
  adminState.packageCursor = "0";
  await loadAdminState();
});

adminRefs.logoutButton?.addEventListener("click", () => {
  if (adminState.refreshToken) {
    api("/api/admin/logout", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ refreshToken: adminState.refreshToken }),
    }).catch(() => {
      // Local cleanup should still continue.
    });
  }

  clearAdminAuth();
  adminRefs.summary.textContent = "Admin oturumu kapatildi.";
  setAdminLoggedIn(false);
  if (adminRefs.liveBadge) {
    adminRefs.liveBadge.textContent = "Canli akis kapali";
  }
});

loadAdminState().catch((error) => {
  clearAdminAuth();
  adminRefs.summary.textContent = error.message;
  setAdminLoggedIn(false);
  if (adminRefs.liveBadge) {
    adminRefs.liveBadge.textContent = "Canli akis kapali";
  }
});

setInterval(() => {
  loadAdminState().catch(() => {
    // Keep current screen if a refresh request fails.
  });
}, ADMIN_REFRESH_MS);

renderPlatformChecks();
