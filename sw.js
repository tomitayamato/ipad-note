// オフライン対応：アプリ本体をキャッシュ（更新は次回起動時に反映）
const CACHE = 'ipad-note-v2';
const ASSETS = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/db.js',
  'js/editor.js',
  'js/pdf.js',
  'js/render.js',
  'js/settings.js',
  'js/ui.js',
  'manifest.json',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      if (cached) {
        e.waitUntil(network);
        return cached;
      }
      const res = await network;
      return res || (req.mode === 'navigate' ? cache.match('index.html') : Response.error());
    }),
  );
});
