// Caches only the app's own shell files (html/css/js/icons/manifest) so the
// last-opened version keeps working with no signal. It never touches
// Firebase/Firestore traffic or Google Fonts — those are separate origins
// and are simply left alone (not intercepted below).
//
// Bump CACHE_NAME whenever you change the list of cached files, or whenever
// you bump a "?v=" on script.js / style.css / firebase-init.js in index.html,
// so old clients pick up the new set instead of being stuck on stale files.
const CACHE_NAME = "factory-shell-v17";

const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css?v=9",
  "./script.js?v=19",
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

  // The page shell (index.html / "./" / any in-app navigation) is
  // NETWORK-FIRST: this is the one request that decides which version of
  // script.js/style.css gets loaded (via their "?v=" query strings), so it
  // must never be served stale-first — that was the bug that made a fixed
  // script.js sit deployed-but-invisible until several reloads happened.
  // Cache is only used as an offline fallback here.
  if(req.mode === "navigate" || req.url === self.registration.scope + "index.html"){
    event.respondWith(
      fetch(req)
        .then((res) => {
          if(res && res.ok){
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match("./index.html")))
    );
    return;
  }

  // Everything else (versioned script/style/js, icons, manifest) is safe to
  // serve cache-first for instant loads, since a real content change always
  // comes with a new "?v=" (a different URL / cache key), not an in-place
  // overwrite of the same URL.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if(res && res.ok){
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => cached); // offline: fall back to whatever we have

      return cached || network;
    })
  );
});
