// Caches only the app's own shell files (html/css/js/icons/manifest) so the
// last-opened version keeps working with no signal. It never touches
// Firebase/Firestore traffic or Google Fonts — those are separate origins
// and are simply left alone (not intercepted below).
//
// Bump CACHE_NAME whenever you change the list of cached files, or whenever
// you bump a "?v=" on script.js / style.css / firebase-init.js in index.html,
// so old clients pick up the new set instead of being stuck on stale files.
const CACHE_NAME = "factory-shell-v9";

const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css?v=7",
  "./script.js?v=13",
  "./firebase-config.js",
  "./firebase-init.js?v=3",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Only handle our own same-origin GET requests. Everything else
  // (Firebase Auth/Firestore, Google Fonts, etc.) is left completely
  // untouched so this never interferes with the cloud sync.
  if(req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          // keep the cached shell fresh for next time we're offline
          if(res && res.ok){
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => cached); // offline: fall back to whatever we have

      // cache-first for instant loads; network still runs in the background
      // to refresh the cache for the next visit
      return cached || network;
    })
  );
});
