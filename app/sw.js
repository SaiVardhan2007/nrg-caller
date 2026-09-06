const CACHE_NAME = "fnrg-preaching-v178";
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
  "./js/oneToOne.js",
  "./js/coreCultivation.js",
  "./js/activityLog.js",
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

// App shell: network-first. Always fetch the latest JS/HTML when online so
// code fixes reach an already-open tab/PWA session immediately instead of
// waiting for a stale-while-revalidate cache to catch up over two reloads.
// Falls back to the cache only when the network is unavailable (offline).
// All Supabase API calls go straight to the network untouched, same as before.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // let Supabase/CDN requests pass through untouched

  event.respondWith(
    fetch(event.request).then((networkResp) => {
      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, networkResp.clone()));
      return networkResp;
    }).catch(() => caches.match(event.request))
  );
});


