const CACHE_NAME = "fnrg-preaching-v251";
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
  "./js/limitedAccess.js",
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

// App shell: network-first, but racing a timeout against the cache. A cold
// launch (app opened fresh from the home screen, not resumed from Recents)
// has to spin up DNS/TLS/TCP from scratch, which can take many seconds on a
// weak signal — and since this handler used to always await the network,
// the splash logo would sit there the whole time. Now, if a cached shell
// exists, a slow network falls back to it after NETWORK_TIMEOUT_MS so the
// app opens instantly; the network fetch keeps running in the background
// and still updates the cache, so code fixes still reach the next open.
// Falls back to the cache on outright network failure (offline) too.
// All Supabase API calls go straight to the network untouched, same as before.
const NETWORK_TIMEOUT_MS = 2500;

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // let Supabase/CDN requests pass through untouched

  event.respondWith(
    (async () => {
      const cached = await caches.match(event.request);

      const networkFetch = fetch(event.request).then((networkResp) => {
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, networkResp.clone()));
        return networkResp;
      });

      if (!cached) return networkFetch.catch(() => caches.match(event.request));

      const timeout = new Promise((resolve) => setTimeout(() => resolve(cached), NETWORK_TIMEOUT_MS));
      return Promise.race([networkFetch.catch(() => cached), timeout]);
    })()
  );
});

// Web Push: the send-push Edge Function's payload is JSON
// { title, body, url, badgeCount }. badgeCount is that recipient's current
// total pending (My Calls + Core Cultivation) at send time, so the OS
// app-icon badge stays right even when the notification arrives while the
// app/phone is closed — it's not just a "1 per push" counter.
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }

  event.waitUntil((async () => {
    await self.registration.showNotification(data.title || "NRG Caller", {
      body: data.body || "",
      icon: "./icons/icon-192.png",
      // Android renders this as a solid-color silhouette from its alpha
      // channel — icon-192.png has none (opaque square), which showed as a
      // blank box. notification-badge.png is a transparent-background
      // silhouette derived from icon-512.png just for this purpose.
      badge: "./icons/notification-badge.png",
      data: { url: data.url || "./" },
    });

    if ("setAppBadge" in self.navigator && typeof data.badgeCount === "number") {
      if (data.badgeCount > 0) self.navigator.setAppBadge(data.badgeCount).catch(() => {});
      else self.navigator.clearAppBadge?.().catch(() => {});
    }
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "./";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});


