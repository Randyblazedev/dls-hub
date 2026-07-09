// sw.js — minimal service worker, required for installability.
// Pass-through fetch for now; add real caching later if offline support is wanted.
const CACHE_NAME = "dls-hub-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (e) => {
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
