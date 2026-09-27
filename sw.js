// EHRLens Service Worker v3.0
// Caches the app shell for instant offline load.
// API responses are NEVER cached — zero PHI persistence.

const CACHE_NAME = 'ehrlens-shell-v3.1';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/styles.css?v=3.1',
  '/app.js?v=3.1',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Never intercept API calls — always live network
  if (url.pathname.startsWith('/api/') || url.hostname.includes('workers.dev')) return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
