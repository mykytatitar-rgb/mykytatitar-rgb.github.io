/* Портфель: логіка сторінки.

   Дані лежать у гілці invest-data цього репозиторію (data.enc.json), зашифровані
   паролем: AES-GCM, ключ з пароля через PBKDF2-SHA256. Розшифрування відбувається
   лише тут, у браузері; ключ (не пароль) можна запам'ятати на пристрої.
   Щоденне оновлення робить invest/tools/update_data.py у GitHub Actions. */
(function () {
  'use strict';

  /* ---------- Налаштування ---------- */
  var DATA_URL = 'https://raw.githubusercontent.com/mykytatitar-rgb/mykytatitar-rgb.github.io/invest-data/data.enc.json';
  var README_URL = 'https://github.com/mykytatitar-rgb/mykytatitar-rgb.github.io/blob/main/invest/README.md';
  var ACTIONS_URL = 'https://github.com/mykytatitar-rgb/mykytatitar-rgb.github.io/actions';
  var LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  var SRC = (LOCAL && new URLSearchParams(location.search).get('src')) || DATA_URL;
  var K = {
    key: 'portfel.key', theme: 'portfel.theme', privacy: 'portfel.privacy', period: 'portfel.period', gperiod: 'portfel.growthPeriod',
    drawn: 'portfel.drawn', ios: 'portfel.iosHintClosed', snap: 'portfel.snapshotHintClosed'
  };

  // Частки компаній в S&P 500 (Slickcharts, 27.10.2026). GOOGL і GOOG разом: це одна компанія.
  var SP500 = {
    NVDA: 0.075, AAPL: 0.0714, MSFT: 0.0561, AMZN: 0.0385, GOOGL: 0.0553, GOOG: 0.0553, AVGO: 0.023,
    META: 0.023, TSLA: 0.0224, 'BRK.B': 0.0167, LLY: 0.0163, MU: 0.0149, WMT: 0.0136, JPM: 0.0127,
    AMD: 0.0126, V: 0.0108, XOM: 0.0108, JNJ: 0.0092, MA: 0.0076, ABBV: 0.0072, INTC: 0.0069,
    PLTR: 0.0068, CVX: 0.0065, COST: 0.0063, CSCO: 0.0062, KO: 0.0057, ORCL: 0.0055, PG: 0.0053,
    UNH: 0.0053, BAC: 0.005
  };
  // Фонди, що повторюють S&P 500: через них ти теж володієш Apple, Tesla тощо.
  var TRACKERS = { VOO: 1, VUAA: 1, VUSA: 1, CSPX: 1, SXR8: 1, IVV: 1, SPY: 1, SPLG: 1, SPYM: 1, IUSA: 1, SPYL: 1, SPX5: 1, I500: 1 };
  var NAMES = {
    AAPL: 'Apple', TSLA: 'Tesla', MSFT: 'Microsoft', NVDA: 'Nvidia', AMZN: 'Amazon', GOOGL: 'Alphabet',
    GOOG: 'Alphabet', META: 'Meta', AVGO: 'Broadcom', 'BRK.B': 'Berkshire Hathaway', LLY: 'Eli Lilly',
    KO: 'Coca-Cola', ORCL: 'Oracle', AMD: 'AMD', JPM: 'JPMorgan', V: 'Visa', MA: 'Mastercard',
    WMT: 'Walmart', XOM: 'ExxonMobil', JNJ: 'Johnson & Johnson', NFLX: 'Netflix', PLTR: 'Palantir',
    HIMS: 'Hims & Hers', ZIM: 'ZIM', INTC: 'Intel', COST: 'Costco', PG: 'Procter & Gamble',
    UNH: 'UnitedHealth', BAC: 'Bank of America', CVX: 'Chevron', CSCO: 'Cisco', MU: 'Micron',
    ABBV: 'AbbVie', LMT: 'Lockheed Martin', RTX: 'RTX', NOC: 'Northrop Grumman', GD: 'General Dynamics'
  };
  var ABOUT = {
    VOO: 'Фонд: 500 найбільших компаній США',
    VUAA: 'Той самий S&P 500, ірландський фонд',
    VUSA: 'S&P 500, ірландський фонд з виплатами',
    CSPX: 'S&P 500, ірландський фонд', SXR8: 'S&P 500, ірландський фонд',
    IVV: 'Фонд на S&P 500', SPY: 'Фонд на S&P 500', SPLG: 'Фонд на S&P 500',
    SGOV: 'Фонд коротких облігацій США', IB01: 'Фонд облігацій США до року'
  };

  /* ---------- Дрібні помічники ---------- */
  var root = document.documentElement;
  var $ = function (id) { return document.getElementById(id); };
  var NS = 'http://www.w3.org/2000/svg';
  var MINUS = '−';
  var MON_GEN = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
  var MON_SHORT = ['січ', 'лют', 'бер', 'кві', 'тра', 'чер', 'лип', 'сер', 'вер', 'жов', 'лис', 'гру'];
  var MON_NOM = ['Січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень', 'Липень', 'Серпень', 'Вересень', 'Жовтень', 'Листопад', 'Грудень'];
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function ok(x) { return typeof x === 'number' && isFinite(x); }
  function sum(xs, f) { var s = 0; for (var i = 0; i < xs.length; i++) { var v = f(xs[i]); if (ok(v)) s += v; } return s; }

  var store = {
    get: function (k, session) { try { return (session ? sessionStorage : localStorage).getItem(k); } catch (e) { return null; } },
    set: function (k, v, session) { try { (session ? sessionStorage : localStorage).setItem(k, v); } catch (e) { /* без збереження */ } },
    del: function (k) { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch (e) { /* нічого */ } }
  };

  var nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var nf1 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  var nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  var uah0 = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 });

  function usd(x) {
    if (!ok(x)) return 'н/д';
    var s = '$' + nf2.format(Math.abs(x));
    return x <= -0.005 ? MINUS + s : s;
  }
  function usdS(x) {
    if (!ok(x)) return 'н/д';
    if (Math.abs(x) < 0.005) return '$0.00';
    return (x > 0 ? '+' : MINUS) + '$' + nf2.format(Math.abs(x));
  }
  function pct(x, digits) {
    if (!ok(x)) return 'н/д';
    var v = Math.abs(x * 100);
    var s = digits === 0 ? nf0.format(v) : nf1.format(v);
    return (x * 100 <= -0.05 ? MINUS : '') + s + '%';
  }
  function pctS(x) {
    if (!ok(x)) return 'н/д';
    if (Math.abs(x) < 0.0005) return '0.0%';
    return (x > 0 ? '+' : MINUS) + nf1.format(Math.abs(x * 100)) + '%';
  }
  function times(x) { return x >= 10 ? nf0.format(x) : nf1.format(x).replace(/\.0$/, ''); }
  function qty(x) {
    if (!ok(x)) return 'н/д';
    var s = Math.abs(x) >= 100 ? nf2.format(x) : x.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    return s;
  }
  function price(x, cur) {
    if (!ok(x)) return 'н/д';
    var digits = x < 10 ? 4 : 2;
    var s = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: digits }).format(x);
    return cur && cur !== 'USD' ? s + ' ' + cur : '$' + s;
  }
  function plural(n, forms) {
    var a = Math.abs(n);
    if (a % 1 !== 0) return forms[1];
    var m10 = a % 10, m100 = a % 100;
    if (m10 === 1 && m100 !== 11) return forms[0];
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return forms[1];
    return forms[2];
  }
  function d(iso) { return new Date(iso + 'T00:00:00Z'); }
  function iso(dt) { return dt.toISOString().slice(0, 10); }
  function dayLong(s) { var t = d(s); return t.getUTCDate() + ' ' + MON_GEN[t.getUTCMonth()]; }
  function dayLongY(s) { var t = d(s); return dayLong(s) + ' ' + t.getUTCFullYear(); }
  function dayShort(s) { var t = d(s); return t.getUTCDate() + ' ' + MON_SHORT[t.getUTCMonth()]; }
  function addMonths(s, m) {
    var t = d(s); var day = t.getUTCDate();
    t.setUTCDate(1); t.setUTCMonth(t.getUTCMonth() + m);
    var last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    t.setUTCDate(Math.min(day, last));
    return iso(t);
  }
  function todayIso() {
    // Дата в Києві: зранку за UTC ще може бути вчора
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date()); } catch (e) { return iso(new Date()); }
  }
  function daysBetween(a, b) { return Math.round((d(b) - d(a)) / 864e5); }

  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v == null || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      });
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, kid) {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach(function (k) { append(el, k); }); return; }
    el.append(kid.nodeType ? kid : String(kid));
  }
  function sv(tag, attrs) {
    var el = document.createElementNS(NS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    return el;
  }
  function icon(id, cls) {
    var svg = sv('svg', { class: 'ic' + (cls ? ' ' + cls : ''), viewBox: '0 0 24 24', 'aria-hidden': 'true' });
    svg.appendChild(sv('use', { href: '#' + id }));
    return svg;
  }
  function money(text, cls) { return h('span', { class: 'money' + (cls ? ' ' + cls : ''), text: text }); }

  /* ---------- Шифрування ---------- */
  function b64d(s) { var bin = atob(s); var u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  function b64e(u8) { var s = ''; for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); }

  function deriveKey(pass, kdf) {
    var enc = new TextEncoder().encode(pass.normalize('NFC'));
    return crypto.subtle.importKey('raw', enc, 'PBKDF2', false, ['deriveKey']).then(function (base) {
      return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: b64d(kdf.salt), iterations: kdf.iter, hash: kdf.hash || 'SHA-256' },
        base, { name: 'AES-GCM', length: 256 }, true, ['decrypt']);
    });
  }
  function decrypt(key, env) {
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(env.cipher.iv) }, key, b64d(env.data)).then(function (buf) {
      return JSON.parse(new TextDecoder().decode(buf));
    });
  }
  function savedKey(env) {
    var raw = store.get(K.key) || store.get(K.key, true);
    if (!raw) return Promise.resolve(null);
    var rec;
    try { rec = JSON.parse(raw); } catch (e) { return Promise.resolve(null); }
    if (!rec || rec.salt !== env.kdf.salt || rec.iter !== env.kdf.iter) return Promise.resolve(null);
    return crypto.subtle.importKey('raw', b64d(rec.k), 'AES-GCM', false, ['decrypt']).catch(function () { return null; });
  }
  function rememberKey(key, env, persist) {
    return crypto.subtle.exportKey('raw', key).then(function (raw) {
      var rec = JSON.stringify({ salt: env.kdf.salt, iter: env.kdf.iter, k: b64e(new Uint8Array(raw)) });
      store.del(K.key);
      store.set(K.key, rec, !persist);
    });
  }

  /* ---------- Стан ---------- */
  var state = {
    env: null, data: null, m: null, period: store.get(K.period) || 'ytd', gperiod: store.get(K.gperiod) || 'ytd',
    gFrom: null, gFocus: null, closesShown: 6, offline: false, fetchedAt: 0, openRows: {}
  };

  /* ---------- Завантаження ---------- */
  function fetchEnvelope(bust) {
    var url = SRC + (bust ? (SRC.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now() : '');
    return fetch(url, { cache: bust ? 'no-store' : 'no-cache' }).then(function (res) {
      if (!res.ok) throw new Error(res.status === 404 ? 'nodata' : 'http ' + res.status);
      state.offline = res.headers.get('X-Portfel-Cache') === '1';
      state.fetchedAt = Date.now();
      return res.json();
    });
  }
  function isEnvelope(x) { return x && x.format === 'portfel-enc' && x.kdf && x.cipher && x.data; }

  function start() {
    showOnly('splash');
    fetchEnvelope(false).then(function (env) {
      if (isEnvelope(env)) {
        state.env = env;
        return savedKey(env).then(function (key) {
          if (!key) return showLock(false);
          return decrypt(key, env).then(show, function () { store.del(K.key); showLock(true); });
        });
      }
      if (LOCAL && env && env.v === 1 && env.positions) return show(env); // відкриті дані лише для перевірки на своєму комп'ютері
      throw new Error('format');
    }).catch(function (err) {
      var msg = String(err && err.message);
      if (msg === 'nodata') fatal('Даних ще немає', 'Схоже, щоденне оновлення ще жодного разу не спрацювало. Налаштуй звіт IBKR за інструкцією.', true);
      else if (msg === 'format') fatal('Дані в незрозумілому форматі', 'Файл з даними пошкоджений або старої версії. Запусти оновлення в GitHub Actions ще раз.', true);
      else fatal('Не вдалося завантажити дані', 'Перевір інтернет і спробуй ще раз. Якщо застосунок уже відкривався раніше, він покаже останні збережені дані навіть без мережі.', false);
    });
  }

  function showOnly(which) {
    ['splash', 'lock', 'app', 'fatal'].forEach(function (id) { $(id).hidden = id !== which; });
  }
  function fatal(title, text, withLink) {
    $('fatalTitle').textContent = title;
    var p = $('fatalText'); p.replaceChildren(text);
    if (withLink) { p.append(' '); p.append(h('a', { href: README_URL, target: '_blank', rel: 'noopener', text: 'Відкрити інструкцію' })); }
    showOnly('fatal');
  }

  /* ---------- Пароль ---------- */
  function showLock(wrongSaved) {
    showOnly('lock');
    drawGuilloche(document.querySelector('[data-guilloche="lock"]'), 'lock');
    var err = $('lockErr');
    err.hidden = !wrongSaved;
    if (wrongSaved) err.textContent = 'Пароль змінився. Введи новий.';
    setTimeout(function () { $('lockPass').focus(); }, 50);
  }
  $('lockForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var pass = $('lockPass').value;
    var err = $('lockErr'), btn = $('lockBtn');
    if (!pass) { err.hidden = false; err.textContent = 'Введи пароль.'; return; }
    btn.disabled = true; btn.textContent = 'Розшифровую…'; err.hidden = true;
    var env = state.env;
    deriveKey(pass, env.kdf).then(function (key) {
      return decrypt(key, env).then(function (data) {
        return rememberKey(key, env, $('lockRemember').checked).then(function () {
          $('lockPass').value = '';
          show(data);
        });
      });
    }).catch(function () {
      err.hidden = false;
      err.textContent = 'Пароль не підійшов. Перевір розкладку клавіатури і спробуй ще раз.';
      $('lockPass').select();
    }).then(function () { btn.disabled = false; btn.textContent = 'Відкрити'; });
  });

  /* ---------- Модель: усе, що показує сторінка ---------- */
  function buildModel(data) {
    var nav = data.nav;
    var positions = (data.positions || []).filter(function (p) { return ok(p.value) && (Math.abs(p.value) >= 0.005 || p.qty); });
    var invested = sum(positions, function (p) { return p.value; });
    var cost = sum(positions, function (p) { return p.cost; });
    var pnl = sum(positions, function (p) { return p.pnl; });
    var other = ok(nav) ? nav - invested : (data.cash || 0);
    if (!ok(nav)) nav = invested + other;
    var cash = ok(data.cash) ? data.cash : other;
    var accrued = other - cash;

    // Кольори закріплені за тікером: новий тікер бере наступний вільний колір
    var order = (data.colorOrder || []).slice();
    positions.forEach(function (p) { if (order.indexOf(p.sym) < 0) order.push(p.sym); });
    var slot = {};
    order.forEach(function (s, i) { slot[s] = i < 8 ? i + 1 : 0; });

    var rows = positions.map(function (p) {
      var name = NAMES[p.sym] || prettyName(p.name, p.sym);
      var kind = p.kind || 'other';
      var about = ABOUT[p.sym] || (kind === 'etf' ? 'Фонд (кошик багатьох акцій)' : kind === 'stock' ? 'Акція, ' + p.sym : kind === 'bond' ? 'Облігація' : p.sym);
      if (kind === 'stock' && !ABOUT[p.sym] && name === p.sym) about = 'Акція однієї компанії';
      var fund = kind === 'etf' || kind === 'fund';
      return {
        sym: p.sym, title: fund ? p.sym : name, name: name, about: about, kind: kind, fund: fund,
        qty: p.qty, price: p.price, cur: p.cur || 'USD', value: p.value, cost: p.cost, pnl: p.pnl,
        pnlPct: ok(p.cost) && p.cost > 0 ? p.pnl / p.cost : null,
        share: nav ? p.value / nav : null, slot: slot[p.sym] || 0, exch: p.exch || ''
      };
    }).sort(function (a, b) { return b.value - a.value; });

    // Щоденна вартість і дохідність без впливу поповнень (time-weighted)
    var hist = (data.history || []).map(function (r) { return { date: r[0], nav: r[1], flow: r[2] || 0 }; })
      .filter(function (r) { return ok(r.nav); })
      .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    var idx = 1, twr = [], started = false;
    for (var i = 0; i < hist.length; i++) {
      var r = hist[i];
      if (started && hist[i - 1].nav > 0) {
        var g = (r.nav - r.flow) / hist[i - 1].nav;
        if (ok(g) && g > 0) idx *= g;
      }
      if (!started && r.nav > 0) started = true;
      if (started) twr.push({ date: r.date, idx: idx });
    }

    // Зміна за останній день
    var day = null;
    if (hist.length >= 2) {
      var a = hist[hist.length - 2], b = hist[hist.length - 1];
      var dv = b.nav - a.nav - b.flow;
      day = { date: b.date, abs: dv, pct: a.nav > 0 ? dv / a.nav : null };
    }

    var bench = (data.bench && data.bench.s) || [];
    var asOf = data.asOf || (hist.length ? hist[hist.length - 1].date : todayIso());
    var year = asOf.slice(0, 4);
    var trades = (data.trades || []).slice().sort(function (x, y) { return x.d < y.d ? 1 : x.d > y.d ? -1 : 0; });
    var cashTx = (data.cashTx || []).slice();
    var ytdTrades = trades.filter(function (t) { return t.d.slice(0, 4) === year; });
    var feesYtd = sum(ytdTrades, function (t) { return Math.abs(t.fee || 0); }) +
      sum(cashTx.filter(function (c) { return c.d.slice(0, 4) === year && c.type === 'fee'; }), function (c) { return -c.amount; });
    var realizedYtd = sum(ytdTrades, function (t) { return t.pnl || 0; });
    var divYtd = sum(cashTx.filter(function (c) { return c.d.slice(0, 4) === year && c.type === 'dividend'; }), function (c) { return c.amount; });
    var taxYtd = sum(cashTx.filter(function (c) { return c.d.slice(0, 4) === year && c.type === 'tax'; }), function (c) { return c.amount; });

    // Вартість кожного активу на закритті біржі: [дата, гроші, {тікер: [кількість, вартість]}]
    var snaps = (data.snaps || []).map(function (s) {
      var parts = {}, total = 0;
      Object.keys(s[2] || {}).forEach(function (k) {
        var v = s[2][k] && s[2][k][1];
        if (ok(v) && Math.abs(v) >= 0.005) { parts[k] = v; total += v; }
      });
      var c = ok(s[1]) ? s[1] : 0;
      return { date: s[0], cash: c, parts: parts, total: total + c };
    }).sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    var navByDate = {};
    hist.forEach(function (r) { navByDate[r.date] = r.nav; });

    return {
      snaps: snaps, navByDate: navByDate,
      data: data, nav: nav, invested: invested, cost: cost, pnl: pnl, cash: cash, accrued: accrued, other: other,
      rows: rows, slot: slot, hist: hist, twr: twr, day: day, bench: bench, benchSym: (data.bench && data.bench.sym) || 'VOO',
      benchAdj: !!(data.bench && data.bench.adj), asOf: asOf, year: year, trades: trades, cashTx: cashTx,
      feesYtd: feesYtd, realizedYtd: realizedYtd, divYtd: divYtd, taxYtd: taxYtd
    };
  }
  function prettyName(name, sym) {
    if (!name) return sym;
    var n = String(name).replace(/\b(INC|CORP|CO|LTD|PLC|SA|NV|AG|HOLDINGS?|GROUP)\b\.?/gi, '').replace(/\s+/g, ' ').trim();
    if (n === n.toUpperCase()) n = n.toLowerCase().replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    return n.length > 26 ? sym : n;
  }

  /* ---------- Періоди для «Ти проти ринку» ---------- */
  var PERIODS = [
    { id: '1m', label: 'Місяць', long: 'за місяць' },
    { id: '3m', label: '3 місяці', long: 'за 3 місяці' },
    { id: 'ytd', label: 'З 1 січня', long: 'з 1 січня' },
    { id: '1y', label: 'Рік', long: 'за рік' },
    { id: 'all', label: 'Усе', long: 'за весь час' }
  ];
  function periodStart(id, m) {
    var last = m.twr.length ? m.twr[m.twr.length - 1].date : m.asOf;
    if (id === '1m') return addMonths(last, -1);
    if (id === '3m') return addMonths(last, -3);
    if (id === 'ytd') return (Number(last.slice(0, 4)) - 1) + '-12-31';
    if (id === '1y') return addMonths(last, -12);
    return m.twr.length ? m.twr[0].date : last;
  }
  function availablePeriods(m) {
    if (m.twr.length < 2) return [];
    var first = m.twr[0].date, last = m.twr[m.twr.length - 1].date;
    var out = PERIODS.filter(function (p) {
      if (p.id === 'all') return daysBetween(first, last) > 400;
      return daysBetween(first, periodStart(p.id, m)) >= -4; // історія покриває початок періоду
    });
    return out;
  }
  function series(id, m) {
    var start = periodStart(id, m);
    var tw = m.twr;
    var i0 = 0;
    for (var i = 0; i < tw.length; i++) { if (tw[i].date <= start) i0 = i; else break; }
    var pts = tw.slice(i0);
    if (pts.length < 2) return [];
    // Ринок: ціна на ту саму дату або останню перед нею
    var b = m.bench, bi = 0, lastClose = null;
    var out = [];
    var base = pts[0].idx, mBase = null;
    for (var j = 0; j < pts.length; j++) {
      var dt = pts[j].date;
      while (bi < b.length && b[bi][0] <= dt) { lastClose = b[bi][1]; bi++; }
      if (j === 0) mBase = lastClose;
      out.push({ date: dt, y: 100 * pts[j].idx / base, m: mBase && lastClose ? 100 * lastClose / mBase : null });
    }
    return out;
  }

  /* ---------- Малювання сторінки ---------- */
  function show(data) {
    state.data = data;
    state.m = buildModel(data);
    showOnly('app');
    renderAll();
    if (!store.get(K.drawn, true)) {
      root.classList.add('reveal');
      store.set(K.drawn, '1', true);
    }
  }

  function renderAll() {
    var m = state.m;
    renderFresh(m);
    renderNotices(m);
    renderHero(m);
    renderMarket(m);
    renderHoldings(m);
    renderFacts(m);
    renderGrowth(m);
    renderOps(m);
    renderAbout(m);
    drawGuilloche(document.querySelector('[data-guilloche="hero"]'), 'hero');
  }

  function renderFresh(m) {
    var age = daysBetween(m.asOf, todayIso());
    var dot = $('freshDot');
    dot.className = 'fresh-dot' + (state.offline ? ' off' : age > 4 ? ' old' : '');
    $('freshText').textContent = (state.offline ? 'Офлайн, дані на ' : 'Дані на ') + dayLong(m.asOf);
    $('fresh').title = 'Закриття біржі ' + dayLongY(m.asOf) + (m.data.generated ? '. Оновлено ' + stamp(m.data.generated) : '');
  }
  function stamp(isoTs) {
    var t = new Date(isoTs);
    if (isNaN(t)) return '';
    var dd = t.toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', timeZone: 'Europe/Kyiv' });
    var tt = t.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' });
    return dd + ' о ' + tt;
  }

  function renderNotices(m) {
    var box = $('notices');
    box.replaceChildren();
    var age = daysBetween(m.asOf, todayIso());
    if (m.data.source === 'snapshot' && !store.get(K.snap)) {
      box.append(notice('i-refresh', '', ['Це знімок рахунку на ' + dayLong(m.asOf) + '. Щоб цифри оновлювались самі щодня, налаштуй звіт IBKR: ',
        h('a', { href: README_URL, target: '_blank', rel: 'noopener', text: 'інструкція на 10 хвилин' }), '.'], K.snap));
    } else if (m.data.source !== 'snapshot' && age > 4) {
      box.append(notice('i-refresh', 'warn', ['Дані на ' + dayLong(m.asOf) + '. Схоже, щоденне оновлення зупинилось. ',
        h('a', { href: ACTIONS_URL, target: '_blank', rel: 'noopener', text: 'Перевір GitHub Actions' }), '.']));
    }
    var ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.navigator.standalone;
    if (ios && !store.get(K.ios)) {
      box.append(notice('i-install', '', ['Щоб поставити як застосунок: натисни «Поділитися» і вибери «На початковий екран».'], K.ios));
    }
  }
  function notice(ic, cls, parts, closeKey) {
    var el = h('div', { class: 'notice' + (cls ? ' ' + cls : '') }, icon(ic), h('p', null, parts));
    if (closeKey) {
      el.append(h('button', {
        class: 'icon-btn notice-x', type: 'button', 'aria-label': 'Закрити', title: 'Закрити',
        onclick: function () { store.set(closeKey, '1'); el.remove(); }
      }, icon('i-x')));
    }
    return el;
  }

  function renderHero(m) {
    $('navNum').textContent = usd(m.nav);
    var uah = m.data.uah;
    var u = $('navUah');
    if (uah && ok(uah.rate)) {
      u.hidden = false;
      u.textContent = '≈ ' + uah0.format(m.nav * uah.rate) + ' ₴ за курсом НБУ';
      u.title = 'Курс НБУ ' + uah.rate.toFixed(2) + ' грн за долар' + (uah.date ? ' на ' + dayLong(uah.date) : '');
    } else u.hidden = true;

    var gain = m.pnl >= 0;
    var pill = $('gainPill');
    pill.classList.toggle('down', !gain);
    $('gainAbs').textContent = usd(Math.abs(m.pnl));
    $('gainPct').textContent = pct(m.cost ? Math.abs(m.pnl) / m.cost : null);
    $('gainLabel').replaceChildren(gain ? 'заробіток на вкладених ' : 'збиток на вкладених ', money(usd(m.cost)));
    pill.setAttribute('aria-label', (gain ? 'Заробіток ' : 'Збиток ') + usd(Math.abs(m.pnl)));

    renderTrend(m);

    var dl = $('dayLine');
    if (m.day && ok(m.day.abs)) {
      var up = m.day.abs >= 0;
      dl.replaceChildren('Останній день торгів, ' + dayLong(m.day.date) + ': ',
        h('b', { class: up ? 'up-t' : 'down-t' }, money(usdS(m.day.abs)), ' (' + pctS(m.day.pct) + ')'));
      dl.hidden = false;
    } else dl.hidden = true;
  }

  /* Рахунок у доларах за рік: скільки ти доклав і скільки заробили вкладення */
  function trendWindow(m) {
    var hist = m.hist.filter(function (r) { return r.nav > 0; });
    if (hist.length < 2) return null;
    var last = hist[hist.length - 1];
    var start = addMonths(last.date, -12);
    var full = hist[0].date <= start;
    var i0 = 0;
    for (var i = 0; i < hist.length; i++) { if (hist[i].date <= start) i0 = i; else break; }
    var pts = hist.slice(full ? i0 : 0);
    var deposits = sum(pts.slice(1), function (r) { return r.flow; });
    var delta = last.nav - pts[0].nav;
    return { pts: pts, full: full, delta: delta, deposits: deposits, growth: delta - deposits };
  }
  function renderTrend(m) {
    var t = trendWindow(m);
    $('trend').hidden = !t;
    if (!t) return;
    $('trendTitle').textContent = t.full ? 'Рахунок за рік' : 'Рахунок з ' + dayLong(t.pts[0].date);
    var dEl = $('trendDelta');
    dEl.className = 'trend-delta ' + (t.delta >= 0 ? 'up-t' : 'down-t');
    dEl.replaceChildren(money(usdS(t.delta)));
    var note = $('trendNote'), dep = t.deposits, gr = t.growth, parts;
    if (Math.abs(dep) < 0.005) parts = [gr >= 0 ? 'Без поповнень: увесь ріст дали вкладення.' : 'Без поповнень: вкладення подешевшали.'];
    else if (dep > 0) parts = gr >= 0
      ? ['З них ', money(usd(dep)), ' ти доклав, а ', money(usd(gr)), ' заробили вкладення.']
      : ['Ти доклав ', money(usd(dep)), ', а вкладення втратили ', money(usd(-gr)), '.'];
    else parts = ['Ти вивів ', money(usd(-dep)), ', а вкладення ' + (gr >= 0 ? 'заробили ' : 'втратили '), money(usd(Math.abs(gr))), '.'];
    note.replaceChildren();
    append(note, parts);
    drawSpark($('spark'), t.pts);
  }
  function drawSpark(box, pts) {
    box.replaceChildren();
    sizes[box.id] = box.clientWidth + 'x' + box.clientHeight;
    var W = Math.max(200, box.clientWidth), H = Math.max(50, box.clientHeight);
    var lo = Infinity, hi = -Infinity;
    pts.forEach(function (r) { lo = Math.min(lo, r.nav); hi = Math.max(hi, r.nav); });
    var span = hi - lo || hi * 0.05 || 1;
    lo -= span * 0.12; hi += span * 0.08;
    var padT = 6, padB = 2, padR = 6;
    var t0 = d(pts[0].date).getTime(), t1 = d(pts[pts.length - 1].date).getTime();
    var X = function (s) { return (d(s).getTime() - t0) / (t1 - t0 || 1) * (W - padR); };
    var Y = function (v) { return padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB); };
    var line = pts.map(function (r, i) { return (i ? 'L' : 'M') + X(r.date).toFixed(1) + ' ' + Y(r.nav).toFixed(1); }).join('');
    var svg = sv('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    svg.appendChild(sv('line', { class: 'sp-base', x1: 0, x2: W, y1: H - 0.5, y2: H - 0.5 }));
    svg.appendChild(sv('path', { class: 'sp-area', d: line + 'L' + X(pts[pts.length - 1].date).toFixed(1) + ' ' + H + 'L0 ' + H + 'Z' }));
    svg.appendChild(sv('path', { class: 'sp-line', d: line }));
    pts.forEach(function (r) { if (Math.abs(r.flow) > 0.005) svg.appendChild(sv('circle', { class: 'sp-dep', cx: X(r.date), cy: Y(r.nav), r: 4 })); });
    var last = pts[pts.length - 1];
    svg.appendChild(sv('circle', { class: 'sp-end', cx: X(last.date), cy: Y(last.nav), r: 4 }));
    var rule = sv('line', { class: 'rule', y1: 0, y2: H, visibility: 'hidden' });
    var dot = sv('circle', { class: 'sp-end', r: 4, visibility: 'hidden' });
    svg.appendChild(rule); svg.appendChild(dot);
    box.appendChild(svg);
    box.setAttribute('aria-label', 'Вартість рахунку: було ' + usd(pts[0].nav) + ', зараз ' + usd(last.nav));
    var xs = pts.map(function (r) { return X(r.date); });
    crosshair(box, W, xs, function (i, cx, cy) {
      var r = pts[i], x = xs[i];
      rule.setAttribute('x1', x); rule.setAttribute('x2', x); rule.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', x); dot.setAttribute('cy', Y(r.nav)); dot.setAttribute('visibility', 'visible');
      var rect = box.getBoundingClientRect();
      var lines = [[null, dayLongY(r.date)], ['var(--accent)', usd(r.nav), 'на рахунку']];
      if (r.flow > 0.005) lines.push(['var(--up)', usdS(r.flow), 'поповнення']);
      else if (r.flow < -0.005) lines.push(['var(--down)', usdS(r.flow), 'виведення']);
      tipShow(cx != null ? cx : rect.left + x * rect.width / W, cy != null ? cy : rect.top + Y(r.nav) * rect.height / H, lines, false);
    }, function () {
      rule.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tipHide();
    });
  }

  // Перехрестя для графіків: мишка, палець і клавіші ← → Home End
  function crosshair(box, W, xs, at, clear) {
    var cur = xs.length - 1;
    function go(i, cx, cy) { cur = Math.max(0, Math.min(xs.length - 1, i)); at(cur, cx, cy); }
    function nearest(clientX) {
      var rect = box.getBoundingClientRect();
      var x = (clientX - rect.left) * W / rect.width;
      var a = 0, b = xs.length - 1;
      while (b - a > 1) { var mid = (a + b) >> 1; if (xs[mid] < x) a = mid; else b = mid; }
      return Math.abs(xs[a] - x) <= Math.abs(xs[b] - x) ? a : b;
    }
    box.onpointermove = function (e) { go(nearest(e.clientX), e.clientX, e.clientY); };
    box.onpointerdown = box.onpointermove;
    box.onpointerleave = clear;
    box.onblur = clear;
    box.onfocus = function () { go(xs.length - 1); };
    box.onkeydown = function (e) {
      var map = { ArrowLeft: cur - 1, ArrowRight: cur + 1, Home: 0, End: xs.length - 1 };
      if (e.key in map) { e.preventDefault(); go(map[e.key]); }
      else if (e.key === 'Escape') clear();
    };
  }

  function renderMarket(m) {
    var avail = availablePeriods(m);
    var box = $('periods');
    box.replaceChildren();
    if (!avail.length) {
      $('chart').replaceChildren(h('div', { class: 'chart-empty', text: 'Графік з\'явиться, коли накопичиться хоча б кілька днів історії.' }));
      $('youEnd').textContent = 'н/д'; $('mktEnd').textContent = 'н/д'; $('verdict').textContent = '';
      return;
    }
    if (!avail.some(function (p) { return p.id === state.period; })) state.period = avail.some(function (p) { return p.id === 'ytd'; }) ? 'ytd' : avail[avail.length - 1].id;
    avail.forEach(function (p) {
      box.append(h('button', {
        type: 'button', role: 'radio', 'aria-checked': String(p.id === state.period), 'data-p': p.id, text: p.label,
        onclick: function () { state.period = p.id; store.set(K.period, p.id); renderMarket(state.m); }
      }));
    });
    box.onkeydown = function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      var i = avail.findIndex(function (p) { return p.id === state.period; });
      i = (i + (e.key === 'ArrowRight' ? 1 : -1) + avail.length) % avail.length;
      state.period = avail[i].id; store.set(K.period, state.period); renderMarket(state.m);
      box.querySelector('[data-p="' + state.period + '"]').focus();
    };

    var rows = series(state.period, m);
    var last = rows[rows.length - 1];
    var per = PERIODS.filter(function (p) { return p.id === state.period; })[0];
    $('youEnd').textContent = last ? usd(last.y) : 'н/д';
    $('mktEnd').textContent = last && ok(last.m) ? usd(last.m) : 'н/д';
    var v = $('verdict');
    if (last && ok(last.m)) {
      var diff = last.y - last.m;
      if (Math.abs(diff) < 0.05) v.replaceChildren(per.long[0].toUpperCase() + per.long.slice(1) + ' ти йдеш нарівні з ринком.');
      else v.replaceChildren(diff > 0 ? 'Ти попереду ринку на ' : 'Ринок попереду на ', h('b', { text: usd(Math.abs(diff)) }), ' з кожних $100 ' + per.long + '.');
    } else v.textContent = '';

    drawLine($('chart'), rows);
    renderPeriodTable(m, avail);
    $('marketNote').textContent = 'Ринок: фонд ' + m.benchSym + ', 500 найбільших компаній США' +
      (m.benchAdj ? ', з дивідендами' : '') + '. Поповнення на лінії не впливають: видно лише, як працювали вкладені гроші.';
  }

  function renderPeriodTable(m, avail) {
    var tb = $('periodTable').tBodies[0];
    tb.replaceChildren();
    avail.forEach(function (p) {
      var r = series(p.id, m), last = r[r.length - 1];
      if (!last) return;
      var you = last.y / 100 - 1, mk = ok(last.m) ? last.m / 100 - 1 : null;
      var diff = ok(mk) ? you - mk : null;
      tb.append(h('tr', null,
        h('td', { text: p.label }),
        h('td', { class: you >= 0 ? 'up-t' : 'down-t', text: pctS(you) }),
        h('td', { text: pctS(mk) }),
        h('td', { class: !ok(diff) ? '' : diff >= 0 ? 'up-t' : 'down-t', text: ok(diff) ? (diff >= 0 ? '+' : MINUS) + nf1.format(Math.abs(diff * 100)) + ' п.п.' : 'н/д' })));
    });
  }

  function renderHoldings(m) {
    var n = m.rows.length;
    $('holdMeta').textContent = n + ' ' + plural(n, ['позиція', 'позиції', 'позицій']) + (m.other > 0.004 ? ' і гроші' : '');

    // Смуга розподілу
    var alloc = $('alloc');
    alloc.replaceChildren();
    var parts = m.rows.map(function (r) { return { key: r.sym, label: r.title, value: r.value, share: r.share, color: colorOf(r.slot) }; });
    if (m.other > 0.004) parts.push({ key: 'CASH', label: 'Гроші на рахунку', value: m.other, share: m.nav ? m.other / m.nav : 0, color: 'var(--c-cash)' });
    parts.forEach(function (p) {
      if (!(p.value > 0)) return;
      var seg = h('i', { 'data-key': p.key, tabindex: '-1' });
      seg.style.flexGrow = String(p.value);
      seg.style.background = p.color;
      seg.addEventListener('pointerenter', function (e) { hot(p.key); tipShow(e.clientX, e.clientY, [[null, p.label], [p.color, usd(p.value), pct(p.share) + ' рахунку']]); });
      seg.addEventListener('pointermove', function (e) { tipMove(e.clientX, e.clientY); });
      seg.addEventListener('pointerleave', function () { hot(null); tipHide(); });
      seg.addEventListener('click', function () { toggleRow(p.key, true); });
      alloc.append(seg);
    });
    alloc.setAttribute('aria-label', 'Розподіл рахунку: ' + parts.map(function (p) { return p.label + ' ' + pct(p.share); }).join(', '));

    // Список
    var list = $('posList');
    list.replaceChildren();
    m.rows.forEach(function (r) { list.append(posItem(r, m)); });
    if (m.other > 0.004) list.append(cashItem(m));
  }
  function colorOf(slot) { return slot ? 'var(--c' + slot + ')' : 'var(--mkt)'; }
  function hot(key) {
    var alloc = $('alloc');
    alloc.classList.toggle('hot', !!key);
    Array.prototype.forEach.call(alloc.children, function (seg) { seg.classList.toggle('on', seg.getAttribute('data-key') === key); });
    Array.prototype.forEach.call($('posList').children, function (li) { li.classList.toggle('hot', li.getAttribute('data-key') === key); });
  }
  function posItem(r, m) {
    var up = (r.pnl || 0) >= 0;
    var id = 'more-' + r.sym.replace(/[^A-Za-z0-9]/g, '');
    var dot = h('i', { class: 'pdot' });
    dot.style.background = colorOf(r.slot);
    var row = h('button', { class: 'pos-row', type: 'button', 'aria-expanded': 'false', 'aria-controls': id },
      dot,
      h('span', { class: 'pos-name' }, h('b', { text: r.title }), h('small', { text: r.about })),
      h('span', { class: 'pos-val' }, money(usd(r.value)), h('small', { text: pct(r.share) })),
      h('span', { class: 'pos-pnl ' + (up ? 'up' : 'down') }, money(usdS(r.pnl)), h('small', { text: pctS(r.pnlPct) })));
    var more = h('div', { class: 'pos-more', id: id, hidden: true }, details(r, m));
    var li = h('li', { class: 'pos', 'data-key': r.sym }, row, more);
    row.addEventListener('click', function () { toggleRow(r.sym); });
    row.addEventListener('pointerenter', function () { hot(r.sym); });
    row.addEventListener('pointerleave', function () { hot(null); });
    if (state.openRows[r.sym]) { more.hidden = false; row.setAttribute('aria-expanded', 'true'); }
    return li;
  }
  function details(r, m) {
    var avg = ok(r.cost) && r.qty ? r.cost / r.qty : null;
    var dl = h('dl', null,
      h('div', null, h('dt', { text: 'Кількість' }), h('dd', { text: qty(r.qty) + ' шт' })),
      h('div', null, h('dt', { text: 'Ціна зараз' }), h('dd', { text: price(r.price, r.cur) })),
      h('div', null, h('dt', { text: 'Середня ціна покупки' }), h('dd', { text: price(avg, r.cur) })),
      h('div', null, h('dt', { text: 'Вкладено' }), h('dd', null, money(usd(r.cost)))));
    var extra = [];
    if (TRACKERS[r.sym]) extra.push('Через цей фонд ти володієш частинками 500 компаній, зокрема Apple, Nvidia і Microsoft.');
    var w = SP500[r.sym];
    if (w) {
      var funds = sum(m.rows.filter(function (x) { return TRACKERS[x.sym]; }), function (x) { return x.value; });
      if (funds > 0) extra.push('Ще ' + usd(funds * w) + ' у ' + r.name + ' лежить усередині твоїх фондів.');
    }
    return [dl, extra.length ? h('p', { text: extra.join(' ') }) : null];
  }
  function cashItem(m) {
    var dot = h('i', { class: 'pdot' });
    dot.style.background = 'var(--c-cash)';
    var sub = m.accrued > 0.004 ? 'вільні ' + usd(m.cash) + ', нараховано ' + usd(m.accrued) : 'ще не вкладені';
    var row = h('button', { class: 'pos-row', type: 'button', disabled: true },
      dot,
      h('span', { class: 'pos-name' }, h('b', { text: 'Гроші на рахунку' }), h('small', null, m.accrued > 0.004 ? money(sub) : sub)),
      h('span', { class: 'pos-val' }, money(usd(m.other)), h('small', { text: pct(m.nav ? m.other / m.nav : null) })),
      h('span', { class: 'pos-pnl' }));
    return h('li', { class: 'pos', 'data-key': 'CASH' }, row);
  }
  function toggleRow(key, reveal) {
    var li = $('posList').querySelector('[data-key="' + key + '"]');
    if (!li) return;
    var row = li.querySelector('.pos-row'), more = li.querySelector('.pos-more');
    if (!more) return;
    var open = more.hidden;
    if (reveal && !open) { li.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' }); return; }
    more.hidden = !open;
    row.setAttribute('aria-expanded', String(open));
    state.openRows[key] = open;
    if (reveal) li.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  /* ---------- Варто знати ---------- */
  function renderFacts(m) {
    var list = $('factList');
    list.replaceChildren();
    var facts = [factConcentration(m), factBestWorst(m), factRealized(m), factFees(m), factDividends(m)].filter(Boolean).slice(0, 4);
    if (!facts.length) facts.push({ ic: 'i-star', title: 'Поки нічого особливого', text: ['Коли в портфелі з\'являться перекоси, великі комісії чи дивіденди, вони будуть тут.'] });
    facts.forEach(function (f) {
      list.append(h('li', { class: 'fact' },
        h('span', { class: 'fact-ic' + (f.tone ? ' ' + f.tone : '') }, icon(f.ic)),
        h('div', null, h('p', { class: 'fact-title' }, f.title), h('p', { class: 'fact-text' }, f.text))));
    });
    $('facts').hidden = false;
  }
  function factConcentration(m) {
    var funds = sum(m.rows.filter(function (r) { return TRACKERS[r.sym]; }), function (r) { return r.value; });
    var best = null;
    m.rows.forEach(function (r) {
      var w = SP500[r.sym];
      if (!w || r.fund || !m.nav) return;
      var exposure = r.value + funds * w;
      var share = exposure / m.nav;
      var factor = share / w;
      if (!best || factor > best.factor) best = { r: r, share: share, w: w, factor: factor, viaFunds: funds * w };
    });
    if (!best || best.factor < 2 || best.share < 0.08) return null;
    var nm = best.r.name;
    var drop = best.share * 0.2;
    return {
      ic: 'i-scale', tone: 'warn',
      title: nm + ' займає ' + pct(best.share, 0) + ' рахунку',
      text: [best.viaFunds > 0.005 ? 'Разом із часткою ' + nm + ' всередині фондів. ' : '',
        'У ринку на неї припадає ' + pct(best.w) + ', у тебе в ', h('b', { text: times(best.factor) }),
        ' ' + plural(Math.round(best.factor), ['раз', 'рази', 'разів']) + ' більше. Якщо ' + nm + ' подешевшає на 20%, весь рахунок втратить близько ' + pct(drop) + '.']
    };
  }
  function factBestWorst(m) {
    var rs = m.rows.filter(function (r) { return ok(r.pnlPct); });
    if (rs.length < 2) return null;
    var best = rs.reduce(function (a, b) { return b.pnlPct > a.pnlPct ? b : a; });
    var worst = rs.reduce(function (a, b) { return b.pnlPct < a.pnlPct ? b : a; });
    var text = ['Найслабша зараз ' + worst.title + ': ', h('b', { text: pctS(worst.pnlPct) }), '. '];
    var feeNote = feeOnly(worst, m);
    if (feeNote) text.push(feeNote);
    else text.push('Це заробіток на папері: поки не продаси, цифри змінюються.');
    return { ic: 'i-star', tone: 'up', title: 'Найкраща покупка: ' + best.title + ', ' + pctS(best.pnlPct), text: text };
  }
  // Позиція в мінусі лише через комісію: усе куплено в межах історії угод і без неї був би плюс
  function feeOnly(r, m) {
    if (!(r.pnl < 0)) return null;
    var own = m.trades.filter(function (t) { return t.sym === r.sym; });
    if (!own.length || own.some(function (t) { return t.side !== 'BUY'; })) return null;
    var q = sum(own, function (t) { return t.qty; });
    if (Math.abs(q - r.qty) > 1e-6) return null;
    var fees = sum(own, function (t) { return Math.abs(t.fee || 0); });
    if (r.pnl + fees <= 0) return null;
    var paid = sum(own, function (t) { return t.qty * t.price; }) / q;
    var move = r.price / paid - 1;
    return 'Вона в мінусі лише через комісію ' + usd(fees) + (move > 0 ? ': ціна з дня покупки зросла на ' + pct(move) + '.' : '.');
  }
  function factRealized(m) {
    var sells = m.trades.filter(function (t) { return t.d.slice(0, 4) === m.year && t.side === 'SELL' && t.kind !== 'CASH'; });
    if (!sells.length) return null;
    var by = {};
    sells.forEach(function (t) { by[t.sym] = (by[t.sym] || 0) + (t.pnl || 0); });
    var total = m.realizedYtd;
    var names = Object.keys(by).sort(function (a, b) { return by[b] - by[a]; }).map(function (s) {
      return (NAMES[s] || s) + ' (' + usdS(by[s]) + ')';
    });
    var list = names.length > 1 ? names.slice(0, -1).join(', ') + ' і ' + names[names.length - 1] : names[0];
    return {
      ic: 'i-coin', tone: total >= 0 ? 'up' : '',
      title: 'Продажі цього року: ' + usdS(total),
      text: ['Ти продав ' + list + '. Цей ' + (total >= 0 ? 'прибуток' : 'збиток') + ' уже зафіксований і більше не зміниться.']
    };
  }
  function factFees(m) {
    if (!(m.feesYtd > 0.005)) return null;
    var by = {};
    m.trades.forEach(function (t) { if (t.d.slice(0, 4) === m.year && t.fee) by[t.sym] = (by[t.sym] || 0) + Math.abs(t.fee); });
    var top = Object.keys(by).sort(function (a, b) { return by[b] - by[a]; })[0];
    var text = [];
    if (top) {
      var tr = m.trades.filter(function (t) { return t.sym === top && t.fee; })[0];
      var lse = tr && /LSE/i.test(tr.exch || '');
      text.push('Найбільша ', h('b', { text: usd(by[top]) }), ' за ' + top + '. ');
      text.push(lse
        ? 'На Лондонській біржі це мінімум за угоду, тож дрібні суми дешевше вкладати у VOO, а ' + top + ' докуповувати рідше й більшими сумами.'
        : 'На малих сумах комісія відчутна: краще купувати рідше, але більшими сумами.');
    }
    return { ic: 'i-fee', title: 'Комісії цього року: ' + usd(m.feesYtd), text: text };
  }
  function factDividends(m) {
    if (!(m.divYtd > 0.005)) return null;
    var net = m.divYtd + (m.taxYtd || 0);
    return {
      ic: 'i-gift', tone: 'up', title: 'Дивіденди цього року: ' + usd(m.divYtd),
      text: [m.taxYtd ? 'Після податку США лишилось ' + usd(net) + '. ' : '', 'В Україні з них ще треба сплатити 9% ПДФО і 5% військового збору.']
    };
  }

  /* ---------- Розвиток портфеля: вартість активів на кожному закритті ---------- */
  var GPERIODS = [
    { id: 'w', label: 'Тиждень' }, { id: '1m', label: 'Місяць' }, { id: '3m', label: '3 місяці' },
    { id: 'ytd', label: 'З 1 січня' }, { id: '1y', label: 'Рік' }, { id: 'all', label: 'Усе' }
  ];
  function growthStart(id, m) {
    var S = m.snaps, last = S[S.length - 1].date;
    if (id === 'w') { var t = d(last); t.setUTCDate(t.getUTCDate() - 7); return iso(t); }
    if (id === '1m') return addMonths(last, -1);
    if (id === '3m') return addMonths(last, -3);
    if (id === 'ytd') return (Number(last.slice(0, 4)) - 1) + '-12-31';
    if (id === '1y') return addMonths(last, -12);
    return S[0].date;
  }
  function growthPeriods(m) {
    var S = m.snaps;
    if (S.length < 2) return [];
    var first = S[0].date, last = S[S.length - 1].date;
    return GPERIODS.filter(function (p) {
      if (p.id === 'all') return daysBetween(first, last) > 400;
      return daysBetween(first, growthStart(p.id, m)) >= -4;
    });
  }
  function navAt(m, snap) { return ok(m.navByDate[snap.date]) ? m.navByDate[snap.date] : snap.total; }

  // Було → стало між двома закриттями; «заробіток» активу без його докупок і продажів
  function compareSnaps(m, from) {
    var S = m.snaps;
    if (S.length < 2) return null;
    var ia = 0;
    for (var i = 0; i < S.length; i++) { if (S[i].date <= from) ia = i; else break; }
    var A = S[ia], B = S[S.length - 1];
    if (ia === S.length - 1) { A = S[S.length - 2]; ia = S.length - 2; }
    var inWin = function (x) { return x > A.date && x <= B.date; };
    var trades = m.trades.filter(function (t) { return t.kind !== 'CASH' && inWin(t.d); });
    var keys = {};
    Object.keys(A.parts).concat(Object.keys(B.parts)).forEach(function (k) { keys[k] = 1; });
    trades.forEach(function (t) { keys[t.sym] = 1; });
    var rows = Object.keys(keys).map(function (k) {
      var vA = A.parts[k] || 0, vB = B.parts[k] || 0, buys = 0, sells = 0;
      trades.forEach(function (t) {
        if (t.sym !== k) return;
        var amt = ok(t.amount) ? t.amount : (t.side === 'BUY' ? -1 : 1) * t.qty * t.price - Math.abs(t.fee || 0);
        if (t.side === 'BUY') buys += -amt; else sells += amt;
      });
      return { key: k, vA: vA, vB: vB, buys: buys, sells: sells, gain: vB - vA - buys + sells };
    }).sort(function (a, b) { return (b.vB - a.vB) || (b.vA - a.vA); });
    var navA = navAt(m, A), navB = navAt(m, B);
    var deposits = sum(m.hist.filter(function (r) { return inWin(r.date); }), function (r) { return r.flow; });
    var growth = navB - navA - deposits;
    var resid = growth - sum(rows, function (r) { return r.gain; });
    return { A: A, B: B, ia: ia, navA: navA, navB: navB, deposits: deposits, growth: growth, rows: rows, resid: resid };
  }

  function renderGrowth(m) {
    var sec = $('growth');
    var avail = growthPeriods(m);
    sec.hidden = !avail.length;
    if (!avail.length) return;
    if (!state.gFrom && !avail.some(function (p) { return p.id === state.gperiod; })) state.gperiod = avail.some(function (p) { return p.id === 'ytd'; }) ? 'ytd' : avail[avail.length - 1].id;
    var box = $('gPeriods');
    box.replaceChildren();
    avail.forEach(function (p) {
      box.append(h('button', {
        type: 'button', role: 'radio', 'aria-checked': String(!state.gFrom && p.id === state.gperiod), 'data-p': p.id, text: p.label,
        onclick: function () { state.gperiod = p.id; state.gFrom = null; store.set(K.gperiod, p.id); renderGrowth(state.m); }
      }));
    });
    var from = state.gFrom || growthStart(state.gperiod, m);
    var c = compareSnaps(m, from);
    if (!c) { sec.hidden = true; return; }

    var input = $('gDate');
    input.min = m.snaps[0].date; input.max = m.snaps[m.snaps.length - 2].date; input.value = c.A.date;
    input.onchange = function () {
      if (!input.value) return;
      state.gFrom = input.value; renderGrowth(state.m);
    };
    $('cmpA').textContent = usd(c.navA);
    $('cmpB').textContent = usd(c.navB);
    $('cmpBLabel').textContent = 'Стало, ' + dayLong(c.B.date);

    var change = c.navB - c.navA, parts;
    var lead = [money(usdS(change)), ' за цей час. '];
    if (Math.abs(c.deposits) < 0.005) parts = lead.concat([c.growth >= 0 ? 'Поповнень не було: усе це заробили вкладення.' : 'Поповнень не було: вкладення подешевшали.']);
    else if (c.deposits > 0) parts = lead.concat(c.growth >= 0
      ? ['Ти доклав ', money(usd(c.deposits)), ', а вкладення заробили ', money(usd(c.growth)), '.']
      : ['Ти доклав ', money(usd(c.deposits)), ', а вкладення втратили ', money(usd(-c.growth)), '.']);
    else parts = lead.concat(['Ти вивів ', money(usd(-c.deposits)), ', а вкладення ' + (c.growth >= 0 ? 'заробили ' : 'втратили '), money(usd(Math.abs(c.growth))), '.']);
    var note = $('cmpNote');
    note.replaceChildren(); append(note, parts);

    // Таблиця «було → стало»
    var tb = $('cmpTable').tBodies[0];
    tb.replaceChildren();
    c.rows.forEach(function (r) {
      var dot = h('i', { class: 'pdot' });
      dot.style.background = colorOf(m.slot[r.key] || slotFor(m, r.key));
      var sold = r.vB < 0.005 && r.vA > 0.005, isNew = r.vA < 0.005 && r.vB > 0.005;
      var tr = h('tr', { 'data-key': r.key },
        h('td', null, h('span', { class: 'cmp-name' }, dot, h('span', null, NAMES[r.key] && !TRACKERS[r.key] ? NAMES[r.key] : r.key))),
        isNew ? h('td', { class: 'soft', text: 'не було' }) : h('td', null, money(usd(r.vA))),
        sold ? h('td', { class: 'soft', text: 'продано' }) : h('td', null, money(usd(r.vB))),
        h('td', { class: r.gain >= 0.005 ? 'up-t' : r.gain <= -0.005 ? 'down-t' : '' }, money(usdS(r.gain))));
      tr.addEventListener('pointerenter', function () { focusBand(r.key); });
      tr.addEventListener('pointerleave', function () { focusBand(null); });
      tb.append(tr);
    });
    tb.append(h('tr', null, h('td', { text: 'Гроші на рахунку' }), h('td', null, money(usd(c.A.cash))), h('td', null, money(usd(c.B.cash))), h('td', { class: 'soft', text: '' })));
    if (Math.abs(c.resid) >= 0.01) {
      tb.append(h('tr', null, h('td', { text: 'Дивіденди, курс валют, інше' }), h('td', { class: 'soft' }), h('td', { class: 'soft' }),
        h('td', { class: c.resid >= 0 ? 'up-t' : 'down-t' }, money(usdS(c.resid)))));
    }
    tb.append(h('tr', { class: 'sum' }, h('td', { text: 'Усього' }), h('td', null, money(usd(c.navA))), h('td', null, money(usd(c.navB))),
      h('td', { class: c.growth >= 0 ? 'up-t' : 'down-t' }, money(usdS(c.growth)))));

    var chart = $('gChart');
    chart.setAttribute('aria-label', 'Вартість активів на кожному закритті з ' + dayLongY(c.A.date) + ' до ' + dayLongY(c.B.date));
    drawStack(chart, m, m.snaps.slice(c.ia));
    renderCloses(m);
  }
  // Колір для паперу, якого вже немає в портфелі (продано): наступний вільний слот
  function slotFor(m, key) {
    var order = (m.data.colorOrder || []).slice();
    m.rows.forEach(function (r) { if (order.indexOf(r.sym) < 0) order.push(r.sym); });
    if (order.indexOf(key) < 0) order.push(key);
    var i = order.indexOf(key);
    return i < 8 ? i + 1 : 0;
  }
  function focusBand(key) {
    state.gFocus = key;
    var chart = $('gChart');
    chart.classList.toggle('focus', !!key);
    Array.prototype.forEach.call(chart.querySelectorAll('[data-key]'), function (el) { el.classList.toggle('on', !!key && el.getAttribute('data-key') === key); });
    Array.prototype.forEach.call($('cmpTable').tBodies[0].rows, function (tr) { tr.classList.toggle('hot', !!key && tr.getAttribute('data-key') === key); });
  }

  // Складений графік: кожен актив окремою смугою, гроші зверху, лінія по верху показує весь рахунок
  function drawStack(box, m, S) {
    box.replaceChildren();
    sizes[box.id] = box.clientWidth + 'x' + box.clientHeight;
    box.onpointermove = box.onpointerleave = box.onkeydown = box.onblur = box.onfocus = box.onpointerdown = null;
    if (S.length < 2) { box.append(h('div', { class: 'chart-empty', text: 'Замало закриттів для цього періоду.' })); return; }
    var W = Math.max(260, box.clientWidth), H = Math.max(160, box.clientHeight);
    var keys = {};
    S.forEach(function (s) { Object.keys(s.parts).forEach(function (k) { keys[k] = 1; }); });
    var order = (m.data.colorOrder || []).slice();
    Object.keys(keys).forEach(function (k) { if (order.indexOf(k) < 0) order.push(k); });
    var ks = order.filter(function (k) { return keys[k]; });
    var hi = 0;
    S.forEach(function (s) { hi = Math.max(hi, s.total, ok(m.navByDate[s.date]) ? m.navByDate[s.date] : 0); });
    var ticks = niceTicks(0, hi * 1.04, H < 220 ? 3 : 4);
    var y1 = ticks[ticks.length - 1];
    var tickFmt = function (v) { return '$' + nf0.format(v); };
    var padL = Math.ceil(Math.max.apply(null, ticks.map(function (v) { return textWidth(tickFmt(v)); }))) + 10;
    var padR = 10, padT = 8, padB = 24;
    var t0 = d(S[0].date).getTime(), t1 = d(S[S.length - 1].date).getTime();
    var X = function (s) { return padL + (d(s).getTime() - t0) / (t1 - t0 || 1) * (W - padL - padR); };
    var Y = function (v) { return padT + (1 - v / (y1 || 1)) * (H - padT - padB); };
    var svg = sv('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    ticks.forEach(function (v) {
      svg.appendChild(sv('line', { class: v === 0 ? 'baseline' : 'gridline', x1: padL, x2: W - padR, y1: Y(v), y2: Y(v) }));
      var t = sv('text', { x: padL - 8, y: Y(v), dy: '0.32em', 'text-anchor': 'end' }); t.textContent = tickFmt(v); svg.appendChild(t);
    });
    timeLabels(svg, S[0].date, S[S.length - 1].date, X, H, padL, W - padR);

    // Накопичені межі смуг
    var lower = S.map(function () { return 0; });
    var layers = ks.map(function (k) { return { key: k, color: colorOf(m.slot[k] || slotFor(m, k)) }; });
    layers.push({ key: 'CASH', color: 'var(--c-cash)' });
    layers.forEach(function (L) {
      var upper = S.map(function (s, i) { return lower[i] + (L.key === 'CASH' ? Math.max(0, s.cash) : (s.parts[L.key] || 0)); });
      var top = '', bottom = '';
      S.forEach(function (s, i) { top += (i ? 'L' : 'M') + X(s.date).toFixed(1) + ' ' + Y(upper[i]).toFixed(1); });
      for (var i = S.length - 1; i >= 0; i--) bottom += 'L' + X(S[i].date).toFixed(1) + ' ' + Y(lower[i]).toFixed(1);
      var band = sv('path', { class: 'band', d: top + bottom + 'Z', 'data-key': L.key });
      band.style.fill = L.color;
      var edge = sv('path', { class: 'edge', d: top, 'data-key': L.key });
      edge.style.stroke = L.color;
      svg.appendChild(band); svg.appendChild(edge);
      L.upper = upper;
      lower = upper;
    });
    var total = '';
    S.forEach(function (s, i) { total += (i ? 'L' : 'M') + X(s.date).toFixed(1) + ' ' + Y(lower[i]).toFixed(1); });
    svg.appendChild(sv('path', { class: 'total', d: total }));
    var rule = sv('line', { class: 'rule', y1: padT, y2: H - padB, visibility: 'hidden' });
    var dot = sv('circle', { class: 'dot total-dot', r: 4, visibility: 'hidden' });
    svg.appendChild(rule); svg.appendChild(dot);
    box.appendChild(svg);
    if (state.gFocus) focusBand(state.gFocus);

    var xs = S.map(function (s) { return X(s.date); });
    crosshair(box, W, xs, function (i, cx, cy) {
      var s = S[i], x = xs[i];
      rule.setAttribute('x1', x); rule.setAttribute('x2', x); rule.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', x); dot.setAttribute('cy', Y(lower[i])); dot.setAttribute('visibility', 'visible');
      var lines = [[null, dayLongY(s.date)], ['var(--ink)', usd(s.total), 'усього']];
      layers.slice().reverse().forEach(function (L) {
        var v = L.key === 'CASH' ? s.cash : s.parts[L.key];
        if (ok(v) && v >= 0.005) lines.push([L.color, usd(v), L.key === 'CASH' ? 'гроші' : (TRACKERS[L.key] ? L.key : (NAMES[L.key] || L.key))]);
      });
      var rect = box.getBoundingClientRect();
      tipShow(cx != null ? cx : rect.left + x * rect.width / W, cy != null ? cy : rect.top + Y(lower[i]) * rect.height / H, lines, false);
    }, function () {
      rule.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tipHide();
    });
  }

  // Підписи часу під графіком: місяці для довгих періодів, тижні для коротких
  function timeLabels(svg, from, to, X, H, left, right) {
    var t0 = d(from).getTime(), t1 = d(to).getTime(), spanDays = (t1 - t0) / 864e5, labels = [];
    if (spanDays > 70) {
      var c = d(from); c.setUTCDate(1); c.setUTCMonth(c.getUTCMonth() + 1);
      while (c.getTime() <= t1) { labels.push({ s: iso(c), text: c.getUTCMonth() === 0 ? String(c.getUTCFullYear()) : MON_SHORT[c.getUTCMonth()] }); c.setUTCMonth(c.getUTCMonth() + 1); }
    } else {
      var step = spanDays > 21 ? 7 : spanDays > 9 ? 3 : 1;
      var w = d(from);
      if (step === 7) w.setUTCDate(w.getUTCDate() + ((8 - w.getUTCDay()) % 7 || 7));
      while (w.getTime() <= t1) { labels.push({ s: iso(w), text: w.getUTCDate() + ' ' + MON_SHORT[w.getUTCMonth()] }); w.setUTCDate(w.getUTCDate() + step); }
    }
    var lastX = -1e9;
    labels.forEach(function (l) {
      var x = X(l.s);
      if (x - lastX < 46 || x < left + 10 || x > right - 10) return;
      lastX = x;
      var t = sv('text', { x: x, y: H - 6, 'text-anchor': 'middle' });
      t.textContent = l.text;
      svg.appendChild(t);
    });
  }

  // Усі закриття таблицею: вартість рахунку, зміна за день без поповнень, поповнення
  function renderCloses(m) {
    var tb = $('closesTable').tBodies[0];
    tb.replaceChildren();
    var rows = m.hist.slice().reverse();
    rows.slice(0, state.closesShown).forEach(function (r, i) {
      var prev = rows[i + 1];
      var dv = prev ? r.nav - prev.nav - r.flow : null;
      var dp = prev && prev.nav > 0 ? dv / prev.nav : null;
      tb.append(h('tr', null,
        h('td', { text: dayShort(r.date) + (r.date.slice(0, 4) === m.year ? '' : ' ' + r.date.slice(0, 4)) }),
        h('td', null, money(usd(r.nav))),
        h('td', { class: 'day-chg ' + (!ok(dv) ? '' : dv >= 0.005 ? 'up-t' : dv <= -0.005 ? 'down-t' : '') },
          ok(dv) ? [money(usdS(dv)), h('small', { text: pctS(dp) })] : 'н/д'),
        h('td', null, Math.abs(r.flow) >= 0.005 ? money(usdS(r.flow)) : '')));
    });
    var more = $('closesMore');
    more.hidden = rows.length <= state.closesShown;
    more.textContent = 'Показати ще (усього ' + rows.length + ')';
    more.onclick = function () { state.closesShown += 30; renderCloses(state.m); };
  }

  /* ---------- Операції ---------- */
  function renderOps(m) {
    var items = [];
    m.trades.forEach(function (t) {
      if (Math.abs(t.amount || 0) < 0.01 && t.kind === 'CASH') return;
      items.push({ d: t.d, t: t });
    });
    m.cashTx.forEach(function (c) { if (Math.abs(c.amount) >= 0.005) items.push({ d: c.d, c: c }); });
    items.sort(function (a, b) { return a.d < b.d ? 1 : a.d > b.d ? -1 : 0; });
    var yearAgo = addMonths(m.asOf, -12);
    var recent = items.filter(function (x) { return x.d > yearAgo; }).length;
    $('opsMeta').textContent = recent + ' за рік';
    var body = $('opsBody');
    body.replaceChildren();
    if (!items.length) { body.append(h('p', { class: 'note', text: 'Операцій поки немає.' })); return; }
    var lastMonth = '';
    items.forEach(function (x) {
      var mon = x.d.slice(0, 7);
      if (mon !== lastMonth) {
        lastMonth = mon;
        var mm = Number(mon.slice(5, 7)) - 1;
        body.append(h('p', { class: 'ops-month', text: MON_NOM[mm] + ' ' + mon.slice(0, 4) }));
      }
      body.append(x.t ? tradeRow(x.t) : cashRow(x.c));
    });
  }
  function tradeRow(t) {
    var nm = NAMES[t.sym] || t.sym;
    if (t.kind === 'CASH') {
      var pair = t.sym.split('.');
      var from = t.side === 'SELL' ? pair[0] : pair[1], to = t.side === 'SELL' ? pair[1] : pair[0];
      var got = t.side === 'SELL' ? (t.qty * t.price) : t.qty;
      return opsRow('i-swap', '', 'Обмін валюти', dayShort(t.d) + ', ' + qty(t.qty) + ' ' + pair[0] + ' за курсом ' + t.price.toFixed(4),
        h('span', null, money(nf2.format(got) + ' ' + (to || ''))), h('small', { text: 'з ' + (from || '') }));
    }
    var buy = t.side === 'BUY';
    var small;
    if (!buy && ok(t.pnl) && Math.abs(t.pnl) >= 0.005) small = h('small', { class: t.pnl > 0 ? 'up-t' : 'down-t' }, money((t.pnl > 0 ? 'прибуток ' : 'збиток ') + usd(Math.abs(t.pnl))));
    else small = h('small', null, money('комісія ' + usd(Math.abs(t.fee || 0))));
    return opsRow(buy ? 'i-buy' : 'i-sell', buy ? 'buy' : '', (buy ? 'Купівля ' : 'Продаж ') + nm,
      dayShort(t.d) + ', ' + qty(t.qty) + ' шт по ' + price(t.price, t.cur), money(usdS(t.amount)), small);
  }
  function cashRow(c) {
    var map = {
      deposit: ['i-in', 'in', 'поповнення'], withdrawal: ['i-sell', '', 'виведення'], dividend: ['i-gift', 'in', 'дивіденди'],
      tax: ['i-fee', '', 'податок з дивідендів'], interest: ['i-coin', 'in', 'відсотки на залишок'], fee: ['i-fee', '', 'плата брокеру'], other: ['i-cash', '', 'рух коштів']
    };
    var k = map[c.type] || map.other;
    var what = c.sym ? (NAMES[c.sym] || c.sym) : (c.type === 'deposit' ? 'переказ на рахунок' : (c.desc || ''));
    var title = k[2][0].toUpperCase() + k[2].slice(1);
    return opsRow(k[0], k[1], title, dayShort(c.d) + (what ? ', ' + what : ''), money(usdS(c.amount)), null);
  }
  function opsRow(ic, tone, title, sub, side, small) {
    return h('div', { class: 'ops-row' },
      h('span', { class: 'ops-ic' + (tone ? ' ' + tone : '') }, icon(ic)),
      h('span', { class: 'ops-main' }, h('b', { text: title }), h('small', { text: sub })),
      h('span', { class: 'ops-side' }, side, small));
  }

  function renderAbout(m) {
    var g = m.data.generated ? stamp(m.data.generated) : '';
    $('aboutMeta').textContent = m.data.source === 'snapshot' ? 'знімок' : 'щодня';
    $('aboutText').textContent = m.data.source === 'snapshot'
      ? 'Зараз тут знімок рахунку на ' + dayLongY(m.asOf) + ', зібраний вручну. Щоб дані оновлювались самі, налаштуй звіт IBKR за інструкцією нижче.'
      : 'Щоранку GitHub бере звіт Interactive Brokers за останнє закриття біржі, записує вартість кожного активу, шифрує все твоїм паролем і викладає сюди. Останнє оновлення: ' + g +
        '. Ціни ринку (' + m.benchSym + '): Yahoo Finance' + (m.data.uah ? ', курс гривні: НБУ.' : '.');
  }

  /* ---------- Лінійний графік ---------- */
  var measureCtx = null;
  function textWidth(str, weight) {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    measureCtx.font = (weight || 400) + ' 12px Geologica, system-ui, sans-serif';
    return measureCtx.measureText(str).width;
  }
  function niceTicks(lo, hi, count) {
    var span = hi - lo || 1;
    var raw = span / count, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var steps = [1, 2, 2.5, 5, 10], step = mag;
    for (var i = 0; i < steps.length; i++) { if (raw <= steps[i] * mag) { step = steps[i] * mag; break; } }
    var t0 = Math.floor(lo / step) * step, t1 = Math.ceil(hi / step) * step, out = [];
    for (var v = t0; v <= t1 + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
    return out;
  }
  function drawLine(box, rows) {
    box.replaceChildren();
    sizes[box.id] = box.clientWidth + 'x' + box.clientHeight;
    box.onpointermove = box.onpointerleave = box.onkeydown = box.onblur = box.onfocus = box.onpointerdown = null;
    if (rows.length < 2) { box.append(h('div', { class: 'chart-empty', text: 'Замало даних для цього періоду.' })); return; }
    var W = Math.max(260, box.clientWidth), H = Math.max(160, box.clientHeight);
    var hasM = rows.some(function (r) { return ok(r.m); });
    var lo = 100, hi = 100;
    rows.forEach(function (r) { lo = Math.min(lo, r.y); hi = Math.max(hi, r.y); if (ok(r.m)) { lo = Math.min(lo, r.m); hi = Math.max(hi, r.m); } });
    var pad = (hi - lo) * 0.06 || 1;
    var ticks = niceTicks(lo - pad, hi + pad, H < 190 ? 3 : 4);
    var y0 = ticks[0], y1 = ticks[ticks.length - 1];
    var step = ticks.length > 1 ? ticks[1] - ticks[0] : 1;
    var tickFmt = function (v) { return '$' + (step < 1 ? v.toFixed(1) : nf0.format(v)); };
    var padL = Math.ceil(Math.max.apply(null, ticks.map(function (v) { return textWidth(tickFmt(v)); }))) + 10;
    var padR = Math.ceil(Math.max(textWidth('Ринок', 600), textWidth('Ти', 600))) + 16;
    var padT = 8, padB = 24;
    var t0 = d(rows[0].date).getTime(), t1 = d(rows[rows.length - 1].date).getTime();
    var X = function (s) { return padL + (d(s).getTime() - t0) / (t1 - t0 || 1) * (W - padL - padR); };
    var Y = function (v) { return padT + (1 - (v - y0) / (y1 - y0 || 1)) * (H - padT - padB); };

    var svg = sv('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    ticks.forEach(function (v) {
      svg.appendChild(sv('line', { class: Math.abs(v - 100) < 1e-9 ? 'baseline' : 'gridline', x1: padL, x2: W - padR, y1: Y(v), y2: Y(v) }));
      var t = sv('text', { x: padL - 8, y: Y(v), dy: '0.32em', 'text-anchor': 'end' });
      t.textContent = tickFmt(v);
      svg.appendChild(t);
    });
    if (ticks.indexOf(100) < 0 && 100 > y0 && 100 < y1) svg.appendChild(sv('line', { class: 'baseline', x1: padL, x2: W - padR, y1: Y(100), y2: Y(100) }));

    var plotRight = W - padR;
    timeLabels(svg, rows[0].date, rows[rows.length - 1].date, X, H, padL, plotRight);

    function path(f) {
      var dd = '', pen = false;
      rows.forEach(function (r) {
        var v = f(r);
        if (!ok(v)) { pen = false; return; }
        dd += (pen ? 'L' : 'M') + X(r.date).toFixed(1) + ' ' + Y(v).toFixed(1);
        pen = true;
      });
      return dd;
    }
    var area = path(function (r) { return r.y; }) + 'L' + X(rows[rows.length - 1].date).toFixed(1) + ' ' + Y(100).toFixed(1) + 'L' + X(rows[0].date).toFixed(1) + ' ' + Y(100).toFixed(1) + 'Z';
    svg.appendChild(sv('path', { class: 'area', d: area }));
    if (hasM) svg.appendChild(sv('path', { class: 'ln mkt', d: path(function (r) { return r.m; }) }));
    svg.appendChild(sv('path', { class: 'ln you', d: path(function (r) { return r.y; }) }));

    // Кінці ліній: крапка й підпис
    var last = rows[rows.length - 1];
    var yy = Y(last.y), ym = ok(last.m) ? Y(last.m) : null;
    var ly = yy, lm = ym;
    if (ym != null && Math.abs(yy - ym) < 15) { var mid = (yy + ym) / 2; if (yy <= ym) { ly = mid - 8; lm = mid + 8; } else { ly = mid + 8; lm = mid - 8; } }
    if (ym != null) {
      svg.appendChild(sv('circle', { class: 'dot mkt', cx: X(last.date), cy: ym, r: 4 }));
      var tm = sv('text', { class: 'end mkt', x: plotRight + 8, y: lm, dy: '0.32em' }); tm.textContent = 'Ринок'; svg.appendChild(tm);
    }
    svg.appendChild(sv('circle', { class: 'dot you', cx: X(last.date), cy: yy, r: 4 }));
    var ty = sv('text', { class: 'end you', x: plotRight + 8, y: ly, dy: '0.32em' }); ty.textContent = 'Ти'; svg.appendChild(ty);

    // Перехрестя
    var rule = sv('line', { class: 'rule', y1: padT, y2: H - padB, visibility: 'hidden' });
    var hm = sv('circle', { class: 'dot mkt', r: 4, visibility: 'hidden' });
    var hy = sv('circle', { class: 'dot you', r: 4, visibility: 'hidden' });
    svg.appendChild(rule); svg.appendChild(hm); svg.appendChild(hy);
    box.appendChild(svg);

    var xs = rows.map(function (r) { return X(r.date); });
    crosshair(box, W, xs, function (i, clientX, clientY) {
      var r = rows[i], x = xs[i];
      rule.setAttribute('x1', x); rule.setAttribute('x2', x); rule.setAttribute('visibility', 'visible');
      hy.setAttribute('cx', x); hy.setAttribute('cy', Y(r.y)); hy.setAttribute('visibility', 'visible');
      if (ok(r.m)) { hm.setAttribute('cx', x); hm.setAttribute('cy', Y(r.m)); hm.setAttribute('visibility', 'visible'); } else hm.setAttribute('visibility', 'hidden');
      var rect = box.getBoundingClientRect();
      var px = rect.left + x * rect.width / W;
      var py = clientY != null ? clientY : rect.top + Math.min(Y(r.y), ok(r.m) ? Y(r.m) : Infinity) * rect.height / H;
      var lines = [[null, dayLongY(r.date)], ['var(--accent)', usd(r.y), 'ти']];
      if (ok(r.m)) lines.push(['var(--mkt)', usd(r.m), 'ринок']);
      tipShow(clientX != null ? clientX : px, py, lines, true);
    }, function () {
      rule.setAttribute('visibility', 'hidden'); hy.setAttribute('visibility', 'hidden'); hm.setAttribute('visibility', 'hidden');
      tipHide();
    });
  }

  /* ---------- Підказка ---------- */
  var tip = $('tip');
  function tipShow(x, y, lines, chart) {
    tip.replaceChildren();
    lines.forEach(function (l, i) {
      if (!l[0] && i === 0) { tip.append(h('div', { class: 'tip-head', text: l[1] })); return; }
      var keyEl = h('i', { class: 'key-line' });
      keyEl.style.background = l[0];
      var val = h('b', null, chart ? l[1] : money(l[1]));
      tip.append(h('div', { class: 'tip-row' }, keyEl, val, l[2] ? h('span', { text: l[2] }) : null));
    });
    tip.hidden = false;
    tipMove(x, y);
  }
  function tipMove(x, y) {
    var tw = tip.offsetWidth, th = tip.offsetHeight, vw = window.innerWidth;
    var left = x + 14;
    if (left + tw > vw - 8) left = x - tw - 14;
    if (left < 8) left = 8;
    var top = y - th - 12;
    if (top < 8) top = y + 16;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }
  function tipHide() { tip.hidden = true; }
  window.addEventListener('scroll', tipHide, { passive: true });

  /* ---------- Гільйош: візерунок як на банкнотах ---------- */
  // Накладені хвилясті кола: r(t) = R + A·sin(k·t), кожна копія трохи повернута.
  // Та сама формула, що й у значку застосунку, лише з тоншими й частішими лініями.
  function guillochePath(cx, cy, R, A, k, copies, perLobe, phase) {
    var dd = '', pts = k * perLobe;
    for (var i = 0; i < copies; i++) {
      var rot = phase + i / copies * (2 * Math.PI / k);
      for (var j = 0; j <= pts; j++) {
        var t = j / pts * 2 * Math.PI;
        var r = R + A * Math.sin(k * t);
        var x = cx + r * Math.cos(t + rot), y = cy + r * Math.sin(t + rot);
        dd += (j ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
      }
      dd += 'Z';
    }
    return dd;
  }
  function drawGuilloche(svg, kind) {
    if (!svg || svg.getAttribute('data-done')) return;
    svg.setAttribute('viewBox', '0 0 400 400');
    // [радіус, амплітуда, пелюстки, копії, точок на пелюстку, поворот, колір]
    var rings = [
      [186, 6, 30, 5, 10, 0, 'g1'],
      [150, 14, 15, 8, 14, 0.05, 'g2'],
      [104, 12, 10, 9, 16, 0, 'g1'],
      [56, 30, 5, 10, 22, 0.1, 'g2']
    ];
    rings.forEach(function (rg) {
      svg.appendChild(sv('path', { class: rg[6], d: guillochePath(200, 200, rg[0], rg[1], rg[2], rg[3], rg[4], rg[5]) }));
    });
    svg.setAttribute('data-done', '1');
    if (kind === 'hero' && !reduceMotion && !store.get(K.drawn + '.g', true)) {
      store.set(K.drawn + '.g', '1', true);
      Array.prototype.forEach.call(svg.querySelectorAll('path'), function (p) {
        var len = 0;
        try { len = Math.ceil(p.getTotalLength()); } catch (e) { len = 0; }
        if (len) p.style.setProperty('--len', String(len));
      });
      svg.classList.add('draw');
    }
  }

  /* ---------- Тема ---------- */
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function themePref() { var p = store.get(K.theme); return p === 'light' || p === 'dark' ? p : 'auto'; }
  function applyTheme(pref) {
    var theme = pref === 'light' || pref === 'dark' ? pref : (mq && mq.matches ? 'dark' : 'light');
    root.setAttribute('data-theme', theme);
    root.setAttribute('data-theme-pref', pref);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0f121a' : '#f3f4f7');
    $('themeUse').setAttribute('href', pref === 'auto' ? '#i-auto' : pref === 'dark' ? '#i-moon' : '#i-sun');
    var names = { light: 'світла', dark: 'темна', auto: 'як у системі' };
    $('themeBtn').setAttribute('aria-label', 'Тема: ' + names[pref]);
    $('themeBtn').title = 'Тема: ' + names[pref];
    Array.prototype.forEach.call(document.querySelectorAll('[data-theme-pick]'), function (b) {
      b.setAttribute('aria-checked', String(b.getAttribute('data-theme-pick') === pref));
    });
  }
  if (mq) {
    var onScheme = function () { if (themePref() === 'auto') applyTheme('auto'); };
    if (mq.addEventListener) mq.addEventListener('change', onScheme); else if (mq.addListener) mq.addListener(onScheme);
  }
  var themeBtn = $('themeBtn'), themeMenu = $('themeMenu');
  function menuOpen(open) {
    themeMenu.hidden = !open;
    themeBtn.setAttribute('aria-expanded', String(open));
    if (open) { var cur = themeMenu.querySelector('[aria-checked="true"]') || themeMenu.querySelector('button'); cur.focus(); }
  }
  themeBtn.addEventListener('click', function () { menuOpen(themeMenu.hidden); });
  themeMenu.addEventListener('click', function (e) {
    var b = e.target.closest('[data-theme-pick]');
    if (!b) return;
    var pref = b.getAttribute('data-theme-pick');
    if (pref === 'auto') store.del(K.theme); else store.set(K.theme, pref);
    applyTheme(pref);
    menuOpen(false);
    themeBtn.focus();
  });
  themeMenu.addEventListener('keydown', function (e) {
    var items = Array.prototype.slice.call(themeMenu.querySelectorAll('button'));
    var i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Escape') { menuOpen(false); themeBtn.focus(); }
    else if (e.key === 'Tab') menuOpen(false);
  });
  document.addEventListener('click', function (e) { if (!themeMenu.hidden && !e.target.closest('.menu-wrap')) menuOpen(false); });

  /* ---------- Сховати суми ---------- */
  function applyPrivacy(on) {
    root.classList.toggle('privacy', on);
    var b = $('privacyBtn');
    b.setAttribute('aria-pressed', String(on));
    var label = on ? 'Показати суми' : 'Сховати суми';
    b.setAttribute('aria-label', label); b.title = label;
    $('privacyUse').setAttribute('href', on ? '#i-eye-off' : '#i-eye');
  }
  $('privacyBtn').addEventListener('click', function () {
    var on = !root.classList.contains('privacy');
    store.set(K.privacy, on ? '1' : '0');
    applyPrivacy(on);
  });

  /* ---------- Оновлення ---------- */
  var toastTimer = null;
  function toast(text) {
    var t = $('toast');
    t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }
  function refresh(silent) {
    var btn = $('refreshBtn');
    if (btn.classList.contains('spin')) return;
    btn.classList.add('spin');
    fetchEnvelope(true).then(function (env) {
      if (!isEnvelope(env)) {
        if (LOCAL && env && env.positions) { show(env); return; }
        throw new Error('format');
      }
      if (state.env && env.data === state.env.data) { renderFresh(state.m); if (!silent) toast(state.offline ? 'Немає зв\'язку, показую збережене' : 'Нових даних ще немає'); return; }
      state.env = env;
      return savedKey(env).then(function (key) {
        if (!key) { showLock(true); return; }
        return decrypt(key, env).then(function (data) { show(data); if (!silent) toast('Дані оновлено'); }, function () { store.del(K.key); showLock(true); });
      });
    }).catch(function () { if (!silent) toast('Не вдалося оновити. Перевір інтернет'); })
      .then(function () { btn.classList.remove('spin'); });
  }
  $('refreshBtn').addEventListener('click', function () { refresh(false); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && state.data && Date.now() - state.fetchedAt > 30 * 60e3) refresh(true);
  });
  $('fatalRetry').addEventListener('click', start);
  $('forgetBtn').addEventListener('click', function () {
    store.del(K.key);
    state.data = null;
    toast('Пароль забуто на цьому пристрої');
    showLock(false);
  });

  /* ---------- Тінь панелі під час прокрутки ---------- */
  var bar = $('bar');
  window.addEventListener('scroll', function () { bar.classList.toggle('scrolled', window.scrollY > 4); }, { passive: true });

  /* ---------- Перемальовування графіків, коли змінюється їхній розмір ---------- */
  var sizes = {}, rafId = 0;
  function redrawIfResized() {
    rafId = 0;
    if (!state.m || $('app').hidden) return;
    ['chart', 'spark', 'gChart'].forEach(function (id) {
      var el = $(id), key = el.clientWidth + 'x' + el.clientHeight;
      if (!el.clientWidth || sizes[id] === key) return;
      sizes[id] = key;
      if (id === 'chart') drawLine(el, series(state.period, state.m));
      else if (id === 'spark') { var t = trendWindow(state.m); if (t) drawSpark(el, t.pts); }
      else if (state.m.snaps.length >= 2) {
        var c = compareSnaps(state.m, state.gFrom || growthStart(state.gperiod, state.m));
        if (c) drawStack(el, state.m, state.m.snaps.slice(c.ia));
      }
    });
  }
  function scheduleRedraw() { if (!rafId) rafId = requestAnimationFrame(redrawIfResized); }
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(scheduleRedraw);
    ro.observe($('chart')); ro.observe($('spark')); ro.observe($('gChart'));
  } else window.addEventListener('resize', scheduleRedraw);

  /* ---------- Встановлення як застосунок ---------- */
  var deferred = null;
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferred = e; $('installBtn').hidden = false; });
  window.addEventListener('appinstalled', function () { deferred = null; $('installBtn').hidden = true; toast('Портфель встановлено'); });
  $('installBtn').addEventListener('click', function () {
    if (!deferred) return;
    deferred.prompt();
    deferred.userChoice.then(function () { deferred = null; $('installBtn').hidden = true; });
  });
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js', { scope: './' }).catch(function () { /* без офлайну */ }); });
  }

  /* ---------- Старт ---------- */
  applyTheme(themePref());
  applyPrivacy(root.classList.contains('privacy'));
  var go = function () { start(); };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(go, go); else go();
})();
