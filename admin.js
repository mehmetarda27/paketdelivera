const ADMIN_TOKEN_KEY = "deliveraAdminToken";
const ADMIN_REFRESH_MS = 15_000;

const adminState = {
  data: null,
  token: localStorage.getItem(ADMIN_TOKEN_KEY) || "",
  selectedRestaurantId: "",
};

const adminRefs = {
  summary: document.getElementById("adminSummary"),
  loginPanel: document.getElementById("adminLoginPanel"),
  workspace: document.getElementById("adminWorkspace"),
  loginForm: document.getElementById("adminLoginForm"),
  activeCouriers: document.getElementById("activeCouriers"),
  waitingPackages: document.getElementById("waitingPackages"),
  inTransitPackages: document.getElementById("inTransitPackages"),
  totalPackages: document.getElementById("totalPackages"),
  selectedRestaurantTitle: document.getElementById("selectedRestaurantTitle"),
  packagePanelTitle: document.getElementById("packagePanelTitle"),
  restaurantStatsBoard: document.getElementById("restaurantStatsBoard"),
  courierForm: document.getElementById("courierForm"),
  courierZone: document.getElementById("courierZone"),
  courierList: document.getElementById("courierList"),
  zoneBoard: document.getElementById("zoneBoard"),
  packageList: document.getElementById("packageList"),
  webhookLogList: document.getElementById("webhookLogList"),
  auditLogList: document.getElementById("auditLogList"),
  restaurantFilter: document.getElementById("restaurantFilter"),
  searchInput: document.getElementById("searchInput"),
  template: document.getElementById("adminPackageTemplate"),
};

function adminHeaders() {
  return authHeaders(adminState.token);
}

function setAdminLoggedIn(isLoggedIn) {
  adminRefs.loginPanel.classList.toggle("hidden", isLoggedIn);
  adminRefs.workspace.classList.toggle("hidden", !isLoggedIn);
}

function bootstrapPath() {
  const params = new URLSearchParams();
  if (adminState.selectedRestaurantId) {
    params.set("restaurantId", adminState.selectedRestaurantId);
  }
  const query = params.toString();
  return query ? `/api/admin/bootstrap?${query}` : "/api/admin/bootstrap";
}

async function loadAdminState() {
  if (!adminState.token) {
    setAdminLoggedIn(false);
    return;
  }

  const data = await api(bootstrapPath(), {
    headers: adminHeaders(),
  });
  hydrateAdmin(data);
}

function renderAdminStats(stats) {
  adminRefs.activeCouriers.textContent = stats.activeCouriers;
  adminRefs.waitingPackages.textContent = stats.waitingPackages;
  adminRefs.inTransitPackages.textContent = stats.inTransitPackages;
  adminRefs.totalPackages.textContent = stats.totalPackages;
  const focusLabel = adminState.selectedRestaurantId ? "Secili restoran filtresi aktif." : "Tum restoranlar gorunuyor.";
  adminRefs.summary.textContent =
    `${stats.assignedPackages} paket otomatik atandi. ${stats.waitingPackages} paket hala uygun kurye bekliyor. ${focusLabel}`;
}

function renderRestaurantFilter(restaurants) {
  adminRefs.restaurantFilter.innerHTML = ['<option value="">Tum Restoranlar</option>']
    .concat(restaurants.map((restaurant) => `<option value="${restaurant.id}">${restaurant.name}</option>`))
    .join("");
  adminRefs.restaurantFilter.value = adminState.selectedRestaurantId;
}

function renderRestaurantStats(restaurants, stats, packages) {
  adminRefs.restaurantStatsBoard.innerHTML = "";

  const selectedRestaurant = restaurants.find((restaurant) => restaurant.id === adminState.selectedRestaurantId) || null;
  const title = selectedRestaurant ? `${selectedRestaurant.name} Operasyon Ozet` : "Tum Restoranlar Operasyon Ozet";
  const panelTitle = selectedRestaurant ? `${selectedRestaurant.name} Paketleri` : "Platform Kaynakli Tum Paketler";
  adminRefs.selectedRestaurantTitle.textContent = title;
  adminRefs.packagePanelTitle.textContent = panelTitle;

  const deliveredCount = packages.filter((pkg) => pkg.status === "delivered").length;
  const assignedCount = packages.filter((pkg) => pkg.status === "assigned").length;
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
        <span class="soft-badge">${courier.available ? "Aktif Kurye" : "Pasif Kurye"}</span>
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
      });
      hydrateAdmin(data);
    });

    actions.appendChild(toggleButton);
    card.appendChild(actions);
    adminRefs.courierList.appendChild(card);
  });
}

