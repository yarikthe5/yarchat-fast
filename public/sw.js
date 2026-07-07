const CACHE = "yarchat-v5";
const SHELL = ["/", "/index.html", "/style.css", "/app.js", "/manifest.json"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith("/socket.io/") ||
      url.pathname.startsWith("/upload") ||
      url.pathname.startsWith("/api/")) return;

  if (SHELL.includes(url.pathname)) {
    e.respondWith(caches.match(e.request).then(c => c || fetch(e.request)));
    return;
  }
  if (url.pathname.startsWith("/uploads/")) {
    e.respondWith(caches.open(CACHE).then(async cache => {
      const cached = await cache.match(e.request);
      const net = fetch(e.request)
        .then(r => { cache.put(e.request, r.clone()); return r; })
        .catch(() => cached);
      return cached || net;
    }));
    return;
  }
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});

self.addEventListener("push", e => {
  if (!e.data) return;
  let data = {};
  try { data = JSON.parse(e.data.text()); } catch { data = { title: "Yarchat", body: e.data.text() }; }
  e.waitUntil(self.registration.showNotification(data.title || "Yarchat", {
    body: data.body || "Нове повідомлення",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: "yarchat-msg",
    renotify: true,
    data: { url: "/" },
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(cls => {
      for (const c of cls) {
        if (c.url.includes(self.location.origin) && "focus" in c) return c.focus();
      }
      return clients.openWindow("/");
    })
  );
});
