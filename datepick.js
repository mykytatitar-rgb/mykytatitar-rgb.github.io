/* Вибір дати для «Справ».

   Рідний <input type="date"> малює календар мовою браузера: в англійському
   Chrome тиждень починається з неділі, а дата пишеться як 11/16/2026.
   Цим не можна керувати зі сторінки, тому календарик свій: тиждень з
   понеділка, назви українською, дата як 16.11.2026.

   Дата скрізь — рядок 'YYYY-MM-DD' (як у збережених завданнях), '' — без дати. */

(function () {
  'use strict';

  var MONTHS = ['Січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень',
    'Липень', 'Серпень', 'Вересень', 'Жовтень', 'Листопад', 'Грудень'];
  var WEEK = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parse(s) { var p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function isDay(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }

  /** '2026-11-16' → '16.11.2026'; порожнє лишається порожнім. */
  function label(s) { return isDay(s) ? s.slice(8, 10) + '.' + s.slice(5, 7) + '.' + s.slice(0, 4) : ''; }

  /** 42 дні сітки місяця m (0–11) року y: з понеділка тижня, де лежить перше число. */
  function grid(y, m) {
    var first = new Date(y, m, 1);
    var start = new Date(y, m, 1 - (first.getDay() + 6) % 7);
    var out = [];
    for (var i = 0; i < 42; i++) out.push(iso(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)));
    return out;
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  var current = null;   // відкритий календарик: { box, close }

  /** Відкрити календарик під anchor. onPick(дата або '') — коли людина обрала. */
  function open(anchor, value, onPick) {
    if (current) current.close();
    var now = new Date(), today = iso(now);
    var base = isDay(value) ? parse(value) : now;
    var y = base.getFullYear(), m = base.getMonth();

    var box = el('div', 'dp');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Обрати дату');
    var prev = el('button', 'dp-nav', '‹'), next = el('button', 'dp-nav', '›');
    prev.type = next.type = 'button';
    prev.setAttribute('aria-label', 'Попередній місяць');
    next.setAttribute('aria-label', 'Наступний місяць');
    var title = el('div', 'dp-title');
    var head = el('div', 'dp-head');
    head.append(prev, title, next);
    var days = el('div', 'dp-grid');
    var clear = el('button', 'dp-link', 'Очистити'), todayBtn = el('button', 'dp-link', 'Сьогодні');
    clear.type = todayBtn.type = 'button';
    var foot = el('div', 'dp-foot');
    foot.append(clear, todayBtn);
    box.append(head, days, foot);

    function paint() {
      title.textContent = MONTHS[m] + ' ' + y;
      days.replaceChildren();
      WEEK.forEach(function (w, i) { days.append(el('span', 'dp-wd' + (i > 4 ? ' we' : ''), w)); });
      grid(y, m).forEach(function (d, i) {
        var b = el('button', 'dp-day', String(+d.slice(8)));
        b.type = 'button';
        b.dataset.day = d;
        if (+d.slice(5, 7) - 1 !== m) b.classList.add('out');
        if (i % 7 > 4) b.classList.add('we');
        if (d === today) b.classList.add('today');
        if (d === value) { b.classList.add('sel'); b.setAttribute('aria-pressed', 'true'); }
        b.setAttribute('aria-label', label(d));
        days.append(b);
      });
    }
    function shift(n) { m += n; if (m < 0) { m = 11; y--; } if (m > 11) { m = 0; y++; } paint(); }
    function pick(d) { close(); onPick(d); }

    prev.addEventListener('click', function () { shift(-1); });
    next.addEventListener('click', function () { shift(1); });
    days.addEventListener('click', function (e) { var b = e.target.closest('.dp-day'); if (b) pick(b.dataset.day); });
    clear.addEventListener('click', function () { pick(''); });
    todayBtn.addEventListener('click', function () { pick(today); });

    // Escape і клік повз закривають лише календарик, а не картку під ним
    function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); anchor.focus(); } }
    function onDown(e) { if (!box.contains(e.target) && !anchor.contains(e.target)) close(); }
    function close() {
      if (current !== api) return;
      current = null;
      box.remove();
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
      anchor.setAttribute('aria-expanded', 'false');
    }
    var api = { box: box, close: close };
    current = api;

    paint();
    document.body.append(box);
    place(box, anchor);
    anchor.setAttribute('aria-expanded', 'true');
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    var sel = box.querySelector('.dp-day.sel') || box.querySelector('.dp-day.today');
    if (sel) sel.focus({ preventScroll: true });
    return api;
  }

  /** Під полем, а якщо внизу не влазить — над ним; ніколи не за краєм екрана. */
  function place(box, anchor) {
    var r = anchor.getBoundingClientRect(), w = box.offsetWidth, hgt = box.offsetHeight, gap = 6;
    var vw = document.documentElement.clientWidth, vh = window.innerHeight;
    var top = r.bottom + gap + hgt <= vh ? r.bottom + gap : Math.max(gap, r.top - gap - hgt);
    var left = Math.min(Math.max(gap, r.left), vw - w - gap);
    box.style.top = top + 'px';
    box.style.left = Math.max(gap, left) + 'px';
  }

  /** Поле дати: кнопка з датою (або «Без дати»), що відкриває календарик. */
  function field(id, value, onPick) {
    var b = el('button', 'dp-field');
    b.type = 'button';
    if (id) b.id = id;
    b.setAttribute('aria-haspopup', 'dialog');
    function show(v) { value = v; b.textContent = label(v) || 'Без дати'; b.classList.toggle('empty', !v); }
    show(value);
    b.addEventListener('click', function () {
      if (current && current.box.isConnected) { current.close(); return; }
      open(b, value, function (v) { show(v); onPick(v); });
    });
    return b;
  }

  window.SpravyDate = { open: open, field: field, label: label, grid: grid, isOpen: function () { return !!current; } };
})();
