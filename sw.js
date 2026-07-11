// sw.js — DLS Hub Service Worker
// Handles PWA install + background push notifications
const CACHE_NAME = "dls-hub-v2";

self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(self.clients.claim()); });

self.addEventListener("fetch", (e) => {
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});

// ── Push notification handler ──────────────────────────────
self.addEventListener("push", (e) => {
  if (!e.data) return;
  let data = {};
  try { data = e.data.json(); } catch (_) { data = { title: "DLS Hub", body: e.data.text() }; }

  const title   = data.title || "DLS Hub";
  const options = {
    body:    data.body  || "You have a new notification",
    icon:    data.icon  || "/public/icons/icon-192.png",
    badge:   "/public/icons/icon-192.png",
    tag:     data.tag   || "dls-hub",
    data:    { url: data.url || "/" },
    vibrate: [200, 100, 200],
    actions: data.actions || [],
  };

  e.waitUntil(self.registration.showNotification(title, options));
});

// ── Tap notification → open/focus the app ─────────────────
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = e.notification.data?.url || "/";
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          client.focus();
          client.navigate(url);
          return;
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
