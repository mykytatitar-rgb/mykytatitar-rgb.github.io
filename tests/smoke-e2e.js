// Наскрізна перевірка основних сценаріїв «Справ» на комп'ютері й телефоні (з підміненим сервером).
// Запуск: node tests/smoke-e2e.js
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const PORT = 8801, SITE = `http://localhost:${PORT}`;
const SB = 'https://kcxqienzhopnsqmykhqv.supabase.co';
const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const day = n => iso(new Date(Date.now() + n * 864e5));
const T0 = day(0);
const rows = new Map();
function put(kind, data) { if (kind === 'todo_task' && !data.seen) data.seen = T0; rows.set(kind + '/' + data.id, { kind, id: data.id, data, deleted: false, updated_at: new Date().toISOString() }); }
put('todo_list', { id: 'my', name: 'Мої завдання', order: 0, color: '#5fa89a', visible: true });
put('todo_list', { id: 'work', name: 'WORK', order: 1, color: '#7c9fd6', visible: true });
put('todo_task', { id: 'a', listId: 'my', title: 'Pay rent', starred: true, due: T0, order: 1 });
put('todo_task', { id: 'b', listId: 'work', title: 'Write report', due: day(-1), order: 1 });
put('todo_task', { id: 'c', listId: 'my', title: 'Call mom', focus: T0, est: 15, order: 2 });
put('todo_task', { id: 'd', listId: 'work', title: 'Team meeting', due: T0, start: '15:00', end: '16:00', order: 2 });
put('todo_task', { id: 'e', listId: 'my', title: 'Future thing', due: day(5), order: 3 });
put('todo_task', { id: 'h', listId: 'my', title: 'Vitamins', due: T0, repeat: 'daily', order: 4 });
const saves = [];
function json(route, status, body) { return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: { 'access-control-allow-origin': '*' } }); }
async function sb(route) {
  const req = route.request(), url = new URL(req.url());
  if (url.pathname === '/auth/v1/token') return json(route, 200, { access_token: 'a', refresh_token: 'r', user: { id: 'u1', email: 'me@x' } });
  if (url.pathname === '/rest/v1/records') return json(route, 200, [...rows.values()]);
  if (url.pathname.endsWith('save_record')) { const b = JSON.parse(req.postData()); saves.push(b.p_id); put(b.p_kind, b.p_data); return json(route, 200, 1); }
  return json(route, 404, {});
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function assert(c, m) { console.log((c ? 'ok: ' : 'FAIL: ') + m); if (!c) process.exitCode = 1; }
const errs = [];
async function open(browser, opts) {
  const ctx = await browser.newContext(opts);
  await ctx.route(SB + '/**', sb);
  await ctx.route(/fonts\.(googleapis|gstatic)\.com|mymemory|languagetool/, r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const p = await ctx.newPage();
  p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
  await p.goto(SITE + '/'); await p.fill('#lgEmail', 'me@x'); await p.fill('#lgPass', 'p'); await p.click('#lgBtn');
  await p.waitForSelector('#app:not([hidden])'); await sleep(1200);
  return p;
}
const task = id => rows.get('todo_task/' + id).data;
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: path.join(__dirname, '..'), stdio: 'ignore' });
  await sleep(800);
  const browser = await chromium.launch();
  try {
    // ---------- комп'ютер ----------
    const D = await open(browser, { viewport: { width: 1400, height: 900 } });
    await D.click('#views .nav-item:has-text("Усі списки")'); await sleep(300);
    assert(await D.locator('.col').count() === 2, 'дошка: дві колонки');
    const titles = await D.locator('.col .task-title').allTextContents();
    assert(titles.includes('Pay rent') && !titles.includes('Future thing'), 'майбутнє сховане, сьогоднішнє видно');
    // додати
    await D.locator('.col').first().locator('.add-row').click(); await sleep(200);
    await D.locator('.col').first().locator('.add-input input').fill('Buy bread');
    await D.locator('.col').first().locator('.add-input input').press('Enter'); await sleep(1600);
    assert([...rows.values()].some(r => r.data.title === 'Buy bread'), 'додане завдання на сервері');
    // виконати
    await D.locator('.col .task', { hasText: 'Buy bread' }).locator('.check').click(); await sleep(1800);
    assert([...rows.values()].find(r => r.data.title === 'Buy bread').data.done === true, 'виконане на сервері');
    // картка: назва, нотатки, дата
    await D.locator('.col .task', { hasText: 'Pay rent' }).locator('.task-body').click(); await D.waitForSelector('.drawer');
    await D.fill('#d-notes', 'до 20-го'); await sleep(200);
    await D.click('#d-due'); await D.locator('.dp .dp-link', { hasText: 'Сьогодні' }).click(); await sleep(200);
    await D.keyboard.press('Escape'); await sleep(1600);
    assert(task('a').notes === 'до 20-го', 'нотатки збережено');
    assert(await D.locator('.drawer').count() === 0, 'Escape закрив картку');
    // розділи
    for (const v of ['Зараз', 'Сьогодні', 'Матриця', 'Календар', 'Важливі']) {
      await D.click('#views .nav-item:has-text("' + v + '")'); await sleep(350);
      assert(await D.locator('#board').evaluate(b => b.textContent.trim().length > 20), 'розділ «' + v + '» намальовано');
    }
    await D.click('#views .nav-item:has-text("Матриця")'); await sleep(300);
    assert(await D.locator('.quad.q1 .task', { hasText: 'Pay rent' }).count() === 1, 'матриця: важливе й термінове');
    await D.click('#views .nav-item:has-text("Сьогодні")'); await sleep(300);
    assert(await D.locator('.focus-group .task', { hasText: 'Call mom' }).count() === 1, 'сьогодні: головне');
    assert(await D.locator('.late-group .task', { hasText: 'Write report' }).count() === 1, 'сьогодні: з минулих днів');
    await D.click('#views .nav-item:has-text("Календар")'); await sleep(400);
    assert(await D.locator('.cal').count() === 1 && /Team meeting/.test(await D.locator('.cal').textContent()), 'календар: подія з часом');
    await D.click('#views .nav-item:has-text("Зараз")'); await sleep(300);
    assert(/Call mom/.test(await D.locator('.now-title').textContent()), 'зараз: головна справа першою');
    // ---------- телефон ----------
    const M = await open(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    assert(await M.locator('.now-card, .now-empty').count() === 1, 'телефон відкривається на «Зараз»');
    assert(await M.evaluate(() => document.documentElement.scrollWidth <= 392), 'без горизонтальної прокрутки');
    await M.click('#fab'); await sleep(300);
    await M.fill('#as-title', 'Phone task'); await M.locator('.add-sheet button:has-text("Додати")').click(); await sleep(1600);
    assert([...rows.values()].some(r => r.data.title === 'Phone task'), 'телефон: додане на сервері');
    await M.locator('.add-sheet button:has-text("Закрити")').click(); await sleep(300);
    for (const v of ['Списки', 'Сьогодні', 'Матриця', 'Календар']) {
      await M.click('#bnav button:has-text("' + v + '")'); await sleep(350);
      assert(await M.evaluate(() => document.documentElement.scrollWidth <= 392), 'телефон «' + v + '»: без горизонтальної прокрутки');
    }
    assert(!errs.length, 'без помилок у консолі ' + errs.join('; '));
  } finally { await browser.close(); srv.kill(); }
})();
