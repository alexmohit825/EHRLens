// EHRLens Service Worker v4.0 — Network-First Strategy
// Immediately purges all old caches on install/activate

const CACHE_NAME = 'ehrlens-shell-v4.0';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Always fetch fresh network first — fallback to cache only if completely offline
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