function renderZoneBoard(zones) {
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

function buildPackageCard(pkg) {
  const node = adminRefs.template.content.cloneNode(true);
  const badge = node.querySelector(".status-badge");
  const select = node.querySelector(".status-select");
  const reassignButton = node.querySelector(".reassign-btn");

  node.querySelector(".tracking-no").textContent = `${pkg.trackingNo} - ${pkg.externalOrderNo} - ${formatDate(pkg.createdAt)}`;
  node.querySelector(".recipient-name").textContent = `${pkg.recipient} - ${pkg.phone}`;
  node.querySelector(".platform-name").textContent = pkg.sourcePlatform;
  node.querySelector(".restaurant-name").textContent = pkg.restaurantName;
  node.querySelector(".courier-name").textContent = pkg.assignedCourierName || "Kurye bekleniyor";
  node.querySelector(".distance-value").textContent = pkg.distanceKm === null ? "-" : `${pkg.distanceKm} km`;
  node.querySelector(".payment-method").textContent = pkg.paymentMethod;
  node.querySelector(".assignment-note").textContent = pkg.assignmentReason;
  node.querySelector(".note-text").textContent = `${pkg.zone} - ${pkg.address}${pkg.note ? ` - ${pkg.note}` : ""}`;

  badge.textContent = statusLabel(pkg.status);
  badge.className = `status-badge ${statusClassName(pkg.status)}`;
  select.innerHTML = createStatusOptions(pkg.status);
  select.value = pkg.status;

  select.addEventListener("change", async (event) => {
    const data = await api(`/api/admin/packages/${pkg.id}/status`, {
      method: "PATCH",
      headers: adminHeaders(),
      body: JSON.stringify({ status: event.target.value }),
    });
    hydrateAdmin(data);
  });

  reassignButton.addEventListener("click", async () => {
    const data = await api(`/api/admin/packages/${pkg.id}/reassign`, {
      method: "POST",
      headers: adminHeaders(),
      body: "{}",
    });
    hydrateAdmin(data);
  });

  return node;
}

function renderAdminPackages(packages) {
  adminRefs.packageList.innerHTML = "";
  const visible = packages.filter(packageVisible);

  if (visible.length === 0) {
    adminRefs.packageList.innerHTML = '<div class="empty-state">Aramana uyan paket bulunamadi.</div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  visible.forEach((pkg) => fragment.appendChild(buildPackageCard(pkg)));
  adminRefs.packageList.appendChild(fragment);
}

function renderWebhookLogs(logs) {
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
          <p>Imza: ${log.signatureValid ? "Gecerli" : "Hatali"} - HTTP ${log.responseStatus}</p>
        </div>
        <span class="soft-badge">${formatDate(log.createdAt)}</span>
      </div>
    `;
    adminRefs.webhookLogList.appendChild(card);
  });
}

function renderAuditLogs(logs) {
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

function hydrateAdmin(data) {
  adminState.data = data;
  setAdminLoggedIn(true);
  renderAdminStats(data.stats);
  setZoneOptions(adminRefs.courierZone, data.zones);
  renderRestaurantFilter(data.restaurants);
  renderRestaurantStats(data.restaurants, data.stats, data.packages);
  renderAdminCouriers(data.couriers);
  renderZoneBoard(data.zones);
  renderAdminPackages(data.packages);
  renderWebhookLogs(data.webhookLogs);
  renderAuditLogs(data.auditLogs || []);
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
  adminState.token = login.token;
  localStorage.setItem(ADMIN_TOKEN_KEY, login.token);
  adminRefs.loginForm.reset();
  await loadAdminState();
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
  const data = await api("/api/admin/couriers", {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify(payload),
  });
  adminRefs.courierForm.reset();
  hydrateAdmin(data);
});

adminRefs.searchInput.addEventListener("input", () => {
  if (adminState.data) {
    renderAdminPackages(adminState.data.packages);
  }
});

adminRefs.restaurantFilter.addEventListener("change", async (event) => {
  adminState.selectedRestaurantId = event.target.value;
  await loadAdminState();
});

loadAdminState().catch((error) => {
  adminRefs.summary.textContent = error.message;
  setAdminLoggedIn(false);
});

setInterval(() => {
  loadAdminState().catch(() => {
    // Keep current screen if a refresh request fails.
  });
}, ADMIN_REFRESH_MS);
