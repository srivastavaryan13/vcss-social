// VCSS Social CRM  –  Service Worker
// Caches the app shell for offline resilience. Bump CACHE_NAME on every deploy
// that changes index.html, css/style.css, or js/app.js.
const CACHE_NAME = "vcss-v2-3";

const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/style.css",
  "./js/app.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) { return cache.addAll(SHELL); })
  );
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE_NAME; })
            .map(function (k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

// Network-first for Supabase API calls; cache-first for shell assets.
self.addEventListener("fetch", function (event) {
  if (event.request.method !== "GET") return;
  var url = event.request.url;

  // Always hit network for Supabase
  if (url.includes("supabase.co")) {
    event.respondWith(fetch(event.request).catch(function () { return caches.match(event.request); }));
    return;
  }

  // Shell: cache-first with background update
  event.respondWith(
    caches.match(event.request).then(function (cached) {
      var network = fetch(event.request).then(function (response) {
        if (response && response.status === 200) {
          var copy = response.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, copy); });
        }
        return response;
      }).catch(function () { return cached; });
      return cached || network;
    })
  );
});
