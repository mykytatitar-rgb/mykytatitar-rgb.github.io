/* Мови для «Справ»: визначити мову тексту, перекласти його й надиктувати.

   Переклад — MyMemory (api.mymemory.translated.net): відкритий сервіс, що
   відповідає браузеру напряму (CORS) і не потребує ключа. Тож у коді сайту
   немає жодного секрету. Без ключа він дає близько 5000 символів на день з
   однієї адреси, а один запит — до 500 байтів тексту. Тому кожен переклад
   кешується в браузері: те саме завдання вдруге не перекладається.

   Голос — Web Speech API браузера (Chrome, Edge, Safari; у Firefox немає). */

(function () {
  'use strict';

  var API = 'https://api.mymemory.translated.net/get';
  var CACHE_KEY = 'spravy.tr';
  var CACHE_MAX = 500;                       // перекладів у кеші; найстаріші витісняються
  var MAX_BYTES = 450;                       // ліміт сервісу — 500 байтів на запит
  var SPEECH = { uk: 'uk-UA', en: 'en-US', es: 'es-ES' };

  /** Мова тексту завдання: uk, es чи en. Кирилиця — українська; іспанські літери чи слова — іспанська. */
  function detect(text) {
    var s = String(text || '');
    if (/[Ѐ-ӿ]/.test(s)) return 'uk';
    if (/[ñ¿¡áéíóúü]/i.test(s) ||
        /(^|[^\p{L}])(el|la|los|las|del|que|para|con|por|una|y|de|comprar|compra|hacer|tengo|mañana)(?=$|[^\p{L}])/iu.test(s)) return 'es';
    return 'en';
  }

  /** Куди перекладати: українське — англійською й іспанською, решту — українською. */
  function targets(lang) { return lang === 'uk' ? ['en', 'es'] : ['uk']; }

  /* ---------- кеш: { "uk>en:текст": [переклад, коли додано] } ---------- */
  var cache = null;
  function load() {
    if (cache) return cache;
    try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {}; } catch (e) { cache = {}; }
    return cache;
  }
  function remember(key, text) {
    var c = load();
    c[key] = [text, Date.now()];
    var keys = Object.keys(c);
    if (keys.length > CACHE_MAX) {
      keys.sort(function (a, b) { return c[a][1] - c[b][1]; })
        .slice(0, keys.length - CACHE_MAX).forEach(function (k) { delete c[k]; });
    }
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (e) { /* немає місця — живемо без кешу */ }
  }

  var pending = {};   // ті самі запити, що вже летять, не дублюємо

  /** Переклад одного тексту з from на to. Promise<рядок>; помилка — з людським поясненням. */
  function translate(text, from, to) {
    var q = String(text || '').trim();
    var key = from + '>' + to + ':' + q;
    var hit = load()[key];
    if (hit) return Promise.resolve(hit[0]);
    if (pending[key]) return pending[key];
    if (new TextEncoder().encode(q).length > MAX_BYTES) return Promise.reject(new Error('задовгий текст для безкоштовного перекладу'));
    var url = API + '?q=' + encodeURIComponent(q) + '&langpair=' + from + '|' + to;
    pending[key] = fetch(url).then(function (res) {
      if (!res.ok) throw new Error(res.status === 429 ? 'вичерпано денний ліміт перекладів' : 'сервіс перекладу не відповів');
      return res.json();
    }).then(function (j) {
      var out = j && j.responseData && j.responseData.translatedText;
      if (Number(j.responseStatus) !== 200 || !out || /MYMEMORY WARNING/i.test(out)) {
        throw new Error(Number(j.responseStatus) === 429 || /MYMEMORY WARNING/i.test(out || '') ? 'вичерпано денний ліміт перекладів' : 'сервіс перекладу не зміг');
      }
      remember(key, out);
      return out;
    }, function (e) {
      if (e && e.message && /ліміт|сервіс/.test(e.message)) throw e;
      throw new Error('немає зв\'язку з сервісом перекладу');
    });
    pending[key].then(clear, clear);
    function clear() { delete pending[key]; }
    return pending[key];
  }

  /** Усі потрібні переклади тексту: Promise<[{ lang, text } | { lang, error }]>. Помилка одного не ховає інших. */
  function translations(text) {
    var from = detect(text);
    return Promise.all(targets(from).map(function (to) {
      return translate(text, from, to).then(
        function (t) { return { lang: to, text: t }; },
        function (e) { return { lang: to, error: e.message }; });
    }));
  }

  /** Те, що вже є в кеші, без мережі: щоб повторна підказка з'являлась одразу. */
  function cached(text) {
    var from = detect(text), q = String(text || '').trim(), c = load();
    var all = targets(from).map(function (to) { var hit = c[from + '>' + to + ':' + q]; return hit && { lang: to, text: hit[0] }; });
    return all.every(Boolean) ? all : null;
  }

  /* ---------- голос ---------- */
  var Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  var active = null;

  /** Надиктувати текст мовою lang (uk/en/es). onText(текст, остаточний?), onState(чи йде запис). */
  function listen(lang, onText, onState) {
    if (!Rec) return false;
    if (active) { active.stop(); return true; }    // другий дотик — зупинити
    var r = new Rec();
    r.lang = SPEECH[lang] || SPEECH.uk;
    r.interimResults = true;
    r.continuous = false;
    r.onresult = function (e) {
      var text = '', final = false;
      for (var i = 0; i < e.results.length; i++) { text += e.results[i][0].transcript; final = final || e.results[i].isFinal; }
      onText(text.trim(), final);
    };
    r.onerror = function (e) { onState(false, e && e.error); };
    r.onend = function () { active = null; onState(false); };
    active = r;
    onState(true);
    try { r.start(); } catch (e) { active = null; onState(false, 'start'); }
    return true;
  }

  window.SpravyLingo = {
    detect: detect, targets: targets, translations: translations, cached: cached,
    canListen: !!Rec, listen: listen, NAMES: { uk: 'UA', en: 'EN', es: 'ES' }
  };
})();
