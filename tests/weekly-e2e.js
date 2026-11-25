// «N разів на тиждень», «за весь час», легка версія й «Полегшити»
// Запуск: node tests/weekly-e2e.js (потрібен playwright). Сервер Supabase підмінено.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const PORT = 8800, SITE = `http://localhost:${PORT}`;
const SB = 'https://kcxqienzhopnsqmykhqv.supabase.co';
const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const day = n => iso(new Date(Date.now() + n * 864e5));
const T0 = day(0);
const dow = (new Date().getDay() + 6) % 7;            // 0 = понеділок
const NEXT_MON = day(7 - dow);
const rows = new Map();
function put(kind, data) { if (kind === 'todo_task' && !data.seen) data.seen = T0; rows.set(kind + '/' + data.id, { kind, id: data.id, data, deleted: false, updated_at: new Date().toISOString() }); }
put('todo_list', { id: 'my', name: 'Мої завдання', order: 0, color: '#5fa89a', visible: true });
put('todo_task', { id: 'gym', listId: 'my', title: 'Gym', due: T0, repeat: 'w2', focus: T0, est: 60, easy: '15 хв розминки вдома', order: 1 });
// цього тижня — нічого; раніше — двічі (рахується «за весь час»)
put('todo_task', { id: 'g1', listId: 'my', title: 'Gym', done: true, doneAt: day(-30), habit: 'gym', order: 9 });
put('todo_task', { id: 'g2', listId: 'my', title: 'Gym', done: true, doneAt: day(-40), habit: 'gym', order: 9 });
function json(route, status, body) { return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: { 'access-control-allow-origin': '*' } }); }
async function sb(route) {
  const req = route.request(), url = new URL(req.url());
  if (url.pathname === '/auth/v1/token') return json(route, 200, { access_token: 'a', refresh_token: 'r', user: { id: 'u1', email: 'me@x' } });
  if (url.pathname === '/rest/v1/records') return json(route, 200, [...rows.values()]);
  if (url.pathname.endsWith('save_record')) { const b = JSON.parse(req.postData()); put(b.p_kind, b.p_data); return json(route, 200, 1); }
  return json(route, 404, {});
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function assert(c, m) { console.log((c ? 'ok: ' : 'FAIL: ') + m); if (!c) process.exitCode = 1; }
const errs = [];
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: path.join(__dirname, '..'), stdio: 'ignore' });
  await sleep(800);
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.route(SB + '/**', sb);
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    const D = await ctx.newPage(); D.on('pageerror', e => errs.push(e.message));
    await D.goto(SITE + '/'); await D.fill('#lgEmail', 'me@x'); await D.fill('#lgPass', 'p'); await D.click('#lgBtn');
    await D.waitForSelector('#app:not([hidden])'); await sleep(1200);
    await D.click('#views .nav-item:has-text("Усі списки")'); await sleep(300);
    const gymRow = () => D.locator('.col .task', { hasText: 'Gym' }).filter({ hasNot: D.locator('.check[aria-label*="невиконаним"]') }).first();
    const chip = await gymRow().locator('.chip.habit').textContent({ timeout: 3000 }).catch(() => '');
    assert(/0\/2/.test(chip) && /тиж/.test(chip), 'норма тижня 0/2: ' + chip);
    assert(/2/.test(await gymRow().locator('.chip.total').textContent({ timeout: 3000 }).catch(() => '')), '«за весь час» 2');
    await gymRow().locator('.task-body').click(); await D.waitForSelector('.drawer');
    const opts = await D.locator('#d-rep option').allTextContents();
    assert(opts.some(o => /3 рази на тиждень/.test(o)), 'у повторах є «3 рази на тиждень»: ' + opts);
    assert(await D.inputValue('#d-easy', { timeout: 3000 }).catch(() => '') === '15 хв розминки вдома', 'у картці поле «Мінімум»');
    await D.keyboard.press('Escape'); await sleep(300);
    // «Зараз»: «Полегшити» показує мінімум; виконання мінімуму зараховується
    await D.click('#views .nav-item:has-text("Зараз")'); await sleep(300);
    assert(/Gym/.test(await D.locator('.now-title').textContent()), 'у «Зараз» — Gym');
    await D.locator('.now-card button', { hasText: 'Полегшити' }).click({ timeout: 3000 }).catch(() => {}); await sleep(300);
    assert(/15 хв розминки вдома/.test(await D.locator('.now-title').textContent()), 'показано мінімум: ' + await D.locator('.now-title').textContent());
    assert(/Gym/.test(await D.locator('.now-card .easy-of').textContent({ timeout: 3000 }).catch(() => '')), 'видно, замість чого');
    await D.locator('.now-actions button', { hasText: 'Готово' }).click(); await sleep(1700);
    const copy = [...rows.values()].find(r => r.data.habit === 'gym' && r.data.doneAt === T0);
    assert(copy && copy.data.easyDone === true, 'мінімум зараховано (позначено як легка версія)');
    const gym = rows.get('todo_task/gym').data;
    assert(gym.due === day(1) || (dow === 6 && gym.due === NEXT_MON), 'норма ще не виконана — знову завтра: ' + gym.due);
    // друге виконання (із «Заплановано»): норму виконано — звичка ховається до понеділка
    await D.click('#views .nav-item:has-text("Усі списки")'); await sleep(300);
    await D.locator('.col .done-toggle', { hasText: 'Заплановано' }).click(); await sleep(300);
    await gymRow().locator('.check').click(); await sleep(1700);
    assert(rows.get('todo_task/gym').data.due === NEXT_MON, 'норму виконано — до понеділка: ' + rows.get('todo_task/gym').data.due + ' (очікував ' + NEXT_MON + ')');
    const chip2 = await gymRow().locator('.chip.habit').textContent({ timeout: 3000 }).catch(() => '');
    assert(/2\/2/.test(chip2), 'тепер 2/2: ' + chip2);
    assert(/4/.test(await gymRow().locator('.chip.total').textContent({ timeout: 3000 }).catch(() => '')), 'за весь час 4');
    assert(!errs.length, 'без помилок ' + errs.join('; '));
  } finally { await browser.close(); srv.kill(); }
})();
