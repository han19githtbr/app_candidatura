const CACHE_NAME = "radar-vagas-v2";
const APP_ASSETS = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/index.js",
  "./database/data.json",
  "./manifest.json",
  "./assets/icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html")))
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "NEW_JOBS") return;

  const count = event.data.count || 0;
  self.registration.showNotification("Radar de Vagas", {
    body: `${count} vaga${count === 1 ? "" : "s"} com bom encaixe para o seu perfil.`,
    icon: "./assets/icon.svg",
    badge: "./assets/icon.svg",
    data: { url: "./index.html" }
  });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data?.url || "./index.html"));
});
