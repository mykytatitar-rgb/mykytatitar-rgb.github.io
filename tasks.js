/* Справи — особистий список задач. Окремий сайт і окремий застосунок:
   ставиться на телефон і комп'ютер власною іконкою.

   Дані — у базі Supabase, таблиця records, види todo_task і todo_list
   (та сама база, що в «Вектора»; його записи й ці одне одному не
   заважають — кожен застосунок читає лише свої види). Кожне завдання —
   окремий рядок: правка на телефоні не перетирає іншої правки на
   комп'ютері.

   Інтерфейс ніколи не чекає на мережу. Усе спершу лягає в браузер, а
   обмін іде у фоні; без інтернету зміни чекають у черзі. */

(function () {
  'use strict';

  var cfg = window.SPRAVY_CONFIG || { url: '', anonKey: '' };
  var BASE = (cfg.url || '').replace(/\/+$/, '');

  var AUTH = 'spravy.auth';           // сесія входу
  var DB_KEY = 'spravy.db';           // локальна копія: { lists: {id: …}, tasks: {id: …} }
  var OUT_KEY = 'spravy.outbox';      // що не встигло поїхати: {"kind/id": номер правки | "del"}
  var SINCE_KEY = 'spravy.since';     // час сервера, до якого вже все прочитано
  var OWNER_KEY = 'spravy.owner';     // чия це копія; інший вхід — інша копія
  var UI_KEY = 'spravy.ui';           // налаштування цього пристрою: тема, розмір, сортування
  var IMPORT_KEY = 'spravy.import';   // перенесення з посилання, що чекає входу

  var K_TASK = 'todo_task', K_LIST = 'todo_list';
  var PUSH_DELAY = 1200;
  var PULL_MS = 20000;                // як часто дивитися, чи не змінилось щось на іншому пристрої
  var RETRY_MS = 15000;
  var OVERLAP_MS = 90000;             // дочитуємо трохи назад — на випадок розбіжності годинників
  var PAGE = 1000;

  var COLORS = ['#82c8b8', '#8fb0e0', '#e0a87c', '#d99aa8', '#b3a6e0', '#b9c67e', '#9aa0ad'];
  var SIZES = [['S', 15], ['M', 17], ['L', 19], ['XL', 21]];
  var REPEATS = { none: 'Не повторювати', daily: 'Щодня', weekdays: 'Щобудні', weekly: 'Щотижня', monthly: 'Щомісяця' };

  /* Матриця Ейзенгауера. Нічого окремо вводити не треба: важливе — із
     зірочкою, термінове — з датою на сьогодні чи раніше. Справ на майбутнє
     в ній немає: вони з'являються у свій день. */
  var QUADS = {
    1: { name: 'Зробити зараз', hint: 'Важливо й терміново.' },
    2: { name: 'Запланувати', hint: 'Важливо, не терміново. Тут найбільше користі на довгу дистанцію.' },
    3: { name: 'Швидко або делегувати', hint: 'Терміново, але не важливо.' },
    4: { name: 'Колись або ніколи', hint: 'Не важливо й не терміново. Можна відпустити.' }
  };

  /* «Що заважає?» — думки, через які справа не починається. Кожна з них —
     відоме когнітивне викривлення: назва, коротке переформулювання й одна
     дія. Без лекцій: побачити думку збоку часто досить, щоб вона відпустила. */
  var BLOCKERS = {
    big: { thought: 'Це надто велике й складне', name: 'Катастрофізація', act: 'step',
      reframe: 'Справа здається більшою, ніж є, бо мозок бачить її всю одразу. Яка найменша дія на 5 хвилин зрушить її з місця?' },
    perfect: { thought: 'Треба ідеально, інакше нема сенсу', name: 'Мислення «все або нічого»', act: 'step',
      reframe: 'Достатньо добре теж рахується. Якою була б чернетка на 70%? Покращити її можна потім.' },
    unclear: { thought: 'Не знаю, з чого почати', name: 'Не викривлення, а нечіткий наступний крок', act: 'step',
      reframe: 'Справа стоїть, коли незрозуміло, що саме робити руками. Запишіть першу фізичну дію: «відкрити…», «написати…», «знайти…».' },
    mood: { thought: 'Немає настрою чи сил', name: 'Емоційне обґрунтування', act: 'kick',
      reframe: 'Почуття не наказ. Мотивація частіше приходить після початку, ніж до нього. Дві хвилини, а далі вирішите.' },
    always: { thought: 'Я завжди все відкладаю', name: 'Надмірне узагальнення', act: 'kick',
      reframe: 'Відкладали раніше не означає відкладатимете завжди. Згадайте, коли вже робили щось схоже. Що тоді допомогло почати?' },
    must: { thought: 'Я мушу, я повинен', name: 'Твердження «треба»', act: 'why',
      reframe: '«Мушу» тисне й забирає вибір. Скажіть інакше: «Я вирішую зробити це, бо…». Навіщо це вам?' },
    fail: { thought: 'Все одно нічого не вийде', name: 'Передбачення майбутнього', act: 'kick',
      reframe: 'Це прогноз, а не факт. Що найімовірніше станеться, якщо просто почати?' },
    others: { thought: 'Інші зроблять краще, а я ні', name: 'Знецінення себе', act: 'step',
      reframe: 'Що ви сказали б другові з такою думкою? Порівнюйте себе з учорашнім собою, а не з іншими.' },
    // дві думки, найчастіші при ADHD: тут не викривлення, а те, як влаштована увага
    bored: { thought: 'Нудно, не тягне', name: 'Нудьга, а не лінь', act: 'icnu',
      reframe: 'Мозок з ADHD запускає не «важливо», а цікаве, виклик, новизна чи терміновість. Додайте до справи хоч одне з них.' },
    overwhelm: { thought: 'Забагато всього, не знаю, за що хапатися', name: 'Параліч вибору', act: 'now',
      reframe: 'Коли справ багато, мозок тримає їх усі одразу й не обирає жодної. Найкращу обирати не треба: візьміть цю на 5 хвилин, решта почекає.' }
  };
  var BLOCKER_ORDER = ['big', 'bored', 'unclear', 'overwhelm', 'mood', 'perfect', 'fail', 'always', 'must', 'others'];
  var FOCUS_MAX = 3;      // головних справ на день: більше — і вони перестають бути головними

  /* Як зробити нудну справу цікавішою: інтерес, виклик, новизна, терміновість
     (так званий interest-based nervous system, Вільям Додсон) і ще компанія. */
  var ICNU = [
    ['Цікавість:', 'поєднайте з приємним: музика, подкаст, улюблений напій.'],
    ['Виклик:', 'гонка з таймером: скільки встигнете за 10 хвилин?'],
    ['Новизна:', 'інше місце чи спосіб: інший стіл, кав\'ярня, надиктувати замість писати.'],
    ['Терміновість:', 'пообіцяйте комусь результат до конкретної години.'],
    ['Не наодинці:', 'робіть поруч із кимось, хоч на відеодзвінку (body doubling).']
  ];

  var EST_STEPS = [5, 15, 30, 60, 90];   // скільки часу забере справа, хвилин
  var TIMER_MINS = [2, 5, 15, 25];
  /* Похвала одразу після виконаного: мозку з ADHD нагорода потрібна зараз, а не колись. */
  var PRAISE = ['Готово. Так тримати.', 'Ще одна справа з голови.', 'Мінус одна. Хороший темп.',
    'Зроблено. Це рахується.', 'Є! Наступна піде легше.'];

  /* ============================================================
     Дрібниці
     ============================================================ */

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* сховище недоступне — живемо в пам'яті */ } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function readJSON(k, def) {
    try { var v = JSON.parse(lsGet(k) || 'null'); return v == null ? def : v; } catch (e) { return def; }
  }

  function $(id) { return document.getElementById(id); }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseDay(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function addDays(s, n) { var d = parseDay(s); d.setDate(d.getDate() + n); return iso(d); }
  function today() { return iso(new Date()); }
  function isDay(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }

  function dueLabel(s) {
    var diff = Math.round((parseDay(s) - parseDay(today())) / 864e5);
    if (diff === 0) return 'Сьогодні';
    if (diff === 1) return 'Завтра';
    if (diff === -1) return 'Вчора';
    if (diff < 0 && diff > -7) return (-diff) + ' дн. тому';
    return parseDay(s).toLocaleDateString('uk-UA', { weekday: 'short', day: 'numeric', month: 'short' });
  }

  /** Наступна дата повторюваного завдання — найближча після сьогодні. */
  function nextDue(s, rep) {
    function step(d) {
      if (rep === 'daily') return addDays(d, 1);
      if (rep === 'weekly') return addDays(d, 7);
      if (rep === 'weekdays') {
        var n = addDays(d, 1);
        while (parseDay(n).getDay() === 0 || parseDay(n).getDay() === 6) n = addDays(n, 1);
        return n;
      }
      if (rep === 'monthly') { var x = parseDay(d); x.setMonth(x.getMonth() + 1); return iso(x); }
      return d;
    }
    var n = step(s || today());
    while (n <= today()) n = step(n);
    return n;
  }

  /** Відмінок після числа: 1 день, 3 дні, 5 днів. */
  function forms(n, one, few, many) {
    var a = n % 10, b = n % 100;
    return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
  }
  function plural(n) { return forms(n, 'завдання', 'завдання', 'завдань'); }

  function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3); }

  /* Капс у назвах. Абревіатури лишаються великими, відомі назви — як пишуться. */
  var KEEP = { SQL: 'SQL', TV: 'TV', ML: 'ML', DA: 'DA', 'ЗНО': 'ЗНО', AI: 'AI', YOUTUBE: 'YouTube',
    GOOGLE: 'Google', PREPLY: 'Preply', GEMINI: 'Gemini', WHOOP: 'Whoop' };
  function isShouting(s) {
    var l = s.match(/\p{L}/gu) || [];
    return l.length > 3 && l.filter(function (c) { return c !== c.toLowerCase(); }).length / l.length > 0.7;
  }
  function calm(s) {
    var x = s.replace(/\p{L}+/gu, function (w) { return KEEP[w] || w.toLowerCase(); });
    var i = x.search(/\p{L}/u);
    return i < 0 ? x : x.slice(0, i) + x[i].toUpperCase() + x.slice(i + 1);
  }

  function h(tag, attrs) {
    var el = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'style') el.style.cssText = v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    (function add(kids) {
      kids.forEach(function (k) {
        if (k == null || k === false) return;
        if (Array.isArray(k)) add(k);
        else el.append(k.nodeType ? k : String(k));
      });
    })(Array.prototype.slice.call(arguments, 2));
    return el;
  }

  var I = {
    addTask: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
    star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.8L12 16.9l-5.25 2.7 1-5.8L3.5 9.7l5.9-.9z"/>',
    dots: '<circle cx="12" cy="5" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="12" cy="19" r="1.3"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    repeat: '<path d="M17 3l3 3-3 3"/><path d="M4 11V9a3 3 0 013-3h13"/><path d="M7 21l-3-3 3-3"/><path d="M20 13v2a3 3 0 01-3 3H4"/>',
    chev: '<path d="M9 6l6 6-6 6"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r=".8"/><circle cx="4" cy="12" r=".8"/><circle cx="4" cy="18" r=".8"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/>',
    sub: '<path d="M6 4v9a3 3 0 003 3h9"/><path d="M15 13l3 3-3 3"/>',
    target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>',
    grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>',
    knot: '<path d="M4.5 5.5h15v10h-9l-4.5 3.5v-3.5H4.5z"/><path d="M10 9.2a2 2 0 113.2 1.6c-.8.5-1.2.9-1.2 1.7"/><circle cx="12" cy="14.2" r=".5" fill="currentColor"/>',
    play: '<path d="M8 5.5l10.5 6.5L8 18.5z"/>',
    bolt: '<path d="M13.5 3L5.5 13.5h6L10.5 21l8-10.5h-6z"/>',
    hourglass: '<path d="M7 3.5h10M7 20.5h10"/><path d="M8 3.5c0 4.2 4 5.3 4 8.5s-4 4.3-4 8.5M16 3.5c0 4.2-4 5.3-4 8.5s4 4.3 4 8.5"/>'
  };
  function svg(d, size, sw) {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('width', size || 18); s.setAttribute('height', size || 18);
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', sw || 2); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    s.innerHTML = d;
    return s;
  }

  /* ============================================================
     Дані
     ============================================================

     Записи завжди збираються цими двома функціями, з полями в одному
     порядку: так відбиток (JSON) того самого запису однаковий і тут, і
     після приходу з сервера, і зайвої відправки не буває. */

  function mkTask(o) {
    return {
      id: String(o.id),
      listId: String(o.listId || ''),
      title: String(o.title || ''),
      notes: String(o.notes || ''),
      due: isDay(o.due) ? o.due : '',
      repeat: REPEATS[o.repeat] ? o.repeat : 'none',
      starred: !!o.starred,
      done: !!o.done,
      doneAt: isDay(o.doneAt) ? o.doneAt : '',
      parentId: String(o.parentId || ''),
      order: Number(o.order) || 0,
      focus: isDay(o.focus) ? o.focus : '',              // день, на який справу обрали головною
      postponed: Math.max(0, Math.floor(Number(o.postponed) || 0)),   // скільки разів прострочене переносили далі
      blocker: BLOCKERS[o.blocker] ? o.blocker : '',     // що заважало востаннє («Що заважає?»)
      blockerAt: isDay(o.blockerAt) ? o.blockerAt : '',
      est: Math.min(600, Math.max(0, Math.round(Number(o.est) || 0)))   // скільки хвилин займе, 0 — не оцінено
    };
  }

  function mkList(o) {
    return {
      id: String(o.id),
      name: String(o.name || 'Список'),
      color: /^#[0-9a-f]{6}$/i.test(o.color || '') ? o.color : COLORS[0],
      visible: o.visible !== false,
      order: Number(o.order) || 0
    };
  }

  var db = { lists: {}, tasks: {} };
  var outbox = {};
  var snap = {};        // "kind/id" → JSON запису, яким його востаннє бачив обмін
  var since = null;
  var seq = Date.now(); // номер правки: щоб відрізнити «відправлене» від «змінене під час відправки»
  var ready = false;    // чи є що показувати — локальна копія або перше читання з сервера

  var ui = { view: 'board', openDone: {}, sort: {}, size: 17, theme: 'auto', mList: '' };

  function bagOf(kind) { return kind === K_TASK ? db.tasks : kind === K_LIST ? db.lists : null; }

  function eachRec(fn) {
    Object.keys(db.lists).forEach(function (id) { fn(K_LIST, db.lists[id]); });
    Object.keys(db.tasks).forEach(function (id) { fn(K_TASK, db.tasks[id]); });
  }

  function loadLocal() {
    var raw = readJSON(DB_KEY, null);
    db = { lists: {}, tasks: {} };
    if (raw && raw.lists && raw.tasks) {
      Object.keys(raw.lists).forEach(function (id) { db.lists[id] = mkList(raw.lists[id]); });
      Object.keys(raw.tasks).forEach(function (id) { db.tasks[id] = mkTask(raw.tasks[id]); });
      ready = true;
    }
    outbox = readJSON(OUT_KEY, {}) || {};
    since = lsGet(SINCE_KEY) || null;
    snap = {};
    eachRec(function (kind, rec) { snap[kind + '/' + rec.id] = JSON.stringify(rec); });
    Object.assign(ui, readJSON(UI_KEY, {}));
  }

  function saveLocal() { lsSet(DB_KEY, JSON.stringify(db)); }
  function saveOutbox() { lsSet(OUT_KEY, JSON.stringify(outbox)); }
  function saveUi() { lsSet(UI_KEY, JSON.stringify(ui)); }

  function forgetLocal() {
    db = { lists: {}, tasks: {} };
    outbox = {}; snap = {}; since = null; ready = false;
    lsDel(DB_KEY); lsDel(OUT_KEY); lsDel(SINCE_KEY);
  }

  /** Що змінилося з минулого разу — у чергу на відправку. Правити окремо нічого не треба. */
  function detect() {
    var seen = {};
    eachRec(function (kind, rec) {
      var key = kind + '/' + rec.id;
      var j = JSON.stringify(rec);
      seen[key] = 1;
      if (snap[key] !== j) { snap[key] = j; outbox[key] = ++seq; }
    });
    Object.keys(snap).forEach(function (key) {
      if (!seen[key]) { delete snap[key]; outbox[key] = 'del'; }
    });
  }

  var quiet = false;
  function commit() {
    detect();
    saveLocal();
    saveOutbox();
    if (quiet) { renderSide(); renderHead(); renderBoard(); } else render();
    if (Object.keys(outbox).length) schedule(PUSH_DELAY);
  }

  function lists() {
    return Object.keys(db.lists).map(function (id) { return db.lists[id]; })
      .sort(function (a, b) { return a.order - b.order || a.name.localeCompare(b.name); });
  }
  function tasks() { return Object.keys(db.tasks).map(function (id) { return db.tasks[id]; }); }
  function listOf(id) { return db.lists[id] || null; }
  function childrenOf(id) { return tasks().filter(function (t) { return t.parentId === id; }); }
  function openCount(listId) {
    return tasks().filter(function (t) { return t.listId === listId && isOpenNow(t); }).length;
  }
  /** Справа з датою в майбутньому: не показуємо її, доки не настане її день. */
  function isFuture(t) { return !!t.due && t.due > today(); }
  /** Відкрита справа верхнього рівня, яку видно вже сьогодні. */
  function isOpenNow(t) { return !t.done && !t.parentId && !isFuture(t); }

  /* ---------- матриця, головне на день, «застрягло» ---------- */

  function isUrgent(t) { return !!t.due && t.due <= today(); }
  function quadrant(t) { return t.starred ? (isUrgent(t) ? 1 : 2) : (isUrgent(t) ? 3 : 4); }
  function isFocus(t) { return t.focus === today(); }
  function focusToday() { return tasks().filter(function (t) { return !t.parentId && isFocus(t); }); }
  function daysLate(t) { return t.due && t.due < today() ? Math.round((parseDay(today()) - parseDay(t.due)) / 864e5) : 0; }
  /** Застрягло: прострочене три дні й довше або вже двічі перенесене далі. */
  function isStuck(t) { return !t.done && !t.parentId && (daysLate(t) >= 3 || t.postponed >= 2); }
  function stuckText(t) {
    var out = [], d = daysLate(t);
    if (d) out.push('чекає вже ' + d + ' ' + forms(d, 'день', 'дні', 'днів'));
    if (t.postponed) out.push('переносилося ' + t.postponed + ' ' + forms(t.postponed, 'раз', 'рази', 'разів'));
    var s = out.join(', ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  /** Нова дата. Прострочене чи сьогоднішнє, перенесене далі, — це відкладання: рахуємо. */
  function setDue(t, v) {
    if (v && t.due && t.due <= today() && v > t.due) t.postponed += 1;
    t.due = v;
  }

  /** Звичка (щодня, щобудні), не зроблена вчора, просто переходить на сьогодні:
      пропуск не накопичується боргом і не висить у «минулих днях». */
  function rollHabits() {
    var t0 = today(), n = 0;
    tasks().forEach(function (t) {
      if (t.done || !t.due || t.due >= t0 || (t.repeat !== 'daily' && t.repeat !== 'weekdays')) return;
      var d = t0;
      while (t.repeat === 'weekdays' && parseDay(d).getDay() % 6 === 0) d = addDays(d, 1);
      t.due = d;
      n++;
    });
    return n;
  }

  /** 5 хв, 1 год, 1,5 год, 2 год 15 хв. */
  function estLabel(m) {
    if (m < 60) return m + ' хв';
    var hr = Math.floor(m / 60), r = m % 60;
    if (r === 30 && hr < 3) return hr + ',5 год';
    return hr + ' год' + (r ? ' ' + r + ' хв' : '');
  }

  /* ---------- «Зараз» ----------
     Одна справа замість довгого списку: при ADHD довгий список паралізує
     вибором, а одна справа з таймером починається. Черга: головне на
     сьогодні, потім на сьогодні, потім з минулих днів. «Не зараз» відсуває
     справу в кінець черги до завтра. Коли сил мало, першими йдуть короткі
     (до 15 хвилин) і ті, де вже записано перший крок: мала перемога
     розганяє краще за велику. */

  var nowAll = false;   // на сьогодні нічого не обрано, а людина хоче взяти будь-яку

  function isQuick(t) { return (t.est > 0 && t.est <= 15) || childrenOf(t.id).some(function (c) { return !c.done; }); }
  function laterIds() { return ui.later && ui.later.day === today() ? ui.later.ids : []; }
  /** «Сил мало» — стан на сьогодні: завтра знову з чистого. */
  function lowEnergy() { return ui.energy === 'low' && ui.energyDay === today(); }

  function nowQueue() {
    var t0 = today(), later = laterIds(), low = lowEnergy();
    function rank(t) {
      if (isFocus(t)) return 0;
      if (t.due === t0) return 1;
      if (t.due && t.due < t0) return 2;
      if (t.due) return -1;            // на майбутнє: ще не час
      return nowAll ? (t.starred ? 3 : 4) : -1;
    }
    var quick = {};
    var q = tasks().filter(function (t) { return !t.done && !t.parentId && rank(t) >= 0; });
    if (low) q.forEach(function (t) { quick[t.id] = isQuick(t) ? 1 : 0; });
    return q.sort(function (a, b) {
      var la = later.indexOf(a.id), lb = later.indexOf(b.id);
      return (la >= 0) - (lb >= 0) || la - lb ||
        (low ? quick[b.id] - quick[a.id] : 0) ||
        rank(a) - rank(b) || (a.due || '9999').localeCompare(b.due || '9999') || a.order - b.order;
    });
  }

  /** Тривалість таймера за замовчуванням: оцінка справи, але не довше 25 хвилин; мало сил — 5. */
  function timerMins(t) {
    if (lowEnergy()) return 5;
    return t.est ? Math.min(t.est, 25) : 15;
  }

  /* ============================================================
     Вхід
     ============================================================

     Сесію поновлюють під замком, спільним для всіх вкладок, і з
     перечитуванням сховища. Supabase при кожному поновленні гасить старий
     ключ, а повторне використання старого вважає крадіжкою й закриває
     сесію цілком — тож дві вкладки, що поновлюють одночасно, вибили б
     вхід на цьому пристрої. */

  var sessionCache;
  function sess() {
    if (sessionCache === undefined) sessionCache = readJSON(AUTH, null);
    return sessionCache;
  }
  function setSess(s) {
    sessionCache = s || null;
    if (s) lsSet(AUTH, JSON.stringify(s)); else lsDel(AUTH);
  }
  function freshSess() { sessionCache = undefined; return sess(); }
  function signedIn() { var s = sess(); return !!(s && s.refresh_token); }

  window.addEventListener('storage', function (e) {
    if (e.key === AUTH) sessionCache = undefined;   // сусідня вкладка поновила чи закрила сесію
  });

  function withAuthLock(fn) {
    if (navigator.locks && navigator.locks.request) return navigator.locks.request('spravy-auth-refresh', fn);
    return fn();
  }

  var refreshing = null;
  function refresh() {
    if (refreshing) return refreshing;
    var used = sess();
    if (!used || !used.refresh_token) return Promise.reject(expired('Потрібен вхід'));

    refreshing = withAuthLock(function () {
      var now = freshSess();
      if (!now || !now.refresh_token) throw expired('Сесія закрита. Увійдіть знову');
      if (now.refresh_token !== used.refresh_token) return now;   // інша вкладка вже поновила

      return fetch(BASE + '/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: now.refresh_token })
      }).then(function (res) {
        if (!res.ok) {
          var after = freshSess();
          if (after && after.refresh_token && after.refresh_token !== now.refresh_token) return after;
          throw expired('Сесія втратила чинність. Увійдіть знову');
        }
        return res.json().then(function (j) {
          var next = { access_token: j.access_token, refresh_token: j.refresh_token, email: (j.user && j.user.email) || now.email };
          setSess(next);
          return next;
        });
      });
    }).then(function (s) {
      refreshing = null;
      return s;
    }, function (e) {
      refreshing = null;
      if (e && e.expired) setSess(null);   // на збої мережі сесію не чіпаємо: вона, найпевніше, жива
      throw e;
    });
    return refreshing;
  }

  function expired(msg) { var e = new Error(msg); e.expired = true; return e; }

  function authFetch(path, opts) {
    var headers = { apikey: cfg.anonKey, 'Content-Type': 'application/json' };
    var s = sess();
    if (s && s.access_token) headers.Authorization = 'Bearer ' + s.access_token;
    return fetch(BASE + path, { method: opts.method || 'GET', headers: headers, body: opts.body });
  }

  /* Токен живе близько години: на першу відмову 401 поновлюємо його й повторюємо запит один раз. */
  function api(path, opts) {
    opts = opts || {};
    return authFetch(path, opts).then(function (res) {
      if (res.status !== 401) return res;
      return refresh().then(function () { return authFetch(path, opts); });
    }).then(function (res) {
      if (res.status === 401) throw expired('Сесія втратила чинність. Увійдіть знову');
      if (!res.ok) {
        return res.text().then(function (t) {
          var msg = t;
          try { var j = JSON.parse(t); msg = j.message || j.msg || j.error_description || t; } catch (e) {}
          throw new Error(msg || ('Сервер відповів ' + res.status));
        });
      }
      return res;
    });
  }

  function rpc(name, args) {
    return api('/rest/v1/rpc/' + name, { method: 'POST', body: JSON.stringify(args) });
  }

  function signIn(email, password) {
    return fetch(BASE + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: password })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (j) {
        if (!res.ok) {
          var code = j.error_code || j.error || '';
          if (code === 'invalid_credentials' || code === 'invalid_grant') throw new Error('Пошта чи пароль не підходять');
          throw new Error(j.error_description || j.msg || j.message || 'Не вдалося увійти');
        }
        setSess({ access_token: j.access_token, refresh_token: j.refresh_token, email: (j.user && j.user.email) || email });
      });
    });
  }

  function deviceName() {
    var ua = navigator.userAgent;
    var os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac/.test(ua) ? 'Mac' : 'інший';
    var br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : '';
    return 'Справи · ' + os + (br ? ' / ' + br : '');
  }

  /* ============================================================
     Обмін
     ============================================================

     Спершу відправляємо своє, потім забираємо чуже — завжди по черзі, не
     разом: інакше відповідь читання, що вийшло до відправки, могла б
     повернути на екран старий стан щойно зміненого завдання. */

  var syncing = false, again = false, timer = null;
  var lastProblem = '';   // чому не вдалося — для першого запуску, коли показати ще нічого

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(sync, ms);
  }

  function setSync(s, text) {
    var el = $('sync');
    if (!el) return;
    el.dataset.s = s;
    el.lastElementChild.textContent = text;
  }

  function sync() {
    clearTimeout(timer);
    if (!BASE || !signedIn()) return Promise.resolve();
    if (syncing) { again = true; return Promise.resolve(); }
    syncing = true;
    if (Object.keys(outbox).length) setSync('wait', 'Зберігаю…');

    var failed = false;
    return push().then(pull).then(function () {
      lastProblem = '';
      setSync('ok', 'Синхронізовано');
      return afterPull();
    }).catch(function (e) {
      failed = true;
      if (e && e.expired) { showLogin('Сесія закінчилась. Увійдіть ще раз, нічого не загубиться.'); return; }
      if (navigator.onLine === false || (e && e.name === 'TypeError')) {
        lastProblem = 'Немає зв\'язку з сервером. Справи з\'являться, щойно буде інтернет.';
        setSync('local', 'Немає зв\'язку. Зміни збережені тут і поїдуть самі');
      } else {
        lastProblem = 'Не вдалося отримати справи: ' + ((e && e.message) || e);
        setSync('error', 'Не вдалося синхронізувати: ' + ((e && e.message) || e));
      }
      if (!ready) renderBoard();
    }).then(function () {
      syncing = false;
      if (again && !failed) { again = false; schedule(300); }
      else if (Object.keys(outbox).length) schedule(failed ? RETRY_MS : PUSH_DELAY);
    });
  }

  function push() {
    var keys = Object.keys(outbox);
    if (!keys.length) return Promise.resolve();
    var i = 0;
    function next() {
      if (i >= keys.length) return Promise.resolve();
      var key = keys[i++];
      var sent = outbox[key];
      if (sent === undefined) return next();
      var cut = key.indexOf('/'), kind = key.slice(0, cut), id = key.slice(cut + 1);
      var bag = bagOf(kind);
      var rec = bag && bag[id];
      var call = rec
        ? rpc('save_record', { p_kind: kind, p_id: id, p_data: rec, p_device: deviceName() })
        : rpc('delete_record', { p_kind: kind, p_id: id, p_device: deviceName() });
      return call.then(function () {
        // змінили, поки летіло, — лишаємо в черзі, поїде наступним колом
        if (outbox[key] === sent) delete outbox[key];
        saveOutbox();
        return next();
      });
    }
    // кілька запитів паралельно: перше перенесення (два десятки рядків) не тягнеться секундами
    return Promise.all([next(), next(), next(), next()]);
  }

  var firstPull = null;   // результат повного читання: чи порожньо на сервері

  function pull() {
    var full = !since;
    var path = '/rest/v1/records?select=kind,id,data,deleted,updated_at' +
      '&kind=in.(' + K_TASK + ',' + K_LIST + ')&order=updated_at.asc,kind.asc,id.asc';
    if (!full) {
      var from = Date.parse(String(since).replace(/(\.\d{3})\d+/, '$1')) - OVERLAP_MS;
      path += '&updated_at=gte.' + encodeURIComponent(new Date(from).toISOString());
    }
    var rows = [];
    function page(offset) {
      return api(path + '&limit=' + PAGE + '&offset=' + offset)
        .then(function (res) { return res.json(); })
        .then(function (part) {
          rows = rows.concat(part);
          return part.length === PAGE ? page(offset + PAGE) : rows;
        });
    }
    return page(0).then(function () {
      var changed = 0, newest = since, present = {};
      rows.forEach(function (row) {
        if (!newest || row.updated_at > newest) newest = row.updated_at;
        present[row.kind + '/' + row.id] = 1;
        if (applyRow(row)) changed++;
      });
      if (full) {
        /* Повне читання — правда сервера: прибираємо тутешнє, чого там немає
           і що не чекає на відправку (лишки від іншого входу тощо). */
        var drop = [];
        eachRec(function (kind, rec) {
          var key = kind + '/' + rec.id;
          if (!present[key] && outbox[key] === undefined) drop.push([kind, rec.id, key]);
        });
        drop.forEach(function (d) { delete bagOf(d[0])[d[1]]; delete snap[d[2]]; changed++; });
        firstPull = { empty: rows.length === 0 };
      }
      if (newest) { since = newest; lsSet(SINCE_KEY, since); }
      if (changed || !ready) {
        ready = true;
        saveLocal();
        if (dragId || gest) renderLater = true; else render();
      }
    });
  }

  function applyRow(row) {
    var key = row.kind + '/' + row.id;
    if (outbox[key] !== undefined) return false;           // наше новіше ще не поїхало
    var bag = bagOf(row.kind);
    if (!bag) return false;
    if (row.deleted) {
      if (!bag[row.id]) return false;
      delete bag[row.id];
      delete snap[key];
      return true;
    }
    if (!row.data || typeof row.data !== 'object') return false;
    var rec = row.kind === K_TASK ? mkTask(Object.assign({}, row.data, { id: row.id })) : mkList(Object.assign({}, row.data, { id: row.id }));
    var j = JSON.stringify(rec);
    if (snap[key] === j && bag[row.id]) return false;
    bag[row.id] = rec;
    snap[key] = j;
    return true;
  }

  /* Після першого читання: перенесення з посилання, а якщо на сервері
     зовсім порожньо (жодного рядка, навіть видаленого) — перший список. */
  function afterPull() {
    var first = firstPull;
    firstPull = null;
    var pending = readJSON(IMPORT_KEY, null);
    if (pending) { lsDel(IMPORT_KEY); applyImport(pending); return; }
    if (first && first.empty && !Object.keys(db.lists).length) {
      db.lists.my = mkList({ id: 'my', name: 'Мої справи', color: COLORS[0], visible: true, order: 0 });
      commit();
    }
    if (rollHabits()) commit();
  }

  /* ============================================================
     Перенесення
     ============================================================

     Посилання виду #import=z.<дані> — список справ із попереднього
     застосунку. Дані йдуть після «#», а цю частину адреси браузер серверу
     не надсилає, тож вони не лишаються ні в коді сайту, ні в журналах. */

  function b64bytes(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function decodeImport(code) {
    if (code.slice(0, 2) === 'j.') return Promise.resolve(new TextDecoder().decode(b64bytes(code.slice(2)))).then(JSON.parse);
    if (code.slice(0, 2) !== 'z.') return Promise.reject(new Error('Незнайомий формат посилання'));
    if (typeof DecompressionStream === 'undefined') return Promise.reject(new Error('Цей браузер не розпаковує перенесення. Відкрийте посилання в Chrome'));
    var stream = new Blob([b64bytes(code.slice(2))]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).text().then(JSON.parse);
  }

  function takeImportFromUrl() {
    var m = /[#&]import=([^&]+)/.exec(location.hash);
    if (!m) return Promise.resolve();
    history.replaceState(null, '', location.pathname + location.search);
    return decodeImport(decodeURIComponent(m[1])).then(function (data) {
      if (!data || !Array.isArray(data.lists) || !Array.isArray(data.tasks)) throw new Error('Посилання пошкоджене');
      lsSet(IMPORT_KEY, JSON.stringify(data));
    }).catch(function (e) {
      toast('Не вдалося прочитати перенесення: ' + e.message);
    });
  }

  function applyImport(data) {
    var t0 = today(), n = 0;
    data.lists.forEach(function (l, i) {
      db.lists[l.id] = mkList(Object.assign({ order: i }, l));
    });
    data.tasks.forEach(function (t, i) {
      var rec = mkTask(Object.assign({ order: i }, t));
      // звички («щодня») переносимо на сьогодні, а не у прострочені
      if (rec.repeat !== 'none' && rec.due && rec.due < t0 && !rec.done) rec.due = t0;
      db.tasks[rec.id] = rec;
      if (!rec.parentId && !rec.done) n++;
    });
    commit();
    toast('Перенесено: ' + n + ' ' + plural(n) + ' і ' + data.lists.length + ' ' + (data.lists.length === 1 ? 'список' : data.lists.length < 5 ? 'списки' : 'списків'));
  }

  /* ============================================================
     Дії
     ============================================================ */

  var toastTimer;
  function toast(msg, undo, ms) {
    clearTimeout(toastTimer);
    var slot = $('toast-slot');
    // над відкритою карткою чи планом — угорі, щоб не затуляти їхні кнопки
    var top = overlays.some(function (k) { return k !== 'nav'; });
    slot.replaceChildren(h('div', { class: 'toast' + (top ? ' top' : ''), role: 'status' },
      h('span', {}, msg),
      undo ? h('button', { type: 'button', onclick: function () { undo(); slot.replaceChildren(); } }, 'Скасувати') : null));
    toastTimer = setTimeout(function () { slot.replaceChildren(); }, ms || 5000);
  }

  function toggleDone(t) {
    if (!t.done && t.repeat !== 'none') {
      var prevDue = t.due;
      var copy = mkTask(Object.assign({}, t, { id: uid(), repeat: 'none', done: true, doneAt: today() }));
      db.tasks[copy.id] = copy;
      t.due = nextDue(t.due, t.repeat);
      commit();
      var next = dueLabel(t.due).toLowerCase();   // «пт, 30 жовт.» уже з крапкою
      toast('Зроблено! Наступний раз: ' + next + (/\.$/.test(next) ? '' : '.'), function () {
        t.due = prevDue; delete db.tasks[copy.id]; commit();
      });
      return;
    }
    t.done = !t.done;
    t.doneAt = t.done ? today() : '';
    if (t.done) childrenOf(t.id).forEach(function (c) { c.done = true; c.doneAt = today(); });
    commit();
    if (t.done) toast(praise(t), function () { t.done = false; t.doneAt = ''; commit(); });
  }

  function praise(t) {
    if (t.parentId) return 'Крок зроблено. Далі легше.';
    if (isFocus(t)) {
      var f = focusToday(), left = f.filter(function (x) { return !x.done; }).length;
      return left ? 'Головне: ' + (f.length - left) + ' з ' + f.length + ' зроблено.' : 'Усе головне на сьогодні зроблено. День уже вдався.';
    }
    return PRAISE[Math.floor(Math.random() * PRAISE.length)];
  }

  /** Маленький салют там, де натиснули: винагорода одразу, а не колись. */
  function burst(el) {
    if (!el || reduceMq.matches) return;
    var r = el.getBoundingClientRect();
    var b = h('div', { class: 'burst', 'aria-hidden': 'true', style: 'left:' + (r.left + r.width / 2) + 'px;top:' + (r.top + r.height / 2) + 'px' });
    for (var i = 0; i < 10; i++) b.append(h('i', { style: '--a:' + (i * 36) + 'deg;--d:' + (26 + (i % 3) * 9) + 'px' }));
    document.body.append(b);
    setTimeout(function () { b.remove(); }, 800);
  }

  function addTask(listId, title, extra) {
    extra = extra || {};
    var min = 0;
    tasks().forEach(function (x) { if (x.order < min) min = x.order; });
    var t = mkTask(Object.assign({ id: uid(), listId: listId, title: title.trim(), order: min - 1, starred: ui.view === 'starred' }, extra));
    if (ui.view === 'today' && !('due' in extra)) t.due = today();
    db.tasks[t.id] = t;
    commit();
    return t;
  }

  /** Головне на сьогодні: не більше трьох відкритих, інакше воно перестає бути головним. */
  function focusFull() {
    if (focusToday().filter(function (x) { return !x.done; }).length < FOCUS_MAX) return false;
    toast('Уже ' + FOCUS_MAX + ' головні справи. Спершу зробіть або приберіть одну з них.');
    return true;
  }
  function toggleFocus(t) {
    if (isFocus(t)) { t.focus = ''; commit(); return; }
    if (focusFull()) return;
    t.focus = today();
    commit();
  }

  function removeTask(t) {
    var gone = [t].concat(childrenOf(t.id));
    gone.forEach(function (x) { delete db.tasks[x.id]; });
    commit();
    toast('Завдання видалено', function () { gone.forEach(function (x) { db.tasks[x.id] = x; }); commit(); });
  }

  function sorted(arr, mode) {
    return arr.slice().sort(mode === 'date'
      ? function (a, b) { return (a.due || '9999').localeCompare(b.due || '9999') || a.order - b.order; }
      : mode === 'starred' ? function (a, b) { return (b.starred - a.starred) || a.order - b.order; }
      : function (a, b) { return a.order - b.order; });
  }

  var dragId = null;
  function clearDrop() {
    document.querySelectorAll('.drop-before,.drop-after,.drop-col').forEach(function (el) {
      el.classList.remove('drop-before', 'drop-after', 'drop-col');
    });
  }
  function moveTask(id, listId, refId, after) {
    var t = db.tasks[id];
    if (!t || id === refId) return;
    var from = t.listId;
    var arr = sorted(tasks().filter(function (x) { return x.listId === listId && !x.parentId && !x.done && x !== t; }), 'mine');
    var idx = refId ? arr.findIndex(function (x) { return x.id === refId; }) + (after ? 1 : 0) : arr.length;
    arr.splice(idx, 0, t);
    arr.forEach(function (x, i) { x.order = i; });
    t.listId = listId;
    childrenOf(t.id).forEach(function (c) { c.listId = listId; });
    if ((ui.sort[listId] || 'mine') !== 'mine') { ui.sort[listId] = 'mine'; saveUi(); }
    commit();
    if (from !== listId) {
      toast('Перенесено в «' + listOf(listId).name + '»', function () {
        t.listId = from;
        childrenOf(t.id).forEach(function (c) { c.listId = from; });
        commit();
      });
    }
  }

  /* ============================================================
     Малювання
     ============================================================ */

  var addingIn = null, openMenu = null, drawerTask = null, armed = null, renameList = null;
  /* Набране в полі не має зникати, коли обмін у фоні перемальовує екран */
  var addDraft = '', renameDraft = null;
  var renderLater = false;   // прийшли зміни, поки людина тягне завдання, — малюємо після
  var mobileMq = matchMedia('(max-width: 760px)');
  var reduceMq = matchMedia('(prefers-reduced-motion: reduce)');
  var hoverMq = matchMedia('(hover: none)');
  var standaloneMq = matchMedia('(display-mode: standalone)');
  var installEvt = null;

  function render() {
    var root = document.documentElement;
    root.style.setProperty('--fs', ui.size + 'px');
    if (ui.theme === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', ui.theme);
    renderSide(); renderHead(); renderTop(); renderNav(); renderBoard(); renderDrawer();
  }

  /** Список, відкритий на телефоні (вкладка), — або перший видимий. */
  function currentList() {
    var vis = lists().filter(function (l) { return l.visible; });
    return vis.filter(function (l) { return l.id === ui.mList; })[0] || vis[0] || lists()[0] || null;
  }

  /* ---------- «Назад» ----------
     Кожне відкрите вікно (картка завдання, панель додавання, меню, план дня,
     «Що заважає?», таймер) — окремий крок в історії. Тоді системна кнопка
     «Назад» на телефоні закриває верхнє вікно, а не виходить із застосунку.
     Вікна можуть лежати одне на одному (картка → «Що заважає?»), тому стек. */
  var overlays = [];      // відкриті вікна, верхнє — останнє
  var skipPops = 0;       // «назад», які ми зробили самі, закриваючи вікно кнопкою
  function pushOverlay(kind) {
    overlays.push(kind);
    try { history.pushState({ spravy: kind }, ''); } catch (e) { /* без історії — просто без «Назад» */ }
  }
  /** Одне вікно змінює інше в межах того самого кроку: інакше запізнілий «назад» закрив би нове. */
  function swapOverlay(from, to) {
    var i = overlays.lastIndexOf(from);
    if (i < 0) return false;
    overlays[i] = to;
    return true;
  }
  function popOverlay(kind) {
    var i = overlays.lastIndexOf(kind);
    if (i < 0) return;
    overlays.splice(i, 1);
    skipPops++;
    try { history.back(); } catch (e) { skipPops--; }
  }
  function isOpen(kind) { return overlays.indexOf(kind) >= 0; }
  function closeTop() {
    var kind = overlays[overlays.length - 1];
    if (kind === 'sheet') closeSheet();
    else if (kind === 'drawer') closeDrawer();
    else if (kind === 'nav') closeNav();
    else if (kind === 'plan') closePlan();
    else if (kind === 'help') closeHelp();
    else if (kind === 'kick') closeKick();
  }
  /** Закрити всі вікна разом і прибрати їхні кроки з історії одним стрибком. */
  function closeOverlays() {
    var n = overlays.length;
    if (!n) return;
    overlays = [];
    closeKick(true); closeHelp(true); closePlan(true); closeSheet(true); closeNav(true);
    if (drawerTask) closeDrawer(true);
    skipPops++;
    try { history.go(-n); } catch (e) { skipPops--; }
  }
  function goNow() {
    closeOverlays();
    ui.view = 'now';
    saveUi();
    window.scrollTo(0, 0);
    render();
  }
  window.addEventListener('popstate', function () {
    if (skipPops) { skipPops--; return; }
    var kind = overlays.pop();
    if (kind === 'sheet') closeSheet(true);
    else if (kind === 'drawer') closeDrawer(true);
    else if (kind === 'nav') closeNav(true);
    else if (kind === 'plan') closePlan(true);
    else if (kind === 'help') closeHelp(true);
    else if (kind === 'kick') closeKick(true);
  });

  /* ---------- шапка й нижня панель телефона ---------- */

  function renderTop() {
    var t0 = today();
    var open = tasks().filter(function (t) { return !t.done && !t.parentId; });
    var now = open.filter(function (t) { return t.due === t0; }).length;
    var late = open.filter(function (t) { return t.due && t.due < t0; }).length;
    var doneToday = tasks().filter(function (t) { return t.done && t.doneAt === t0 && !t.parentId; }).length;
    var total = doneToday + now + late;
    var d = new Date().toLocaleDateString('uk-UA', { weekday: 'short', day: 'numeric', month: 'long' });
    $('topTitle').textContent = d.charAt(0).toUpperCase() + d.slice(1);
    var prog = $('topProg');
    prog.replaceChildren();
    if (total) {
      prog.append(
        h('div', { class: 'bar', role: 'progressbar', 'aria-label': 'Виконано сьогодні', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(doneToday) },
          h('i', { style: 'width:' + Math.round(doneToday / total * 100) + '%' })),
        h('span', { title: 'Сьогодні виконано ' + doneToday + ' з ' + total }, doneToday + '/' + total));
      if (late) prog.append(h('span', { class: 'late', title: 'З минулих днів: ' + late }, svg(I.clock, 13), late));
    }

    var tabs = $('mtabs');
    var vis = lists().filter(function (l) { return l.visible; });
    if (!mobileMq.matches || ui.view !== 'board' || !ready || vis.length < 2) { tabs.hidden = true; tabs.replaceChildren(); return; }
    var cur = currentList();
    tabs.hidden = false;
    tabs.replaceChildren.apply(tabs, vis.map(function (l) {
      var n = openCount(l.id);
      return h('button', { type: 'button', class: 'tab', role: 'tab', style: '--c:' + l.color, 'aria-selected': String(l === cur),
        onclick: function () { ui.mList = l.id; saveUi(); window.scrollTo(0, 0); render(); } },
        h('i', { class: 'col-dot' }), l.name, n ? h('small', {}, n) : null);
    }));
    var sel = tabs.querySelector('[aria-selected="true"]');
    if (sel && tabs.dataset.sel !== cur.id) {
      tabs.dataset.sel = cur.id;
      sel.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    }
  }

  function renderNav() {
    var t0 = today();
    var open = tasks().filter(isOpenNow);
    var due = open.filter(function (t) { return t.due && t.due <= t0; });
    var late = due.some(function (t) { return t.due < t0; });
    // на телефоні чотири розділи: «Важливі» — це верхній рядок матриці
    var items = [
      ['now', 'Зараз', I.bolt, 0],
      ['board', 'Списки', I.list, 0],
      ['today', 'Сьогодні', I.sun, due.length],
      ['matrix', 'Матриця', I.grid, open.filter(function (t) { return quadrant(t) === 1; }).length]
    ];
    $('bnav').replaceChildren.apply($('bnav'), items.map(function (x) {
      return h('button', { type: 'button', 'aria-current': String(ui.view === x[0]),
        onclick: function () { ui.view = x[0]; saveUi(); window.scrollTo(0, 0); render(); } },
        h('span', { class: 'bn-ico' }, svg(x[2], 22, 1.9)),
        h('span', {}, x[1]),
        x[3] ? h('span', { class: 'bn-badge' + (x[0] === 'today' && late ? ' late' : '') }, x[3]) : null);
    }));
  }

  /** Телефон: запрошення поставити застосунок на головний екран, поки його там немає. */
  function installBar() {
    if (!mobileMq.matches || !installEvt || standaloneMq.matches) return null;
    return h('div', { class: 'install-bar' },
      h('span', {}, 'Поставте «Справи» на головний екран: відкриватимуться з іконки, як звичайний застосунок.'),
      h('button', { type: 'button', class: 'btn primary', onclick: install }, 'Встановити'));
  }

  function renderSide() {
    var open = tasks().filter(isOpenNow);
    var t0 = today();
    var views = [
      ['now', 'Зараз', I.bolt, 0],
      ['board', 'Усі списки', I.list, open.length],
      ['today', 'Сьогодні', I.sun, open.filter(function (t) { return t.due && t.due <= t0; }).length],
      ['matrix', 'Матриця', I.grid, open.filter(function (t) { return quadrant(t) === 1; }).length],
      ['starred', 'Важливі', I.star, open.filter(function (t) { return t.starred; }).length]
    ];
    $('views').replaceChildren.apply($('views'), views.map(function (v) {
      return h('button', { type: 'button', class: 'nav-item', 'aria-current': String(ui.view === v[0]),
        onclick: function () { ui.view = v[0]; saveUi(); closeNav(); render(); } },
        svg(v[2], 20), v[1], h('span', { class: 'count' }, v[3] || ''));
    }));
    var cur = mobileMq.matches && ui.view === 'board' ? currentList() : null;
    $('lists').replaceChildren.apply($('lists'), lists().map(function (l) {
      return h('div', { class: 'list-row', style: '--c:' + l.color, 'aria-current': String(l === cur) },
        h('button', { type: 'button', class: 'dot', role: 'switch', 'aria-checked': String(l.visible),
          'aria-label': (l.visible ? 'Сховати з дошки «' : 'Показати на дошці «') + l.name + '»',
          title: l.visible ? 'Сховати з дошки' : 'Показати на дошці',
          onclick: function () { l.visible = !l.visible; commit(); } }),
        h('button', { type: 'button', class: 'name', onclick: function () { showList(l); } }, l.name),
        h('span', { class: 'count' }, openCount(l.id) || ''));
    }));
    $('themes').replaceChildren.apply($('themes'), [['auto', 'Авто'], ['dark', 'Темна'], ['light', 'Світла']].map(function (x) {
      return h('button', { type: 'button', 'aria-pressed': String(ui.theme === x[0]), onclick: function () { ui.theme = x[0]; saveUi(); render(); } }, x[1]);
    }));
    $('sizes').replaceChildren.apply($('sizes'), SIZES.map(function (x) {
      return h('button', { type: 'button', 'aria-pressed': String(ui.size === x[1]), 'aria-label': 'Розмір тексту ' + x[0],
        onclick: function () { ui.size = x[1]; saveUi(); render(); } }, x[0]);
    }));
  }

  function renderHead() {
    var t0 = today();
    var open = tasks().filter(function (t) { return !t.done && !t.parentId; });
    var now = open.filter(function (t) { return t.due === t0; }).length;
    var late = open.filter(function (t) { return t.due && t.due < t0; }).length;
    var doneToday = tasks().filter(function (t) { return t.done && t.doneAt === t0 && !t.parentId; }).length;
    var total = doneToday + now + late;
    var date = new Date().toLocaleDateString('uk-UA', { weekday: 'long', day: 'numeric', month: 'long' });
    date = date.charAt(0).toUpperCase() + date.slice(1);
    var canInstall = installEvt && !standaloneMq.matches;
    var focus = focusToday(), focusDone = focus.filter(function (t) { return t.done; }).length;
    $('head').replaceChildren(
      h('div', { class: 'head-date' }, date),
      h('div', { class: 'head-sum' },
        total ? [
          h('span', {}, 'Сьогодні ', h('b', {}, doneToday + ' з ' + total), ' виконано'),
          h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(doneToday) },
            h('i', { style: 'width:' + Math.round(doneToday / total * 100) + '%' })),
          late ? h('span', { class: 'late' }, 'з минулих днів: ' + late) : null
        ] : h('span', {}, ready ? 'На сьогодні нічого не заплановано' : ''),
        // план дня: поки головного не обрано — запрошення, потім — скільки з нього зроблено
        !ready ? null : focus.length
          ? h('button', { type: 'button', class: 'focus-pill', title: 'Головне на сьогодні', onclick: function () { openPlan('focus'); } },
              svg(I.target, 15), 'Головне: ' + focusDone + ' з ' + focus.length)
          : h('button', { type: 'button', class: 'btn', onclick: function () { openPlan(); } }, svg(I.target, 16), ' Спланувати день'),
        canInstall ? h('button', { type: 'button', class: 'btn primary', onclick: install }, 'Встановити застосунок') : null));
  }

  function chipsFor(t, showList) {
    var out = [];
    if (isFocus(t) && !t.done && !t.parentId) out.push(h('span', { class: 'chip focus' }, svg(I.target, 14), 'Головне'));
    if (isStuck(t)) out.push(h('span', { class: 'chip stuck', title: stuckText(t) }, 'застрягло'));
    if (t.due) {
      var late = !t.done && t.due < today(), now = t.due === today();
      out.push(h('span', { class: 'chip' + (late ? ' late' : now ? ' today' : '') }, svg(I.clock, 14), dueLabel(t.due), t.repeat !== 'none' ? svg(I.repeat, 14) : null));
    } else if (t.repeat !== 'none') {
      out.push(h('span', { class: 'chip' }, svg(I.repeat, 14), REPEATS[t.repeat]));
    }
    if (t.est && !t.done) out.push(h('span', { class: 'chip', title: 'Скільки часу займе' }, svg(I.hourglass, 14), estLabel(t.est)));
    var subs = childrenOf(t.id);
    if (subs.length && !t.parentId && !t.done && showList) {
      out.push(h('span', { class: 'chip' }, svg(I.sub, 14), subs.filter(function (s) { return s.done; }).length + '/' + subs.length));
    }
    if (showList) {
      var l = listOf(t.listId);
      if (l) out.push(h('span', { class: 'chip list', style: '--c:' + l.color }, l.name));
    }
    return out.length ? h('div', { class: 'chips' }, out) : null;
  }

  /** Відкрити список: на телефоні — його вкладку, на комп'ютері — прокрутити до колонки. */
  function showList(l) {
    var wasHidden = !l.visible;
    l.visible = true;
    ui.view = 'board';
    ui.mList = l.id;
    saveUi();
    closeNav();
    if (wasHidden) commit(); else render();
    if (mobileMq.matches) { window.scrollTo(0, 0); return; }
    var col = document.querySelector('.col[data-list="' + l.id + '"]');
    if (col) col.scrollIntoView({ behavior: reduceMq.matches ? 'auto' : 'smooth', inline: 'center', block: 'nearest' });
  }

  function openDrawer(id) {
    drawerTask = id;
    pushOverlay('drawer');
    render();
  }

  function taskRow(t, opts) {
    opts = opts || {};
    var drag = !!opts.drag;
    var row = h('div', {
      class: 'task' + (t.done ? ' done' : '') + (opts.sub ? ' sub' : ''),
      draggable: drag ? 'true' : null,
      ondragstart: drag ? function (e) {
        dragId = t.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', t.id);
        requestAnimationFrame(function () { row.classList.add('dragging'); });
      } : null,
      ondragend: drag ? function () {
        dragId = null; clearDrop(); row.classList.remove('dragging');
        if (renderLater) { renderLater = false; render(); }
      } : null,
      ondragover: drag ? function (e) {
        if (!dragId) return;
        e.preventDefault(); e.stopPropagation(); clearDrop();
        var r = row.getBoundingClientRect();
        row.classList.add(e.clientY > r.top + r.height / 2 ? 'drop-after' : 'drop-before');
      } : null,
      ondrop: drag ? function (e) {
        if (!dragId) return;
        e.preventDefault(); e.stopPropagation();
        var after = row.classList.contains('drop-after');
        clearDrop();
        moveTask(dragId, t.listId, t.id, after);
      } : null
    },
      h('button', { type: 'button', class: 'check', 'aria-label': t.done ? 'Позначити невиконаним' : 'Позначити виконаним', onclick: function (e) {
        if (t.done || reduceMq.matches) return toggleDone(t);
        if (row.classList.contains('completing')) return;
        row.classList.add('completing');
        burst(e.currentTarget);
        setTimeout(function () { toggleDone(t); }, 420);
      } }),
      h('button', { type: 'button', class: 'task-body', onclick: function () { openDrawer(t.id); } },
        h('span', { class: 'task-title' }, t.title || 'Без назви'),
        t.notes && !t.done ? h('span', { class: 'task-notes' }, t.notes) : null,
        chipsFor(t, !!opts.showList)),
      opts.sub || t.done ? null : h('button', { type: 'button', class: 'star' + (t.starred ? ' on' : ''), 'aria-label': t.starred ? 'Прибрати зірочку' : 'Додати зірочку',
        onclick: function () { t.starred = !t.starred; commit(); } }, svg(I.star, 19, 1.8)));
    if (opts.touch === false || !mobileMq.matches) return row;
    // телефон: рядок у обгортці, під якою видно, що зробить свайп
    var wrap = h('div', { class: 'srow', 'data-id': t.id, 'data-top': opts.lift ? '1' : null,
      'data-ldone': t.done ? 'Повернути' : 'Виконано', 'data-ldel': 'Видалити' }, row);
    touchable(wrap, row, t, !!opts.lift);
    return wrap;
  }

  /* ---------- жести на телефоні ----------
     Свайп праворуч — виконано (або повернути виконане), ліворуч — видалити;
     обидва зі «Скасувати». Довге натискання піднімає завдання, і його можна
     перетягнути вище чи нижче. Звичайна прокрутка пальцем лишається як є:
     рух угору-вниз до спрацювання жесту віддаємо сторінці. */

  var gest = null;
  var swallowClick = 0;     // після жесту палець відпускають над кнопкою — це не натискання

  document.addEventListener('click', function (e) {
    if (Date.now() - swallowClick < 450) { e.stopPropagation(); e.preventDefault(); }
  }, true);
  document.addEventListener('contextmenu', function (e) { if (gest) e.preventDefault(); }, true);

  function touchable(wrap, row, t, liftable) {
    wrap.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) { cancelGesture(); return; }
      var p = e.touches[0];
      gest = { wrap: wrap, row: row, t: t, x0: p.clientX, y0: p.clientY, cy: p.clientY, dx: 0, dy: 0, mode: 'wait', sy0: window.scrollY,
        timer: liftable ? setTimeout(lift, 380) : null };
    }, { passive: true });
    wrap.addEventListener('touchmove', function (e) {
      var g = gest;
      if (!g || g.wrap !== wrap) return;
      var p = e.touches[0];
      g.dx = p.clientX - g.x0; g.dy = p.clientY - g.y0; g.cy = p.clientY;
      if (g.mode === 'wait') {
        var ax = Math.abs(g.dx), ay = Math.abs(g.dy);
        if (ax > 12 && ax > ay * 1.5) { clearTimeout(g.timer); g.mode = 'swipe'; wrap.classList.add('swiping'); }
        else if (ax > 10 || ay > 10) { cancelGesture(); return; }    // це прокрутка
        else return;
      }
      if (e.cancelable) e.preventDefault();
      if (g.mode === 'swipe') swipeMove(g); else if (g.mode === 'lift') liftMove(g);
    }, { passive: false });
    wrap.addEventListener('touchend', function () { endGesture(wrap); });
    wrap.addEventListener('touchcancel', function () { cancelGesture(); });
  }

  function swipeMove(g) {
    var w = g.wrap.offsetWidth;
    var x = Math.max(-w, Math.min(w, g.dx));
    g.row.style.transform = 'translateX(' + x + 'px)';
    g.wrap.dataset.swipe = x > 0 ? 'done' : 'del';
    g.wrap.classList.toggle('armed', Math.abs(x) > w * 0.33);
  }

  function resetSwipe(g) {
    g.row.style.transition = 'transform .18s ease';
    g.row.style.transform = '';
    setTimeout(function () {
      g.wrap.classList.remove('swiping', 'armed');
      g.wrap.removeAttribute('data-swipe');
      g.row.style.transition = '';
    }, 200);
  }

  function lift() {
    var g = gest;
    if (!g || g.mode !== 'wait') return;
    g.mode = 'lift';
    g.wrap.classList.add('lifted');
    if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) {} }
    g.list = Array.prototype.slice.call(g.wrap.parentNode.querySelectorAll('.srow[data-top]'));
    (function edge() {
      // біля верхнього чи нижнього краю екрана список сам прокручується
      if (gest !== g || g.mode !== 'lift') return;
      var top = 140, bottom = window.innerHeight - 120, v = 0;
      if (g.cy < top) v = -Math.min(14, (top - g.cy) / 5);
      else if (g.cy > bottom) v = Math.min(14, (g.cy - bottom) / 5);
      if (v) { window.scrollBy(0, v); liftMove(g); }
      requestAnimationFrame(edge);
    })();
  }

  function liftMove(g) {
    g.wrap.style.transform = 'translateY(' + (g.dy + window.scrollY - g.sy0) + 'px)';
    clearDrop();
    g.target = null; g.after = false;
    var others = g.list.filter(function (w) { return w !== g.wrap; });
    for (var i = 0; i < others.length; i++) {
      var r = others[i].getBoundingClientRect();
      if (g.cy < r.top + r.height / 2) { g.target = others[i]; break; }
    }
    if (!g.target && others.length) { g.target = others[others.length - 1]; g.after = true; }
    if (g.target) g.target.classList.add(g.after ? 'drop-after' : 'drop-before');
  }

  function endGesture(wrap) {
    var g = gest;
    if (!g || g.wrap !== wrap) return;
    gest = null;
    clearTimeout(g.timer);
    if (g.mode === 'swipe') {
      swallowClick = Date.now();
      var w = wrap.offsetWidth, x = g.dx;
      if (Math.abs(x) > w * 0.33) {
        g.row.style.transition = 'transform .16s ease';
        g.row.style.transform = 'translateX(' + (x > 0 ? w : -w) + 'px)';
        setTimeout(function () { if (x > 0) toggleDone(g.t); else removeTask(g.t); }, 160);
      } else resetSwipe(g);
    } else if (g.mode === 'lift') {
      swallowClick = Date.now();
      clearDrop();
      wrap.classList.remove('lifted');
      wrap.style.transform = '';
      var ref = g.target && g.target.dataset.id;
      if (ref && ref !== g.t.id) moveTask(g.t.id, g.t.listId, ref, g.after);
    }
    if (renderLater) { renderLater = false; render(); }
  }

  function cancelGesture() {
    var g = gest;
    gest = null;
    if (!g) return;
    clearTimeout(g.timer);
    if (g.mode === 'swipe') resetSwipe(g);
    if (g.mode === 'lift') { clearDrop(); g.wrap.classList.remove('lifted'); g.wrap.style.transform = ''; }
    if (renderLater) { renderLater = false; render(); }
  }

  function addBlock(listId, extra) {
    var key = listId + (extra ? ':x' : '');
    if (addingIn === key) {
      var input = h('input', { id: 'add-' + listId, placeholder: 'Назва завдання', autocomplete: 'off', 'aria-label': 'Назва завдання',
        oninput: function () { addDraft = input.value; },
        onkeydown: function (e) {
          if (e.key === 'Enter' && input.value.trim()) {
            var title = input.value;
            addDraft = '';
            addTask(listId, title, extra);
            requestAnimationFrame(function () { var i = $('add-' + listId); if (i) i.focus(); });
          }
          if (e.key === 'Escape') { addingIn = null; addDraft = ''; render(); }
        },
        onblur: function () {
          setTimeout(function () {
            if (addingIn === key && (!document.activeElement || document.activeElement.id !== 'add-' + listId)) {
              addingIn = null;
              if (!addDraft.trim()) addDraft = '';
              render();
            }
          }, 120);
        } });
      input.value = addDraft;
      requestAnimationFrame(function () { if (document.activeElement !== input) input.focus(); });
      return h('div', { class: 'add-input' }, svg(I.addTask, 22, 1.8), input);
    }
    return h('button', { type: 'button', class: 'add-row', onclick: function () { addingIn = key; addDraft = ''; render(); } }, svg(I.addTask, 22, 1.8), 'Додати завдання');
  }

  var DONE_SHOWN = 30;   // виконаних показуємо стільки, решта — за кнопкою: повтори щодня за рік — сотні рядків
  var doneLimit = {};

  function column(l) {
    var mode = ui.sort[l.id] || 'mine';
    var phone = mobileMq.matches;
    var canDrag = !phone && !hoverMq.matches;
    var top = sorted(tasks().filter(function (t) { return t.listId === l.id && isOpenNow(t); }), mode);
    // справи на майбутнє сховані, доки не настане їхній день; знайти їх можна тут, згорнутими
    var later = sorted(tasks().filter(function (t) { return t.listId === l.id && !t.parentId && !t.done && isFuture(t); }), 'date');
    ui.openFuture = ui.openFuture || {};
    var futureOpen = !!ui.openFuture[l.id];
    var done = tasks().filter(function (t) {
      if (t.listId !== l.id || !t.done) return false;
      var p = t.parentId && db.tasks[t.parentId];
      return !p || !p.done;
    }).sort(function (a, b) { return (b.doneAt || '').localeCompare(a.doneAt || '') || b.order - a.order; });
    var rows = [];
    top.forEach(function (t) {
      rows.push(taskRow(t, { drag: canDrag, lift: phone }));
      sorted(childrenOf(t.id).filter(function (s) { return !s.done; }), 'mine').forEach(function (s) { rows.push(taskRow(s, { sub: true })); });
    });
    var isOpen = !!ui.openDone[l.id];
    var limit = doneLimit[l.id] || DONE_SHOWN;
    /* На телефоні назва списку вже у вкладці над ним — тут лише скільки й як упорядковано */
    var tabbed = phone && lists().filter(function (x) { return x.visible; }).length > 1;
    var SORT_NAMES = { mine: 'мій порядок', date: 'за датою', starred: 'спершу із зірочкою' };
    var col = h('section', { class: 'col', style: '--c:' + l.color, 'aria-label': l.name, 'data-list': l.id,
      ondragover: function (e) { if (!dragId) return; e.preventDefault(); clearDrop(); col.classList.add('drop-col'); },
      ondragleave: function (e) { if (!col.contains(e.relatedTarget)) col.classList.remove('drop-col'); },
      ondrop: function (e) { if (!dragId) return; e.preventDefault(); clearDrop(); moveTask(dragId, l.id, null, true); } },
      h('div', { class: 'col-head' },
        tabbed
          ? h('div', { class: 'col-title' }, h('span', {}, (top.length ? top.length + ' ' + plural(top.length) : 'Немає завдань') + ' · ' + SORT_NAMES[mode]))
          : h('div', { class: 'col-title' }, h('i', { class: 'col-dot' }), h('span', {}, l.name),
              top.length ? h('span', { class: 'pill', title: top.length + ' ' + plural(top.length) }, top.length) : null),
        columnMenu(l, mode)),
      phone ? null : addBlock(l.id),
      // на комп'ютері кожен список гортається сам: шапка й «Додати завдання» лишаються на місці
      h('div', { class: 'col-body' },
        rows.length ? rows : h('div', { class: 'empty' }, done.length ? 'Усе виконано. Можна видихнути.'
          : later.length ? 'Сьогодні тут нічого. Заплановане з\'явиться у свій день.' : 'Поки порожньо. Додайте перше завдання.'),
        later.length ? h('button', { type: 'button', class: 'done-toggle', 'aria-expanded': String(futureOpen),
          onclick: function () { ui.openFuture[l.id] = !futureOpen; saveUi(); render(); } }, svg(I.chev, 18), 'Заплановано (' + later.length + ')') : null,
        futureOpen ? later.map(function (t) { return taskRow(t, { touch: false }); }) : null,
        done.length ? h('button', { type: 'button', class: 'done-toggle', 'aria-expanded': String(isOpen),
          onclick: function () { ui.openDone[l.id] = !isOpen; saveUi(); render(); } }, svg(I.chev, 18), 'Виконані (' + done.length + ')') : null,
        isOpen ? done.slice(0, limit).map(function (t) { return taskRow(t); }) : null,
        isOpen && done.length > limit ? h('button', { type: 'button', class: 'more', onclick: function () { doneLimit[l.id] = limit + 100; render(); } },
          'Показати ще ' + Math.min(100, done.length - limit)) : null));
    return col;
  }

  function columnMenu(l, mode) {
    var open = openMenu === l.id;
    var wrap = h('div', { class: 'menu-wrap' },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Дії зі списком', 'aria-expanded': String(open),
        onclick: function (e) { e.stopPropagation(); openMenu = open ? null : l.id; armed = null; render(); } }, svg(I.dots, 20)));
    if (!open) return wrap;
    var doneList = tasks().filter(function (t) { return t.listId === l.id && t.done; });
    var loud = tasks().filter(function (t) { return t.listId === l.id && isShouting(t.title); });
    wrap.append(h('div', { class: 'menu', onclick: function (e) { e.stopPropagation(); } },
      h('div', { class: 'menu-label' }, 'Сортування'),
      [['mine', 'Мій порядок'], ['date', 'За датою'], ['starred', 'Спершу із зірочкою']].map(function (x) {
        return h('button', { type: 'button', onclick: function () { ui.sort[l.id] = x[0]; openMenu = null; saveUi(); render(); } },
          (mode === x[0] ? '✓ ' : ' ') + x[1]);
      }),
      h('hr'),
      h('div', { class: 'menu-label' }, 'Колір'),
      h('div', { class: 'swatches' }, COLORS.map(function (c) {
        return h('button', { type: 'button', style: '--c:' + c, 'aria-label': 'Колір списку', 'aria-pressed': String(l.color === c),
          onclick: function () { l.color = c; commit(); } });
      })),
      h('hr'),
      h('button', { type: 'button', onclick: function () { openMenu = null; renameList = l.id; render(); } }, 'Перейменувати'),
      loud.length ? h('button', { type: 'button', onclick: function () {
        var was = loud.map(function (t) { return [t, t.title]; });
        loud.forEach(function (t) { t.title = calm(t.title); });
        openMenu = null; commit();
        toast('Прибрано капс у ' + was.length + ' ' + plural(was.length), function () { was.forEach(function (x) { x[0].title = x[1]; }); commit(); });
      } }, 'Прибрати капс у назвах') : null,
      doneList.length ? h('button', { type: 'button', onclick: function () {
        doneList.forEach(function (t) { delete db.tasks[t.id]; });
        openMenu = null; commit();
        toast('Видалено виконаних: ' + doneList.length, function () { doneList.forEach(function (t) { db.tasks[t.id] = t; }); commit(); });
      } }, 'Очистити виконані') : null,
      Object.keys(db.lists).length > 1 ? h('button', { type: 'button', class: 'danger', onclick: function () {
        if (armed !== l.id) { armed = l.id; render(); return; }
        var gone = tasks().filter(function (t) { return t.listId === l.id; });
        delete db.lists[l.id];
        gone.forEach(function (t) { delete db.tasks[t.id]; });
        openMenu = null; armed = null; commit();
        toast('Список «' + l.name + '» видалено', function () {
          db.lists[l.id] = l;
          gone.forEach(function (t) { db.tasks[t.id] = t; });
          commit();
        });
      } }, armed === l.id ? 'Натисніть ще раз, щоб видалити' : 'Видалити список') : null));
    return wrap;
  }

  function renameCol(l) {
    var fresh = renameDraft === null;
    var input = h('input', { id: 'rename-input', 'aria-label': 'Нова назва списку',
      oninput: function () { renameDraft = input.value; },
      onkeydown: function (e) { if (e.key === 'Enter') done(); if (e.key === 'Escape') { renameList = null; renameDraft = null; render(); } },
      onblur: function () { setTimeout(function () { if (!document.activeElement || document.activeElement.id !== 'rename-input') done(); }, 120); } });
    input.value = fresh ? l.name : renameDraft;
    renameDraft = input.value;
    function done() {
      if (renameList !== l.id) return;
      renameList = null;
      if (input.value.trim()) l.name = input.value.trim();
      renameDraft = null;
      commit();
    }
    requestAnimationFrame(function () {
      if (document.activeElement === input) return;
      input.focus();
      if (fresh) input.select();
    });
    return h('section', { class: 'col', style: '--c:' + l.color }, h('div', { class: 'add-input rename' }, input));
  }

  function renderBoard() {
    var b = $('board');
    if (!ready) {
      b.replaceChildren(h('section', { class: 'flat' }, h('h2', {}, lastProblem ? 'Поки без справ' : 'Завантажую ваші справи…'),
        h('div', { class: 'empty' }, lastProblem || 'Перший раз на цьому пристрої: беремо їх із сервера.')));
      return;
    }
    if (ui.view === 'board') {
      var vis = lists().filter(function (l) { return l.visible; });
      if (!vis.length) {
        b.replaceChildren(h('section', { class: 'flat' }, h('h2', {}, Object.keys(db.lists).length ? 'Усі списки приховано' : 'Списків ще немає'),
          h('div', { class: 'empty' }, Object.keys(db.lists).length ? 'Увімкніть потрібні списки в меню ліворуч.' : 'Створіть перший у меню ліворуч: поле «Новий список».')));
        return;
      }
      if (mobileMq.matches) {
        // вкладки списків — у шапці (renderTop), тут лише відкритий список
        var cur = currentList();
        b.replaceChildren(installBar() || '', planInvite(true) || '', renameList === cur.id ? renameCol(cur) : column(cur));
        return;
      }
      // колонки малюються наново, а гортання кожної має лишитися там, де було
      var kept = {};
      b.querySelectorAll('.col[data-list] > .col-body').forEach(function (x) { kept[x.parentNode.dataset.list] = x.scrollTop; });
      b.replaceChildren.apply(b, vis.map(function (l) { return renameList === l.id ? renameCol(l) : column(l); }));
      b.querySelectorAll('.col[data-list] > .col-body').forEach(function (x) {
        var y = kept[x.parentNode.dataset.list];
        if (y) x.scrollTop = y;
      });
      return;
    }
    if (ui.view === 'now') { renderNow(b); return; }
    if (ui.view === 'matrix') { renderMatrix(b); return; }
    if (ui.view === 'today') { renderToday(b); return; }
    var open = tasks().filter(isOpenNow);
    var first = lists().filter(function (l) { return l.visible; })[0] || lists()[0];
    var starred = sorted(open.filter(function (t) { return t.starred; }), 'date');
    b.replaceChildren(installBar() || '', h('section', { class: 'flat' },
      h('h2', {}, 'Важливі'),
      first && !mobileMq.matches ? addBlock(first.id, { starred: true }) : null,
      starred.length ? starred.map(function (t) { return taskRow(t, { showList: true }); })
        : h('div', { class: 'empty' }, 'Позначте важливі завдання зірочкою, і вони з\'являться тут.')));
  }

  /* ---------- «План на день»: запрошення ----------
     Поки головного на сьогодні не обрано — тихе запрошення. «Не зараз»
     ховає його до завтра: план корисний, коли він легкий, а не обов'язковий. */
  function planInvite(slim) {
    if (!ready || focusToday().length || ui.planSkip === today()) return null;
    if (!tasks().some(isOpenNow)) return null;
    var late = tasks().filter(function (t) { return !t.done && !t.parentId && daysLate(t); }).length;
    return h('div', { class: slim ? 'plan-bar' : 'plan-card' },
      h('span', { class: 'plan-ico' }, svg(I.target, 20)),
      h('div', { class: 'plan-text' },
        h('b', {}, 'План на день'),
        slim ? null : h('span', {}, (late ? 'Вирішити, що робити зі справами з минулих днів (' + late + '), й о' : 'О') + 'брати до трьох головних. Хвилина.')),
      h('button', { type: 'button', class: 'btn primary', onclick: function () { openPlan(); } }, slim ? 'Почати' : 'Спланувати'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Не зараз', title: 'Не зараз',
        onclick: function () { ui.planSkip = today(); saveUi(); render(); } }, svg(I.close, 18)));
  }

  function renderToday(b) {
    var t0 = today();
    var open = tasks().filter(function (t) { return !t.done && !t.parentId; });
    var focus = focusToday();
    var focusOpen = sorted(focus.filter(function (t) { return !t.done; }), 'mine');
    var focusDone = focus.length - focusOpen.length;
    var rest = open.filter(function (t) { return t.due && t.due <= t0 && !isFocus(t); });
    var late = sorted(rest.filter(function (t) { return t.due < t0; }), 'date');
    var now = sorted(rest.filter(function (t) { return t.due === t0; }), 'mine');
    var first = lists().filter(function (l) { return l.visible; })[0] || lists()[0];
    // зроблене сьогодні — на видноті: «я нічого не встиг» рідко правда
    var done = sorted(tasks().filter(function (t) { return t.done && !t.parentId && t.doneAt === t0; }), 'mine');

    b.replaceChildren(installBar() || '', h('section', { class: 'flat' },
      h('h2', {}, 'Сьогодні'),
      planInvite(false),
      focus.length ? [
        h('div', { class: 'group-row' },
          h('div', { class: 'group-label' }, 'Головне · ' + focusDone + ' з ' + focus.length),
          h('button', { type: 'button', class: 'link-btn', onclick: function () { openPlan('focus'); } }, 'Змінити')),
        focusOpen.length ? focusOpen.map(function (t) { return taskRow(t, { showList: true }); })
          : h('div', { class: 'empty win' }, 'Головне на сьогодні зроблено. Усе інше буде бонусом.')
      ] : null,
      first && !mobileMq.matches ? addBlock(first.id, { due: t0 }) : null,
      late.length ? [
        h('div', { class: 'group-row' },
          h('div', { class: 'group-label' }, 'З минулих днів'),
          h('button', { type: 'button', class: 'link-btn', onclick: function () { openPlan('triage'); } }, 'Розібрати')),
        late.map(function (t) { return taskRow(t, { showList: true }); })
      ] : null,
      now.length ? [h('div', { class: 'group-row' }, h('div', { class: 'group-label' }, 'На сьогодні')),
        now.map(function (t) { return taskRow(t, { showList: true }); })] : null,
      !focus.length && !late.length && !now.length ? h('div', { class: 'empty' }, 'На сьогодні нічого не заплановано.') : null,
      done.length ? [h('div', { class: 'group-row' }, h('div', { class: 'group-label win' }, 'Зроблено сьогодні · ' + done.length)),
        done.slice(0, DONE_SHOWN).map(function (t) { return taskRow(t, { showList: true }); })] : null));
  }

  /* ---------- «Зараз»: одна справа ---------- */

  function renderNow(b) {
    var q = nowQueue(), t = q[0];
    var energy = h('div', { class: 'seg energy', role: 'group', 'aria-label': 'Скільки зараз сил' },
      [['ok', 'Сили є'], ['low', 'Сил мало']].map(function (x) {
        return h('button', { type: 'button', 'aria-pressed': String((lowEnergy() ? 'low' : 'ok') === x[0]),
          onclick: function () { ui.energy = x[0]; ui.energyDay = today(); saveUi(); render(); } }, x[1]);
      }));
    var body;
    if (!t) {
      var anyOpen = tasks().some(function (x) { return !x.done && !x.parentId; });
      body = h('div', { class: 'now-empty' },
        h('div', { class: 'now-empty-title' }, anyOpen ? 'На сьогодні нічого не обрано' : 'Усе зроблено'),
        h('p', {}, anyOpen ? 'Оберіть до трьох головних справ або візьміть будь-яку з решти. По одній.'
          : 'Відкритих справ немає. Можна відпочити з чистою совістю.'),
        anyOpen ? h('div', { class: 'help-row' },
          h('button', { type: 'button', class: 'btn primary', onclick: function () { openPlan('focus'); } }, 'Обрати головне'),
          h('button', { type: 'button', class: 'btn', onclick: function () { nowAll = true; render(); } }, 'Взяти будь-яку')) : null);
    } else {
      var l = listOf(t.listId);
      var step = sorted(childrenOf(t.id).filter(function (c) { return !c.done; }), 'mine')[0];
      var mins = timerMins(t);
      body = [
        h('article', { class: 'now-card' },
          h('div', { class: 'chips' },
            isFocus(t) ? h('span', { class: 'chip focus' }, svg(I.target, 14), 'Головне') : null,
            t.due ? h('span', { class: 'chip' + (t.due < today() ? ' late' : t.due === today() ? ' today' : '') }, svg(I.clock, 14), dueLabel(t.due)) : null,
            t.est ? h('span', { class: 'chip' }, svg(I.hourglass, 14), estLabel(t.est)) : null,
            l ? h('span', { class: 'chip list', style: '--c:' + l.color }, l.name) : null),
          h('button', { type: 'button', class: 'now-title', title: 'Відкрити картку', onclick: function () { openDrawer(t.id); } }, t.title || 'Без назви'),
          step ? h('div', { class: 'now-step' },
            h('button', { type: 'button', class: 'check', 'aria-label': 'Крок зроблено', onclick: function (e) { burst(e.currentTarget); toggleDone(step); } }),
            h('span', {}, h('small', {}, 'Перший крок'), step.title)) : null,
          h('button', { type: 'button', class: 'btn primary now-go', onclick: function () { startKick(t, mins); } },
            svg(I.play, 18), 'Почати · ' + estLabel(mins)),
          h('div', { class: 'now-mins' }, h('span', {}, 'або'),
            TIMER_MINS.filter(function (m) { return m !== mins; }).map(function (m) {
              return h('button', { type: 'button', onclick: function () { startKick(t, m); } }, m + ' хв');
            })),
          h('div', { class: 'now-actions' },
            h('button', { type: 'button', class: 'btn', onclick: function (e) { burst(e.currentTarget); toggleDone(t); } }, 'Готово'),
            h('button', { type: 'button', class: 'btn', onclick: function () { notNow(t, q.length); } }, 'Не зараз')),
          h('button', { type: 'button', class: 'quiet-link', onclick: function () { openHelp(t); } }, svg(I.knot, 16), 'Не можу взятися?')),
        q.length > 1 ? h('div', { class: 'now-next' }, 'Далі: ', h('b', {}, q[1].title || 'Без назви'),
          q.length > 2 ? ' · ще ' + (q.length - 2) : '') : null
      ];
    }
    b.replaceChildren(installBar() || '', h('section', { class: 'flat now' },
      h('div', { class: 'now-head' }, h('h2', {}, 'Зараз'), energy),
      planInvite(true),
      body));
  }

  /** «Не зараз»: у кінець черги до завтра. Нічого не змінює в самій справі. */
  function notNow(t, n) {
    var t0 = today();
    if (!ui.later || ui.later.day !== t0) ui.later = { day: t0, ids: [] };
    ui.later.ids = ui.later.ids.filter(function (id) { return id !== t.id && db.tasks[id]; }).concat(t.id);
    saveUi();
    if (n < 2 && !nowAll && tasks().some(function (x) { return !x.done && !x.parentId && x.id !== t.id; })) {
      nowAll = true;
      render();
      toast('На сьогодні більше нічого. Ось щось із решти.');
      return;
    }
    render();
    if (n < 2) toast('Інших відкритих справ немає.');
  }

  /* ---------- Матриця ----------
     Чотири квадранти рахуються самі: зірочка — важливо, дата до завтра —
     терміново. Щоб перекласти справу, досить зірочки чи дати. */
  var QUAD_SHOWN = 6;

  function renderMatrix(b) {
    var by = { 1: [], 2: [], 3: [], 4: [] };
    tasks().forEach(function (t) { if (isOpenNow(t)) by[quadrant(t)].push(t); });
    var EMPTY = {
      1: 'Нічого не горить. Добре.',
      2: 'Позначте зірочкою те, що справді важливе, і воно з\'явиться тут.',
      3: 'Термінового неважливого немає.',
      4: 'Порожньо.'
    };
    ui.qOpen = ui.qOpen || {};
    function quad(q) {
      var arr = q === 4 ? sorted(by[q], 'mine') : sorted(by[q], 'date');
      var open = !!ui.qOpen[q];
      var shown = open ? arr : arr.slice(0, QUAD_SHOWN);
      return h('section', { class: 'quad q' + q, 'aria-label': QUADS[q].name },
        h('div', { class: 'quad-head' },
          h('span', { class: 'qnum' }, q),
          h('span', { class: 'quad-name' }, QUADS[q].name),
          arr.length ? h('span', { class: 'pill' }, arr.length) : null),
        h('div', { class: 'quad-hint' }, QUADS[q].hint),
        arr.length ? shown.map(function (t) { return taskRow(t, { showList: true }); }) : h('div', { class: 'empty' }, EMPTY[q]),
        arr.length > QUAD_SHOWN ? h('button', { type: 'button', class: 'more', onclick: function () { ui.qOpen[q] = !open; saveUi(); render(); } },
          open ? 'Згорнути' : 'Показати всі ' + arr.length) : null);
    }
    b.replaceChildren(installBar() || '', h('section', { class: 'flat wide' },
      h('h2', {}, 'Матриця'),
      planInvite(true),
      h('p', { class: 'matrix-rule' }, 'Важливе позначайте зірочкою. Термінове: з датою на сьогодні чи раніше. Справи на майбутнє з\'являться тут у свій день.'),
      h('div', { class: 'matrix' }, [1, 2, 3, 4].map(quad))));
  }

  /* ---------- картка завдання ---------- */

  var drawerStamp = '';
  function stampOf(t) { return t.id + ':' + JSON.stringify(t) + childrenOf(t.id).map(function (c) { return c.title + c.done; }).join(); }

  /** Закрити картку. fromBack — її вже закрила кнопка «Назад», крок історії знято. */
  function closeDrawer(fromBack) {
    var t = drawerTask && db.tasks[drawerTask];
    drawerTask = null; drawerStamp = '';
    if (!fromBack) popOverlay('drawer');
    // порожнє, щойно створене кнопкою «Нове завдання», не лишаємо
    if (t && !t.title.trim() && !t.notes.trim()) {
      childrenOf(t.id).forEach(function (c) { delete db.tasks[c.id]; });
      delete db.tasks[t.id];
      commit();
    } else render();
  }

  function renderDrawer() {
    var layer = $('layer');
    var t = drawerTask && db.tasks[drawerTask];
    if (!t) {
      // картку закрило щось інше (видалення, зміна з іншого пристрою) — крок історії теж прибираємо
      if (isOpen('drawer')) popOverlay('drawer');
      drawerTask = null; drawerStamp = '';
      if (layer.firstChild) layer.replaceChildren();
      return;
    }
    if (drawerStamp === stampOf(t)) return;
    var active = document.activeElement;
    var focusId = active && active.id, selStart = active && active.selectionStart;
    drawerStamp = stampOf(t);

    function close() { closeDrawer(false); }
    function set(k, v) { t[k] = v; commit(); }
    function typed(k, v) { t[k] = v; quiet = true; commit(); quiet = false; drawerStamp = stampOf(t); }

    var parent = t.parentId && db.tasks[t.parentId];
    var delBtn = h('button', { type: 'button', class: 'btn danger', onclick: function () {
      if (!delBtn.classList.contains('armed')) { delBtn.classList.add('armed'); delBtn.textContent = 'Точно видалити?'; return; }
      drawerTask = null; removeTask(t);
    } }, 'Видалити');
    var subInput = h('input', { id: 'd-sub', placeholder: 'Додати підзавдання', autocomplete: 'off', onkeydown: function (e) {
      if (e.key === 'Enter' && subInput.value.trim()) {
        var max = 0;
        childrenOf(t.id).forEach(function (c) { if (c.order > max) max = c.order; });
        addTask(t.listId, subInput.value, { parentId: t.id, order: max + 1, starred: false, due: '' });
      }
    } });
    var title = h('textarea', { id: 'd-title', class: 'title-input', rows: '2', 'aria-label': 'Назва', placeholder: 'Що треба зробити?' });
    title.value = t.title;
    title.addEventListener('input', function () { typed('title', title.value.replace(/\n/g, ' ')); });
    var notes = h('textarea', { id: 'd-notes', placeholder: 'Деталі, посилання, кроки' });
    notes.value = t.notes;
    notes.addEventListener('input', function () { typed('notes', notes.value); });
    var due = h('input', { id: 'd-due', type: 'date', value: t.due || '', onchange: function (e) { setDue(t, e.target.value); commit(); } });
    var rep = h('select', { id: 'd-rep', onchange: function (e) { t.repeat = e.target.value; if (t.repeat !== 'none' && !t.due) t.due = today(); commit(); } },
      Object.keys(REPEATS).map(function (k) { return h('option', { value: k, selected: t.repeat === k }, REPEATS[k]); }));
    var list = h('select', { id: 'd-list', onchange: function (e) {
      t.listId = e.target.value;
      childrenOf(t.id).forEach(function (c) { c.listId = t.listId; });
      commit();
    } }, lists().map(function (l) { return h('option', { value: l.id, selected: t.listId === l.id }, l.name); }));
    var t0 = today();

    layer.replaceChildren(
      h('div', { class: 'scrim', onclick: close }),
      h('aside', { class: 'drawer', role: 'dialog', 'aria-label': 'Деталі завдання' },
        h('div', { class: 'drawer-head' },
          h('span', { class: 'crumb' }, parent ? 'Підзавдання: ' + parent.title : ((listOf(t.listId) || {}).name || '')),
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Закрити', onclick: close }, svg(I.close, 20))),
        title,
        isShouting(t.title) ? h('button', { type: 'button', class: 'decaps', onclick: function () { set('title', calm(t.title)); } }, 'Аа  Прибрати капс') : null,
        // матриця й головне на день — двома перемикачами, без окремих полів
        parent || t.done ? null : h('div', { class: 'd-flags' },
          h('button', { type: 'button', class: 'flag' + (t.starred ? ' on' : ''), 'aria-pressed': String(t.starred),
            onclick: function () { set('starred', !t.starred); } }, svg(I.star, 16, 1.8), 'Важливо'),
          h('button', { type: 'button', class: 'flag' + (isFocus(t) ? ' on' : ''), 'aria-pressed': String(isFocus(t)),
            onclick: function () { toggleFocus(t); } }, svg(I.target, 16), 'Головне сьогодні'),
          h('span', { class: 'd-quad' }, isFuture(t)
            ? 'Заплановано: з\'явиться в списку ' + dueLabel(t.due).toLowerCase()
            : 'Матриця: ' + QUADS[quadrant(t)].name.toLowerCase())),
        parent || t.done ? null : isStuck(t)
          ? h('div', { class: 'stuck-hint' },
              h('span', {}, stuckText(t) + '. Схоже, щось заважає.'),
              h('button', { type: 'button', class: 'btn', onclick: function () { openHelp(t); } }, svg(I.knot, 16), ' Що заважає?'))
          : h('button', { type: 'button', class: 'quiet-link', onclick: function () { openHelp(t); } }, svg(I.knot, 16), 'Не можу взятися?'),
        h('div', { class: 'field' }, h('label', { for: 'd-notes' }, 'Нотатки'), notes),
        h('div', { class: 'row2' },
          h('div', { class: 'field' }, h('label', { for: 'd-due' }, 'Дата'), due),
          h('div', { class: 'field' }, h('label', { for: 'd-rep' }, 'Повтор'), rep)),
        h('div', { class: 'quick' }, [['Сьогодні', t0], ['Завтра', addDays(t0, 1)], ['Через тиждень', addDays(t0, 7)], ['Без дати', '']].map(function (x) {
          return h('button', { type: 'button', onclick: function () { setDue(t, x[1]); commit(); } }, x[0]);
        })),
        // оцінка часу: проти «часової сліпоти» — видно, чи влазить день
        parent || t.done ? null : h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Скільки часу займе'),
          h('div', { class: 'quick est' }, EST_STEPS.map(function (m) {
            return h('button', { type: 'button', 'aria-pressed': String(t.est === m), onclick: function () { set('est', t.est === m ? 0 : m); } }, estLabel(m));
          }))),
        parent ? null : h('div', { class: 'field' }, h('label', { for: 'd-list' }, 'Список'), list),
        parent ? null : h('div', { class: 'field' }, h('label', { for: 'd-sub' }, 'Підзавдання'),
          sorted(childrenOf(t.id), 'mine').map(function (c) { return taskRow(c, { touch: false }); }), subInput),
        h('div', { class: 'drawer-foot' },
          delBtn,
          h('div', {},
            h('button', { type: 'button', class: 'btn', onclick: function () { toggleDone(t); } }, t.done ? 'Повернути' : 'Виконано'),
            h('button', { type: 'button', class: 'btn primary', onclick: close }, 'Готово')))));

    var f = focusId && $(focusId);
    if (f) {
      f.focus();
      try { if (selStart != null) f.setSelectionRange(selStart, selStart); } catch (e) { /* не текстове поле */ }
    } else if (!t.title) title.focus();
  }

  /* ============================================================
     Вхід на екрані
     ============================================================ */

  function showLogin(msg) {
    $('app').hidden = true;
    $('login').hidden = false;
    $('lgEmail').value = $('lgEmail').value || lsGet(OWNER_KEY) || '';
    var err = $('lgErr');
    err.hidden = !msg;
    err.textContent = msg || '';
    setTimeout(function () { ($('lgEmail').value ? $('lgPass') : $('lgEmail')).focus(); }, 0);
  }

  function showApp() {
    $('login').hidden = true;
    $('app').hidden = false;
    if (rollHabits()) commit(); else render();
    // жести на телефоні не видно — один раз підказуємо
    if (mobileMq.matches && !ui.tipGestures) {
      ui.tipGestures = true;
      saveUi();
      setTimeout(function () { toast('Свайп праворуч: виконано. Ліворуч: видалити. Довге натискання: перетягнути.', null, 9000); }, 1500);
    }
  }

  /** Копія в браузері належить конкретному входу: увійшли іншим акаунтом — починаємо з чистого. */
  function claimLocal() {
    var s = sess();
    var email = s && s.email ? String(s.email).toLowerCase() : '';
    var owner = lsGet(OWNER_KEY);
    if (email && owner && owner !== email) forgetLocal();
    if (email) lsSet(OWNER_KEY, email);
  }

  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var email = $('lgEmail').value.trim(), pass = $('lgPass').value;
    if (!email || !pass) { showLogin('Введіть пошту й пароль'); return; }
    var btn = $('lgBtn');
    btn.disabled = true; btn.textContent = 'Вхід…';
    signIn(email, pass).then(function () {
      $('lgPass').value = '';
      claimLocal();
      showApp();
      return sync();
    }).catch(function (err) {
      showLogin(err && err.name === 'TypeError' ? 'Немає зв\'язку з сервером. Перевірте інтернет' : err.message);
    }).then(function () {
      btn.disabled = false; btn.textContent = 'Увійти';
    });
  });

  /* ============================================================
     Застосунок на екрані
     ============================================================ */

  function install() {
    if (!installEvt) return;
    var evt = installEvt;
    evt.prompt();
    evt.userChoice.then(function (c) {
      installEvt = null;
      renderHead();
      if (c && c.outcome === 'accepted') toast('Готово: «Справи» тепер серед застосунків');
    });
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();      // замість дрібної смужки браузера — помітна кнопка в шапці
    installEvt = e;
    renderHead();
  });
  window.addEventListener('appinstalled', function () { installEvt = null; renderHead(); });

  function openNav() { $('app').classList.add('nav-open'); pushOverlay('nav'); }
  function closeNav(fromBack) {
    var app = $('app');
    if (!app.classList.contains('nav-open')) return;
    app.classList.remove('nav-open');
    if (!fromBack) popOverlay('nav');
  }

  /* ---------- нове завдання на телефоні ----------
     Кругла кнопка «+» відкриває панель над клавіатурою: назва й швидкі
     налаштування (дата, зірочка, повтор, список). Enter додає й лишає
     панель відкритою для наступного; закриває «Назад» або дотик повз неї. */
  var sheet = null;

  function openSheet() {
    var l = ui.view === 'board' ? currentList() : (lists().filter(function (x) { return x.visible; })[0] || lists()[0]);
    if (!l) { toast('Спершу створіть список у меню'); return; }
    sheet = { listId: l.id, due: ui.view === 'today' ? today() : '', starred: ui.view === 'starred', repeat: 'none', focus: false };
    pushOverlay('sheet');
    renderSheet();
  }

  function closeSheet(fromBack) {
    if (!sheet) return;
    sheet = null;
    $('sheet').replaceChildren();
    if (!fromBack) popOverlay('sheet');
  }

  function renderSheet() {
    var box = $('sheet');
    var s = sheet, t0 = today(), t1 = addDays(t0, 1);
    var input = h('input', { id: 'as-title', class: 'sheet-input', placeholder: 'Нове завдання', autocomplete: 'off',
      enterkeyhint: 'done', 'aria-label': 'Назва завдання' });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); save(); } });

    /* Кнопки не забирають фокус у поля: інакше на кожен дотик ховалась би клавіатура */
    function chip(icon, label, fn) {
      return h('button', { type: 'button', class: 'schip', 'aria-pressed': 'false',
        onpointerdown: function (e) { e.preventDefault(); }, onclick: fn }, icon, label);
    }
    var bToday = chip(svg(I.sun, 16), 'Сьогодні', function () { s.due = s.due === t0 ? '' : t0; paint(); });
    var bTomorrow = chip(null, 'Завтра', function () { s.due = s.due === t1 ? '' : t1; paint(); });
    var dateText = h('span', {}, 'Дата');
    var picker = h('input', { type: 'date', class: 'chip-picker', 'aria-label': 'Обрати дату' });
    picker.addEventListener('change', function () { s.due = picker.value; paint(); });
    var bDate = h('label', { class: 'schip' }, svg(I.clock, 16), dateText, picker);
    var bStar = chip(svg(I.star, 16, 1.8), 'Важливо', function () { s.starred = !s.starred; paint(); });
    var bFocus = chip(svg(I.target, 16), 'Головне', function () {
      if (!s.focus && focusFull()) return;
      s.focus = !s.focus;
      paint();
    });
    var rep = h('select', { 'aria-label': 'Повтор' }, Object.keys(REPEATS).map(function (k) {
      return h('option', { value: k }, k === 'none' ? 'Без повтору' : REPEATS[k]);
    }));
    rep.addEventListener('change', function () { s.repeat = rep.value; if (s.repeat !== 'none' && !s.due) s.due = t0; paint(); });
    var bRep = h('label', { class: 'schip' }, svg(I.repeat, 16), rep);
    var lsel = h('select', { 'aria-label': 'Список' }, lists().map(function (l) { return h('option', { value: l.id }, l.name); }));
    lsel.addEventListener('change', function () { s.listId = lsel.value; paint(); });
    var bList = h('label', { class: 'schip', 'aria-pressed': 'true' }, h('i', { class: 'col-dot' }), lsel);

    function paint() {
      var other = s.due && s.due !== t0 && s.due !== t1;
      bToday.setAttribute('aria-pressed', String(s.due === t0));
      bTomorrow.setAttribute('aria-pressed', String(s.due === t1));
      bDate.setAttribute('aria-pressed', String(!!other));
      dateText.textContent = other ? dueLabel(s.due) : 'Дата';
      picker.value = s.due || '';
      bStar.setAttribute('aria-pressed', String(s.starred));
      bFocus.setAttribute('aria-pressed', String(s.focus));
      bRep.setAttribute('aria-pressed', String(s.repeat !== 'none'));
      rep.value = s.repeat;
      lsel.value = s.listId;
      bList.style.setProperty('--c', (listOf(s.listId) || {}).color || COLORS[0]);
    }

    function save() {
      var title = input.value.trim();
      if (!title) { input.focus(); return; }
      addTask(s.listId, title, { due: s.due, starred: s.starred, repeat: s.repeat, focus: s.focus ? today() : '' });
      if (s.due > today()) toast('Заплановано на ' + dueLabel(s.due).toLowerCase() + ': з\'явиться в списку у свій день.');
      else if (ui.view === 'board' && s.listId !== (currentList() || {}).id) toast('Додано в «' + listOf(s.listId).name + '»');
      if (s.focus) { s.focus = false; paint(); }    // головне — поштучно, не все підряд
      input.value = '';
      input.focus();
    }

    box.replaceChildren(
      h('div', { class: 'sheet-scrim', onclick: function () { closeSheet(); } }),
      h('div', { class: 'add-sheet', role: 'dialog', 'aria-label': 'Нове завдання' },
        input,
        h('div', { class: 'sheet-chips' }, bToday, bTomorrow, bDate, bStar, bFocus, bRep, bList),
        h('div', { class: 'sheet-actions' },
          h('button', { type: 'button', class: 'btn', onclick: function () { closeSheet(); } }, 'Закрити'),
          h('button', { type: 'button', class: 'btn primary', onpointerdown: function (e) { e.preventDefault(); }, onclick: save }, 'Додати'))));
    paint();
    input.focus();    // одразу, ще в межах дотику до «+»: тоді телефон відкриває клавіатуру
  }

  /* ============================================================
     План на день
     ============================================================

     Хвилина вранці замість великої системи. Два кроки:
     1) прострочене — по одному: сьогодні, завтра, через тиждень, без дати,
        уже зроблено чи відпустити (щоденний огляд у дусі GTD: нічого не висить);
     2) до трьох головних справ на сьогодні; першими пропонуються вчорашні
        незроблені головні, потім важливе з матриці.
     Будь-який крок можна пропустити. */

  var plan = null;   // { step: 'triage' | 'focus', queue: [id], i, picked: {id: true}, all }

  function openPlan(step) {
    var queue = sorted(tasks().filter(function (t) { return !t.done && !t.parentId && daysLate(t); }), 'date')
      .map(function (t) { return t.id; });
    var picked = {};
    focusToday().forEach(function (t) { if (!t.done) picked[t.id] = true; });
    plan = { step: step === 'focus' || !queue.length ? 'focus' : 'triage', queue: queue, i: 0, picked: picked, all: false };
    closeNav();
    pushOverlay('plan');
    renderPlan();
  }

  function closePlan(fromBack) {
    if (!plan) return;
    plan = null;
    $('plan').replaceChildren();
    if (!fromBack) popOverlay('plan');
    render();
  }

  function renderPlan() {
    var box = $('plan');
    if (!plan) { box.replaceChildren(); return; }
    var body = plan.step === 'triage' ? triageStep() : focusStep();
    // що з простроченого ще не розібрано: туди можна повернутися з другого кроку
    var left = plan.queue.filter(function (id) { var x = db.tasks[id]; return x && !x.done && daysLate(x); }).length;
    box.replaceChildren(
      h('div', { class: 'modal-scrim', onclick: function () { closePlan(); } }),
      h('div', { class: 'modal plan', role: 'dialog', 'aria-label': 'План на день' },
        h('div', { class: 'modal-head' },
          h('div', { class: 'steps' },
            !plan.queue.length ? null
              : plan.step === 'triage' ? h('span', { class: 'on' }, '1. Минулі дні')
              : left ? h('button', { type: 'button', onclick: function () { plan.step = 'triage'; plan.i = 0; renderPlan(); } }, '1. Минулі дні · ' + left)
              : h('span', { class: 'past' }, '1. Минулі дні'),
            h('span', { class: plan.step === 'focus' ? 'on' : '' }, (plan.queue.length ? '2. ' : '') + 'Головне')),
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Закрити', onclick: function () { closePlan(); } }, svg(I.close, 20))),
        body));
  }

  function triageStep() {
    // пропускаємо те, що тим часом зробили, видалили чи вже переназначили
    while (plan.i < plan.queue.length) {
      var x = db.tasks[plan.queue[plan.i]];
      if (x && !x.done && daysLate(x)) break;
      plan.i++;
    }
    if (plan.i >= plan.queue.length) { plan.step = 'focus'; return focusStep(); }
    var t = db.tasks[plan.queue[plan.i]];
    var t0 = today();
    var l = listOf(t.listId);
    function next() { plan.i++; renderPlan(); }
    function due(v) { return function () { setDue(t, v); commit(); next(); }; }
    // що ще не розібрано; коли цього забагато, легше почати з чистого аркуша, ніж здатися
    var rest = plan.queue.slice(plan.i).map(function (id) { return db.tasks[id]; })
      .filter(function (x) { return x && !x.done && daysLate(x); });
    function fresh() {
      var was = rest.map(function (x) { return [x, x.due]; });
      // звички — на сьогодні, решта — без дати; лічильник відкладань не росте
      rest.forEach(function (x) { x.due = x.repeat !== 'none' ? t0 : ''; });
      commit();
      plan.i = plan.queue.length;
      renderPlan();
      var habits = rest.filter(function (x) { return x.repeat !== 'none'; }).length, other = rest.length - habits;
      toast('Чистий аркуш: ' + [other ? other + ' ' + plural(other) + ' без дати' : '', habits ? 'звички (' + habits + ') на сьогодні' : '']
        .filter(Boolean).join(', ') + '. Нічого не зникло.', function () {
        was.forEach(function (p) { p[0].due = p[1]; });
        commit();
      }, 8000);
    }
    return h('div', { class: 'tri' },
      h('div', { class: 'modal-title' }, 'З минулих днів'),
      h('div', { class: 'modal-sub' }, (plan.i + 1) + ' з ' + plan.queue.length + '. Без докорів: просто вирішіть, що з нею.'),
      h('div', { class: 'tri-card' },
        l ? h('span', { class: 'chip list', style: '--c:' + l.color }, l.name) : null,
        h('div', { class: 'tri-title' }, t.title || 'Без назви'),
        h('div', { class: 'tri-meta' }, stuckText(t))),
      h('div', { class: 'tri-actions' },
        h('button', { type: 'button', class: 'btn primary', onclick: due(t0) }, 'Сьогодні'),
        h('button', { type: 'button', class: 'btn', onclick: due(addDays(t0, 1)) }, 'Завтра'),
        h('button', { type: 'button', class: 'btn', onclick: due(addDays(t0, 7)) }, 'Через тиждень'),
        h('button', { type: 'button', class: 'btn', onclick: due('') }, 'Без дати'),
        h('button', { type: 'button', class: 'btn', onclick: function () { toggleDone(t); next(); } }, 'Уже зроблено'),
        h('button', { type: 'button', class: 'btn danger', onclick: function () { removeTask(t); next(); } }, 'Відпустити')),
      h('div', { class: 'tri-foot' },
        h('button', { type: 'button', class: 'quiet-link', onclick: function () { openHelp(t); } }, svg(I.knot, 16), 'Що заважає?'),
        h('button', { type: 'button', class: 'link-btn', onclick: next }, 'Пропустити')),
      rest.length >= 3 ? h('div', { class: 'fresh' },
        h('span', {}, 'Забагато, щоб розбирати по одній?'),
        h('button', { type: 'button', class: 'link-btn', onclick: fresh }, 'Чистий аркуш для всіх ' + rest.length)) : null);
  }

  function focusStep() {
    var t0 = today(), y = addDays(t0, -1);
    function score(t) {
      if (plan.picked[t.id]) return 0;
      if (t.focus === y) return 1;                 // учора було головним, не встигли
      var q = quadrant(t);
      return q === 1 ? 2 : q === 2 ? 3 : q === 3 ? 4 : 5;
    }
    var cands = tasks().filter(isOpenNow).sort(function (a, b) {
      return score(a) - score(b) || (a.due || '9999').localeCompare(b.due || '9999') || a.order - b.order;
    });
    var shown = plan.all ? cands : cands.slice(0, 7);
    var n = Object.keys(plan.picked).length;
    var full = n >= FOCUS_MAX;
    var insight = blockerInsight();
    // скільки часу займе обране — щоб день не планувати на 14 годин
    var load = Object.keys(plan.picked).reduce(function (s, id) { var x = db.tasks[id]; return s + (x ? x.est : 0); }, 0);
    return h('div', { class: 'pick' },
      h('div', { class: 'modal-title' }, 'Головне на сьогодні'),
      h('div', { class: 'modal-sub' }, 'Оберіть до трьох. Решту теж можна робити, але ці три зроблять день вдалим.'),
      insight ? h('div', { class: 'insight' }, insight) : null,
      cands.length ? h('div', { class: 'cands' }, shown.map(function (t) {
        var on = !!plan.picked[t.id];
        var l = listOf(t.listId);
        return h('button', { type: 'button', class: 'cand' + (on ? ' on' : ''), 'aria-pressed': String(on), disabled: !on && full,
          onclick: function () { if (on) delete plan.picked[t.id]; else plan.picked[t.id] = true; renderPlan(); } },
          h('span', { class: 'cand-mark' }, svg(I.target, 18)),
          h('span', { class: 'cand-body' },
            h('span', { class: 'cand-title' }, t.title || 'Без назви'),
            h('span', { class: 'cand-meta' },
              (t.focus === y ? 'учора було головним · ' : '') + QUADS[quadrant(t)].name.toLowerCase() +
              (t.due ? ' · ' + dueLabel(t.due).toLowerCase() : '') + (t.est ? ' · ' + estLabel(t.est) : '') + (l ? ' · ' + l.name : ''))));
      })) : h('div', { class: 'empty' }, 'Відкритих справ немає. Можна просто жити.'),
      cands.length > shown.length ? h('button', { type: 'button', class: 'more', onclick: function () { plan.all = true; renderPlan(); } },
        'Показати всі ' + cands.length) : null,
      load ? h('div', { class: 'load' + (load > 360 ? ' over' : '') }, load > 360
        ? 'Разом ≈ ' + estLabel(load) + '. Це більше, ніж реально вміщає день. Залиште одну-дві: решта не зникне.'
        : 'Разом ≈ ' + estLabel(load) + '. Закладайте в півтора раза більше: оцінки майже завжди оптимістичні.') : null,
      h('div', { class: 'modal-foot' },
        h('span', { class: 'pick-count' }, n + ' з ' + FOCUS_MAX),
        h('button', { type: 'button', class: 'btn primary', onclick: applyFocus }, n ? 'Готово' : 'Сьогодні без головного')));
  }

  function applyFocus() {
    var t0 = today(), n = 0;
    tasks().forEach(function (t) {
      if (t.parentId || t.done) return;
      if (plan.picked[t.id]) { t.focus = t0; n++; }
      else if (t.focus === t0) t.focus = '';
    });
    if (!n) { ui.planSkip = t0; saveUi(); }
    commit();
    closePlan();
    toast(n ? 'План готовий: ' + n + ' ' + (n === 1 ? 'головна справа' : 'головні справи') + ' на сьогодні.' : 'Добре, сьогодні без головного.');
  }

  /** Що найчастіше заважало за тиждень: свій «улюблений» патерн краще знати в обличчя. */
  function blockerInsight() {
    var from = addDays(today(), -7), count = {};
    tasks().forEach(function (t) { if (t.blocker && t.blockerAt >= from) count[t.blocker] = (count[t.blocker] || 0) + 1; });
    var top = Object.keys(count).sort(function (a, b) { return count[b] - count[a]; })[0];
    if (!top || count[top] < 2) return null;
    return 'Цього тижня найчастіше заважала думка «' + BLOCKERS[top].thought + '» (' + count[top] + '). Це ' +
      BLOCKERS[top].name.charAt(0).toLowerCase() + BLOCKERS[top].name.slice(1) + '.';
  }

  /* ============================================================
     Що заважає?
     ============================================================

     Оберіть думку, що зупиняє, — побачите її назву (когнітивне викривлення),
     коротке переформулювання й одну дію: записати перший крок, сказати собі
     «навіщо» або почати на дві хвилини. Обране запам'ятовується в завданні,
     щоб «План на день» міг показати, що заважає найчастіше. */

  var help = null;   // { id, key }

  function openHelp(t) {
    help = { id: t.id, key: '' };
    pushOverlay('help');
    renderHelp();
  }

  function closeHelp(fromBack) {
    if (!help) return;
    help = null;
    $('help').replaceChildren();
    if (!fromBack) popOverlay('help');
  }

  function renderHelp() {
    var box = $('help');
    var t = help && db.tasks[help.id];
    if (!t) { closeHelp(); return; }
    var body;
    if (!help.key) {
      body = [
        h('div', { class: 'modal-title' }, 'Що заважає?'),
        h('div', { class: 'modal-sub' }, 'Яка думка зупиняє, коли беретеся за «' + (t.title || 'цю справу') + '»?'),
        h('div', { class: 'thoughts' }, BLOCKER_ORDER.map(function (k) {
          return h('button', { type: 'button', class: 'thought', onclick: function () {
            help.key = k;
            t.blocker = k;
            t.blockerAt = today();
            commit();
            renderHelp();
          } }, '«' + BLOCKERS[k].thought + '»');
        }))
      ];
    } else {
      var b = BLOCKERS[help.key];
      body = [
        h('button', { type: 'button', class: 'link-btn back', onclick: function () { help.key = ''; renderHelp(); } }, '← Інша думка'),
        h('div', { class: 'thought-quote' }, '«' + b.thought + '»'),
        h('div', { class: 'distortion' }, b.name),
        h('p', { class: 'reframe' }, b.reframe),
        helpAction(t, b)
      ];
    }
    box.replaceChildren(
      h('div', { class: 'modal-scrim', onclick: function () { closeHelp(); } }),
      h('div', { class: 'modal help', role: 'dialog', 'aria-label': 'Що заважає?' },
        h('div', { class: 'modal-head' },
          h('span', { class: 'steps' }, h('span', { class: 'on' }, 'Що заважає')),
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Закрити', onclick: function () { closeHelp(); } }, svg(I.close, 20))),
        body));
  }

  function helpAction(t, b) {
    if (b.act === 'icnu') {
      return h('div', { class: 'help-act' },
        h('ul', { class: 'icnu' }, ICNU.map(function (x) { return h('li', {}, h('b', {}, x[0]), ' ' + x[1]); })),
        h('button', { type: 'button', class: 'btn primary', onclick: function () { startKick(t, 10); } }, svg(I.play, 16), ' Гонка з таймером: 10 хвилин'),
        h('button', { type: 'button', class: 'link-btn', onclick: function () { startKick(t); } }, 'Або просто 2 хвилини'));
    }
    if (b.act === 'now') {
      return h('div', { class: 'help-act' },
        h('button', { type: 'button', class: 'btn primary', onclick: function () { startKick(t, 5); } }, svg(I.play, 16), ' Почати цю на 5 хвилин'),
        h('button', { type: 'button', class: 'link-btn', onclick: goNow }, 'Відкрити «Зараз»: по одній справі'));
    }
    if (b.act === 'kick') {
      return h('div', { class: 'help-act' },
        h('button', { type: 'button', class: 'btn primary', onclick: function () { startKick(t); } }, svg(I.play, 16), ' Почати на 2 хвилини'),
        h('button', { type: 'button', class: 'link-btn', onclick: function () { help.key = 'unclear'; renderHelp(); } }, 'Або записати перший крок'));
    }
    var why = b.act === 'why';
    var input = h('input', { class: 'help-input', autocomplete: 'off', enterkeyhint: 'done',
      placeholder: why ? 'бо…' : 'Напр.: відкрити підручник на 5-й сторінці',
      'aria-label': why ? 'Навіщо це мені' : 'Перший крок' });
    function save() {
      var v = input.value.trim();
      if (!v) { input.focus(); return; }
      if (why) {
        t.notes = (t.notes ? t.notes + '\n' : '') + 'Навіщо: ' + v;
        commit();
        toast('Записано в нотатки: тепер видно, навіщо це.');
      } else {
        var max = 0;
        childrenOf(t.id).forEach(function (c) { if (c.order > max) max = c.order; });
        addTask(t.listId, v, { parentId: t.id, order: max + 1, starred: false, due: '' });
        toast('Перший крок записано.');
      }
      closeHelp();
    }
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); save(); } });
    setTimeout(function () { input.focus(); }, 30);
    return h('div', { class: 'help-act' },
      input,
      h('div', { class: 'help-row' },
        h('button', { type: 'button', class: 'btn primary', onclick: save }, why ? 'Записати' : 'Додати перший крок'),
        h('button', { type: 'button', class: 'link-btn', onclick: function () { startKick(t); } }, 'Почати на 2 хвилини')));
  }

  /* ============================================================
     Таймер
     ============================================================

     Час при ADHD «невидимий», тож він на екрані: кільце тане, поки йде
     відлік. Дві хвилини — правило старту: найважче почати, закінчувати не
     обов'язково. Довші — для самої роботи. Думку, що відволікає, не
     проганяють, а записують на потім (прийом з КПТ для дорослих з ADHD)
     і повертаються до справи. */

  var kick = null;   // { id, end, total, iv, lock, parked }
  var KICK_MIN = 2;
  var RING = 2 * Math.PI * 54;

  function startKick(t, min) {
    min = min || KICK_MIN;
    // «Що заважає?» змінюється таймером у межах того самого кроку історії
    if (help && swapOverlay('help', 'kick')) { help = null; $('help').replaceChildren(); }
    else if (!isOpen('kick')) pushOverlay('kick');
    var parked = kick ? kick.parked : 0, lock = kick ? kick.lock : null;
    if (kick) clearInterval(kick.iv);
    kick = { id: t.id, end: Date.now() + min * 60000, total: min * 60000, iv: null, lock: lock, parked: parked };
    wakeAudio();
    lockScreen();
    renderKick();
  }

  function closeKick(fromBack) {
    if (!kick) return;
    clearInterval(kick.iv);
    unlockScreen();
    kick = null;
    document.title = 'Справи';
    $('kick').replaceChildren();
    if (!fromBack) popOverlay('kick');
  }

  /** Екран не гасне, поки йде відлік: таймер має бути видно. */
  function lockScreen() {
    if (!kick || kick.lock || !navigator.wakeLock || document.hidden || Date.now() >= kick.end) return;
    navigator.wakeLock.request('screen').then(function (l) {
      if (!kick || kick.lock) { l.release().catch(function () {}); return; }
      kick.lock = l;
      l.addEventListener('release', function () { if (kick && kick.lock === l) kick.lock = null; });
    }).catch(function () { /* не дозволили — таймер працює й так */ });
  }
  function unlockScreen() {
    if (!kick || !kick.lock) return;
    var l = kick.lock;
    kick.lock = null;
    try { l.release().catch(function () {}); } catch (e) {}
  }

  /* Сигнал наприкінці. Звук готуємо в мить натискання «Почати»: пізніше
     браузер не дасть його ввімкнути без дотику людини. */
  var audio = null;
  function wakeAudio() {
    try {
      var A = window.AudioContext || window.webkitAudioContext;
      if (!A) return;
      if (!audio) audio = new A();
      if (audio.state === 'suspended') audio.resume();
    } catch (e) { audio = null; }
  }
  function chime() {
    if (!audio) return;
    try {
      var t0 = audio.currentTime;
      [[0, 660], [0.22, 880]].forEach(function (x) {
        var o = audio.createOscillator(), g = audio.createGain();
        o.type = 'sine';
        o.frequency.value = x[1];
        g.gain.setValueAtTime(0.0001, t0 + x[0]);
        g.gain.exponentialRampToValueAtTime(0.18, t0 + x[0] + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + x[0] + 0.5);
        o.connect(g); g.connect(audio.destination);
        o.start(t0 + x[0]); o.stop(t0 + x[0] + 0.55);
      });
    } catch (e) { /* без звуку — лишається вібрація й екран */ }
  }

  function renderKick() {
    var box = $('kick');
    var t = kick && db.tasks[kick.id];
    if (!t) { closeKick(); return; }
    clearInterval(kick.iv);
    var start = kick.total <= KICK_MIN * 60000;   // дві хвилини — щоб почати, а не закінчити
    var finished = Date.now() >= kick.end;
    var time = h('div', { class: 'kick-time', role: 'timer' });
    var ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ring.setAttribute('viewBox', '0 0 120 120');
    ring.setAttribute('class', 'kick-ring');
    ring.setAttribute('aria-hidden', 'true');
    ring.innerHTML = '<circle cx="60" cy="60" r="54" class="track"/><circle cx="60" cy="60" r="54" class="arc"/>';
    var arc = ring.lastChild;
    arc.style.strokeDasharray = RING;

    // думка на потім: записали — і назад до справи
    var park = h('input', { class: 'help-input park', autocomplete: 'off', enterkeyhint: 'done',
      placeholder: 'Інша думка? Запишіть на потім', 'aria-label': 'Думка на потім' });
    var parkNote = h('div', { class: 'park-note', role: 'status' }, kick.parked ? 'На потім записано: ' + kick.parked : '');
    park.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      var v = park.value.trim(), l = lists().filter(function (x) { return x.visible; })[0] || lists()[0];
      if (!v || !l || !kick) return;
      addTask(l.id, v, { due: '', starred: false });
      kick.parked++;
      park.value = '';
      parkNote.textContent = 'Записано в «' + l.name + '» (' + kick.parked + '). Повертайтеся до справи.';
    });

    function done(e) { burst(e.currentTarget); if (!t.done) toggleDone(t); closeKick(); }
    box.replaceChildren(
      h('div', { class: 'modal-scrim' }),
      h('div', { class: 'modal kick', role: 'dialog', 'aria-label': 'Таймер' },
        h('div', { class: 'kick-task' }, t.title || 'Без назви'),
        finished ? [
          h('div', { class: 'kick-done' }, start ? 'Ви почали. Це найважче.' : 'Час вийшов.'),
          h('div', { class: 'modal-sub' }, start ? 'Можна зупинитися з чистою совістю або продовжити, поки йде.'
            : 'Якщо ви в потоці, продовжуйте. Якщо ні, перерва: встаньте, вода, кілька кроків.'),
          h('div', { class: 'help-row center' },
            h('button', { type: 'button', class: 'btn primary', onclick: done }, 'Зроблено'),
            start ? h('button', { type: 'button', class: 'btn', onclick: function () { closeKick(); } }, 'Продовжу далі')
              : h('button', { type: 'button', class: 'btn', onclick: function () { startKick(t, 5); } }, 'Ще 5 хв'),
            start ? null : h('button', { type: 'button', class: 'btn', onclick: function () { closeKick(); } }, 'Досить на зараз'))
        ] : [
          h('div', { class: 'kick-dial' }, ring, time),
          h('div', { class: 'modal-sub' }, start ? 'Лише дві хвилини, без вимоги закінчити.' : 'Тільки ця справа. Решта почекає.'),
          h('div', { class: 'help-row center' },
            h('button', { type: 'button', class: 'btn primary', onclick: done }, 'Зроблено'),
            h('button', { type: 'button', class: 'btn', onclick: function () { closeKick(); } }, 'Зупинити')),
          park, parkNote
        ]));
    if (finished) { document.title = 'Справи'; unlockScreen(); return; }
    function tick() {
      if (!kick) return;
      var left = Math.max(0, kick.end - Date.now());
      var s = Math.ceil(left / 1000);
      var txt = Math.floor(s / 60) + ':' + pad(s % 60);
      time.textContent = txt;
      arc.style.strokeDashoffset = String(RING * (1 - left / kick.total));
      document.title = txt + ' · Справи';    // видно й на вкладці, коли перемкнулися деінде
      if (!left) {
        if (navigator.vibrate) { try { navigator.vibrate([120, 80, 120]); } catch (e) {} }
        chime();
        renderKick();
      }
    }
    tick();
    kick.iv = setInterval(tick, 250);
  }

  $('fab').addEventListener('click', openSheet);

  $('menuBtn').addEventListener('click', function (e) {
    e.stopPropagation();
    if ($('app').classList.contains('nav-open')) closeNav(); else openNav();
  });
  document.addEventListener('click', function (e) {
    if (openMenu) { openMenu = null; armed = null; render(); }
    if ($('app').classList.contains('nav-open') && !$('side').contains(e.target)) closeNav();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && openMenu) { openMenu = null; render(); }
    // Escape закриває верхнє вікно, де б не був фокус (після кнопки в картці він на сторінці)
    else if (e.key === 'Escape' && overlays.length) { e.preventDefault(); closeTop(); }
    var tag = (document.activeElement && document.activeElement.tagName) || '';
    if ((e.key === 'n' || e.key === 'т') && !e.ctrlKey && !e.metaKey && !e.altKey && !/INPUT|TEXTAREA|SELECT/.test(tag) && !drawerTask && !$('app').hidden) {
      e.preventDefault();
      $('create').click();
    }
  });
  $('create').addEventListener('click', function () {
    var l = lists().filter(function (x) { return x.visible; })[0] || lists()[0];
    if (!l) { toast('Спершу створіть список у меню ліворуч'); return; }
    var t = addTask(l.id, '', ui.view === 'today' ? { due: today() } : {});
    if ($('app').classList.contains('nav-open')) {
      // меню змінюється карткою в межах того самого кроку історії
      $('app').classList.remove('nav-open');
      swapOverlay('nav', 'drawer');
      drawerTask = t.id;
      render();
    } else openDrawer(t.id);
  });
  $('newListForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var name = $('newListName').value.trim();
    if (!name) return;
    var max = -1;
    lists().forEach(function (l) { if (l.order > max) max = l.order; });
    var l = mkList({ id: uid(), name: name, color: COLORS[Object.keys(db.lists).length % COLORS.length], visible: true, order: max + 1 });
    db.lists[l.id] = l;
    $('newListName').value = '';
    ui.view = 'board';
    ui.mList = l.id;
    saveUi();
    commit();
  });

  mobileMq.addEventListener('change', function () { render(); });

  /* Обмін: одразу, коли повертаємось до застосунку, коли з'являється
     інтернет, і раз на 20 секунд, поки він відкритий. Ховаючись — віддаємо
     все, що лишилося в черзі, щоб на іншому пристрої воно вже було. */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { if (Object.keys(outbox).length) sync(); return; }
    // могла змінитися дата — «сьогодні», минулі дні, звички
    if (rollHabits()) commit(); else render();
    lockScreen();   // браузер знімає заборону гасити екран, коли ховаємось
    sync();
    checkUpdate(false);
  });
  window.addEventListener('online', function () { sync(); });
  setInterval(function () { if (!document.hidden && signedIn()) sync(); }, PULL_MS);

  /* Нова версія. Вікно застосунку може стояти відкритим днями, а новий код
     приходить лише з перезавантаженням. Тож коли повертаємося до вікна й
     раз на 15 хвилин питаємо сайт, чи не змінився код. Змінився — тихо
     перезавантажуємось, поки людина нічого не набирає, не тримає відкритих
     вікон і не запустила таймер. Дані не губляться: усе вже в браузері. */
  var codeTag = null, codeNew = false, lastTouch = 0;
  ['pointerdown', 'keydown', 'wheel'].forEach(function (ev) {
    document.addEventListener(ev, function () { lastTouch = Date.now(); }, { passive: true, capture: true });
  });
  function checkUpdate(quiet) {
    if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
    fetch('tasks.js', { method: 'HEAD', cache: 'no-store' }).then(function (res) {
      var tag = res.ok && (res.headers.get('etag') || res.headers.get('last-modified'));
      if (!tag) return;
      if (codeTag === null) { codeTag = tag; return; }
      if (tag !== codeTag) { codeNew = true; reloadIfIdle(quiet); }
    }).catch(function () { /* без мережі перевіримо згодом */ });
  }
  function reloadIfIdle(quiet) {
    if (!codeNew || overlays.length || dragId || gest) return;
    var a = document.activeElement;
    if (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) return;
    if (Date.now() - lastTouch < (quiet ? 60000 : 2000)) return;   // людина саме щось робить
    var last = Number(lsGet('spravy.reloadAt')) || 0;
    if (Date.now() - last < 10 * 60000) return;                     // не частіше разу на 10 хвилин
    lsSet('spravy.reloadAt', String(Date.now()));
    location.reload();
  }
  setInterval(function () { if (!document.hidden) checkUpdate(true); }, 15 * 60000);

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js', { scope: './' }).catch(function (e) { console.warn('SW не зареєструвався:', e); });
    });
  }

  /* ============================================================
     Старт
     ============================================================ */

  loadLocal();
  checkUpdate();     // запам'ятати, яка версія коду зараз на сайті
  takeImportFromUrl().then(function () {
    if (!BASE) { setSync('error', 'Не налаштовано адресу бази'); }
    if (!signedIn()) { showLogin(''); return; }
    claimLocal();
    showApp();
    sync();
  });
})();
