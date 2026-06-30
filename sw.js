const CACHE = "yarchat-v4";
const SHELL = ["/", "/index.html", "/style.css", "/client.js", "/manifest.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Не чіпаємо socket.io та API — нехай йдуть в мережу напряму
  if (url.pathname.startsWith("/socket.io/") || url.pathname.startsWith("/upload") || url.pathname.startsWith("/api/")) {
    return;
  }

  // App shell: cache-first
  if (SHELL.includes(url.pathname)) {
    e.respondWith(
      caches.match(e.request).then((cached) => cached || fetch(e.request))
    );
    return;
  }

  // Завантажені файли (фото/відео/голосові): cache-first з фоновим оновленням
  if (url.pathname.startsWith("/uploads/")) {
    e.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(e.request);
        const networkFetch = fetch(e.request)
          .then((res) => {
            cache.put(e.request, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || networkFetch;
      })
    );
    return;
  }

  // Все інше: мережа з фолбеком на кеш
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
