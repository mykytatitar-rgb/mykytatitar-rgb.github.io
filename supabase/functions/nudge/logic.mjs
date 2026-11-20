/* Що й коли надіслати на телефон. Чиста функція: час, пояс людини, її справи й те, що вже
   надсилали, → список нагадувань. Сервер (index.ts) лише читає дані й відправляє.

   Навіщо: при СДУГ «не бачу — не існує». Застосунок, який треба самому згадати відкрити,
   програє. Тому три поштовхи на день, не більше:
   - ранок (9:00–9:59): з чого почати — головна справа або «оберіть головне»;
   - справа з часом: за 10 хвилин до початку;
   - вечір (20:00–20:59): закрити день і обрати головне на завтра. */

var MORNING = 9, EVENING = 20, BEFORE_MIN = 10, DEFAULT_TZ = 'Europe/Kyiv';

/** Місцеві дата й час людини: { day: 'YYYY-MM-DD', hour, minute }. Кривий пояс — Київ. */
export function localTime(ms, tz) {
  var f;
  try { f = new Intl.DateTimeFormat('en-CA', { timeZone: tz || DEFAULT_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
  catch (e) { f = new Intl.DateTimeFormat('en-CA', { timeZone: DEFAULT_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
  var p = {};
  f.formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
  return { day: p.year + '-' + p.month + '-' + p.day, hour: Number(p.hour) % 24, minute: Number(p.minute) };
}

function nextDay(day) {
  var d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
function minutes(hhmm) { var p = String(hhmm).split(':'); return Number(p[0]) * 60 + Number(p[1]); }

/** tasks: дані записів todo_task; sent: Set ключів, уже надісланих цій людині. */
export function decide(ms, tz, tasks, sent) {
  var now = localTime(ms, tz), day = now.day, out = [];
  var open = (tasks || []).filter(function (t) { return t && !t.done && !t.parentId; });
  function push(key, title, body, url) { if (!sent.has(key)) out.push({ key: key, title: title, body: body, url: url }); }

  if (now.hour === MORNING) {
    var focus = open.filter(function (t) { return t.focus === day; });
    if (focus.length) push('m:' + day, 'Доброго ранку', 'Почніть з «' + focus[0].title + '». Лише перший крок.', './?view=now');
    else push('m:' + day, 'Доброго ранку', 'Оберіть до трьох головних на сьогодні. Хвилина.', './?plan=1');
  }

  var nowMin = now.hour * 60 + now.minute;
  open.forEach(function (t) {
    if (t.due !== day || !/^\d\d:\d\d$/.test(t.start || '')) return;
    var left = minutes(t.start) - nowMin;
    if (left >= 0 && left <= BEFORE_MIN) push('s:' + t.id + ':' + day, t.title, 'О ' + t.start + (left ? ', за ' + left + ' хв' : ', уже зараз'), './?view=now');
  });

  if (now.hour === EVENING) {
    var tomorrow = nextDay(day);
    var picked = open.some(function (t) { return t.focus === tomorrow; });
    if (!picked) {
      var left = open.filter(function (t) { return t.repeat === 'none' && ((t.due && t.due <= day) || t.focus === day); }).length;
      push('e:' + day, 'Закрити день', left
        ? 'Лишилось ' + left + '. Дві хвилини: що на завтра, і головне на завтра.'
        : 'Оберіть головне на завтра: уранці буде легше почати.', './?evening=1');
    }
  }
  return out;
}
