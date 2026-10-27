/* Service worker «Справ»: запуск з іконки миттєвий і без інтернету.

   Номерів версій в адресах тут немає навмисно: сторінка й код беруться з
   мережі (з перевіркою, чи змінилися), а кеш — запасний варіант, коли
   мережі немає чи вона надто повільна. Тож нова версія приходить з першим
   же відкриттям, і нічого піднімати руками не треба. */

var CACHE = 'spravy-v2';

var SHELL = [
  './',
  './tasks.css',
  './tasks.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  './config.js'
];

var NET_TIMEOUT = 2500;

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      // один недоступний файл не має валити всю установку
      .then(function (c) { return Promise.allSettled(SHELL.map(function (u) { return c.add(u); })); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        // лише свої старі кеші
        return Promise.all(keys.filter(function (k) { return k.indexOf('spravy-') === 0 && k !== CACHE; })
          .map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // база, шрифти — повз кеш
  // Інші підпроєкти на цьому домені (напр. /mathhub/ — додаток Hola) мають
  // власні сторінки й service worker: не підміняємо їх оболонкою «Справ».
  if (url.pathname.indexOf('/mathhub/') === 0) return;
  if (/^\/invest(\/|$)/.test(url.pathname)) return;  // «Портфель», репозиторій invest

  var page = req.mode === 'navigate';
  e.respondWith(fresh(page ? new Request('./', { cache: 'no-cache' }) : req, page));
});

/**
 * Мережа з обмеженням часу; вдале — одразу в кеш. Не встигла чи немає
 * інтернету — збережена копія. Для сторінки ключ кешу один ('./'): з
 * будь-якою адресою на сайті відкривається той самий застосунок.
 */
function fresh(req, page) {
  return new Promise(function (resolve) {
    var done = false;
    function fromCache() {
      caches.match(req, { ignoreSearch: page }).then(function (hit) {
        if (done) return;
        if (hit) { done = true; resolve(hit); }
      });
    }
    var timer = setTimeout(fromCache, NET_TIMEOUT);
    fetch(req, { cache: 'no-cache' }).then(function (res) {
      clearTimeout(timer);
      if (res && res.ok && res.type === 'basic' && !res.redirected) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      if (!done) { done = true; resolve(res); }
    }).catch(function () {
      clearTimeout(timer);
      caches.match(req, { ignoreSearch: page }).then(function (hit) {
        if (done) return;
        done = true;
        resolve(hit || new Response('Немає зв\'язку, а збереженої копії ще немає. Відкрийте «Справи» з інтернетом один раз.', {
          status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        }));
      });
    });
  });
}
