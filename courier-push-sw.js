const COURIER_PAGE = "/courier.html";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json?.() || {};
  } catch {
    payload = { body: event.data?.text?.() || "Yeni paket atandi." };
  }

  const title = payload.title || "Delivera Express - Yeni Paket";
  const options = {
    body: payload.body || "Yeni bir paketiniz var.",
    tag: payload.tag || "delivera-new-package",
    data: {
      url: payload.url || COURIER_PAGE,
      packageId: payload.packageId || "",
    },
    requireInteraction: true,
    renotify: true,
    vibrate: [300, 100, 300, 100, 600],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || COURIER_PAGE, self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).pathname === COURIER_PAGE);
    if (existing) {
      await existing.navigate(targetUrl);
      return existing.focus();
    }
    return self.clients.openWindow(targetUrl);
  })());
});
