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
  waiting: "Havuzda Bekliyor",
  assigned: "Kuryeye Atandi",
  picked_up: "Kurye Aldi",
  delivered: "Teslim Edildi",
  cancelled: "Iptal Edildi",
};
const STATUS_OPTIONS = ["waiting", "assigned", "picked_up", "delivered", "cancelled"];

async function api(path, options = {}) {
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

  if (!response.ok) {
    throw new Error(data.error || "Bir hata olustu.");
  }

  return data;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("tr-TR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
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
