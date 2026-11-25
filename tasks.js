/* Справи — особистий список задач. Окремий сайт і окремий застосунок:
   ставиться на телефон і комп'ютер власною іконкою.

   Дані — у власному проєкті Supabase (організація Spravy), таблиця records,
   види todo_task і todo_list. Кожне завдання —
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
  // Supabase заблокував проєкт (вичерпано місячний ліміт безкоштовного плану): довбати
  // сервер щопівхвилини марно — чекаємо 10 хвилин або дотику «Спробувати зараз»
  var QUOTA_PAUSE_MS = 10 * 60000;
  var pausedUntil = 0;
  function isQuotaBlock(e) { return /exceed_\w*quota|restricted due to the following violations/i.test((e && e.message) || ''); }
  var OVERLAP_MS = 90000;             // дочитуємо трохи назад — на випадок розбіжності годинників
  var PAGE = 1000;

  var COLORS = ['#82c8b8', '#8fb0e0', '#e0a87c', '#d99aa8', '#b3a6e0', '#b9c67e', '#9aa0ad'];
  var SIZES = [['S', 15], ['M', 17], ['L', 19], ['XL', 21]];
  // wN — «N разів на тиждень» у будь-які дні: немає «пропущеного понеділка», лише скільки лишилось
  var REPEATS = { none: 'Не повторювати', daily: 'Щодня', weekdays: 'Щобудні', w2: '2 рази на тиждень', w3: '3 рази на тиждень',
    w4: '4 рази на тиждень', w5: '5 разів на тиждень', weekly: 'Щотижня', monthly: 'Щомісяця' };
  /** Скільки разів на тиждень (для wN), інакше 0. */
  function perWeek(rep) { var m = /^w([2-5])$/.exec(rep || ''); return m ? +m[1] : 0; }

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
  var STAR_MAX = 7;       // важливих водночас: коли їх 19, зірочка вже нічого не виділяє
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
  function isTime(s) { return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s); }

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
      if (perWeek(rep)) return addDays(d, 1);
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

  var PHOTO_MAX = 12;      // фото на завдання
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
    spell: '<path d="M4 17l4-11 4 11M5.5 13h5"/><path d="M13.5 15.5l2.5 2.5 4.5-5"/>',
    flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    moon: '<path d="M19.5 14.5A8 8 0 019.5 4.5a8 8 0 1010 10z"/>',
    image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="M20.5 16l-5-5L5 19.5"/>',
    cal: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21"/>',
    lang: '<path d="M3.5 5.5h9M8 3.5v2M5 5.5c.9 3.2 3.2 5.6 6.5 7M11 5.5c-.9 3.2-3.2 5.6-6.5 7"/><path d="M13 20.5l4-9 4 9M14.5 17.5h5"/>',
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
      start: isTime(o.start) ? o.start : '',             // час у календарі; без нього — «весь день»
      end: isTime(o.start) && isTime(o.end) && o.end > o.start ? o.end : '',
      color: /^#[0-9a-f]{6}$/i.test(o.color || '') ? o.color : '',   // колір події; порожньо — колір списку
      est: Math.min(600, Math.max(0, Math.round(Number(o.est) || 0))),   // скільки хвилин займе, 0 — не оцінено
      images: mkImages(o.images),                        // фото: файли у сховищі, тут лише шлях і розмір
      rank: Math.max(0, Math.round(Number(o.rank) || 0)), // місце в квадранті матриці; 0 — не переставляли
      seen: isDay(o.seen) ? o.seen : '',                   // коли справу востаннє чіпали; давно — вона йде в «Колись»
      habit: String(o.habit || ''),                        // у виконаної копії звички — id самої звички
      after: String(o.after || '').slice(0, 80),           // якір звички: «після ранкової кави»
      easy: String(o.easy || '').slice(0, 120),            // мінімум звички на день, коли сил мало
      easyDone: !!o.easyDone,                              // у копії: зроблено мінімум
      goal: !!o.goal,                                      // ціль (одна на раз): її кроки — підзавдання
      why: String(o.why || '').slice(0, 300),              // у цілі: навіщо, що зміниться (WOOP: бажання й результат)
      obstacle: String(o.obstacle || '').slice(0, 160),    // у цілі: головна перешкода
      ifThen: String(o.ifThen || '').slice(0, 160)         // у цілі: план «якщо перешкода — то я…»
    };
  }

  /** Фото завдання: [{ path: 'uid/назва.webp', w, h }]; чуже й биті записи відкидаються. */
  function mkImages(a) {
    return (Array.isArray(a) ? a : []).filter(function (x) {
      return x && typeof x.path === 'string' && /^[\w-]+\/[\w-]+\.(webp|jpg|png)$/.test(x.path);
    }).slice(0, PHOTO_MAX).map(function (x) {
      return { path: x.path, w: Math.max(0, Math.round(Number(x.w) || 0)), h: Math.max(0, Math.round(Number(x.h) || 0)) };
    });
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
    // одноразово: перечитати все з сервера, щоб старі справи дізнались, коли їх востаннє чіпали
    if (lsGet('spravy.seenV') !== '1') { since = null; lsSet('spravy.seenV', '1'); }
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
      if (snap[key] !== j) {
        // справу щойно чіпали: це й рахуємо «останнім доторком» (для «Колись»)
        if (kind === K_TASK && rec.seen !== today()) { rec.seen = today(); j = JSON.stringify(rec); }
        snap[key] = j; outbox[key] = ++seq;
      }
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
  function isOpenNow(t) { return !t.done && !t.parentId && !isFuture(t) && !isSomeday(t); }
  /** «Колись»: справа без дати, зірочки, повтору й «головного», яку не чіпали SOMEDAY_DAYS днів.
      Вона не зникає, а тихо йде з очей: 81 відкрита справа — це шум, що з'їдає увагу. */
  var SOMEDAY_DAYS = 21;
  function isSomeday(t) {
    return !t.done && !t.parentId && !t.starred && !t.due && t.repeat === 'none' && !isFocus(t) &&
      !!t.seen && t.seen < addDays(today(), -SOMEDAY_DAYS);
  }

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
      if (t.done || !t.due || t.due >= t0 || (t.repeat !== 'daily' && t.repeat !== 'weekdays' && !perWeek(t.repeat))) return;
      var d = t0;
      while (t.repeat === 'weekdays' && parseDay(d).getDay() % 6 === 0) d = addDays(d, 1);
      t.due = d;
      n++;
    });
    return n;
  }

  /* ---------- звички без хрестиків і ланцюжків ----------
     Ланцюжок, що обнуляється від одного пропуску, при СДУГ частіше вмикає сором, ніж мотивацію,
     а сором — поганий двигун. Тому рахуємо зроблені дні за тиждень (пропуски нічого не забирають)
     і після одного пропуску лише м'яко нагадуємо: головне — не пропустити вдруге. */
  function isHabit(t) { return !t.parentId && (t.repeat === 'daily' || t.repeat === 'weekdays' || !!perWeek(t.repeat)); }
  function mondayOf(d) { return addDays(d, -((parseDay(d).getDay() + 6) % 7)); }
  function habitDays(t) {
    var days = {};
    tasks().forEach(function (x) {
      if (!x.done || !x.doneAt || x === t) return;
      // старі копії (до посилання habit) впізнаємо за назвою й списком
      if (x.habit === t.id || (!x.habit && x.repeat === 'none' && !x.parentId && x.listId === t.listId && x.title === t.title)) days[x.doneAt] = (days[x.doneAt] || 0) + 1;
    });
    return days;
  }
  function habitNeeded(t, d) { return t.repeat === 'daily' || parseDay(d).getDay() % 6 !== 0; }
  /** { done, need } за останні 7 днів, включно з сьогодні; missed — учора пропущено, а сьогодні ще ні. */
  function habitWeek(t) {
    var days = habitDays(t), t0 = today(), done = 0, need = 0;
    var n = perWeek(t.repeat);
    // «N разів на тиждень» рахує рази; щоденні звички — дні
    var total = Object.keys(days).reduce(function (s2, k2) { return s2 + (n ? days[k2] : 1); }, 0);
    if (n) {
      // норма календарного тижня (пн–нд): скільки вже, скільки треба; пропусків тут не буває
      for (var k = mondayOf(t0); k <= t0; k = addDays(k, 1)) done += days[k] || 0;
      return { done: done, need: n, missed: false, total: total, week: true };
    }
    for (var i = 0; i < 7; i++) {
      var d = addDays(t0, -i);
      if (!habitNeeded(t, d)) continue;
      need++;
      if (days[d]) done++;
    }
    var y = addDays(t0, -1);
    var any = Object.keys(days).length > 0;
    return { done: done, need: need, missed: any && habitNeeded(t, y) && !days[y] && !days[t0], total: total, week: false };
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
    var q = tasks().filter(function (t) { return !t.done && !t.parentId && !isSomeday(t) && rank(t) >= 0; });
    if (low) q.forEach(function (t) { quick[t.id] = isQuick(t) ? 1 : 0; });
    return q.sort(function (a, b) {
      var la = later.indexOf(a.id), lb = later.indexOf(b.id);
      return (la >= 0) - (lb >= 0) || la - lb ||
        (low ? quick[b.id] - quick[a.id] : 0) ||
        rank(a) - rank(b) || (a.rank || 1e9) - (b.rank || 1e9) ||   // ручний порядок, як у «Сьогодні»
        (a.due || '9999').localeCompare(b.due || '9999') || a.order - b.order;
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
          var next = { access_token: j.access_token, refresh_token: j.refresh_token, email: (j.user && j.user.email) || now.email, uid: (j.user && j.user.id) || now.uid || '' };
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
    var headers = Object.assign({ apikey: cfg.anonKey, 'Content-Type': 'application/json' }, opts.headers);
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
          // 5xx: база не встигла відповісти, пароль тут ні до чого
          if (res.status >= 500) throw new Error('Сервер бази зараз не відповідає. Спробуйте за хвилину');
          throw new Error(j.error_description || j.msg || j.message || 'Не вдалося увійти');
        }
        setSess({ access_token: j.access_token, refresh_token: j.refresh_token, email: (j.user && j.user.email) || email, uid: (j.user && j.user.id) || '' });
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

  function setSync(s, text, retry) {
    var el = $('sync');
    if (!el) return;
    el.dataset.s = s;
    el.querySelector('span').textContent = text;
    var old = el.querySelector('button');
    if (old) old.remove();
    if (retry) el.append(h('button', { type: 'button', class: 'link-btn', onclick: function () { pausedUntil = 0; sync(); } }, 'Спробувати зараз'));
  }

  function sync() {
    clearTimeout(timer);
    if (!BASE || !signedIn()) return Promise.resolve();
    if (Date.now() < pausedUntil) return Promise.resolve();   // сервер на паузі: зміни чекають тут
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
      if (isQuotaBlock(e)) {
        pausedUntil = Date.now() + QUOTA_PAUSE_MS;
        lastProblem = 'Сервер на паузі: вичерпано місячний безкоштовний ліміт Supabase. Справи збережені на цьому пристрої.';
        setSync('local', 'Сервер на паузі: вичерпано місячний ліміт Supabase. Усе збережено тут і поїде само, щойно сервер відновиться.', true);
      } else if (navigator.onLine === false || (e && e.name === 'TypeError')) {
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
      else if (Date.now() < pausedUntil) schedule(pausedUntil - Date.now() + 100);
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
    if (row.kind === K_TASK && !rec.seen && /^\d{4}-\d{2}-\d{2}/.test(row.updated_at || '')) rec.seen = row.updated_at.slice(0, 10);
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

  /** opts.easy — зроблено мінімум звички: зараховується так само, лише позначається. */
  function toggleDone(t, opts) {
    if (!t.done && t.repeat !== 'none') {
      var prevDue = t.due;
      var copy = mkTask(Object.assign({}, t, { id: uid(), repeat: 'none', done: true, doneAt: today(), habit: t.id, after: '', easy: '', rank: 0,
        easyDone: !!(opts && opts.easy), title: t.title }));
      db.tasks[copy.id] = copy;
      var n = perWeek(t.repeat);
      // норму тижня виконано — до понеділка; ні — знову завтра
      if (n) t.due = habitWeek(t).done >= n ? addDays(mondayOf(today()), 7) : addDays(today(), 1);
      else t.due = nextDue(t.due, t.repeat);
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

  /** Зірочка: зняти — завжди; поставити — якщо важливих менше STAR_MAX, інакше спершу обрати, з якої зняти. */
  function toggleStar(t) {
    if (t.starred) { t.starred = false; commit(); return; }
    askStar(t.title, t.id, function () { t.starred = true; commit(); });
  }
  function askStar(title, exceptId, apply) {
    var on = tasks().filter(function (x) { return x.starred && !x.done && !x.parentId && x.id !== exceptId; });
    if (on.length < STAR_MAX) { apply(); return; }
    var layer = h('div', { class: 'star-layer' });
    function close() { layer.remove(); document.removeEventListener('keydown', onKey, true); }
    function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); } }
    layer.append(
      h('div', { class: 'modal-scrim', onclick: close }),
      h('div', { class: 'modal star-pick', role: 'dialog', 'aria-label': 'Забагато важливого' },
        h('div', { class: 'modal-title' }, 'Важливих уже ' + on.length),
        h('div', { class: 'modal-sub' }, 'Зірочка допомагає, лише коли їх мало. З якої зняти, щоб поставити на «' + title + '»?'),
        h('div', { class: 'cands' }, sorted(on, 'date').map(function (x) {
          var l = listOf(x.listId);
          return h('button', { type: 'button', class: 'cand', onclick: function () { x.starred = false; close(); apply(); } },
            h('span', { class: 'cand-mark' }, svg(I.star, 18, 1.8)),
            h('span', { class: 'cand-body' }, h('span', { class: 'cand-title' }, x.title || 'Без назви'),
              h('span', { class: 'cand-meta' }, (x.due ? dueLabel(x.due) + ' · ' : '') + (l ? l.name : ''))));
        })),
        h('div', { class: 'modal-foot' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Скасувати'))));
    document.body.append(layer);
    document.addEventListener('keydown', onKey, true);
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
  /** Поставити список на місце to серед решти (0 — перший). Одне місце, де вирішується порядок списків. */
  function placeList(l, to) {
    var arr = lists().filter(function (x) { return x !== l; });
    arr.splice(Math.max(0, Math.min(arr.length, to)), 0, l);
    arr.forEach(function (x, i) { x.order = i; });
    commit();
  }

  var listDragId = null;   // список, який тягнуть у меню ліворуч

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
    $('app').classList.toggle('view-cal', ui.view === 'calendar');
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
    else if (kind === 'calform') window.SpravyCal.closeForm();
    else if (kind === 'voice') closeVoice();
  }
  /** Закрити всі вікна разом і прибрати їхні кроки з історії одним стрибком. */
  function closeOverlays() {
    var n = overlays.length;
    if (!n) return;
    overlays = [];
    closeKick(true); closeHelp(true); closePlan(true); closeSheet(true); closeNav(true); window.SpravyCal.closeForm(true); closeVoice(true);
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
    else if (kind === 'calform') window.SpravyCal.closeForm(true);
    else if (kind === 'voice') closeVoice(true);
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
      ['matrix', 'Матриця', I.grid, open.filter(function (t) { return quadrant(t) === 1; }).length],
      ['calendar', 'Календар', I.cal, 0]
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
      ['calendar', 'Календар', I.cal, 0],
      ['starred', 'Важливі', I.star, open.filter(function (t) { return t.starred; }).length],
      ['goal', 'Ціль', I.flag, goalBadge()]
    ];
    $('views').replaceChildren.apply($('views'), views.map(function (v) {
      return h('button', { type: 'button', class: 'nav-item' + (v[0] === 'goal' ? ' phone-keep' : ''), 'aria-current': String(ui.view === v[0]),
        onclick: function () { ui.view = v[0]; saveUi(); closeNav(); render(); } },
        svg(v[2], 20), v[1], h('span', { class: 'count' }, v[3] || ''));
    }));
    var cur = mobileMq.matches && ui.view === 'board' ? currentList() : null;
    $('lists').replaceChildren.apply($('lists'), lists().map(function (l) {
      // на комп'ютері списки можна перетягувати, щоб змінити їхній порядок
      var row = h('div', { class: 'list-row', style: '--c:' + l.color, 'aria-current': String(l === cur),
        draggable: hoverMq.matches ? null : 'true',
        ondragstart: function (e) { listDragId = l.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', l.id); },
        ondragend: function () { listDragId = null; clearDrop(); },
        ondragover: function (e) {
          if (!listDragId || listDragId === l.id) return;
          e.preventDefault(); clearDrop();
          var r = row.getBoundingClientRect();
          row.classList.add(e.clientY > r.top + r.height / 2 ? 'drop-after' : 'drop-before');
        },
        ondrop: function (e) {
          var moving = listDragId && db.lists[listDragId];
          if (!moving || moving === l) return;
          e.preventDefault();
          var after = row.classList.contains('drop-after');
          clearDrop(); listDragId = null;
          var rest = lists().filter(function (x) { return x !== moving; });
          placeList(moving, rest.indexOf(l) + (after ? 1 : 0));
        } },
        h('button', { type: 'button', class: 'dot', role: 'switch', 'aria-checked': String(l.visible),
          'aria-label': (l.visible ? 'Сховати з дошки «' : 'Показати на дошці «') + l.name + '»',
          title: l.visible ? 'Сховати з дошки' : 'Показати на дошці',
          onclick: function () { l.visible = !l.visible; commit(); } }),
        h('button', { type: 'button', class: 'name', onclick: function () { showList(l); } }, l.name),
        h('span', { class: 'count' }, openCount(l.id) || ''));
      return row;
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
      out.push(h('span', { class: 'chip' + (late ? ' late' : now ? ' today' : '') }, svg(I.clock, 14), dueLabel(t.due) + (t.start ? ' ' + t.start : ''), t.repeat !== 'none' ? svg(I.repeat, 14) : null));
    } else if (t.repeat !== 'none') {
      out.push(h('span', { class: 'chip' }, svg(I.repeat, 14), REPEATS[t.repeat]));
    }
    if (t.est && !t.done) out.push(h('span', { class: 'chip', title: 'Скільки часу займе' }, svg(I.hourglass, 14), estLabel(t.est)));
    if (isHabit(t) && !t.done) {
      var hw = habitWeek(t);
      out.push(h('span', { class: 'chip habit', title: hw.week ? 'Цього тижня ' + hw.done + ' з ' + hw.need + ' разів, у будь-які дні.'
          : 'Цього тижня зроблено ' + hw.done + ' з ' + hw.need + ' днів. Пропуск нічого не обнуляє: рахується кожен зроблений день.' },
        svg(I.repeat, 14), hw.done + '/' + hw.need + (hw.week ? ' цього тижня' : '')));
      if (hw.total) out.push(h('span', { class: 'chip total', title: 'Скільки разів зроблено за весь час. Не обнуляється.' }, 'всього ' + hw.total));
      if (hw.missed) out.push(h('span', { class: 'chip twice', title: 'Один пропуск — нормально. Головне — не пропустити двічі поспіль.' }, 'не пропустити вдруге'));
      if (t.after) out.push(h('span', { class: 'chip anchor', title: 'Якір: після чого робите' }, '↪ ' + t.after));
    }
    if (t.images.length) out.push(h('span', { class: 'chip photos', title: 'Фото' }, svg(I.image, 14), String(t.images.length)));
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
    // куди кладемо перетягнуте: у списку — порядок списку, у матриці — порядок квадранта
    var move = opts.move || function (id, ref, after) { moveTask(id, t.listId, ref, after); };
    var accepts = opts.accepts || function () { return true; };
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
        if (!dragId || !accepts(dragId)) return;
        e.preventDefault(); e.stopPropagation(); clearDrop();
        var r = row.getBoundingClientRect();
        row.classList.add(e.clientY > r.top + r.height / 2 ? 'drop-after' : 'drop-before');
      } : null,
      ondrop: drag ? function (e) {
        if (!dragId || !accepts(dragId)) return;
        e.preventDefault(); e.stopPropagation();
        var after = row.classList.contains('drop-after');
        clearDrop();
        move(dragId, t.id, after);
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
        h('span', { class: 'task-title', onmouseenter: function (e) { tipHover(t, e.currentTarget); }, onmouseleave: tipLeave }, t.title || 'Без назви'),
        t.notes && !t.done ? h('span', { class: 'task-notes' }, t.notes) : null,
        chipsFor(t, !!opts.showList)),
      t.title ? h('button', { type: 'button', class: 'tr-btn', 'aria-label': 'Переклад', title: 'Переклад',
        onclick: function (e) { e.stopPropagation(); tipToggle(t, e.currentTarget); } }, svg(I.lang, 17, 1.7)) : null,
      opts.sub || t.done ? null : h('button', { type: 'button', class: 'star' + (t.starred ? ' on' : ''), 'aria-label': t.starred ? 'Прибрати зірочку' : 'Додати зірочку',
        onclick: function () { toggleStar(t); } }, svg(I.star, 19, 1.8)));
    if (opts.touch === false || !mobileMq.matches) return row;
    // телефон: рядок у обгортці, під якою видно, що зробить свайп
    var wrap = h('div', { class: 'srow', 'data-id': t.id, 'data-top': opts.lift ? '1' : null,
      'data-ldone': t.done ? 'Повернути' : 'Виконано', 'data-ldel': 'Видалити' }, row);
    touchable(wrap, row, t, !!opts.lift, move);
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

  function touchable(wrap, row, t, liftable, move) {
    wrap.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) { cancelGesture(); return; }
      var p = e.touches[0];
      gest = { wrap: wrap, row: row, t: t, move: move, x0: p.clientX, y0: p.clientY, cy: p.clientY, dx: 0, dy: 0, mode: 'wait', sy0: window.scrollY,
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
      if (ref && ref !== g.t.id) g.move(g.t.id, ref, g.after);
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
      return h('div', { class: 'add-input' }, svg(I.addTask, 22, 1.8), input, micFor(input));
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
    // важливе (із зірочкою) завжди вгорі списку; всередині кожної групи — обраний порядок
    top = top.filter(function (t) { return t.starred; }).concat(top.filter(function (t) { return !t.starred; }));
    // справи на майбутнє сховані, доки не настане їхній день; знайти їх можна тут, згорнутими
    var later = sorted(tasks().filter(function (t) { return t.listId === l.id && !t.parentId && !t.done && isFuture(t); }), 'date');
    ui.openFuture = ui.openFuture || {};
    var futureOpen = !!ui.openFuture[l.id];
    var someday = sorted(tasks().filter(function (t) { return t.listId === l.id && isSomeday(t); }), 'mine');
    ui.openSomeday = ui.openSomeday || {};
    var somedayOpen = !!ui.openSomeday[l.id];
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
      // меню першим: воно стоїть у куті, а назва обтікає його
      h('div', { class: 'col-head' },
        columnMenu(l, mode),
        tabbed
          ? h('div', { class: 'col-title' }, h('span', {}, (top.length ? top.length + ' ' + plural(top.length) : 'Немає завдань') + ' · ' + SORT_NAMES[mode]))
          : h('div', { class: 'col-title' }, h('i', { class: 'col-dot' }), h('span', {}, l.name),
              top.length ? h('span', { class: 'pill', title: top.length + ' ' + plural(top.length) }, top.length) : null)),
      phone ? null : addBlock(l.id),
      // на комп'ютері кожен список гортається сам: шапка й «Додати завдання» лишаються на місці
      h('div', { class: 'col-body' },
        rows.length ? rows : h('div', { class: 'empty' }, done.length ? 'Усе виконано. Можна видихнути.'
          : later.length ? 'Сьогодні тут нічого. Заплановане з\'явиться у свій день.' : 'Поки порожньо. Додайте перше завдання.'),
        later.length ? h('button', { type: 'button', class: 'done-toggle', 'aria-expanded': String(futureOpen),
          onclick: function () { ui.openFuture[l.id] = !futureOpen; saveUi(); render(); } }, svg(I.chev, 18), 'Заплановано (' + later.length + ')') : null,
        futureOpen ? later.map(function (t) { return taskRow(t, { touch: false }); }) : null,
        someday.length ? h('button', { type: 'button', class: 'done-toggle', 'aria-expanded': String(somedayOpen),
          title: 'Справи без дати, яких не чіпали ' + SOMEDAY_DAYS + ' днів. Відкрийте й натисніть «Повернути», щоб знову бачити в списку.',
          onclick: function () { ui.openSomeday[l.id] = !somedayOpen; saveUi(); render(); } }, svg(I.chev, 18), 'Колись (' + someday.length + ')') : null,
        somedayOpen ? someday.map(function (t) { return taskRow(t, { touch: false }); }) : null,
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
    var all = lists(), at = all.indexOf(l);
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
      at > 0 ? h('button', { type: 'button', onclick: function () { openMenu = null; placeList(l, at - 1); } }, '↑ Вище') : null,
      at < all.length - 1 ? h('button', { type: 'button', onclick: function () { openMenu = null; placeList(l, at + 1); } }, '↓ Нижче') : null,
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
    if (ui.view === 'calendar') { window.SpravyCal.render(b, calApi); return; }
    if (ui.view === 'now') { renderNow(b); return; }
    if (ui.view === 'matrix') { renderMatrix(b); return; }
    if (ui.view === 'today') { renderToday(b); return; }
    if (ui.view === 'goal') { renderGoal(b); return; }
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
    var focusOpen = byRank(sorted(focus.filter(function (t) { return !t.done; }), 'mine'));
    var focusDone = focus.length - focusOpen.length;
    var rest = open.filter(function (t) { return t.due && t.due <= t0 && !isFocus(t); });
    var late = byRank(sorted(rest.filter(function (t) { return t.due < t0; }), 'date'));
    var now = byRank(sorted(rest.filter(function (t) { return t.due === t0; }), 'mine'));
    var first = lists().filter(function (l) { return l.visible; })[0] || lists()[0];
    // зроблене сьогодні — на видноті: «я нічого не встиг» рідко правда
    var done = sorted(tasks().filter(function (t) { return t.done && !t.parentId && t.doneAt === t0; }), 'mine');

    b.replaceChildren(installBar() || '', h('section', { class: 'flat' },
      h('h2', { class: 'sr-only' }, 'Сьогодні'),
      hero('today'),
      roadmap(),
      eveningInvite() || planInvite(false),
      focus.length ? [
        h('div', { class: 'group-row' },
          // «0 з 3» великими літерами читається як «0 3 3»: кирилична З схожа на трійку
          h('div', { class: 'group-label' }, 'Головне · ' + focusDone + '/' + focus.length),
          h('button', { type: 'button', class: 'link-btn', onclick: function () { openPlan('focus'); } }, 'Змінити')),
        focusOpen.length ? h('div', { class: 'rank-group focus-group' }, rankRows(focusOpen))
          : h('div', { class: 'empty win' }, 'Головне на сьогодні зроблено. Усе інше буде бонусом.')
      ] : null,
      first && !mobileMq.matches ? addBlock(first.id, { due: t0 }) : null,
      late.length ? [
        h('div', { class: 'group-row' },
          h('div', { class: 'group-label' }, 'З минулих днів'),
          h('button', { type: 'button', class: 'link-btn', onclick: function () { openPlan('triage'); } }, 'Розібрати')),
        h('div', { class: 'rank-group late-group' }, rankRows(late))
      ] : null,
      now.length ? [h('div', { class: 'group-row' }, h('div', { class: 'group-label' }, 'На сьогодні')),
        h('div', { class: 'rank-group now-group' }, rankRows(now))] : null,
      !focus.length && !late.length && !now.length ? h('div', { class: 'empty' }, 'На сьогодні нічого не заплановано.') : null,
      done.length ? [h('div', { class: 'group-row' }, h('div', { class: 'group-label win' }, 'Зроблено сьогодні · ' + done.length)),
        done.slice(0, DONE_SHOWN).map(function (t) { return taskRow(t, { showList: true }); })] : null,
      h('button', { type: 'button', class: 'quiet-link close-day', onclick: openEvening }, svg(I.moon || I.target, 16), 'Закрити день')));
  }

  /* ============================================================
     Привітання з персонажем і ціль з дорожньою картою
     Ціль — будь-яка справа з позначкою «Ціль» (одна на раз); кроки — її
     підзавдання. Ціль-звичка показує тижневу норму. Персонаж стоїть на
     поточному кроці: видно, скільки пройдено й що далі.
     ============================================================ */
  function avatarEl(mood, size) {
    var s = document.createElement('span');
    s.className = 'av';
    s.innerHTML = window.SpravyAvatar ? window.SpravyAvatar.svg(mood, size) : '';
    return s;
  }
  function goalTask() { return tasks().filter(function (t) { return t.goal && !t.done && !t.parentId; })[0] || null; }
  function setGoal(t) {
    var on = !t.goal;
    tasks().forEach(function (x) { if (x.goal) x.goal = false; });
    t.goal = on;
    commit();
    if (on) toast('Ціль: «' + t.title + '». Її дорожня карта — у розділі «Ціль», а також у «Зараз» і «Сьогодні».');
  }

  function hero(kind) {
    var hr = new Date().getHours(), t0 = today();
    var focus = focusToday(), fDone = focus.filter(function (t) { return t.done; }).length;
    var doneToday = tasks().filter(function (t) { return t.done && t.doneAt === t0 && !t.parentId; }).length;
    var allFocus = focus.length && fDone === focus.length;
    var mood = allFocus || doneToday >= 3 ? 'cheer' : lowEnergy() || hr >= 21 ? 'calm' : 'happy';
    var hello = hr < 5 ? 'Доброї ночі' : hr < 12 ? 'Доброго ранку' : hr < 18 ? 'Добрий день' : 'Добрий вечір';
    var line = allFocus ? 'Головне на сьогодні зроблено. День уже вдався.'
      : doneToday ? 'Сьогодні вже ' + doneToday + ' ' + (doneToday === 1 ? 'справа' : doneToday < 5 ? 'справи' : 'справ') + '. Так тримати.'
      : lowEnergy() ? 'Сил мало — беремо найменший крок.'
      : kind === 'now' ? 'Одна справа. Один крок. Поїхали.' : 'Що зробить цей день вдалим?';
    return h('section', { class: 'hero' },
      h('div', { class: 'hero-text' },
        h('div', { class: 'hero-hello' }, hello),
        h('div', { class: 'hero-title' }, kind === 'now' ? 'Крок ' : 'План ', h('em', {}, 'на сьогодні')),
        h('div', { class: 'hero-line' }, line),
        focus.length ? h('div', { class: 'hero-stats' },
          h('span', {}, svg(I.target, 14), 'Головне ' + fDone + '/' + focus.length),
          doneToday ? h('span', {}, svg(I.check || I.addTask, 14), 'Зроблено ' + doneToday) : null) : null),
      avatarEl(mood, 108));
  }

  /** Дорожня карта цілі: вузли кроків, персонаж на поточному, крок на сьогодні. */
  /** Цілі ще немає: замість порожнечі — запрошення. Назвати нову або обрати з великих справ. */
  function goalInvite() {
    if (ui.goalLater === today()) return null;
    var cands = tasks().filter(function (t) { return !t.done && !t.parentId && !isHabit(t) && t.title; })
      .map(function (t) { return { t: t, steps: childrenOf(t.id).length }; })
      .filter(function (x) { return x.steps || x.t.starred || (x.t.due && x.t.due > addDays(today(), 3)) || x.t.est >= 60; })
      .sort(function (a, b) { return b.steps - a.steps || (b.t.starred - a.t.starred) || a.t.order - b.t.order; })
      .slice(0, 4);
    var input = h('input', { placeholder: 'Напр.: пройти курс з ML до кінця місяця', autocomplete: 'off', enterkeyhint: 'done', 'aria-label': 'Назва цілі' });
    function create() {
      var v = input.value.trim();
      if (!v) { input.focus(); return; }
      var l = lists().filter(function (x) { return x.visible; })[0] || lists()[0];
      if (!l) return;
      var t = addTask(l.id, v, { due: '' });
      setGoal(t);
    }
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); create(); } });
    var track = h('div', { class: 'rm-track rm-ghost' });
    track.innerHTML = '<svg viewBox="0 0 320 96" preserveAspectRatio="none" aria-hidden="true"><path d="M0 70 C 60 70 60 34 120 34 C 180 34 180 66 240 66 C 290 66 300 40 320 40" class="rm-path"/></svg>';
    var me = h('span', { class: 'rm-me', style: 'left:8%;top:72%' });
    me.append(avatarEl('happy', 44));
    track.append(me, h('span', { class: 'rm-node locked', style: 'left:92%;top:42%' }, svg(I.flag, 16, 2.2)));
    return h('section', { class: 'roadmap rm-empty', 'aria-label': 'Поставити ціль' },
      h('div', { class: 'rm-head' }, h('span', { class: 'rm-kicker' }, svg(I.target, 14), 'Ціль'),
        h('button', { type: 'button', class: 'link-btn', onclick: function () { ui.goalLater = today(); saveUi(); render(); } }, 'Пізніше')),
      h('div', { class: 'rm-title' }, 'До чого йдете?'),
      h('div', { class: 'rm-info' }, 'Велика справа, до якої йдете кроками. Тут буде її дорожня карта: що пройдено й що далі.'),
      track,
      h('div', { class: 'first-step-row' }, input, h('button', { type: 'button', class: 'btn primary', onclick: create }, 'Поставити')),
      cands.length ? h('div', { class: 'rm-cands' }, h('small', {}, 'Або оберіть з наявних:'),
        cands.map(function (x) {
          return h('button', { type: 'button', class: 'schip', onclick: function () { setGoal(x.t); } },
            x.t.title + (x.steps ? ' · ' + x.steps + ' ' + forms(x.steps, 'крок', 'кроки', 'кроків') : ''));
        })) : null);
  }

  function roadmap(wide) {
    var g = goalTask();
    if (!g) return goalInvite();
    var nodes, info, step = null, isH = isHabit(g);
    if (isH) {
      var hw = habitWeek(g);
      nodes = [];
      for (var i = 0; i < hw.need; i++) nodes.push({ state: i < hw.done ? 'done' : i === hw.done ? 'now' : 'locked' });
      info = hw.done + '/' + hw.need + (hw.week ? ' цього тижня' : ' за тиждень') + (hw.total ? ' · всього ' + hw.total : '');
    } else {
      var steps = sorted(childrenOf(g.id), 'mine');
      var cur = steps.filter(function (s) { return !s.done; })[0];
      step = cur || null;
      nodes = steps.map(function (s, i) { return { state: s.done ? 'done' : s === cur ? 'now' : 'locked', title: s.title, n: i + 1, id: s.id }; });
      // без кроків — порожні місця, щоб доріжку було видно одразу
      if (!steps.length) nodes = [{ state: 'slot' }, { state: 'slot' }, { state: 'slot' }];
      var doneN = steps.filter(function (s) { return s.done; }).length;
      info = steps.length ? doneN + '/' + steps.length + ' ' + forms(steps.length, 'крок', 'кроки', 'кроків') + (doneN === steps.length ? ' · усі пройдено!' : '')
        : 'Додайте 3–5 кроків нижче: вони стануть доріжкою до цілі.';
    }
    // у звички дата — наступний раз, а не дедлайн
    var left = g.due && !isH ? Math.round((parseDay(g.due) - parseDay(today())) / 864e5) : null;
    var dl = left === null ? null : left < 0 ? 'дедлайн минув' : left === 0 ? 'сьогодні дедлайн'
      : 'до ' + parseDay(g.due).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' }) + ' · ' + left + ' ' + forms(left, 'день', 'дні', 'днів');
    // вузли на хвилястій доріжці; довгу ціль показуємо вікном навколо поточного кроку
    var MAX = wide ? 7 : 6, nowI = Math.max(0, nodes.findIndex(function (n) { return n.state === 'now'; }));
    var from = Math.max(0, Math.min(nowI - 2, nodes.length - MAX)), shown = nodes.slice(from, from + MAX);
    // фініш — прапорець наприкінці (у цілі-справи; у звички тиждень і є вся доріжка)
    if (!isH && from + MAX >= nodes.length) shown = shown.concat({ state: 'finish', title: g.title });
    var W = 320, H = 96, n = shown.length || 1;
    var pts = shown.map(function (_, k) { var x = n === 1 ? W / 2 : 24 + k * (W - 48) / (n - 1); return [x, k % 2 ? 34 : 66]; });
    // плавна доріжка: від лівого краю через усі вузли до правого (кожна крива — 3 точки)
    var all = [[0, 60]].concat(pts, [[W, 50]]);
    var d = 'M' + all[0][0] + ' ' + all[0][1] + all.slice(1).map(function (p, k) {
      var prev = all[k], mx = (prev[0] + p[0]) / 2;
      return ' C ' + mx + ' ' + prev[1] + ' ' + mx + ' ' + p[1] + ' ' + p[0] + ' ' + p[1];
    }).join('');
    var track = h('div', { class: 'rm-track' + (wide ? ' rm-wide' : '') });
    track.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true"><path d="' + d + '" class="rm-path"/></svg>';
    shown.forEach(function (nd, k) {
      var icon = nd.state === 'done' ? svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 16, 3)
        : nd.state === 'locked' ? (nd.n ? String(nd.n) : svg('<rect x="6" y="11" width="12" height="9" rx="2"/><path d="M9 11V8a3 3 0 016 0v3"/>', 14, 2))
        : nd.state === 'finish' ? svg(I.flag, 16, 2.2) : nd.state === 'slot' ? null : svg(I.target, 16, 2.2);
      var pos = 'left:' + (pts[k][0] / W * 100) + '%;top:' + (pts[k][1] / H * 100) + '%';
      // вузол кроку відкриває його картку; фініш — картку самої цілі
      var target = nd.id || (nd.state === 'finish' ? g.id : '');
      var el = target ? h('button', { type: 'button', class: 'rm-node ' + nd.state, style: pos, title: nd.title || '',
        'aria-label': (nd.n ? 'Крок ' + nd.n + ': ' : 'Фініш: ') + (nd.title || ''), onclick: function () { openDrawer(target); } }, icon)
        : h('span', { class: 'rm-node ' + nd.state, style: pos, title: nd.title || '' }, icon);
      track.append(el);
      // підпис: номер і назва; на вузькій картці лише номер у вузлі, підписи — у широкому розділі «Ціль»
      if (wide && (nd.title || nd.state === 'finish')) {
        track.append(h('span', { class: 'rm-label ' + nd.state, style: pos },
          nd.state === 'finish' ? 'Фініш' : nd.n + ' · ' + nd.title));
      }
      if (nd.state === 'now') {
        var me = h('span', { class: 'rm-me', style: 'left:' + (pts[k][0] / W * 100) + '%;top:' + (pts[k][1] / H * 100) + '%' });
        me.append(avatarEl('happy', 44));
        track.append(me);
      }
    });
    // ще немає поточного кроку: персонаж на старті; усе пройдено — на фініші й радіє
    if (!shown.some(function (nd) { return nd.state === 'now'; })) {
      var fin = !isH && nodes.length && nodes.every(function (nd) { return nd.state === 'done'; });
      var at = fin ? pts[pts.length - 1] : [8, 66];
      var me2 = h('span', { class: 'rm-me', style: 'left:' + (at[0] / W * 100) + '%;top:' + (at[1] / H * 100) + '%' });
      me2.append(avatarEl(fin ? 'cheer' : 'happy', 44));
      track.append(me2);
    }
    return h('section', { class: 'roadmap', 'aria-label': 'Ціль' },
      h('div', { class: 'rm-head' },
        h('span', { class: 'rm-kicker' }, svg(I.target, 14), 'Ціль'),
        dl ? h('span', { class: 'rm-deadline' + (left !== null && left <= 2 ? ' soon' : '') }, svg(I.cal, 14), dl) : null),
      h('button', { type: 'button', class: 'rm-title', onclick: function () { openDrawer(g.id); } }, g.title),
      h('div', { class: 'rm-info' }, info),
      track,
      step ? h('div', { class: 'rm-step' },
        h('button', { type: 'button', class: 'check', 'aria-label': 'Крок зроблено', onclick: function (e) { burst(e.currentTarget); toggleDone(step); } }),
        h('span', {}, h('small', {}, 'Крок на сьогодні'), step.title),
        h('button', { type: 'button', class: 'btn primary', onclick: function () { startKick(step); } }, svg(I.play, 14), 'Почати')) : null,
      isH ? null : stepAdder(g));
  }

  /* ---------- наявні справи як кроки цілі ----------
     Крок цілі — підзавдання цілі. Наявну справу можна прив'язати, навіть виконану: тоді
     вона стає пройденим кроком на початку доріжки. Не беремо звички та їхні виконання,
     справи з власними підзавданнями (вкладеність одна) і саму ціль. */
  function canAttach(t, g) {
    return t !== g && !t.parentId && !t.goal && !t.habit && t.repeat === 'none' && !childrenOf(t.id).length;
  }
  function attachSteps(g, list) {
    var was = list.map(function (t) { return [t, t.parentId, t.listId, t.order]; });
    var kids = childrenOf(g.id), min = 0, max = 0;
    kids.forEach(function (c, i) { if (!i || c.order < min) min = c.order; if (!i || c.order > max) max = c.order; });
    // виконані — пройдені кроки на початку, за датою; решта — після наявних
    var done = list.filter(function (t) { return t.done; }).sort(function (a, b) { return (a.doneAt || '').localeCompare(b.doneAt || ''); });
    var open = list.filter(function (t) { return !t.done; });
    done.forEach(function (t, i) { t.order = (kids.length ? min : 0) - done.length + i; });
    open.forEach(function (t, i) { t.order = (kids.length ? max : 0) + 1 + i; });
    list.forEach(function (t) { t.parentId = g.id; t.listId = g.listId; });
    commit();
    toast('Додано до цілі: ' + list.length + ' ' + forms(list.length, 'крок', 'кроки', 'кроків') + '.', function () {
      was.forEach(function (w) { w[0].parentId = w[1]; w[0].listId = w[2]; w[0].order = w[3]; });
      commit();
    }, 8000);
  }
  /** Вікно вибору наявних справ: пошук, позначити кілька, «Додати N». */
  function openAttach(g) {
    var picked = {}, q = '';
    var all = tasks().filter(function (t) { return canAttach(t, g); }).sort(function (a, b) {
      return (a.done - b.done) || (b.doneAt || '').localeCompare(a.doneAt || '') || a.order - b.order;
    });
    var layer = h('div', { class: 'star-layer' });
    var listBox = h('div', { class: 'cands' });
    var addBtn = h('button', { type: 'button', class: 'btn primary', disabled: true, onclick: function () {
      var list = all.filter(function (t) { return picked[t.id]; });
      close(); if (list.length) attachSteps(g, list);
    } }, 'Додати');
    var search = h('input', { type: 'search', placeholder: 'Пошук', autocomplete: 'off', 'aria-label': 'Пошук справ' });
    search.addEventListener('input', function () { q = search.value.trim().toLowerCase(); paint(); });
    function paint() {
      var n = Object.keys(picked).length;
      addBtn.disabled = !n; addBtn.textContent = n ? 'Додати ' + n : 'Додати';
      var shown = all.filter(function (t) { return !q || t.title.toLowerCase().indexOf(q) >= 0; }).slice(0, 80);
      listBox.replaceChildren.apply(listBox, shown.length ? shown.map(function (t) {
        var on = !!picked[t.id], l = listOf(t.listId);
        return h('button', { type: 'button', class: 'cand' + (on ? ' on' : ''), 'aria-pressed': String(on),
          onclick: function () { if (on) delete picked[t.id]; else picked[t.id] = true; paint(); } },
          h('span', { class: 'cand-mark' }, svg(t.done ? I.check : I.addTask, 18, 2)),
          h('span', { class: 'cand-body' }, h('span', { class: 'cand-title' }, t.title || 'Без назви'),
            h('span', { class: 'cand-meta' }, (t.done ? 'зроблено' + (t.doneAt ? ' ' + dueLabel(t.doneAt).toLowerCase() : '') + ' · ' : '') + (l ? l.name : ''))));
      }) : [h('div', { class: 'empty' }, q ? 'Нічого не знайдено.' : 'Немає справ, які можна додати.')]);
    }
    function close() { layer.remove(); document.removeEventListener('keydown', onKey, true); }
    function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); } }
    layer.append(h('div', { class: 'modal-scrim', onclick: close }),
      h('div', { class: 'modal attach-pick', role: 'dialog', 'aria-label': 'Додати наявні справи до цілі' },
        h('div', { class: 'modal-title' }, 'Кроки з наявних справ'),
        h('div', { class: 'modal-sub' }, 'До цілі «' + g.title + '». Виконані стануть пройденими кроками на початку доріжки.'),
        search, listBox,
        h('div', { class: 'modal-foot' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Скасувати'), addBtn)));
    paint();
    document.body.append(layer);
    document.addEventListener('keydown', onKey, true);
    setTimeout(function () { search.focus(); });
  }

  /** Поле «Додати крок»: кроки цілі додаються один за одним, у кінець доріжки. */
  var goalDraft = { text: '', focused: false };
  function stepAdder(g) {
    var input = h('input', { placeholder: childrenOf(g.id).length ? 'Наступний крок' : 'Напр.: пройти урок 1', autocomplete: 'off', enterkeyhint: 'done', 'aria-label': 'Новий крок цілі' });
    input.value = goalDraft.text;
    input.addEventListener('input', function () { goalDraft.text = input.value; });
    input.addEventListener('focus', function () { goalDraft.focused = true; });
    input.addEventListener('blur', function () { goalDraft.focused = false; });
    function add() {
      var v = input.value.trim();
      if (!v) { input.focus(); return; }
      var max = 0;
      childrenOf(g.id).forEach(function (c) { if (c.order > max) max = c.order; });
      goalDraft = { text: '', focused: true };          // поле лишається під рукою для наступного кроку
      addTask(g.listId, v, { parentId: g.id, order: max + 1, starred: false, due: '' });
    }
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    if (goalDraft.focused) setTimeout(function () { input.focus(); });
    return h('div', { class: 'rm-add-wrap' },
      h('div', { class: 'rm-add first-step-row' }, input, micFor(input, add), h('button', { type: 'button', class: 'btn', onclick: add }, svg(I.addTask, 16), 'Крок')),
      h('button', { type: 'button', class: 'link-btn', onclick: function () { openAttach(g); } }, 'Додати наявні справи, зокрема виконані'));
  }

  /** Підпис біля «Ціль» у меню: «1/3» кроків (або тижнева норма звички). */
  function goalBadge() {
    var g = goalTask();
    if (!g) return '';
    if (isHabit(g)) { var hw = habitWeek(g); return hw.done + '/' + hw.need; }
    var st = childrenOf(g.id);
    return st.length ? st.filter(function (x) { return x.done; }).length + '/' + st.length : '';
  }

  /* ---------- розділ «Ціль» ----------
     Ліворуч — доріжка з підписаними кроками й список кроків. Праворуч — те, що за дослідженнями
     найбільше тримає людину на шляху: навіщо (WOOP: бажання й результат), темп і прогноз фінішу
     (видно, чи встигаєте), план «якщо… то…» на головну перешкоду (Gollwitzer, Oettingen)
     і журнал перемог (принцип прогресу, Amabile). */

  /** Перше число в назві кроку: «Lesson 10» → 10; без числа — null. */
  function stepNum(t) { var m = /\d+/.exec(t.title); return m ? +m[0] : null; }
  /** Кроки з номерами стоять не по зростанню (напр. імпорт дав 10, 9, 8)? */
  function stepsUnordered(steps) {
    var nums = steps.map(stepNum).filter(function (n) { return n !== null; });
    return nums.some(function (n, i) { return i && n < nums[i - 1]; });
  }
  /** Номеровані кроки стають по зростанню на свої ж місця; кроки без номера лишаються де були. */
  function orderByNumber(g) {
    var steps = sorted(childrenOf(g.id), 'mine');
    var was = steps.map(function (t) { return [t, t.order]; });
    var numbered = steps.filter(function (t) { return stepNum(t) !== null; })
      .sort(function (a, b) { return stepNum(a) - stepNum(b) || a.order - b.order; });
    var k = 0;
    steps.map(function (t) { return stepNum(t) !== null ? numbered[k++] : t; })
      .forEach(function (t, i) { t.order = i + 1; });
    commit();
    toast('Кроки впорядковано за номером.', function () { was.forEach(function (w) { w[0].order = w[1]; }); commit(); }, 8000);
  }

  /** Темп: скільки кроків пройдено щотижня (8 тижнів), середнє за 4 і коли в такому темпі буде фініш. */
  function goalPace(g, steps) {
    var t0 = today(), mon = mondayOf(t0), weeks = [];
    for (var i = 7; i >= 0; i--) weeks.push({ from: addDays(mon, -7 * i), n: 0 });
    steps.forEach(function (s) {
      if (!s.done || !s.doneAt) return;
      weeks.forEach(function (w) { if (s.doneAt >= w.from && s.doneAt < addDays(w.from, 7)) w.n++; });
    });
    var last28 = steps.filter(function (s) { return s.done && s.doneAt && s.doneAt > addDays(t0, -28); }).length;
    var perWeek = last28 / 4, left = steps.filter(function (s) { return !s.done; }).length;
    var eta = perWeek > 0 && left ? addDays(t0, Math.ceil(left / perWeek * 7)) : '';
    var daysToDue = g.due ? Math.round((parseDay(g.due) - parseDay(t0)) / 864e5) : null;
    var need = daysToDue !== null && daysToDue > 0 && left ? Math.ceil(left / (daysToDue / 7) * 10) / 10 : null;
    return { weeks: weeks, week: weeks[7].n, perWeek: perWeek, left: left, eta: eta, need: need,
      late: !!(g.due && left && (!eta || eta > g.due)) };
  }

  var goalEdit = { name: '', text: '', pos: 0 };   // поле панелі, в якому пишуть: текст і фокус переживають перемальовування
  function goalField(g, name, tag, ph) {
    var el = h(tag, { name: name, placeholder: ph, autocomplete: 'off', 'aria-label': ph, rows: tag === 'textarea' ? 3 : null });
    el.value = goalEdit.name === name ? goalEdit.text : g[name] || '';
    el.addEventListener('focus', function () { goalEdit = { name: name, text: el.value, pos: el.value.length }; });
    el.addEventListener('input', function () { goalEdit.text = el.value; goalEdit.pos = el.selectionStart; });
    el.addEventListener('blur', function () {
      if (!el.isConnected) return;                     // поле прибрало перемальовування — це не вихід з нього
      if (goalEdit.name === name) goalEdit.name = '';
      var v = el.value.trim();
      if (v === (g[name] || '')) return;
      g[name] = v;
      setTimeout(commit);      // спершу хай фокус перейде в сусіднє поле, тоді перемальовуємо — і він там лишиться
    });
    if (goalEdit.name === name) setTimeout(function () { el.focus(); try { el.setSelectionRange(goalEdit.pos, goalEdit.pos); } catch (e) {} });
    return el;
  }
  function dateUk(s) { return parseDay(s).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' }); }

  function goalSide(g, steps) {
    var cards = [h('div', { class: 'gp-card' },
      h('div', { class: 'gp-title' }, svg(I.star || I.target, 15), 'Навіщо'),
      goalField(g, 'why', 'textarea', 'Що зміниться, коли дійдете? Напр.: зможу податися на junior DA'))];
    if (steps.length) {
      var p = goalPace(g, steps), max = Math.max.apply(null, p.weeks.map(function (w) { return w.n; }).concat(1));
      cards.push(h('div', { class: 'gp-card gp-pace' },
        h('div', { class: 'gp-title' }, svg(I.chart || I.target, 15), 'Темп і прогноз'),
        h('div', { class: 'gp-nums' },
          h('div', {}, h('b', {}, String(p.week)), h('small', {}, 'цього тижня')),
          h('div', {}, h('b', {}, String(Math.round(p.perWeek * 10) / 10)), h('small', {}, 'кроків на тиждень')),
          h('div', {}, h('b', {}, String(p.left)), h('small', {}, 'лишилось'))),
        h('div', { class: 'gp-bars', 'aria-label': 'Кроки за останні 8 тижнів' }, p.weeks.map(function (w, i) {
          return h('i', { class: i === 7 ? 'now' : '', style: 'height:' + Math.max(6, w.n / max * 100) + '%', title: w.n + ' з ' + dateUk(w.from) });
        })),
        h('div', { class: 'gp-eta' + (p.late ? ' late' : '') },
          !p.left ? 'Усі кроки пройдено. Фініш!'
            : p.eta ? 'Прогноз фінішу в цьому темпі: ' + dateUk(p.eta) + '.'
            : 'Прогноз з’явиться, щойно пройдете перший крок.',
          p.need !== null && p.late ? ' Щоб встигнути до ' + dateUk(g.due) + ', треба ' + p.need + ' ' + forms(Math.ceil(p.need), 'крок', 'кроки', 'кроків') + ' на тиждень.' : '',
          p.need !== null && !p.late && p.left ? ' До дедлайну встигаєте.' : '')));
    }
    cards.push(h('div', { class: 'gp-card' },
      h('div', { class: 'gp-title' }, svg(I.bolt || I.target, 15), 'Якщо… то…'),
      h('small', { class: 'gp-hint' }, 'Що найімовірніше завадить і що ви тоді зробите. План наперед підвищує шанс дійти.'),
      h('label', { class: 'gp-if' }, h('span', {}, 'Якщо'), goalField(g, 'obstacle', 'input', 'напр.: втомився після роботи')),
      h('label', { class: 'gp-if' }, h('span', {}, 'то я'), goalField(g, 'ifThen', 'input', 'напр.: дивлюсь лише 10 хвилин уроку'))));
    var wins = steps.filter(function (s) { return s.done; })
      .sort(function (a, b) { return (b.doneAt || '').localeCompare(a.doneAt || '') || b.order - a.order; }).slice(0, 5);
    if (wins.length) cards.push(h('div', { class: 'gp-card' },
      h('div', { class: 'gp-title' }, svg(I.check, 15), 'Перемоги'),
      h('ul', { class: 'gp-wins' }, wins.map(function (s) {
        return h('li', {}, h('span', {}, s.title), s.doneAt ? h('small', {}, dueLabel(s.doneAt)) : null);
      }))));
    return h('aside', { class: 'goal-side' }, cards);
  }

  /** Розділ «Ціль»: велика дорожня карта, усі кроки (і пройдені), панель праворуч, зняти ціль. */
  function renderGoal(b) {
    var g = goalTask();
    var steps = g && !isHabit(g) ? sorted(childrenOf(g.id), 'mine') : [];
    var openS = steps.filter(function (x) { return !x.done; }), doneS = steps.filter(function (x) { return x.done; });
    var main = h('div', { class: 'goal-main' },
      roadmap(true),
      g && !isHabit(g) ? h('div', { class: 'goal-steps' },
        h('div', { class: 'group-row' }, h('div', { class: 'group-label' }, 'Кроки · ' + doneS.length + '/' + steps.length),
          stepsUnordered(steps) ? h('button', { type: 'button', class: 'link-btn', onclick: function () { orderByNumber(g); } }, 'Упорядкувати за номером') : null),
        openS.length ? openS.map(function (x) { return taskRow(x, { drag: !mobileMq.matches && !hoverMq.matches, lift: mobileMq.matches }); })
          : h('div', { class: 'empty' }, steps.length ? 'Усі кроки пройдено. Ціль досягнуто? Відмітьте її в картці.' : 'Кроків ще немає: додайте їх у картці вище.'),
        doneS.length ? [h('div', { class: 'group-label win' }, 'Пройдено · ' + doneS.length), doneS.map(function (x) { return taskRow(x); })] : null) : null);
    b.replaceChildren(installBar() || '', h('section', { class: 'flat wide goal-view' },
      h('div', { class: 'group-row' }, h('h2', {}, 'Ціль'),
        g ? h('button', { type: 'button', class: 'link-btn', onclick: function () { setGoal(g); } }, 'Зняти ціль') : null),
      h('div', { class: 'goal-grid' }, main, g ? goalSide(g, steps) : null)));
  }

  /* ---------- «Зараз»: одна справа ---------- */

  /* Розмита, велика чи застрягла справа без кроків — це ціль, а не дія: мозок не бачить,
     з чого почати. Просимо назвати першу фізичну дію на дві хвилини. */
  var VAGUE = /^(to\s+)?(study|learn|research|prepare|figure|adjust|work on|review|plan|organi[sz]e|clean|write|finish|start|do|read|practi[cs]e)\b|^(вивчити|вчити|розібратися|розібрати|підготувати|прибрати|написати|доробити|зробити|спланувати|дослідити|подумати|організувати|прочитати|повторити)/i;
  function needsStep(t) {
    return !childrenOf(t.id).some(function (c) { return !c.done; }) && (isStuck(t) || VAGUE.test(t.title.trim()) || t.est >= 45);
  }
  var stepDraft = { id: '', text: '', focused: false };   // набране не зникає, коли обмін у фоні перемальовує екран
  function firstStepBox(t) {
    if (stepDraft.id !== t.id) stepDraft = { id: t.id, text: '', focused: false };
    var input = h('input', { placeholder: 'Напр.: відкрити конспект і прочитати першу сторінку', autocomplete: 'off', enterkeyhint: 'done',
      'aria-label': 'Перша дія на 2 хвилини' });
    input.value = stepDraft.text;
    input.addEventListener('input', function () { stepDraft.text = input.value; });
    input.addEventListener('focus', function () { stepDraft.focused = true; });
    input.addEventListener('blur', function () { stepDraft.focused = false; });
    function add() {
      var v = input.value.trim();
      if (!v) { input.focus(); return; }
      stepDraft = { id: '', text: '', focused: false };
      addTask(t.listId, v, { parentId: t.id, order: 0, starred: false, due: '' });
    }
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    if (stepDraft.focused) setTimeout(function () { input.focus(); input.setSelectionRange(input.value.length, input.value.length); });
    return h('div', { class: 'first-step' },
      h('label', {}, 'Яка перша дія на 2 хвилини?'),
      h('div', { class: 'first-step-row' }, input, h('button', { type: 'button', class: 'btn', onclick: add }, 'Додати')));
  }

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
      // «Полегшити»: мінімум звички замість повної версії (і він зараховується); мало сил — одразу мінімум
      var canEasy = !!t.easy && isHabit(t);
      var easyOn = canEasy && (lowEnergy() || (ui.easyNow && ui.easyNow.id === t.id && ui.easyNow.day === today()));
      body = [
        h('article', { class: 'now-card' },
          h('div', { class: 'chips' },
            isFocus(t) ? h('span', { class: 'chip focus' }, svg(I.target, 14), 'Головне') : null,
            t.due ? h('span', { class: 'chip' + (t.due < today() ? ' late' : t.due === today() ? ' today' : '') }, svg(I.clock, 14), dueLabel(t.due)) : null,
            t.est ? h('span', { class: 'chip' }, svg(I.hourglass, 14), estLabel(t.est)) : null,
            l ? h('span', { class: 'chip list', style: '--c:' + l.color }, l.name) : null),
          h('button', { type: 'button', class: 'now-title', title: 'Відкрити картку', onclick: function () { openDrawer(t.id); } }, easyOn ? t.easy : (t.title || 'Без назви')),
          easyOn ? h('div', { class: 'easy-of' }, 'Мінімум замість «' + t.title + '». Теж зараховується.') : null,
          step ? h('div', { class: 'now-step' },
            h('button', { type: 'button', class: 'check', 'aria-label': 'Крок зроблено', onclick: function (e) { burst(e.currentTarget); toggleDone(step); } }),
            h('span', {}, h('small', {}, 'Перший крок'), step.title)) : needsStep(t) ? firstStepBox(t) : null,
          // без оцінки «чи влазить день» не працює — питаємо тут, одним дотиком
          t.est ? null : h('div', { class: 'now-est', role: 'group', 'aria-label': 'Скільки часу займе' },
            h('span', {}, 'Скільки часу?'),
            [5, 15, 30, 60].map(function (m) {
              return h('button', { type: 'button', onclick: function () { t.est = m; commit(); } }, estLabel(m));
            })),
          h('button', { type: 'button', class: 'btn primary now-go', onclick: function () { startKick(t, mins); } },
            svg(I.play, 18), 'Почати · ' + estLabel(mins)),
          h('div', { class: 'now-mins' }, h('span', {}, 'або'),
            TIMER_MINS.filter(function (m) { return m !== mins; }).map(function (m) {
              return h('button', { type: 'button', onclick: function () { startKick(t, m); } }, m + ' хв');
            })),
          h('div', { class: 'now-actions' },
            h('button', { type: 'button', class: 'btn', onclick: function (e) { burst(e.currentTarget); toggleDone(t, { easy: easyOn }); } }, 'Готово'),
            canEasy && !lowEnergy() ? h('button', { type: 'button', class: 'btn', onclick: function () {
              ui.easyNow = easyOn ? null : { id: t.id, day: today() }; saveUi(); render();
            } }, easyOn ? 'Повна версія' : 'Полегшити') : null,
            h('button', { type: 'button', class: 'btn', onclick: function () { notNow(t, q.length); } }, 'Не зараз')),
          h('button', { type: 'button', class: 'quiet-link', onclick: function () { openHelp(t); } }, svg(I.knot, 16), 'Не можу взятися?')),
        q.length > 1 ? h('div', { class: 'now-next' }, 'Далі: ', h('b', {}, q[1].title || 'Без назви'),
          q.length > 2 ? ' · ще ' + (q.length - 2) : '') : null
      ];
    }
    b.replaceChildren(installBar() || '', h('section', { class: 'flat now' },
      hero('now'),
      h('div', { class: 'now-head' }, h('h2', {}, 'Зараз'), energy),
      roadmap(),
      eveningInvite() || planInvite(true),
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

  /* Групи, що збирають справи з різних списків (квадранти матриці, «Сьогодні»), мають власний
     ручний порядок rank: порядок у самих списках при цьому не змінюється. */

  /** Спершу переставлені вручну (за rank), далі решта в порядку base — як було до перестановок. */
  function byRank(base) {
    return base.filter(function (t) { return t.rank; }).sort(function (a, b) { return a.rank - b.rank; })
      .concat(base.filter(function (t) { return !t.rank; }));
  }
  function quadSorted(list, q) { return byRank(q === 4 ? sorted(list, 'mine') : sorted(list, 'date')); }

  /** Рядки групи, які можна переставляти між собою: мишкою на комп'ютері, довгим натисканням на телефоні. */
  function rankRows(arr, shown, extra) {
    var phone = mobileMq.matches;
    function move(id, ref, after) { rankIn(arr, id, ref, after); }
    function accepts(id) { return arr.some(function (x) { return x.id === id; }); }   // лише в межах своєї групи
    return (shown || arr).map(function (t) {
      return taskRow(t, Object.assign({ showList: true, drag: !phone, lift: phone, move: move, accepts: accepts }, extra));
    });
  }

  /** Поставити id перед/після ref у групі arr і пронумерувати всіх 1..n. Порядок у списках не змінюється. */
  function rankIn(arr, id, ref, after) {
    var t = db.tasks[id];
    if (!t || id === ref) return;
    var rest = arr.filter(function (x) { return x.id !== id; });
    var i = rest.findIndex(function (x) { return x.id === ref; });
    if (i < 0) return;
    rest.splice(i + (after ? 1 : 0), 0, t);
    rest.forEach(function (x, n) { x.rank = n + 1; });
    commit();
  }

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
      var arr = quadSorted(by[q], q);
      var open = !!ui.qOpen[q];
      var shown = open ? arr : arr.slice(0, QUAD_SHOWN);
      return h('section', { class: 'quad q' + q, 'aria-label': QUADS[q].name },
        h('div', { class: 'quad-head' },
          h('span', { class: 'qnum' }, q),
          h('span', { class: 'quad-name' }, QUADS[q].name),
          arr.length ? h('span', { class: 'pill' }, arr.length) : null),
        h('div', { class: 'quad-hint' }, QUADS[q].hint),
        arr.length ? h('div', { class: 'rank-group' }, rankRows(arr, shown)) : h('div', { class: 'empty' }, EMPTY[q]),
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

  /* ============================================================
     Фото в завданні
     Файли лежать у приватному сховищі Supabase (кошик spravy, тека
     користувача), у завданні — лише шлях і розмір. Перед відправкою
     зображення стискаємо: скрін на 2–5 МБ стає 150–400 КБ.
     ============================================================ */

  var PHOTO_SIDE = 1600;     // довша сторона після стискання, px
  var photoUrls = {};        // шлях → blob-адреса (щоб не тягнути те саме вдруге)

  /** id користувача: з входу, а для старих сесій — з токена. */
  function userId() {
    var s = sess();
    if (s && s.uid) return s.uid;
    try { return JSON.parse(atob(s.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub || ''; } catch (e) { return ''; }
  }

  /** Стиснути зображення: Promise<{ blob, w, h, ext }>. */
  function shrink(file) {
    return createImageBitmap(file).then(function (img) {
      var k = Math.min(1, PHOTO_SIDE / Math.max(img.width, img.height));
      var w = Math.round(img.width * k), hh = Math.round(img.height * k);
      var c = document.createElement('canvas');
      c.width = w; c.height = hh;
      c.getContext('2d').drawImage(img, 0, 0, w, hh);
      if (img.close) img.close();
      return new Promise(function (res, rej) {
        c.toBlob(function (b) {
          if (!b) return rej(new Error('не вдалося стиснути'));
          if (b.type === 'image/webp') return res({ blob: b, w: w, h: hh, ext: 'webp' });
          c.toBlob(function (j) { j ? res({ blob: j, w: w, h: hh, ext: 'jpg' }) : rej(new Error('не вдалося стиснути')); }, 'image/jpeg', 0.85);
        }, 'image/webp', 0.82);
      });
    });
  }

  function photoUrl(path) {
    if (!photoUrls[path]) {
      photoUrls[path] = api('/storage/v1/object/authenticated/spravy/' + path)
        .then(function (r) { return r.blob(); })
        .then(function (b) { return URL.createObjectURL(b); });
      photoUrls[path].catch(function () { delete photoUrls[path]; });   // наступного разу спробуємо знову
    }
    return photoUrls[path];
  }

  /** Додати фото до завдання. Повертає Promise, що завершується після запису. */
  function addPhotos(id, list) {
    var imgs = [].filter.call(list || [], function (f) { return /^image\//.test(f.type); });
    var t = db.tasks[id];
    if (!t || !imgs.length) return Promise.resolve();
    var room = PHOTO_MAX - t.images.length;
    if (room <= 0) { toast('У завданні вже ' + PHOTO_MAX + ' фото: більше не влазить'); return Promise.resolve(); }
    if (!userId()) { toast('Щоб додати фото, треба увійти'); return Promise.resolve(); }
    imgs = imgs.slice(0, room);
    pendingPhotos[id] = (pendingPhotos[id] || 0) + imgs.length;
    paintPending(id);
    return Promise.all(imgs.map(function (f) {
      return shrink(f).then(function (x) {
        var path = userId() + '/' + uid() + '.' + x.ext;
        return api('/storage/v1/object/spravy/' + path, { method: 'POST', body: x.blob, headers: { 'Content-Type': x.blob.type } }).then(function () {
          photoUrls[path] = Promise.resolve(URL.createObjectURL(x.blob));
          var cur = db.tasks[id];
          if (cur) { cur.images = cur.images.concat({ path: path, w: x.w, h: x.h }); commit(); }
        });
      }).catch(function (e) {
        toast(e && e.name === 'TypeError' ? 'Фото не додано: немає зв\'язку' : 'Фото не додано: ' + ((e && e.message) || 'помилка'));
      }).then(function () { pendingPhotos[id]--; paintPending(id); });
    }));
  }
  var pendingPhotos = {};   // id завдання → скільки фото ще летить
  function paintPending(id) {
    var box = document.querySelector('.drawer .photos');
    if (!box || drawerTask !== id) return;
    [].forEach.call(box.querySelectorAll('.photo.wait'), function (n) { n.remove(); });
    for (var i = 0; i < (pendingPhotos[id] || 0); i++) box.insertBefore(h('span', { class: 'photo wait', 'aria-label': 'Завантаження' }), box.lastChild);
  }

  function removePhoto(id, path) {
    var t = db.tasks[id];
    if (!t) return;
    t.images = t.images.filter(function (x) { return x.path !== path; });
    commit();
    api('/storage/v1/object/spravy/' + path, { method: 'DELETE' }).catch(function () { /* файл без посилання нікому не видно */ });
  }

  /** Рядок мініатюр у картці + кнопка «Додати фото». */
  function photoField(t) {
    var input = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
    input.addEventListener('change', function () { addPhotos(t.id, input.files); input.value = ''; });
    var box = h('div', { class: 'photos' },
      t.images.map(function (x, i) {
        var img = h('img', { alt: 'Фото ' + (i + 1), width: x.w || null, height: x.h || null, decoding: 'async' });
        photoUrl(x.path).then(function (u) { img.src = u; }, function () { img.parentNode && img.parentNode.classList.add('broken'); });
        return h('button', { type: 'button', class: 'photo', 'aria-label': 'Відкрити фото ' + (i + 1), onclick: function () { viewPhoto(t.id, x.path); } }, img);
      }),
      h('button', { type: 'button', class: 'photo add', onclick: function () { input.click(); } }, svg(I.image, 20), h('span', {}, 'Додати фото'), input));
    setTimeout(function () { paintPending(t.id); });
    return h('div', { class: 'field' },
      h('span', { class: 'field-label' }, 'Фото', mobileMq.matches ? null : h('span', { class: 'hint' }, ' · можна вставити скрін: Ctrl+V')),
      box);
  }

  /** Фото на весь екран: закрити (Escape, клік повз) або видалити. */
  function viewPhoto(id, path) {
    var del = h('button', { type: 'button', class: 'btn danger' }, 'Видалити');
    var img = h('img', { alt: 'Фото' });
    var view = h('div', { class: 'photo-view', role: 'dialog', 'aria-label': 'Фото' },
      img,
      h('div', { class: 'photo-bar' },
        del,
        h('button', { type: 'button', class: 'btn', onclick: function () { close(); } }, 'Закрити')));
    photoUrl(path).then(function (u) { img.src = u; });
    function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); } }
    function close() { view.remove(); document.removeEventListener('keydown', onKey, true); }
    view.addEventListener('click', function (e) { if (e.target === view) close(); });
    del.addEventListener('click', function () {
      if (!del.classList.contains('armed')) { del.classList.add('armed'); del.textContent = 'Точно видалити?'; return; }
      close(); removePhoto(id, path);
    });
    document.addEventListener('keydown', onKey, true);
    document.body.append(view);
    view.querySelector('.btn:not(.danger)').focus();
  }

  // скрін із буфера (Ctrl+V) чи файл, перетягнутий на картку
  document.addEventListener('paste', function (e) {
    if (!drawerTask || !e.clipboardData) return;
    var f = [].filter.call(e.clipboardData.files || [], function (x) { return /^image\//.test(x.type); });
    if (!f.length) return;           // звичайний текст вставляється як завжди
    e.preventDefault();
    addPhotos(drawerTask, f);
  });
  document.addEventListener('dragover', function (e) {
    if (drawerTask && e.dataTransfer && [].indexOf.call(e.dataTransfer.types || [], 'Files') >= 0 && e.target.closest && e.target.closest('.drawer')) e.preventDefault();
  });
  document.addEventListener('drop', function (e) {
    if (!drawerTask || !e.dataTransfer || !e.dataTransfer.files.length || !(e.target.closest && e.target.closest('.drawer'))) return;
    e.preventDefault();
    addPhotos(drawerTask, e.dataTransfer.files);
  });

  var drawerStamp = '';
  function stampOf(t) { return t.id + ':' + JSON.stringify(t) + childrenOf(t.id).map(function (c) { return c.title + c.done; }).join(); }

  /** Закрити картку. fromBack — її вже закрила кнопка «Назад», крок історії знято. */
  function closeDrawer(fromBack) {
    var t = drawerTask && db.tasks[drawerTask];
    drawerTask = null; drawerStamp = '';
    if (!fromBack) popOverlay('drawer');
    // порожнє, щойно створене кнопкою «Нове завдання», не лишаємо
    if (t && !t.title.trim() && !t.notes.trim() && !t.images.length) {
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
    // час події: кінець завжди після початку; час без дати ставить подію на сьогодні
    function times(s, e) { var x = window.SpravyCal.normTimes(s, e); t.start = x.start; t.end = x.end; if (t.start && !t.due) t.due = today(); commit(); }
    function timeIn(id, v, fn) { return h('input', { id: id, type: 'time', step: '900', value: v, onchange: function (e) { fn(e.target.value); } }); }
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
    // звичку легше вбудувати в те, що вже робите щодня: «після кави — вітаміни»
    // легка версія: краще мінімум, ніж нічого, і він зараховується
    var easyIn = h('input', { id: 'd-easy', placeholder: 'Напр.: 15 хв розминки вдома', autocomplete: 'off', maxlength: '120' });
    easyIn.value = t.easy;
    easyIn.addEventListener('input', function () { typed('easy', easyIn.value); });
    var afterIn = h('input', { id: 'd-after', placeholder: 'Напр.: після ранкової кави', autocomplete: 'off', maxlength: '80' });
    afterIn.value = t.after;
    afterIn.addEventListener('input', function () { typed('after', afterIn.value); });
    var due = window.SpravyDate.field('d-due', t.due || '', function (v) { setDue(t, v); commit(); });
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
        goalTask() && canAttach(t, goalTask()) ? h('button', { type: 'button', class: 'quiet-link', title: 'Зробити кроком цілі «' + goalTask().title + '»',
          onclick: function () { attachSteps(goalTask(), [t]); } }, svg(I.flag, 16), 'Крок цілі «' + goalTask().title + '»') : null,
        isSomeday(t) ? h('div', { class: 'someday-note' },
          h('span', {}, 'Лежить у «Колись»: її не чіпали понад ' + SOMEDAY_DAYS + ' днів.'),
          h('button', { type: 'button', class: 'btn', onclick: function () { t.seen = today(); commit(); } }, 'Повернути в список')) : null,
        t.title ? translateBox(t) : null,
        t.title ? fixBox(t) : null,
        // матриця й головне на день — двома перемикачами, без окремих полів
        parent || t.done ? null : h('div', { class: 'd-flags' },
          h('button', { type: 'button', class: 'flag' + (t.starred ? ' on' : ''), 'aria-pressed': String(t.starred),
            onclick: function () { toggleStar(t); } }, svg(I.star, 16, 1.8), 'Важливо'),
          h('button', { type: 'button', class: 'flag' + (isFocus(t) ? ' on' : ''), 'aria-pressed': String(isFocus(t)),
            onclick: function () { toggleFocus(t); } }, svg(I.target, 16), 'Головне сьогодні'),
          h('button', { type: 'button', class: 'flag' + (t.goal ? ' on' : ''), 'aria-pressed': String(t.goal),
            title: 'Велика ціль з дорожньою картою: кроки — підзавдання', onclick: function () { setGoal(t); } }, svg(I.flag || I.target, 16), 'Ціль'),
          h('span', { class: 'd-quad' }, isFuture(t)
            ? 'Заплановано: з\'явиться в списку ' + dueLabel(t.due).toLowerCase()
            : 'Матриця: ' + QUADS[quadrant(t)].name.toLowerCase())),
        parent || t.done ? null : isStuck(t)
          ? h('div', { class: 'stuck-hint' },
              h('span', {}, stuckText(t) + '. Схоже, щось заважає.'),
              h('button', { type: 'button', class: 'btn', onclick: function () { openHelp(t); } }, svg(I.knot, 16), ' Що заважає?'))
          : h('button', { type: 'button', class: 'quiet-link', onclick: function () { openHelp(t); } }, svg(I.knot, 16), 'Не можу взятися?'),
        h('div', { class: 'field' }, h('label', { for: 'd-notes' }, 'Нотатки'), notes),
        photoField(t),
        h('div', { class: 'row2' },
          h('div', { class: 'field' }, h('label', { for: 'd-due' }, 'Дата'), due),
          h('div', { class: 'field' }, h('label', { for: 'd-rep' }, 'Повтор'), rep)),
        isHabit(t) ? h('div', { class: 'field' }, h('label', { for: 'd-after' }, 'Після чого? (якір звички)'), afterIn) : null,
        isHabit(t) ? h('div', { class: 'field' }, h('label', { for: 'd-easy' }, 'Мінімум, коли сил мало'), easyIn) : null,
        parent ? null : h('div', { class: 'row2' },
          h('div', { class: 'field' }, h('label', { for: 'd-start' }, 'Початок'), timeIn('d-start', t.start, function (v) { times(v, t.end); })),
          h('div', { class: 'field' }, h('label', { for: 'd-end' }, 'Кінець'), timeIn('d-end', t.end, function (v) { times(t.start, v); }))),
        parent ? null : h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Колір у календарі'),
          h('div', { class: 'swatches' }, COLORS.map(function (c) {
            return h('button', { type: 'button', class: 'swatch', style: '--c:' + c, 'aria-label': 'Колір', 'aria-pressed': String(calApi.colorOf(t) === c),
              onclick: function () { set('color', c); } });
          }))),
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
            h('button', { type: 'button', class: 'btn primary', onclick: close }, 'Зберегти')))));

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
    // телефон: кожне нове відкриття — одразу одна справа, без вибору, куди дивитися
    try {
      if (mobileMq.matches && !sessionStorage.getItem('spravy.opened')) { ui.view = 'now'; saveUi(); }
      sessionStorage.setItem('spravy.opened', '1');
    } catch (e) { /* без sessionStorage — як раніше */ }
    if (rollHabits()) commit(); else render();
    launchShortcut();
    checkPush();
    // жести на телефоні не видно — один раз підказуємо
    if (mobileMq.matches && !ui.tipGestures) {
      ui.tipGestures = true;
      saveUi();
      setTimeout(function () { toast('Свайп праворуч: виконано. Ліворуч: видалити. Довге натискання: перетягнути.', null, 9000); }, 1500);
    }
  }

  /** Ярлики іконки й посилання з нагадувань: ?voice=1 — диктувати, ?add=1 — нове завдання,
      ?plan=1 — план на день, ?evening=1 — закрити день, ?view=now — «Зараз». Один раз за відкриття. */
  function launchShortcut() {
    var m = /[?&](voice|add|plan|evening|view)=(\w+)/.exec(location.search);
    if (!m) return;
    history.replaceState(null, '', location.pathname + location.hash);
    if (m[1] === 'view') { if (m[2] === 'now') { ui.view = 'now'; saveUi(); render(); } return; }
    setTimeout({ voice: openVoice, add: openSheet, plan: function () { openPlan(); }, evening: openEvening }[m[1]], 50);
  }
  /* ============================================================
     Нагадування на телефон (Web Push). Сервер (функція nudge) сам
     вирішує, коли: о 9-й — з чого почати; за 10 хв до справи з часом;
     о 20-й — закрити день. Тут лише підписати цей пристрій.
     ============================================================ */
  var pushOn = null;   // null — ще не знаємо; true / false
  function canPush() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
  function b64u(s) {
    var b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
    return Uint8Array.from(b, function (c) { return c.charCodeAt(0); });
  }
  function pushSub() { return navigator.serviceWorker.ready.then(function (r) { return r.pushManager.getSubscription(); }); }
  function checkPush() {
    if (!canPush() || !signedIn()) return;
    pushSub().then(function (s) { pushOn = !!s && Notification.permission === 'granted'; renderPush(); }, function () {});
  }
  function enablePush() {
    Notification.requestPermission().then(function (perm) {
      if (perm !== 'granted') throw new Error('perm');
      return fetch(BASE + '/functions/v1/nudge?pub=1').then(function (r) { return r.json(); });
    }).then(function (j) {
      return navigator.serviceWorker.ready.then(function (r) {
        return r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(j.publicKey) });
      });
    }).then(function (sub) {
      var k = sub.toJSON();
      var tz = '';
      try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
      return rpc('push_subscribe', { p_endpoint: k.endpoint, p_p256dh: k.keys.p256dh, p_auth: k.keys.auth, p_tz: tz });
    }).then(function () {
      pushOn = true; renderPush();
      toast('Нагадування увімкнено: о 9-й — з чого почати, за 10 хв до справ із часом, о 20-й — закрити день.', null, 8000);
    }, function (e) {
      toast(e && e.message === 'perm' ? 'Браузер не дав дозволу на сповіщення. Дозвольте їх у налаштуваннях сайту.'
        : 'Не вдалося увімкнути нагадування' + (e && e.message ? ': ' + e.message : ''));
    });
  }
  function testPush() {
    api('/functions/v1/nudge?test=1', { method: 'POST', body: '{}' }).then(function (r) { return r.json(); }).then(function (j) {
      toast(j && j.sent ? 'Надіслано. За кілька секунд прийде сповіщення.' : 'Сервер не знайшов цей пристрій. Вимкніть і увімкніть ще раз.');
    }, function () { toast('Не вдалося надіслати пробне нагадування'); });
  }
  function disablePush() {
    pushSub().then(function (s) {
      if (!s) return null;
      return rpc('push_unsubscribe', { p_endpoint: s.endpoint }).catch(function () {}).then(function () { return s.unsubscribe(); });
    }).then(function () { pushOn = false; renderPush(); toast('Нагадування на цьому пристрої вимкнено'); });
  }
  function renderPush() {
    var box = $('pushBox');
    if (!box) return;
    if (!canPush() || pushOn === null) { box.replaceChildren(); return; }
    box.replaceChildren(h('div', {}, 'Нагадування'), pushOn
      ? h('div', { class: 'push-row' }, h('span', { class: 'push-on' }, 'Увімкнено'),
          h('button', { type: 'button', class: 'link-btn', onclick: testPush }, 'Перевірити'),
          h('button', { type: 'button', class: 'link-btn', onclick: disablePush }, 'Вимкнути'))
      : h('div', { class: 'push-row' },
          h('button', { type: 'button', class: 'btn', onclick: enablePush }, 'Увімкнути'),
          h('span', { class: 'push-hint' }, 'о 9-й, перед справами з часом, о 20-й')));
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
    var bDate = h('button', { type: 'button', class: 'schip', 'aria-haspopup': 'dialog',
      onpointerdown: function (e) { e.preventDefault(); },
      onclick: function () { window.SpravyDate.open(bDate, s.due, function (v) { s.due = v; paint(); }); } }, svg(I.clock, 16), dateText);
    // скільки часу займе — одним дотиком, поки справа свіжа в голові
    var estBtns = [5, 15, 30, 60].map(function (m) {
      return h('button', { type: 'button', class: 'schip', 'aria-pressed': 'false', onpointerdown: function (e) { e.preventDefault(); },
        onclick: function () { s.est = s.est === m ? 0 : m; paint(); } }, estLabel(m));
    });
    var bStar = chip(svg(I.star, 16, 1.8), 'Важливо', function () {
      if (s.starred) { s.starred = false; paint(); return; }
      askStar(input.value.trim() || 'нове завдання', null, function () { s.starred = true; paint(); });
    });
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
      bStar.setAttribute('aria-pressed', String(s.starred));
      estBtns.forEach(function (b, i) { b.setAttribute('aria-pressed', String(s.est === [5, 15, 30, 60][i])); });
      bFocus.setAttribute('aria-pressed', String(s.focus));
      bRep.setAttribute('aria-pressed', String(s.repeat !== 'none'));
      rep.value = s.repeat;
      lsel.value = s.listId;
      bList.style.setProperty('--c', (listOf(s.listId) || {}).color || COLORS[0]);
    }

    function save() {
      var title = input.value.trim();
      if (!title) { input.focus(); return; }
      addTask(s.listId, title, { due: s.due, starred: s.starred, repeat: s.repeat, focus: s.focus ? today() : '', est: s.est || 0 });
      s.est = 0;
      if (s.due > today()) toast('Заплановано на ' + dueLabel(s.due).toLowerCase() + ': з\'явиться в списку у свій день.');
      else if (ui.view === 'board' && s.listId !== (currentList() || {}).id) toast('Додано в «' + listOf(s.listId).name + '»');
      if (s.focus) { s.focus = false; paint(); }    // головне — поштучно, не все підряд
      input.value = '';
      input.focus();
    }

    box.replaceChildren(
      h('div', { class: 'sheet-scrim', onclick: function () { closeSheet(); } }),
      h('div', { class: 'add-sheet', role: 'dialog', 'aria-label': 'Нове завдання' },
        h('div', { class: 'sheet-row' }, input, micFor(input)),
        h('div', { class: 'sheet-chips' }, bToday, bTomorrow, bDate, bStar, bFocus, bRep, bList),
        h('div', { class: 'sheet-chips est-pick', role: 'group', 'aria-label': 'Скільки часу займе' }, svg(I.hourglass, 16), estBtns),
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

  var plan = null;   // { step: 'triage' | 'focus' | 'left', queue: [id], i, picked: {id: true}, all, day, evening }

  function openPlan(step) {
    var queue = sorted(tasks().filter(function (t) { return !t.done && !t.parentId && daysLate(t); }), 'date')
      .map(function (t) { return t.id; });
    var picked = {};
    focusToday().forEach(function (t) { if (!t.done) picked[t.id] = true; });
    plan = { step: step === 'focus' || !queue.length ? 'focus' : 'triage', queue: queue, i: 0, picked: picked, all: false, day: today(), evening: false };
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
    if (plan.evening) { renderEvening(box); return; }
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
    var day = plan.day, t0 = today(), y = addDays(day, -1), tomorrow = day > t0;
    function score(t) {
      if (plan.picked[t.id]) return 0;
      if (t.focus === y) return 1;                 // учора було головним, не встигли
      var q = quadrant(t);
      return q === 1 ? 2 : q === 2 ? 3 : q === 3 ? 4 : 5;
    }
    // на завтра — те, що буде видно завтра: без дати, на завтра чи раніше
    var cands = tasks().filter(tomorrow ? function (t) {
      return !t.done && !t.parentId && !isSomeday(t) && (!t.due || t.due <= day);
    } : isOpenNow).sort(function (a, b) {
      return score(a) - score(b) || (a.due || '9999').localeCompare(b.due || '9999') || a.order - b.order;
    });
    var shown = plan.all ? cands : cands.slice(0, 7);
    var n = Object.keys(plan.picked).length;
    var full = n >= FOCUS_MAX;
    var insight = blockerInsight();
    // скільки часу займе обране — щоб день не планувати на 14 годин
    var load = Object.keys(plan.picked).reduce(function (s, id) { var x = db.tasks[id]; return s + (x ? x.est : 0); }, 0);
    return h('div', { class: 'pick' },
      h('div', { class: 'modal-title' }, tomorrow ? 'Головне на завтра' : 'Головне на сьогодні'),
      h('div', { class: 'modal-sub' }, tomorrow ? 'Оберіть до трьох зараз, поки день свіжий у голові. Уранці рішення вже буде прийняте.'
        : 'Оберіть до трьох. Решту теж можна робити, але ці три зроблять день вдалим.'),
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
      // при СДУГ час «на око» майже завжди вдвічі коротший за справжній: рахуємо з запасом ×2
      load ? h('div', { class: 'load' + (load * 2 > 360 ? ' over' : '') }, 'За оцінкою ' + estLabel(load) + ', з запасом ×2 — ' + estLabel(load * 2) + '. ' + (load * 2 > 360
        ? 'Це більше, ніж реально вміщає день. Залиште одну-дві: решта не зникне.'
        : 'Плануйте саме стільки: оцінки майже завжди оптимістичні.')) : null,
      h('div', { class: 'modal-foot' },
        h('span', { class: 'pick-count' }, n + ' з ' + FOCUS_MAX),
        h('button', { type: 'button', class: 'btn primary', onclick: applyFocus }, n ? 'Готово' : tomorrow ? 'Готово, без головного' : 'Сьогодні без головного')));
  }

  function applyFocus() {
    var t0 = plan.day, n = 0, evening = plan.evening, first = null;
    tasks().forEach(function (t) {
      if (t.parentId || t.done) return;
      if (plan.picked[t.id]) { t.focus = t0; n++; first = first || t; }
      else if (t.focus === t0) t.focus = '';
    });
    if (evening) {
      ui.closedDay = today(); saveUi();
      commit(); closePlan();
      toast(n ? 'День закрито. Завтра почнете з «' + first.title + '».' : 'День закрито. Відпочивайте.');
      return;
    }
    if (!n) { ui.planSkip = t0; saveUi(); }
    commit();
    closePlan();
    toast(n ? 'План готовий: ' + n + ' ' + (n === 1 ? 'головна справа' : 'головні справи') + ' на сьогодні.' : 'Добре, сьогодні без головного.');
  }

  /* ---------- «Закрити день»: дві хвилини ввечері ----------
     1) що лишилось на сьогодні — завтра, без дати чи вже зроблено (звички не питаємо: вони самі);
     2) до трьох головних на завтра. Уранці не треба вирішувати, з чого почати. */
  function leftToday() {
    var t0 = today();
    return sorted(tasks().filter(function (t) {
      return !t.done && !t.parentId && t.repeat === 'none' && ((t.due && t.due <= t0) || isFocus(t));
    }), 'date');
  }
  function openEvening() {
    var t1 = addDays(today(), 1), picked = {};
    tasks().forEach(function (t) { if (!t.done && t.focus === t1) picked[t.id] = true; });
    plan = { evening: true, step: 'left', queue: [], i: 0, picked: picked, all: false, day: t1 };
    closeNav();
    pushOverlay('plan');
    renderPlan();
  }
  /** Увечері (після 18:00), якщо день ще не закрито й є що закривати. */
  function eveningInvite() {
    if (!ready || new Date().getHours() < 18 || ui.closedDay === today()) return null;
    var n = leftToday().length;
    return h('div', { class: 'plan-card' },
      h('span', { class: 'plan-ico' }, svg(I.moon || I.target, 20)),
      h('div', { class: 'plan-text' }, h('b', {}, 'Закрити день'),
        h('span', {}, (n ? 'Вирішити, що робити з ' + n + ' ' + plural(n) + ' на сьогодні, й о' : 'О') + 'брати головне на завтра. Дві хвилини.')),
      h('button', { type: 'button', class: 'btn primary', onclick: openEvening }, 'Закрити'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Не сьогодні', title: 'Не сьогодні',
        onclick: function () { ui.closedDay = today(); saveUi(); render(); } }, svg(I.close, 18)));
  }
  function renderEvening(box) {
    var t1 = addDays(today(), 1);
    var body;
    if (plan.step === 'left') {
      var left = leftToday();
      body = h('div', { class: 'evening' },
        h('div', { class: 'modal-title' }, 'Що лишилось на сьогодні'),
        h('div', { class: 'modal-sub' }, left.length ? 'Без докорів: день був таким, яким був. Просто вирішіть, куди кожну.'
          : 'Нічого не висить. Добрий день.'),
        left.length ? h('div', { class: 'ev-list' }, left.map(function (t) {
          function act(fn) { return function () { fn(); commit(); renderPlan(); }; }
          return h('div', { class: 'ev-row' },
            h('div', { class: 'ev-title' }, t.title || 'Без назви'),
            h('div', { class: 'ev-acts' },
              h('button', { type: 'button', class: 'btn', onclick: act(function () { setDue(t, t1); t.focus = ''; }) }, 'Завтра'),
              h('button', { type: 'button', class: 'btn', onclick: act(function () { t.due = ''; t.focus = ''; }) }, 'Без дати'),
              h('button', { type: 'button', class: 'btn', onclick: act(function () { toggleDone(t); }) }, 'Зроблено')));
        })) : null,
        h('div', { class: 'modal-foot' },
          left.length > 1 ? h('button', { type: 'button', class: 'link-btn', onclick: function () {
            left.forEach(function (t) { setDue(t, t1); t.focus = ''; }); commit(); renderPlan();
          } }, 'Усе на завтра') : h('span'),
          h('button', { type: 'button', class: 'btn primary', onclick: function () { plan.step = 'focus'; renderPlan(); } }, 'Далі')));
    } else body = focusStep();
    box.replaceChildren(
      h('div', { class: 'modal-scrim', onclick: function () { closePlan(); } }),
      h('div', { class: 'modal plan', role: 'dialog', 'aria-label': 'Закрити день' },
        h('div', { class: 'modal-head' },
          h('div', { class: 'steps' },
            plan.step === 'left' ? h('span', { class: 'on' }, '1. Що лишилось')
              : h('button', { type: 'button', onclick: function () { plan.step = 'left'; renderPlan(); } }, '1. Що лишилось'),
            h('span', { class: plan.step === 'focus' ? 'on' : '' }, '2. Головне на завтра')),
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Закрити', onclick: function () { closePlan(); } }, svg(I.close, 20))),
        body));
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

  /** Дихання 4-7-8 (три кола): швидко збиває «забагато всього», перш ніж обирати справу. */
  function breath() {
    var box = h('div', { class: 'breath' });
    var PH = [['Вдих носом', 4], ['Затримайте дихання', 7], ['Повільний видих ротом', 8]];
    function start() {
      var round = 0, ph = 0;
      (function step() {
        if (!box.isConnected) return;   // вікно закрили — зупиняємось
        if (ph === PH.length) { ph = 0; round++; }
        if (round === 3) { box.replaceChildren(h('span', {}, 'Готово. Тепер — одна справа на 5 хвилин.')); return; }
        var p = PH[ph];
        box.replaceChildren(h('b', {}, p[0]), h('span', {}, ' · ' + p[1] + ' с · коло ' + (round + 1) + ' з 3'),
          h('i', { class: 'breath-bar', style: 'animation-duration:' + p[1] + 's' }));
        ph++;
        setTimeout(step, p[1] * 1000);
      })();
    }
    box.append(h('button', { type: 'button', class: 'btn', onclick: start }, 'Спершу дихання 4-7-8 (хвилина)'));
    return box;
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
        breath(),
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

  /* ============================================================
     Голос і переклад (саму роботу з мовами робить lingo.js)
     ============================================================ */

  /* Календар (calendar.js) читає й пише ті самі завдання лише через цей api */
  var calApi = {
    h: h, ui: function () { return ui; }, saveUi: saveUi, today: today,
    mobile: function () { return mobileMq.matches; },
    colors: COLORS,
    tasks: function () { return tasks().filter(function (t) { return !t.parentId && t.due; }); },
    task: function (id) { return db.tasks[id]; },
    colorOf: function (t) { return t.color || (listOf(t.listId) || {}).color || COLORS[0]; },
    defaultColor: function () { var l = lists().filter(function (x) { return x.visible; })[0] || lists()[0]; return (l && l.color) || COLORS[0]; },
    open: function (id) { openDrawer(id); },
    save: function () { commit(); },
    create: function (f) {
      var l = lists().filter(function (x) { return x.visible; })[0] || lists()[0];
      if (!l) { toast('Спершу створіть список у меню ліворуч'); return; }
      addTask(l.id, f.title, { due: f.due, start: f.start, end: f.end, color: f.color, starred: false });
    },
    pushOverlay: pushOverlay, popOverlay: popOverlay
  };

  var VOICE = ['uk', 'en', 'es'];

  /** Мікрофон і перемикач мови біля поля. Розпізнане йде в поле, щоб його можна було виправити. */
  /** onFinal — якщо передано, викликається з остаточно розпізнаним текстом (напр. одразу додати крок). */
  function micFor(input, onFinal) {
    var L = window.SpravyLingo;
    if (!L || !L.canListen) return null;     // браузер не вміє — кнопки немає
    var lang = VOICE.indexOf(ui.voiceLang) >= 0 ? ui.voiceLang : 'uk';
    function keep(e) { e.preventDefault(); } // фокус лишається в полі: клавіатура не ховається, поле не закривається
    var langBtn = h('button', { type: 'button', class: 'mic-lang', title: 'Мова диктування: UA / EN / ES', onpointerdown: keep, onmousedown: keep,
      onclick: function () { lang = VOICE[(VOICE.indexOf(lang) + 1) % VOICE.length]; ui.voiceLang = lang; saveUi(); langBtn.textContent = L.NAMES[lang]; } },
      L.NAMES[lang]);
    var base = '';
    var mic = h('button', { type: 'button', class: 'mic', 'aria-label': 'Надиктувати', title: 'Надиктувати', onpointerdown: keep, onmousedown: keep,
      onclick: function () {
        base = input.value.trim();
        L.listen(lang, function (text, final) {
          input.value = (base ? base + ' ' : '') + text;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          if (final && onFinal) onFinal();
        }, function (on, err) {
          mic.classList.toggle('rec', on);
          mic.setAttribute('aria-pressed', String(on));
          if (err === 'not-allowed' || err === 'service-not-allowed') toast('Немає дозволу на мікрофон: дозвольте його в налаштуваннях сайту.');
          else if (err && err !== 'aborted' && err !== 'no-speech') toast('Не вдалося розпізнати мовлення. Спробуйте ще раз.');
          if (!on && input.isConnected) input.focus();
        });
      } }, svg(I.mic, 18));
    return h('span', { class: 'voice' }, mic, langBtn);
  }

  /* ============================================================
     Голос на телефоні: один дотик — і справа в списку.
     Кнопка мікрофона поруч із «+»; ярлик іконки «Надиктувати справу»
     (?voice=1) відкриває те саме. «Завтра», «сьогодні» з фрази стають
     датою. Після додавання — «Ще одну», «Скасувати», «Готово».
     ============================================================ */
  var vcap = null;   // { box, listId, run, last }

  function openVoice() {
    var L = window.SpravyLingo;
    if (!L || !L.canListen) { toast('Цей браузер не вміє розпізнавати мовлення. Спробуйте Chrome або Safari.'); return; }
    if (vcap) return;
    var l = ui.view === 'board' ? currentList() : (lists().filter(function (x) { return x.visible; })[0] || lists()[0]);
    if (!l) { toast('Спершу створіть список у меню'); return; }
    var box = h('div', { class: 'vcap', role: 'dialog', 'aria-label': 'Надиктувати справу' });
    vcap = { box: box, listId: l.id, run: 0, last: null };
    box.addEventListener('click', function (e) { if (e.target === box) closeVoice(); });   // дотик повз картку
    document.body.append(vcap.box);
    pushOverlay('voice');
    listenVoice();
  }

  function closeVoice(fromBack) {
    if (!vcap) return;
    vcap.run++;                                   // запізнілі відповіді розпізнавання вже нічого не додають
    window.SpravyLingo.stopListening();
    vcap.box.remove();
    vcap = null;
    if (!fromBack) popOverlay('voice');
  }

  function voiceLang() { return VOICE.indexOf(ui.voiceLang) >= 0 ? ui.voiceLang : 'uk'; }

  /** Куди йде надиктоване: у список чи кроком у ціль (якщо ціль є). Вибір запам'ятовується. */
  function voiceGoal() { var g = goalTask(); return ui.voiceTarget === 'goal' && g && !isHabit(g) ? g : null; }
  function voiceTargetBtn(state, text, list) {
    var g = goalTask(), toGoal = voiceGoal();
    if (!g || isHabit(g)) return h('span', { class: 'vcap-list', style: '--c:' + (list ? list.color : '') }, list ? list.name : '');
    return h('button', { type: 'button', class: 'vcap-list vcap-target' + (toGoal ? ' goal' : ''), style: '--c:' + (list ? list.color : ''),
      title: 'Куди додавати: у список чи кроком цілі', onclick: function () {
        ui.voiceTarget = toGoal ? '' : 'goal'; saveUi(); paintVoice(state, text);
      } }, toGoal ? 'Крок цілі «' + g.title + '»' : (list ? list.name : ''), svg(I.chev, 14));
  }

  function paintVoice(state, text) {
    var L = window.SpravyLingo, v = vcap;
    var list = listOf(v.listId);
    var lang = h('button', { type: 'button', class: 'mic-lang', title: 'Мова диктування', onclick: function () {
      ui.voiceLang = VOICE[(VOICE.indexOf(voiceLang()) + 1) % VOICE.length]; saveUi();
      if (state === 'listen') { v.run++; L.stopListening(); listenVoice(); } else paintVoice(state, text);
    } }, L.NAMES[voiceLang()]);
    var big = h('button', { type: 'button', class: 'vcap-mic' + (state === 'listen' ? ' rec' : ''), 'aria-label': state === 'listen' ? 'Зупинити' : 'Говорити',
      onclick: function () { if (state === 'listen') L.stopListening(); else listenVoice(); } }, svg(I.mic, 34));
    var body;
    if (state === 'listen') body = [h('div', { class: 'vcap-say' }, text || 'Слухаю…'), h('div', { class: 'vcap-hint' }, 'Скажіть справу. «Завтра» чи «сьогодні» стане датою.')];
    else if (state === 'added') body = [h('div', { class: 'vcap-ok' }, v.last.parentId ? '✓ Додано кроком цілі' : '✓ Додано'), h('div', { class: 'vcap-say' }, v.last.title),
      v.last.due ? h('div', { class: 'vcap-hint' }, dueLabel(v.last.due)) : null];
    else body = [h('div', { class: 'vcap-say' }, 'Нічого не почув'), h('div', { class: 'vcap-hint' }, text || 'Натисніть «Спробувати ще» і скажіть ще раз.')];
    function closeBtn(label) { return h('button', { type: 'button', class: 'btn', onclick: function () { closeVoice(); } }, label); }
    var buttons = state === 'listen' ? [closeBtn('Закрити')]
      : state === 'added' ? [h('button', { type: 'button', class: 'btn', onclick: undoVoice }, 'Скасувати'), closeBtn('Готово'),
          h('button', { type: 'button', class: 'btn primary', onclick: listenVoice }, 'Ще одну')]
      : [closeBtn('Закрити'), h('button', { type: 'button', class: 'btn primary', onclick: listenVoice }, 'Спробувати ще')];
    v.box.replaceChildren(h('div', { class: 'vcap-card' },
      h('div', { class: 'vcap-top' }, voiceTargetBtn(state, text, list), lang),
      big, body, h('div', { class: 'vcap-btns' }, buttons)));
  }

  function listenVoice() {
    var L = window.SpravyLingo, v = vcap;
    if (!v) return;
    var run = ++v.run, heard = '';
    paintVoice('listen', '');
    L.listen(voiceLang(), function (text) {
      if (vcap !== v || v.run !== run) return;
      heard = text;
      var say = v.box.querySelector('.vcap-say');
      if (say) say.textContent = text;
    }, function (on, err) {
      if (on || vcap !== v || v.run !== run) return;
      if (err === 'not-allowed' || err === 'service-not-allowed') return paintVoice('quiet', 'Немає дозволу на мікрофон: дозвольте його в налаштуваннях сайту.');
      var x = L.spokenTask(heard, today());
      if (!x.title) return paintVoice('quiet', err && err !== 'no-speech' && err !== 'aborted' ? 'Не вдалося розпізнати. Спробуйте ще раз.' : '');
      v.run++;                                    // onend після onerror не має додати вдруге
      var g = voiceGoal();
      if (g) {
        var max = 0;
        childrenOf(g.id).forEach(function (c) { if (c.order > max) max = c.order; });
        v.last = addTask(g.listId, x.title, { parentId: g.id, order: max + 1, starred: false, due: x.due || '' });
      } else v.last = addTask(v.listId, x.title, x.due ? { due: x.due } : {});
      if (navigator.vibrate) navigator.vibrate(30);
      paintVoice('added');
    });
  }

  function undoVoice() {
    var t = vcap && vcap.last;
    if (t && db.tasks[t.id]) { delete db.tasks[t.id]; commit(); }
    vcap.last = null;
    listenVoice();
  }

  (function () {
    var fabMic = $('fabMic');
    if (window.SpravyLingo && window.SpravyLingo.canListen) fabMic.hidden = false;
    fabMic.addEventListener('click', openVoice);
  })();

  /** Картка: перекласти назву й нотатки іншою мовою й замінити ними текст (зі «Скасувати»). */
  function translateBox(t) {
    var L = window.SpravyLingo;
    if (!L) return null;
    var box = h('div', { class: 'tr-card' });
    function start() {
      box.replaceChildren(h('button', { type: 'button', class: 'quiet-link translate-open', onclick: pick }, svg(I.lang, 16, 1.7), 'Перекласти'));
    }
    function pick() {
      box.replaceChildren(h('div', { class: 'tr-pick' }, h('span', {}, 'Перекласти на'),
        L.plan(t.title).map(function (p) { return h('button', { type: 'button', onclick: function () { show(p.to); } }, L.NAMES[p.to]); }),
        h('button', { type: 'button', class: 'link-btn', onclick: start }, 'Скасувати')));
    }
    function show(lang) {
      box.replaceChildren(h('div', { class: 'tr-preview muted' }, 'Перекладаю…'));
      Promise.all([L.translateTo(t.title, lang), L.translateTo(t.notes, lang)]).then(function (r) {
        if (!box.isConnected) return;
        box.replaceChildren(h('div', { class: 'tr-preview' },
          h('b', {}, L.NAMES[lang]),
          h('div', { class: 'tr-text' }, r[0]),
          r[1] ? h('div', { class: 'tr-notes' }, r[1]) : null,
          h('div', { class: 'help-row' },
            h('button', { type: 'button', class: 'btn primary', onclick: function () { useTranslation(t, lang, r[0], r[1]); } }, 'Замінити'),
            h('button', { type: 'button', class: 'btn', onclick: pick }, 'Інша мова'))));
      }, function (e) {
        if (box.isConnected) box.replaceChildren(h('div', { class: 'tr-preview tip-err' }, 'Не вдалося перекласти: ' + e.message + '.'),
          h('button', { type: 'button', class: 'link-btn', onclick: pick }, 'Спробувати ще'));
      });
    }
    start();
    return box;
  }

  /** «Виправити помилки»: показати виправлений текст і замінити лише за згодою. */
  function fixBox(t) {
    var L = window.SpravyLingo;
    if (!L || !L.proofread) return null;
    var box = h('div', { class: 'tr-card fix-card' });
    // кнопка лишається на місці: текст можуть змінити й перевірити знову
    function start(note) {
      box.replaceChildren(h('button', { type: 'button', class: 'quiet-link', onclick: check }, svg(I.spell, 16, 1.7), 'Виправити помилки'),
        note ? h('span', { class: 'fix-note' }, note) : null);
    }
    function marked(r) {
      return r.parts.map(function (p) { return p.fixed ? h('mark', {}, p.text) : p.text; });
    }
    function check() {
      var title = t.title, notes = t.notes;
      box.replaceChildren(h('div', { class: 'tr-preview muted' }, 'Перевіряю…'));
      Promise.all([L.proofread(title), L.proofread(notes)]).then(function (r) {
        if (!box.isConnected) return;
        if (!r[0].count && !r[1].count) {
          start('Помилок не знайдено');
          return;
        }
        box.replaceChildren(h('div', { class: 'tr-preview fix-preview' },
          h('b', {}, 'Виправлень: ' + (r[0].count + r[1].count)),
          h('div', { class: 'tr-text' }, marked(r[0])),
          r[1].text ? h('div', { class: 'tr-notes' }, marked(r[1])) : null,
          h('div', { class: 'help-row' },
            h('button', { type: 'button', class: 'btn primary', onclick: function () {
              // текст могли змінити, поки йшла перевірка: правимо лише те, що перевіряли
              if (t.title === title) t.title = r[0].text;
              if (t.notes === notes) t.notes = r[1].text;
              commit();
              toast('Виправлено');
            } }, 'Виправити'),
            h('button', { type: 'button', class: 'btn', onclick: function () { start(); } }, 'Скасувати'))));
      }, function (e) {
        if (box.isConnected) start('Не вдалося перевірити: ' + e.message);
      });
    }
    start();
    return box;
  }

  /* Підказка з перекладом. На комп'ютері — після короткої затримки наведення
     на назву (не на кожен рух мишки), на телефоні — тапом по значку. */
  var TIP_DELAY = 600;
  var TIP_GRACE = 300;     // стільки мишка має, щоб перейти з назви на підказку
  var tip = { id: null, mode: '', timer: null, hide: null };

  function tipHover(t, anchor) {
    if (hoverMq.matches || !t.title) return;
    clearTimeout(tip.timer); clearTimeout(tip.hide);
    tip.timer = setTimeout(function () { showTip(t, anchor, 'hover'); }, TIP_DELAY);
  }
  function tipLeave() {
    clearTimeout(tip.timer);
    if (tip.mode === 'hover') tip.hide = setTimeout(hideTip, TIP_GRACE);
  }
  $('tip').addEventListener('mouseenter', function () { clearTimeout(tip.hide); });
  $('tip').addEventListener('mouseleave', function () { if (tip.mode === 'hover') hideTip(); });

  /** Замінити текст завдання перекладом: назву одразу, нотатки — разом із нею або щойно перекладуться.
      Одне місце для підказки й картки; «Скасувати» повертає обидва. */
  function useTranslation(t, lang, title, notes) {
    var L = window.SpravyLingo, was = [t.title, t.notes];
    t.title = title;
    if (notes !== undefined && t.notes) t.notes = notes || t.notes;
    commit();
    toast('Перекладено: ' + L.NAMES[lang], function () { t.title = was[0]; t.notes = was[1]; commit(); });
    if (notes === undefined && t.notes) L.translateTo(was[1], lang).then(function (n) {
      if (t.title === title && t.notes === was[1] && n) { t.notes = n; commit(); }
    }, function () { /* нотатки лишаються як були */ });
  }
  function tipToggle(t, anchor) {
    if (tip.id === t.id && tip.mode === 'click') hideTip(); else showTip(t, anchor, 'click');
  }
  function hideTip() {
    clearTimeout(tip.timer); clearTimeout(tip.hide);
    tip.id = null; tip.mode = '';
    $('tip').hidden = true;
  }
  function showTip(t, anchor, mode) {
    var L = window.SpravyLingo;
    if (!L || !anchor.isConnected) return;
    var box = $('tip'), id = t.id;
    tip.id = id; tip.mode = mode;
    function paint(items) {
      if (tip.id !== id) return;             // поки чекали, мишка вже на іншому
      // кожен переклад — кнопка: клік замінює текст завдання цією мовою
      box.replaceChildren.apply(box, items ? items.map(function (x) {
        if (x.error) return h('div', { class: 'tip-row', 'data-lang': x.lang }, h('b', {}, L.NAMES[x.lang]),
          h('span', { class: 'tip-err' }, 'Не вдалося перекласти: ' + x.error + '.'));
        return h('button', { type: 'button', class: 'tip-row pick', 'data-lang': x.lang, title: 'Замінити текст завдання цим перекладом',
          onclick: function () { var task = db.tasks[id]; hideTip(); if (task) useTranslation(task, x.lang, x.text); } },
          h('b', {}, L.NAMES[x.lang]), h('span', {}, x.text));
      }) : [h('div', { class: 'tip-row muted' }, 'Перекладаю…')]);
      box.hidden = false;
      var r = anchor.getBoundingClientRect(), w = box.offsetWidth, hgt = box.offsetHeight;
      var top = r.bottom + 6 + hgt > innerHeight ? r.top - 6 - hgt : r.bottom + 6;
      box.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left)) + 'px';
      box.style.top = Math.max(8, top) + 'px';
    }
    var ready = L.cached(t.title);
    if (ready) { paint(ready); return; }
    paint(null);
    L.translations(t.title).then(paint);
  }
  document.addEventListener('pointerdown', function (e) {
    if (tip.id && !e.target.closest('#tip, .tr-btn')) hideTip();
  }, true);
  document.addEventListener('scroll', function () { if (tip.id) hideTip(); }, true);

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
    if (e.key === 'Escape' && !$('tip').hidden) { hideTip(); return; }
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
  /* ---------- переїзд на інший сервер і новий пароль ----------
     «Справи» мають власний проєкт Supabase. Пристрій, що працював зі старим
     сервером, лишає собі справи й чергу, але ключі входу старого сервера тут
     не дійсні: просимо увійти ще раз і перечитуємо все з нуля. */
  var BASE_KEY = 'spravy.base';
  function serverMoved() {
    if (lsGet(BASE_KEY) === BASE) return false;
    lsSet(BASE_KEY, BASE);
    since = null; lsDel(SINCE_KEY);
    if (!signedIn()) return false;
    setSess(null);
    return true;
  }

  function recover() {
    var email = $('lgEmail').value.trim();
    if (!email) { showLogin('Впишіть пошту, і ми надішлемо лист, щоб задати новий пароль.'); return; }
    fetch(BASE + '/auth/v1/recover?redirect_to=' + encodeURIComponent(location.origin + location.pathname), {
      method: 'POST', headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email })
    }).then(function (res) {
      showLogin(res.ok ? 'Лист надіслано на ' + email + '. Відкрийте посилання з нього, і задасте новий пароль.'
        : res.status === 429 ? 'Листів забагато за короткий час. Спробуйте за годину.' : 'Не вдалося надіслати лист. Спробуйте трохи згодом.');
    }, function () { showLogin('Немає зв\'язку з сервером. Перевірте інтернет'); });
  }
  $('lgForgot').addEventListener('click', recover);

  /** Посилання з листа: #access_token=…&type=recovery — форма нового пароля. */
  function takeRecovery() {
    var p = new URLSearchParams(location.hash.replace(/^#/, ''));
    if (p.get('type') !== 'recovery' || !p.get('access_token')) return false;
    var at = p.get('access_token'), rt = p.get('refresh_token') || '';
    history.replaceState(null, '', location.pathname + location.search);
    var input = h('input', { id: 'newPass', type: 'password', autocomplete: 'new-password', minlength: '6', required: true });
    var err = h('p', { class: 'login-err', role: 'alert', hidden: true });
    var btn = h('button', { class: 'btn primary', type: 'submit' }, 'Зберегти пароль');
    var form = h('form', { class: 'login-card', novalidate: true },
      h('h1', { class: 'login-title' }, 'Новий пароль'),
      h('p', { class: 'login-hint' }, 'Придумайте новий пароль для «Справ» (від 6 символів).'),
      h('div', { class: 'field' }, h('label', { for: 'newPass' }, 'Пароль'), input), err, btn);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (input.value.length < 6) { err.hidden = false; err.textContent = 'Щонайменше 6 символів'; return; }
      btn.disabled = true;
      fetch(BASE + '/auth/v1/user', { method: 'PUT', headers: { apikey: cfg.anonKey, Authorization: 'Bearer ' + at, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: input.value }) }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (j) {
          if (!res.ok) throw new Error(j.msg || j.message || 'Посилання застаріло. Надішліть лист ще раз.');
          setSess({ access_token: at, refresh_token: rt, email: j.email || lsGet(OWNER_KEY) || '', uid: j.id || '' });
          $('loginForm').hidden = false; form.remove();
          claimLocal(); showApp(); sync();
          toast('Пароль змінено.');
        });
      }).catch(function (e2) { err.hidden = false; err.textContent = e2.message; btn.disabled = false; });
    });
    $('app').hidden = true;
    $('login').hidden = false;
    $('loginForm').hidden = true;
    $('login').append(form);
    setTimeout(function () { input.focus(); });
    return true;
  }

  loadLocal();
  var moved = serverMoved();
  checkUpdate();     // запам'ятати, яка версія коду зараз на сайті
  takeImportFromUrl().then(function () {
    if (!BASE) { setSync('error', 'Не налаштовано адресу бази'); }
    if (takeRecovery()) return;
    if (!signedIn()) { showLogin(moved ? 'Справи переїхали на власний сервер. Увійдіть ще раз тим самим паролем: нічого не загубилось.' : ''); return; }
    claimLocal();
    showApp();
    sync();
  });
})();
