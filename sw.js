// Service worker — офлайн-кэш приложения.
// Данные пользователя хранятся в localStorage (не здесь), кэшируется только код приложения.
const CACHE = 'konverty-1.0.0';
const ASSETS = [
  './',
  './index.html',
  './core.js',
  './manifest.webmanifest',
  './icon.svg'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Стратегия: сначала сеть (чтобы получать обновления), при офлайне — из кэша.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // Кэшируем только свой origin (код приложения). Кросс-доменные GET (api.github.com для синка, курсы валют)
  // НЕ кэшируем — иначе офлайн отдаёт устаревшие данные синхронизации и засоряется хранилище.
  const sameOrigin = new URL(e.request.url).origin === self.location.origin;
  if (!sameOrigin) return;   // пусть идёт обычным сетевым запросом, без вмешательства SW
  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return resp;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html')))
  );
});
