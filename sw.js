// Service Worker: macht die App offline startfähig.
// Eigene Dateien: "stale-while-revalidate" → sofort aus dem Cache, im Hintergrund aktualisieren
//   (neue Version ist beim übernächsten Öffnen aktiv). Bei jedem Update VERSION hochzählen.
// Firebase-Bibliothek (gstatic.com): cache-first, die Dateien sind versioniert und ändern sich nie.
const VERSION = 'bwz-v2';
const FB = '12.19.0';
const SHELL = [
  './', './index.html', './style.css', './app.js', './config.js',
  './backend-firebase.js', './backend-mock.js', './import-data.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './apple-touch-icon.png'
];
const FIREBASE = ['app', 'auth', 'firestore'].map(m => `https://www.gstatic.com/firebasejs/${FB}/firebase-${m}.js`);

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await c.addAll(SHELL);
    // Firebase best effort – falls es hier scheitert, wird es beim ersten Laden zur Laufzeit gecached
    await Promise.all(FIREBASE.map(u => c.add(new Request(u, { mode: 'cors' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
    e.respondWith((async () => {
      const c = await caches.open(VERSION);
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    })());
    return;
  }

  if (url.origin !== self.location.origin) return;   // Firestore/Auth-Verkehr nicht anfassen

  e.respondWith((async () => {
    const c = await caches.open(VERSION);
    const key = req.mode === 'navigate' ? './index.html' : req;
    const hit = await c.match(key, { ignoreSearch: true });
    const net = fetch(req).then(res => {
      if (res.ok) c.put(key, res.clone());
      return res;
    }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    return (await net) || new Response('Offline und nicht im Cache', { status: 503 });
  })());
});
