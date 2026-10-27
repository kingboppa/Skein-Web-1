const C = 'skein-v2';
const ASSETS = ['./', 'index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(C).then(c => c.addAll(ASSETS))); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
/* Open instantly from the saved copy, then refresh it in the background; the page applies a newer copy the next time you come back. */
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const cdn = u.hostname === 'cdn.jsdelivr.net';
  if (u.origin !== location.origin && !cdn) return;
  e.respondWith(caches.open(C).then(async c => {
    const hit = await c.match(e.request);
    if (hit && cdn) return hit; // versioned library file: never changes
    const net = fetch(e.request, cdn ? undefined : { cache: 'no-cache' }).then(async r => {
      if (r && r.ok) {
        const old = hit && (hit.headers.get('etag') || hit.headers.get('last-modified'));
        const now = r.headers.get('etag') || r.headers.get('last-modified');
        await c.put(e.request, r.clone());
        if (hit && old && now && old !== now) {
          const cs = await self.clients.matchAll({ includeUncontrolled: true });
          cs.forEach(x => x.postMessage({ upd: 1 }));
        }
      }
      return r;
    });
    if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
    return net.catch(() => new Response('', { status: 504 }));
  }));
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
