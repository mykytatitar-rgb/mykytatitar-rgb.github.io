/* Service worker «Портфеля»: запуск з іконки швидкий і працює без інтернету.

   Сторінка, код і дані беруться з мережі (з обмеженням часу), кеш лише запасний
   варіант. Тож нова версія приходить з першим відкриттям, номери версій піднімати
   не треба. Діє лише в межах /invest/; «Справи» в корені сайту мають свій. */

var CACHE = 'portfel-v1';
var DATA_HOST = 'raw.githubusercontent.com';

var SHELL = [
  './',
  './app.css',
  './app.js',
  './boot.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  './fonts/geologica-latin.woff2',
  './fonts/geologica-latin-ext.woff2',
  './fonts/geologica-cyrillic.woff2',
  './fonts/geologica-cyrillic-ext.woff2'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return Promise.allSettled(SHELL.map(function (u) { return c.add(u); })); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k.indexOf('portfel-') === 0 && k !== CACHE; })
          .map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);

  // Зашифровані дані з гілки invest-data: мережа, а без неї остання збережена копія
  if (url.hostname === DATA_HOST && url.pathname.indexOf('/invest-data/') > 0) {
    e.respondWith(fresh(req, new Request(url.origin + url.pathname), 6000, true));
    return;
  }
  if (url.origin !== self.location.origin) return;
  var scope = new URL(self.registration.scope).pathname;
  if (url.pathname.indexOf(scope) !== 0) return;

  if (req.mode === 'navigate') {
    e.respondWith(fresh(new Request('./', { cache: 'no-cache' }), new Request('./'), 3000, false));
    return;
  }
  e.respondWith(fresh(req, req, 3000, false));
});

/**
 * Мережа з обмеженням часу; вдалу відповідь одразу кладемо в кеш під ключем key.
 * Не встигла чи немає інтернету: збережена копія. Для даних додаємо позначку
 * X-Portfel-Cache, щоб сторінка написала «офлайн».
 */
function fresh(req, key, timeout, mark) {
  return new Promise(function (resolve) {
    var done = false;
    function fromCache(final) {
      return caches.match(key, { ignoreSearch: true }).then(function (hit) {
        if (done) return;
        if (hit) { done = true; resolve(mark ? tag(hit) : hit); return; }
        if (final) {
          done = true;
          resolve(new Response('Немає зв\'язку, а збереженої копії ще немає. Відкрий «Портфель» з інтернетом один раз.', {
            status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          }));
        }
      });
    }
    var timer = setTimeout(function () { fromCache(false); }, timeout);
    fetch(req, { cache: 'no-cache' }).then(function (res) {
      clearTimeout(timer);
      if (res && res.ok && !res.redirected && (res.type === 'basic' || res.type === 'cors')) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(key, copy); });
      }
      if (!done) { done = true; resolve(res); }
    }).catch(function () {
      clearTimeout(timer);
      fromCache(true);
    });
  });
}

function tag(res) {
  var headers = new Headers(res.headers);
  headers.set('X-Portfel-Cache', '1');
  // Дані з іншого домену: сторінка побачить позначку, лише якщо її явно відкрити
  headers.set('Access-Control-Expose-Headers', 'X-Portfel-Cache');
  return res.blob().then(function (body) {
    return new Response(body, { status: res.status, statusText: res.statusText, headers: headers });
  });
}
