const STORAGE_TOKEN_KEY = "kuryeTakipCourierToken";
const LOCATION_PUSH_MS = 15_000;

const courierState = {
  token: localStorage.getItem(STORAGE_TOKEN_KEY) || "",
  data: null,
  watchId: null,
  lastCoords: null,
};

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
  stats: document.getElementById("courierStats"),
  packages: document.getElementById("courierPackages"),
  template: document.getElementById("courierPackageTemplate"),
};

function setLoggedIn(isLoggedIn) {
  courierRefs.loginPanel.classList.toggle("hidden", isLoggedIn);
  courierRefs.workspacePanel.classList.toggle("hidden", !isLoggedIn);
}

function setLocationStatus(message) {
  courierRefs.locationStatus.textContent = message;
}

function stopLocationWatch() {
  if (courierState.watchId !== null) {
    navigator.geolocation.clearWatch(courierState.watchId);
    courierState.watchId = null;
  }
}

function locationLabel(courier) {
  const gps = `${Number(courier.latitude).toFixed(5)}, ${Number(courier.longitude).toFixed(5)}`;
  const freshness = courier.lastLocationAt ? formatTimeAgo(courier.lastLocationAt) : "Konum daha paylasilmadi";
  return `${gps} - ${freshness}`;
}

function renderCourierStats(courier, packages) {
  courierRefs.stats.innerHTML = "";

  const delivered = packages.filter((pkg) => pkg.status === "delivered").length;
  const inTransit = packages.filter((pkg) => pkg.status === "picked_up").length;

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
      <strong>${courier.available ? "Aktif" : "Pasif"}</strong>
    </article>
    <article class="mini-stat-card">
      <span>Canli GPS</span>
      <strong class="gps-stat">${locationLabel(courier)}</strong>
    </article>
  `;
}

function renderPackages(packages) {
  courierRefs.packages.innerHTML = "";

  if (packages.length === 0) {
    courierRefs.packages.innerHTML = '<div class="empty-state">Bu kuryeye atanmis paket yok.</div>';
    return;
  }

  const fragment = document.createDocumentFragment();

  packages.forEach((pkg) => {
    const node = courierRefs.template.content.cloneNode(true);
    const badge = node.querySelector(".status-badge");
    const select = node.querySelector(".status-select");

    node.querySelector(".tracking-no").textContent = `${pkg.trackingNo} - ${pkg.externalOrderNo}`;
    node.querySelector(".recipient-name").textContent = `${pkg.recipient} - ${pkg.phone}`;
    node.querySelector(".platform-name").textContent = pkg.sourcePlatform;
    node.querySelector(".restaurant-name").textContent = pkg.restaurantName;
    node.querySelector(".zone-name").textContent = `${pkg.zone} - ${pkg.address}`;
    node.querySelector(".eta-value").textContent = pkg.eta;
    node.querySelector(".payment-method").textContent = pkg.paymentMethod;
    node.querySelector(".note-text").textContent = `${pkg.note || "Ek not yok."} - ${formatDate(pkg.createdAt)}`;

    badge.textContent = statusLabel(pkg.status);
    badge.className = `status-badge ${statusClassName(pkg.status)}`;
    select.innerHTML = createStatusOptions(pkg.status, ["assigned", "picked_up", "delivered"]);
    select.value = pkg.status === "waiting" ? "assigned" : pkg.status;

    select.addEventListener("change", async (event) => {
      const data = await api(`/api/courier/packages/${pkg.id}/status`, {
        method: "PATCH",
        headers: authHeaders(courierState.token),
        body: JSON.stringify({ status: event.target.value }),
      });
      hydrateCourierWorkspace(data);
    });

    fragment.appendChild(node);
  });

  courierRefs.packages.appendChild(fragment);
}

function syncAvailabilityButton(courier) {
  courierRefs.availabilityButton.textContent = courier.available ? "Pasife Al" : "Aktife Al";
}

function hydrateCourierWorkspace(data) {
  courierState.data = data;
  setLoggedIn(true);
  courierRefs.name.textContent = data.courier.name;
  courierRefs.summary.textContent =
    `${data.courier.name} hesabi ile giris yapildi. ${data.packages.length} paket bulundu.`;
  setLocationStatus(data.courier.lastLocationAt ? `Canli konum aktif. Son guncelleme ${formatTimeAgo(data.courier.lastLocationAt)}.` : "Konum izni verilirse admin paneli seni canli gorur.");
  syncAvailabilityButton(data.courier);
  renderCourierStats(data.courier, data.packages);
  renderPackages(data.packages);
}

async function pushCourierLocation(payload) {
  const data = await api("/api/courier/location", {
    method: "PATCH",
    headers: authHeaders(courierState.token),
    body: JSON.stringify(payload),
  });
  hydrateCourierWorkspace(data);
  return data;
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

      if (!moved) {
        setLocationStatus("Canli konum acik. Konum sabit, yeni veri bekleniyor.");
        return;
      }

      courierState.lastCoords = coords;
      setLocationStatus("Canli konum admine gonderiliyor...");
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
      maximumAge: LOCATION_PUSH_MS,
      timeout: 12_000,
    }
  );
}

async function loadCourierWorkspace() {
  if (!courierState.token) {
    setLoggedIn(false);
    return;
  }

  try {
    const data = await api("/api/courier/me", {
      headers: authHeaders(courierState.token),
    });
    hydrateCourierWorkspace(data);
  } catch (error) {
    localStorage.removeItem(STORAGE_TOKEN_KEY);
    courierState.token = "";
    setLoggedIn(false);
    courierRefs.summary.textContent = error.message;
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
  courierState.token = data.token;
  localStorage.setItem(STORAGE_TOKEN_KEY, data.token);
  const workspace = await api("/api/courier/me", {
    headers: authHeaders(courierState.token),
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
  courierState.token = "";
  courierState.data = null;
  courierState.lastCoords = null;
  localStorage.removeItem(STORAGE_TOKEN_KEY);
  setLoggedIn(false);
  setLocationStatus("Konum kapatildi.");
  courierRefs.summary.textContent = "Cikis yapildi.";
});

window.addEventListener("beforeunload", stopLocationWatch);

loadCourierWorkspace();
