/* Календар «Справ»: день, тиждень, місяць.

   Окремого сховища в календаря немає. Подія — це звичайне завдання з датою
   (due) і, за бажання, часом (start, end) та кольором (color); завдання без
   часу стоять у рядку «весь день». Усе читання й запис іде через api, який
   дає tasks.js, тож створене тут одразу є в списках, і навпаки.

   Сітка погодинна, 00:00–24:00, крок 15 хвилин. На комп'ютері: клік по
   слоту — швидка форма на годину, протягнути по сітці — задати тривалість,
   подію можна перетягнути на інший час чи день і розтягнути за нижній край.
   На телефоні: дотик — форма знизу, свайп убік — сусідній день. */

(function () {
  'use strict';

  var HOUR = 48;                 // висота години, px
  var SNAP = 15;                 // крок сітки, хвилин
  var DOW = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];
  var MONTH_SHOWN = 3;           // подій у клітинці місяця, решта — «ще N»
  var ALLDAY_SHOWN = 2;          // справ без часу в день, поки рядок «весь день» згорнуто
  var ALLDAY_BARS = 3;
  var SHORT = 30;
  var LIFT_MS = 400;
  var ECHO_MS = 450;             // клік, що браузер шле слідом за дотиком             // довге натискання пальцем, що піднімає подію                // подія до 30 хв — назва й час в один рядок           // смужок у тижні на телефоні

  /* ---------- дати й час (чисті функції) ---------- */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parse(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function add(s, n) { var d = parse(s); d.setDate(d.getDate() + n); return iso(d); }
  function monday(s) { return add(s, -((parse(s).getDay() + 6) % 7)); }
  function mins(t) { var p = String(t).split(':'); return +p[0] * 60 + +p[1]; }
  function hhmm(m) { m = Math.max(0, Math.min(1439, Math.round(m))); return pad(Math.floor(m / 60)) + ':' + pad(m % 60); }
  function range(s, e) { return hhmm(s) + '–' + (e >= 1440 ? '24:00' : hhmm(e)); }
  function snap(m) { return Math.max(0, Math.min(1440, Math.round(m / SNAP) * SNAP)); }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function noYearMark(s) { return s.replace(/\s*р\.$/, ''); }

  /** Початок і кінець події: кінець після початку, а без нього — година. Без початку — без часу. */
  function normTimes(start, end) {
    if (!start) return { start: '', end: '' };
    var s = mins(start), e = end ? mins(end) : 0;
    return { start: hhmm(s), end: e > s ? hhmm(e) : hhmm(Math.min(s + 60, 1439)) };
  }

  /** Дати повторів справи в межах [from, to], після самої дати due. Нічого не зберігається: лише для показу. */
  function occurrences(due, rep, from, to) {
    var out = [], dd = parse(due), d = due >= from ? add(due, 1) : from;
    for (; d <= to; d = add(d, 1)) {
      var x = parse(d), wd = x.getDay();
      if (rep === 'daily' || (rep === 'weekdays' && wd % 6 !== 0) || (rep === 'weekly' && wd === dd.getDay()) ||
          (rep === 'monthly' && x.getDate() === dd.getDate())) out.push(d);
    }
    return out;
  }

  /** Розкладка подій дня, що перетинаються: { id: { col, cols } } — стоять поруч, кожна у своїй колонці. */
  function layout(evs) {
    var out = {}, group = [], ends = [], groupEnd = -1;
    function close() { group.forEach(function (id) { out[id].cols = ends.length; }); group = []; ends = []; }
    evs.slice().sort(function (a, b) { return a.s - b.s || b.e - a.e; }).forEach(function (ev) {
      if (ev.s >= groupEnd) { close(); groupEnd = -1; }
      var c = ends.findIndex(function (end) { return end <= ev.s; });
      if (c < 0) { c = ends.length; ends.push(ev.e); } else ends[c] = ev.e;
      out[ev.id] = { col: c, cols: 1 };
      group.push(ev.id);
      groupEnd = Math.max(groupEnd, ev.e);
    });
    close();
    return out;
  }

  /* ---------- стан ---------- */
  var api = null, box = null, drag = null, pending = false, form = null, scrollKey = '';

  function view() { var v = api.ui().calView; return v === 'day' || v === 'week' || v === 'month' ? v : (api.mobile() ? 'day' : 'week'); }
  function anchor() { var d = api.ui().calDate; return /^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : api.today(); }
  function setState(v, d) { var u = api.ui(); u.calView = v; u.calDate = d; api.saveUi(); render(box, api); }
  function days() {
    var v = view(), a = anchor();
    if (v === 'day') return [a];
    var m = monday(a);
    return [0, 1, 2, 3, 4, 5, 6].map(function (i) { return add(m, i); });
  }
  function shift(dir) {
    var v = view(), a = anchor();
    if (v === 'day') return setState(v, add(a, dir));
    if (v === 'week') return setState(v, add(a, 7 * dir));
    var d = parse(a); d.setDate(1); d.setMonth(d.getMonth() + dir);
    setState(v, iso(d));
  }

  function title() {
    var v = view(), a = anchor(), d = parse(a);
    if (v === 'day') return cap(noYearMark(d.toLocaleDateString('uk-UA', api.mobile() ? { weekday: 'short', day: 'numeric', month: 'long' } : { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })));
    if (v === 'month') return cap(noYearMark(d.toLocaleDateString('uk-UA', { month: 'long', year: 'numeric' })));
    var w = days(), s = parse(w[0]), e = parse(w[6]), mon = api.mobile() ? 'short' : 'long';
    var dm = function (x) { return x.toLocaleDateString('uk-UA', { day: 'numeric', month: mon }); };
    return (s.getMonth() === e.getMonth() ? s.getDate() + '–' + dm(e) : dm(s) + ' – ' + dm(e)) + ' ' + e.getFullYear();
  }

  /* Події за датою: покажчик будується раз на малювання, а не перебором усіх завдань для кожного дня */
  var index = {};
  function buildIndex(from, to) {
    var m = {};
    function put(d, t) { (m[d] || (m[d] = [])).push(t); }
    api.tasks().forEach(function (t) {
      put(t.due, t);
      // повторювана справа — ще й на всіх майбутніх днях видимого періоду, блідою копією
      if (t.repeat && t.repeat !== 'none' && !t.done) occurrences(t.due, t.repeat, from, to).forEach(function (d) {
        put(d, Object.assign({}, t, { due: d, occ: true }));
      });
    });
    return m;
  }
  /** Перший і останній день, які зараз на екрані. */
  function visible() {
    if (view() !== 'month') { var ds = days(); return [ds[0], ds[ds.length - 1]]; }
    var a = parse(anchor()), s = monday(iso(new Date(a.getFullYear(), a.getMonth(), 1)));
    return [s, add(s, 41)];
  }
  function eventsOn(date) { return (index[date] || []).slice(); }
  /** Порядок у клітинці: справжні справи перед повторами, невиконані перед виконаними, далі за часом. */
  function byPlace(a, b) { return (!!a.occ - !!b.occ) || (a.done - b.done) || ((a.start || '') < (b.start || '') ? -1 : (a.start || '') > (b.start || '') ? 1 : 0); }
  function span(t) { var s = mins(t.start); return { s: s, e: t.end ? mins(t.end) : Math.min(s + 60, 1440) }; }

  /* ---------- малювання ---------- */
  function h() { return api.h.apply(null, arguments); }

  function render(container, a) {
    api = a; box = container;
    if (drag || dayDrag) { pending = true; return; }   // посеред перетягування не перемальовуємо
    pending = false;
    var vis = visible();
    index = buildIndex(vis[0], vis[1]);
    var old = container.querySelector('.cal-scroll'), top = old ? old.scrollTop : null;
    var v = view();
    var cal = h('section', { class: 'cal is-' + v },
      h('div', { class: 'cal-bar' },
        h('button', { type: 'button', class: 'btn cal-today', onclick: function () { setState(view(), api.today()); } }, 'Сьогодні'),
        h('button', { type: 'button', class: 'icon-btn cal-prev', 'aria-label': 'Назад', onclick: function () { shift(-1); } }, '‹'),
        h('button', { type: 'button', class: 'icon-btn cal-next', 'aria-label': 'Вперед', onclick: function () { shift(1); } }, '›'),
        h('h2', { class: 'cal-title' }, title()),
        h('div', { class: 'seg cal-views', role: 'group', 'aria-label': 'Вид' }, [['day', 'День'], ['week', 'Тиждень'], ['month', 'Місяць']].map(function (x) {
          return h('button', { type: 'button', 'aria-pressed': String(v === x[0]), onclick: function () { setState(x[0], anchor()); } }, x[1]);
        }))),
      v === 'month' ? month() : timed());
    container.replaceChildren(cal);
    var sc = cal.querySelector('.cal-scroll');
    if (!sc) return;
    var key = v;
    if (key === scrollKey && top != null) sc.scrollTop = top;
    else {
      var now = new Date(), withToday = days().indexOf(api.today()) >= 0;
      sc.scrollTop = Math.max(0, ((withToday ? now.getHours() : 8) - 1) * HOUR);
    }
    scrollKey = key;
  }

  function toggleAllday() { var u = api.ui(); u.calAllOpen = !u.calAllOpen; api.saveUi(); render(box, api); }

  function chip(t, withTime) {
    return h('button', { type: 'button', class: 'ev' + (t.done ? ' done' : '') + (t.occ ? ' rep' : ''), style: '--c:' + api.colorOf(t), 'data-id': t.id,
      onclick: function (e) { e.stopPropagation(); api.open(t.id); } },
      withTime && t.start ? h('span', { class: 'ev-time' }, t.start + ' ') : null, t.title || 'Без назви');
  }

  function timed() {
    var ds = days(), t0 = api.today(), cols = '--n:' + ds.length + ';grid-template-columns: 3.5rem repeat(' + ds.length + ', minmax(0, 1fr))';
    var head = h('div', { class: 'cal-head', style: cols }, h('div', {}), ds.map(function (d, i) {
      var dd = parse(d);
      return h('div', { class: 'cal-dayhead' + (d === t0 ? ' today' : '') },
        h('span', { class: 'dow' }, DOW[(dd.getDay() + 6) % 7]),
        h('button', { type: 'button', class: 'dnum', 'aria-label': 'Відкрити день', onclick: function () { setState('day', d); } }, dd.getDate()));
    }));
    // «весь день» згорнуто до ALLDAY_SHOWN справ на день, щоб сітці лишалось місце; кнопка розгортає
    // на телефоні в тижні колонки вузькі: замість обрізаних назв — кольорові смужки й «+N», дотик відкриває день
    var bars = api.mobile() && ds.length > 1;
    var open = !!api.ui().calAllOpen && !bars, many = false, limit = bars ? ALLDAY_BARS : ALLDAY_SHOWN;
    var cells = ds.map(function (d) {
      var evs = eventsOn(d).filter(function (t) { return !t.start; }).sort(byPlace);
      if (evs.length > limit) many = true;
      var shown = open ? evs : evs.slice(0, limit), rest = evs.length - shown.length;
      return h('div', { class: 'cell', 'data-date': d, onclick: bars ? function () { setState('day', d); } : null },
        shown.map(function (t) { return bars ? h('span', { class: 'ev bar' + (t.done ? ' done' : '') + (t.occ ? ' rep' : ''), style: '--c:' + api.colorOf(t), title: t.title }) : chip(t, false); }),
        rest ? h('button', { type: 'button', class: 'more-ev', onclick: bars ? null : toggleAllday }, bars ? '+' + rest : 'ще ' + rest) : null);
    });
    var allday = dayDragOn(h('div', { class: 'cal-allday' + (open ? ' open' : ''), style: cols },
      h('div', { class: 'gut' }, 'весь день',
        !bars && (many || open) ? h('button', { type: 'button', class: 'ad-toggle', 'aria-expanded': String(open), 'aria-label': open ? 'Згорнути' : 'Розгорнути',
          title: open ? 'Згорнути' : 'Показати все', onclick: toggleAllday }, open ? '▴' : '▾') : null),
      cells));
    var hours = h('div', { class: 'cal-hours' }, Array.from({ length: 24 }, function (_, i) { return h('span', { style: 'top:' + i * HOUR + 'px' }, i ? pad(i) + ':00' : ''); }));
    var grid = h('div', { class: 'cal-grid', style: cols + ';height:' + 24 * HOUR + 'px' }, hours, ds.map(function (d) { return column(d, d === t0); }));
    grid.addEventListener('pointerdown', down);
    grid.addEventListener('pointermove', move);
    grid.addEventListener('pointerup', up);
    grid.addEventListener('pointercancel', cancel);
    grid.addEventListener('touchmove', touchGuard, { passive: false });
    return [head, allday, h('div', { class: 'cal-scroll' }, grid)];
  }

  function column(d, isToday) {
    var evs = eventsOn(d).filter(function (t) { return t.start; });
    var lay = layout(evs.map(function (t) { var sp = span(t); return { id: t.id, s: sp.s, e: sp.e }; }));
    var col = h('div', { class: 'cal-col' + (isToday ? ' today' : ''), 'data-date': d }, evs.map(function (t) {
      var sp = span(t), L = lay[t.id];
      return h('div', { class: 'ev' + (t.done ? ' done' : '') + (t.occ ? ' rep' : '') + (sp.e - sp.s <= SHORT ? ' short' : ''), 'data-id': t.id, style: '--c:' + api.colorOf(t) + ';top:' + sp.s / 60 * HOUR + 'px;height:' +
          Math.max(18, (sp.e - sp.s) / 60 * HOUR - 2) + 'px;left:calc(' + L.col / L.cols * 100 + '% + 1px);width:calc(' + 100 / L.cols + '% - 3px)' },
        h('span', { class: 'ev-title' }, t.title || 'Без назви'),
        h('span', { class: 'ev-time' }, range(sp.s, sp.e)),
        h('span', { class: 'ev-handle', 'aria-hidden': 'true' }));
    }));
    if (isToday) { var n = new Date(); col.append(h('div', { class: 'now-line', style: 'top:' + (n.getHours() * 60 + n.getMinutes()) / 60 * HOUR + 'px' })); }
    return col;
  }

  function month() {
    var a = parse(anchor()), first = iso(new Date(a.getFullYear(), a.getMonth(), 1)), start = monday(first), t0 = api.today();
    var cells = Array.from({ length: 42 }, function (_, i) {
      var d = add(start, i), dd = parse(d), evs = eventsOn(d).sort(byPlace);
      return h('div', { class: 'cell' + (dd.getMonth() !== a.getMonth() ? ' out' : '') + (d === t0 ? ' today' : ''), 'data-date': d,
        onclick: function (e) {
          if (api.mobile()) return setState('day', d);   // клітинки дрібні: спершу подивитись день
          var r = e.currentTarget.getBoundingClientRect(); openForm({ date: d, start: '', end: '' }, e.clientX || r.left, e.clientY || r.top);
        } },
        h('button', { type: 'button', class: 'dnum', onclick: function (e) { e.stopPropagation(); setState('day', d); } }, dd.getDate()),
        evs.slice(0, MONTH_SHOWN).map(function (t) { return chip(t, true); }),
        evs.length > MONTH_SHOWN ? h('button', { type: 'button', class: 'more-ev', onclick: function (e) { e.stopPropagation(); setState('day', d); } }, 'ще ' + (evs.length - MONTH_SHOWN)) : null);
    });
    return dayDragOn(h('div', { class: 'cal-month' }, DOW.map(function (x) { return h('div', { class: 'mhead' }, x); }), cells));
  }

  /* ---------- перетягування по сітці ---------- */
  function minAt(col, y) { return (y - col.getBoundingClientRect().top) / HOUR * 60; }
  function colAt(grid, x) {
    var cs = grid.querySelectorAll('.cal-col');
    for (var i = 0; i < cs.length; i++) { var r = cs[i].getBoundingClientRect(); if (x >= r.left && x < r.right) return cs[i]; }
    return null;
  }

  function down(e) {
    if (e.button !== 0 || form) return;
    var col = e.target.closest('.cal-col'), el = e.target.closest('.ev');
    if (!col) return;
    var touch = e.pointerType !== 'mouse';
    drag = { grid: e.currentTarget, col: col, el: el, touch: touch, x0: e.clientX, y0: e.clientY, moved: false };
    if (el && el.classList.contains('rep')) drag.mode = 'open';          // повтор не перетягується: лише відкрити справу
    else if (el) {
      var t = api.task(el.dataset.id), sp = span(t);
      drag.mode = e.target.closest('.ev-handle') ? 'resize' : 'move';
      if (touch) drag.lift = setTimeout(function () { lift(drag, e.pointerId); }, LIFT_MS);
      drag.s = sp.s; drag.e = sp.e; drag.date = col.dataset.date; drag.grab = minAt(col, e.clientY) - sp.s;
    } else {
      drag.mode = 'create';
      drag.at = minAt(col, e.clientY);
    }
    if (!touch) { e.currentTarget.setPointerCapture(e.pointerId); e.preventDefault(); }
  }

  /* Пальцем: короткий дотик відкриває, свайп гортає дні, а довге натискання піднімає подію,
     і далі вона йде за пальцем (сітка в цей час не гортається). */
  function lift(d, pointerId) {
    if (!d || drag !== d || d.moved) return;
    d.lifted = true;
    d.el.classList.add('lifted');
    if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) {} }
    try { d.grid.setPointerCapture(pointerId); } catch (e) {}
  }
  function touchGuard(e) { if (drag && drag.lifted) e.preventDefault(); }

  function move(e) {
    var d = drag;
    if (!d || d.mode === 'open') return;
    if (d.touch && !d.lifted) {                   // ще не піднято: рух пальця — це гортання чи свайп
      if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > 8) clearTimeout(d.lift);
      return;
    }
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 5) return;
    d.moved = true;
    var len = d.e - d.s;
    if (d.mode === 'create') {
      var cur = minAt(d.col, e.clientY), a = Math.min(d.at, cur), b = Math.max(d.at, cur);
      d.ns = Math.floor(a / SNAP) * SNAP; d.ne = Math.max(d.ns + SNAP, snap(b));
      ghost(d.col, d.ns, d.ne);
    } else if (d.mode === 'move') {
      var col = colAt(d.grid, e.clientX) || d.col;
      d.ns = Math.max(0, Math.min(1440 - len, snap(minAt(col, e.clientY) - d.grab)));
      d.ndate = col.dataset.date;
      if (d.el.parentNode !== col) col.append(d.el);
      place(d.el, d.ns, d.ns + len, true);
    } else {
      d.ne = Math.max(d.s + SNAP, Math.min(1440, snap(minAt(d.col, e.clientY))));
      place(d.el, d.s, d.ne, false);
    }
  }

  function place(el, s, e, full) {
    el.style.top = s / 60 * HOUR + 'px';
    el.style.height = Math.max(18, (e - s) / 60 * HOUR - 2) + 'px';
    if (full) { el.style.left = '1px'; el.style.width = 'calc(100% - 3px)'; }
    el.classList.add('dragging');
    el.querySelector('.ev-time').textContent = range(s, e);
  }
  function ghost(col, s, e) {
    var g = col.querySelector('.ev.ghost') || col.appendChild(h('div', { class: 'ev ghost', style: '--c:' + api.defaultColor() }, h('span', { class: 'ev-time' })));
    g.style.top = s / 60 * HOUR + 'px';
    g.style.height = Math.max(18, (e - s) / 60 * HOUR - 2) + 'px';
    g.querySelector('.ev-time').textContent = range(s, e);
  }

  function up(e) {
    var d = drag;
    if (!d) return;
    drag = null;
    clearTimeout(d.lift);
    var dx = e.clientX - d.x0, dy = e.clientY - d.y0;
    if (d.lifted && !d.moved) return finish();     // підняли й відпустили на місці — нічого не міняємо
    if (d.touch && !d.lifted) {
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) return shift(dx < 0 ? 1 : -1);   // свайп
      if (Math.hypot(dx, dy) > 10) return finish();
    }
    if (!d.moved) {
      if (d.el) { finish(); return api.open(d.el.dataset.id); }
      var s = Math.floor(d.at / 30) * 30;
      ghost(d.col, s, Math.min(s + 60, 1440));
      return openForm({ date: d.col.dataset.date, start: hhmm(s), end: hhmm(Math.min(s + 60, 1439)) }, e.clientX, e.clientY);
    }
    if (d.mode === 'create') return openForm({ date: d.col.dataset.date, start: hhmm(d.ns), end: hhmm(Math.min(d.ne, 1439)) }, e.clientX, e.clientY);
    var t = api.task(d.el.dataset.id);
    if (t) {
      if (d.mode === 'move') {
        t.due = d.ndate || d.date;
        t.start = hhmm(d.ns); t.end = hhmm(Math.min(d.ns + d.e - d.s, 1439));
      } else t.end = hhmm(Math.min(d.ne, 1439));
      api.save();
    }
    finish();
  }
  function cancel() { if (drag) clearTimeout(drag.lift); drag = null; finish(); }

  /* ---------- «весь день» і місяць: перетягнути справу на інший день (мишкою) ---------- */
  var dayDrag = null;
  function dayDown(e) {
    var el = e.target.closest('.ev');
    if (e.button !== 0 || e.pointerType !== 'mouse' || form || !el || !el.dataset.id || /\b(rep|bar)\b/.test(el.className)) return;
    dayDrag = { root: e.currentTarget, el: el, id: el.dataset.id, x0: e.clientX, y0: e.clientY, moved: false, pointerId: e.pointerId };
  }
  function cellAt(root, x, y) {
    var cs = root.querySelectorAll('.cell[data-date]');
    for (var i = 0; i < cs.length; i++) { var r = cs[i].getBoundingClientRect(); if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) return cs[i]; }
    return null;
  }
  function dayMove(e) {
    var d = dayDrag;
    if (!d) return;
    var dx = e.clientX - d.x0, dy = e.clientY - d.y0;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 5) return;
      d.moved = true;                              // захоплюємо лише з першим рухом: простий клік і далі відкриває справу
      d.root.setPointerCapture(d.pointerId);
      d.el.classList.add('dragging');
    }
    d.el.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    d.root.querySelectorAll('.drop-day').forEach(function (c) { c.classList.remove('drop-day'); });
    var c = cellAt(d.root, e.clientX, e.clientY);
    if (c) c.classList.add('drop-day');
  }
  function dayUp(e) {
    var d = dayDrag;
    dayDrag = null;
    if (!d || !d.moved) return;
    var c = cellAt(d.root, e.clientX, e.clientY), t = api.task(d.id);
    if (c && t && t.due !== c.dataset.date) { t.due = c.dataset.date; api.save(); } else finish();
  }
  function dayCancel() { dayDrag = null; finish(); }
  function dayDragOn(root) {
    root.addEventListener('pointerdown', dayDown);
    root.addEventListener('pointermove', dayMove);
    root.addEventListener('pointerup', dayUp);
    root.addEventListener('pointercancel', dayCancel);
    return root;
  }
  function finish() { render(box, api); }

  /* ---------- швидка форма ---------- */
  function openForm(o, x, y) {
    if (form) closeForm();
    var color = api.defaultColor();
    var title = h('input', { name: 'title', class: 'calform-title', placeholder: 'Назва події', autocomplete: 'off', enterkeyhint: 'done', 'aria-label': 'Назва' });
    var start = h('input', { name: 'start', type: 'time', step: '900', value: o.start, 'aria-label': 'Початок' });
    var end = h('input', { name: 'end', type: 'time', step: '900', value: o.end, 'aria-label': 'Кінець' });
    var sw = h('div', { class: 'swatches' }, api.colors.map(function (c) {
      return h('button', { type: 'button', class: 'swatch', style: '--c:' + c, 'data-c': c, 'aria-label': 'Колір', 'aria-pressed': String(c === color),
        onclick: function () { color = c; sw.querySelectorAll('.swatch').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.c === c)); }); } });
    }));
    function save(e) {
      if (e) e.preventDefault();
      var name = title.value.trim();
      if (!name) { title.focus(); return; }
      var tm = normTimes(start.value, end.value);
      closeForm();
      api.create({ title: name, due: o.date, start: tm.start, end: tm.end, color: color });
    }
    var el = h('form', { class: 'calform', onsubmit: save, onkeydown: function (e) { if (e.key === 'Escape') { e.stopPropagation(); closeForm(); } } },
      title,
      h('div', { class: 'calform-when' },
        h('span', {}, cap(parse(o.date).toLocaleDateString('uk-UA', { weekday: 'short', day: 'numeric', month: 'long' }))),
        start, h('span', {}, '–'), end),
      sw,
      h('div', { class: 'calform-actions' },
        h('button', { type: 'button', class: 'btn', onclick: function () { closeForm(); } }, 'Скасувати'),
        h('button', { type: 'submit', class: 'btn primary' }, 'Зберегти')));
    // форма відкривається, коли палець відпустили; клік того самого дотику прилітає слідом — він не має її закрити
    var opened = Date.now();
    var wrap = h('div', { class: 'calform-layer' }, h('div', { class: 'calform-scrim', onclick: function () { if (Date.now() - opened > ECHO_MS) closeForm(); } }), el);
    document.body.append(wrap);
    if (!api.mobile()) {
      var w = el.offsetWidth, hgt = el.offsetHeight;
      el.style.left = Math.max(8, Math.min(innerWidth - w - 8, x + 12)) + 'px';
      el.style.top = Math.max(8, Math.min(innerHeight - hgt - 8, y - 30)) + 'px';
    }
    form = wrap;
    api.pushOverlay('calform');
    title.focus();
  }

  /** Закрити форму. fromBack — її вже закрила кнопка «Назад». */
  function closeForm(fromBack) {
    if (!form) return;
    form.remove(); form = null;
    if (!fromBack) api.popOverlay('calform');
    document.querySelectorAll('.cal .ev.ghost').forEach(function (g) { g.remove(); });
  }

  var KEYS = { KeyT: function () { setState(view(), api.today()); }, ArrowLeft: function () { shift(-1); }, ArrowRight: function () { shift(1); },
    KeyD: function () { setState('day', anchor()); }, KeyW: function () { setState('week', anchor()); }, KeyM: function () { setState('month', anchor()); } };
  document.addEventListener('keydown', function (e) {
    var fn = KEYS[e.code];
    if (!fn || !box || !box.querySelector('.cal') || form || drag || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName) || document.querySelector('.drawer, .modal, .add-sheet')) return;
    e.preventDefault();
    fn();
  });

  /* червона лінія часу рухається сама, без перемальовування */
  setInterval(function () {
    var n = new Date();
    document.querySelectorAll('.cal .now-line').forEach(function (l) { l.style.top = (n.getHours() * 60 + n.getMinutes()) / 60 * HOUR + 'px'; });
  }, 60000);

  window.SpravyCal = { render: render, layout: layout, occurrences: occurrences, normTimes: normTimes, closeForm: closeForm, HOUR: HOUR };
})();
