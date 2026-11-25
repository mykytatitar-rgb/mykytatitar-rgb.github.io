/* Service worker «Справ»: запуск з іконки миттєвий і без інтернету.

   Номерів версій в адресах тут немає навмисно: сторінка й код беруться з
   мережі (з перевіркою, чи змінилися), а кеш — запасний варіант, коли
   мережі немає чи вона надто повільна. Тож нова версія приходить з першим
   же відкриттям, і нічого піднімати руками не треба. */

var CACHE = 'spravy-v5';

var SHELL = [
  './',
  './tasks.css',
  './tasks.js',
  './datepick.js',
  './avatar.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  './config.js',
  './lingo.js',
  './calendar.js'
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

  if (req.mode === 'navigate') {
    e.respondWith(fresh(new Request('./', { cache: 'no-cache' }), true, false).then(function (r) {
      if (r.net && e.resultingClientId) netTabs[e.resultingClientId] = 1;
      return r.res;
    }));
    return;
  }
  e.respondWith(fresh(req, false, !!netTabs[e.clientId]).then(function (r) { return r.res; }));
});

/* Вкладки, чию сторінку взято з мережі. Їхні скрипти теж беремо з мережі,
   хай і повільної: інакше після викладки нова сторінка могла зібратися зі
   старим lingo.js із кешу, і нові можливості тихо зникали. Кеш для них —
   лише коли мережа зовсім не відповіла. */
var netTabs = {};

/**
 * Мережа з обмеженням часу; вдале — одразу в кеш. Не встигла чи немає
 * інтернету — збережена копія. Для сторінки ключ кешу один ('./'): з
 * будь-якою адресою на сайті відкривається той самий застосунок.
 * patient — не підміняти кешем через таймер, чекати мережу.
 * Результат: { res, net } — відповідь і чи прийшла вона з мережі.
 */
function fresh(req, page, patient) {
  return new Promise(function (resolve) {
    var done = false;
    function fromCache() {
      caches.match(req, { ignoreSearch: page }).then(function (hit) {
        if (done) return;
        if (hit) { done = true; resolve({ res: hit, net: false }); }
      });
    }
    var timer = patient ? null : setTimeout(fromCache, NET_TIMEOUT);
    fetch(req, { cache: 'no-cache' }).then(function (res) {
      clearTimeout(timer);
      if (res && res.ok && res.type === 'basic' && !res.redirected) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      if (!done) { done = true; resolve({ res: res, net: true }); }
    }).catch(function () {
      clearTimeout(timer);
      caches.match(req, { ignoreSearch: page }).then(function (hit) {
        if (done) return;
        done = true;
        resolve({ net: false, res: hit || new Response('Немає зв\'язку, а збереженої копії ще немає. Відкрийте «Справи» з інтернетом один раз.', {
          status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        }) });
      });
    });
  });
}

/* ---------- нагадування (Web Push) ----------
   Сервер (функція nudge) надсилає { title, body, url, tag }: зранку, перед справою з часом,
   увечері. Дотик відкриває потрібний екран: у вже відкритому вікні або в новому. */
self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Справи', {
    body: d.body || '', tag: d.tag || 'spravy', icon: './icon-192.png', badge: './icon-192.png', data: { url: d.url || './' }
  }));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    var w = list[0];
    if (!w) return self.clients.openWindow(url);
    return w.focus().then(function () { return w.navigate ? w.navigate(url) : null; })
      .catch(function () { return self.clients.openWindow(url); });
  }));
});
