// Offline: App-Shell vorab cachen, Kartenbilder und OCR-Dateien bei Gebrauch.
// API-Antworten liegen in IndexedDB (siehe js/api.js), nicht hier.
const VERSION = 'kw-v17';
const SHELL = [
  './', 'index.html', 'css/app.css', 'js/app.js', 'js/api.js', 'js/calc.js', 'js/db.js', 'js/ocr.js', 'js/grading.js', 'js/scanner.js', 'js/flip.js',
  'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'api.tcgdex.net') return; // IndexedDB übernimmt
  const sameOrigin = url.origin === self.location.origin;
  const isImage = url.hostname === 'assets.tcgdex.net';
  if (!sameOrigin && !isImage) return;

  // App-Code: Netz zuerst (Updates), sonst Cache. Bilder & OCR-Daten: Cache zuerst.
  const cacheFirst = isImage || url.pathname.includes('/vendor/');
  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const hit = await cache.match(req);
      if (cacheFirst && hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
        return res;
      } catch (err) {
        if (hit) return hit;
        if (req.mode === 'navigate') return cache.match('index.html');
        throw err;
      }
    }),
  );
});
