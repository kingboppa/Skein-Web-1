const C = 'skein-v1';
const ASSETS = ['./', 'index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(C).then(c => c.addAll(ASSETS))); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (u.origin === location.origin || u.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(fetch(e.request).then(r => { const cp = r.clone(); caches.open(C).then(c => c.put(e.request, cp)); return r; })
      .catch(() => caches.match(e.request)));
  }
});

/* notifications */
self.addEventListener('push', e => {
  let d = { t: 'Skein', b: 'New message', g: 'sk' };
  try { if (e.data) d = Object.assign(d, e.data.json()); } catch (x) { /* show the generic one */ }
  e.waitUntil(self.registration.showNotification(String(d.t || 'Skein').slice(0, 60), {
    body: String(d.b || 'New message').slice(0, 140), tag: String(d.g || 'sk').slice(0, 60), renotify: true,
    icon: 'icon-192.png', badge: 'icon-192.png', data: { g: d.g }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const g = e.notification.data && e.notification.data.g;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    for (const c of cs) { if ('focus' in c) { if (g) c.postMessage({ open: g }); return c.focus(); } }
    return self.clients.openWindow('./');
  }));
});
