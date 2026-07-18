const CACHE_NAME = "nrg-caller-v1";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./css/theme.css",
  "./js/main.js",
  "./js/config.js",
  "./js/supabaseClient.js",
  "./js/utils.js",
  "./js/auth.js",
  "./js/admin.js",
  "./js/caller.js",
  "./js/reception.js",
  "./js/collection.js",
  "./manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// App shell: cache-first (instant load). All Supabase API calls go straight
// to the network (never cached) so data is always live.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // let Supabase/CDN requests pass through untouched

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request).then((networkResp) => {
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, networkResp.clone()));
        return networkResp;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
