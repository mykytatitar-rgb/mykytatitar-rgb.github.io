// «Сьогодні» на широкому екрані: права колонка — день (час, навантаження, наступне), звички тижня, перемоги.
// На телефоні колонки немає. Запуск: node tests/todayside-e2e.js
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const PORT = 8815, SITE = `http://localhost:${PORT}`;
const SB = /url:\s*'([^']+)'/.exec(fs.readFileSync(path.join(__dirname, '..', 'config.js'), 'utf8'))[1];
const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const day = n => iso(new Date(Date.now() + n * 864e5)), T0 = day(0);
const rows = new Map();
function put(kind, data) { if (kind === 'todo_task' && !data.seen) data.seen = T0; rows.set(kind + '/' + data.id, { kind, id: data.id, data, deleted: false, updated_at: new Date().toISOString() }); }
put('todo_list', { id: 'my', name: 'Мої завдання', order: 0, visible: true });
put('todo_task', { id: 'f1', listId: 'my', title: 'Write report', focus: T0, est: 60, order: 1 });
put('todo_task', { id: 't1', listId: 'my', title: 'Call bank', due: T0, est: 30, order: 2 });
put('todo_task', { id: 't2', listId: 'my', title: 'Standup', due: T0, start: '15:00', end: '15:30', order: 3 });
put('todo_task', { id: 'l1', listId: 'my', title: 'Old thing', due: day(-2), order: 4 });
put('todo_task', { id: 'gym', listId: 'my', title: 'Gym', due: day(1), repeat: 'w3', order: 5 });
put('todo_task', { id: 'gc', listId: 'my', title: 'Gym', done: true, doneAt: T0, habit: 'gym', order: 9 });
put('todo_task', { id: 'sql', listId: 'my', title: 'Daily SQL', due: T0, repeat: 'daily', order: 6 });
put('todo_task', { id: 's1', listId: 'my', title: 'Daily SQL', done: true, doneAt: day(-1), habit: 'sql', order: 9 });
put('todo_task', { id: 'w1', listId: 'my', title: 'Morning run', done: true, doneAt: T0, order: 7 });
put('todo_task', { id: 'w2', listId: 'my', title: 'Lesson 5', done: true, doneAt: T0, order: 8 });
function json(route, status, body) { return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: { 'access-control-allow-origin': '*' } }); }
async function sb(route) {
  const req = route.request(), url = new URL(req.url());
  if (url.pathname === '/auth/v1/token') return json(route, 200, { access_token: 'a', refresh_token: 'r', user: { id: 'u1', email: 'me@x' } });
  if (url.pathname === '/rest/v1/records') return json(route, 200, [...rows.values()]);
  return json(route, 200, 1);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function assert(c, m) { console.log((c ? 'ok: ' : 'FAIL: ') + m); if (!c) process.exitCode = 1; }
const errs = [];
async function open(browser, hour, opts) {
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 1600, height: 950 } }, opts || {}));
  await ctx.clock.setFixedTime(new Date(T0 + 'T' + hour + ':00'));
  await ctx.route(SB + '/**', sb);
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
  await p.goto(SITE + '/'); await p.fill('#lgEmail', 'me@x'); await p.fill('#lgPass', 'p'); await p.click('#lgBtn');
  await p.waitForSelector('#app:not([hidden])'); await sleep(1200);
  if (!opts) { await p.click('#views .nav-item:has-text("Сьогодні")'); await sleep(400); }
  return p;
}
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: path.join(__dirname, '..'), stdio: 'ignore' });
  await sleep(800);
  const browser = await chromium.launch();
  try {
    const D = await open(browser, '13:00');
    const side = D.locator('#board .today-side'), main = D.locator('#board .today-main');
    assert(await side.count() === 1 && await side.isVisible(), 'праворуч від справ — колонка дня');
    const sb1 = await side.boundingBox(), mb = await main.boundingBox();
    assert(sb1 && mb && sb1.x >= mb.x + mb.width - 4, 'вона стоїть праворуч, а не під списком');
    assert(await D.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'без горизонтальної прокрутки');
    // день: зараз, скільки лишилось, навантаження, наступне
    const dayCard = side.locator('.ds-day');
    const dt = await dayCard.textContent();
    assert(/Зараз 13:00/.test(dt) && /до 22:00/.test(dt) && /9 год/.test(dt), 'час дня: «Зараз 13:00 · до 22:00 лишилось 9 год»: ' + dt);
    assert(/Заплановано 2 год/.test(dt), 'заплановано: година + 30 хв + зустріч 30 хв = 2 год: ' + dt);
    assert(/1 без оцінки/.test(dt), 'скільки справ без оцінки часу');
    assert(/Standup/.test(dt) && /через 2 год/.test(dt), 'наступне: Standup через 2 год');
    assert(await dayCard.locator('.ts-now').count() === 1 && await dayCard.locator('.ts-ev').count() === 1, 'смужка дня: «зараз» і подія');
    assert(await dayCard.locator('.ds-warn').count() === 0, 'план вміщається в день — без тривоги');
    // звички тижня
    const hab = side.locator('.ds-habits');
    const ht = await hab.textContent();
    assert(/Gym/.test(ht) && /1\/3/.test(ht), 'звичка «3 рази на тиждень»: Gym 1/3: ' + ht);
    const dots = hab.locator('.hb-row', { hasText: 'Daily SQL' }).locator('.hb-dot');
    assert(await dots.count() === 7 && await hab.locator('.hb-row', { hasText: 'Daily SQL' }).locator('.hb-dot.today').count() === 1, 'щоденна звичка: 7 днів тижня, сьогодні позначено');
    // перемоги
    const wt = await side.locator('.ds-wins').textContent();
    assert(/Morning run/.test(wt) && /Lesson 5/.test(wt), 'перемоги сьогодні праворуч: ' + wt);
    assert(!(await main.locator('.group-label.win').isVisible().catch(() => false)), 'у списку зліва зроблене не повторюється');
    await D.screenshot({ path: '/tmp/claude-0/-home-user/bafb89b7-c7f8-578b-95e4-6ee3fa365e31/scratchpad/today-side.png' });
    // вечір: плану більше, ніж лишилось дня
    const E = await open(browser, '21:00');
    const warn = E.locator('#board .today-side .ds-warn');
    assert(await warn.count() === 1 && /більш/.test(await warn.textContent()), 'о 21:00 план не вміщається — підказка: ' + await warn.textContent().catch(() => ''));
    assert(await warn.locator('button', { hasText: 'Обрати головне' }).count() === 1, 'і кнопка «Обрати головне»');
    // телефон: колонки немає
    const M = await open(browser, '13:00', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await M.click('#bnav button:has-text("Сьогодні")'); await sleep(400);
    assert(!(await M.locator('#board .today-side').isVisible().catch(() => false)), 'телефон: колонки дня немає');
    assert(await M.evaluate(() => document.documentElement.scrollWidth <= 392), 'телефон: без горизонтальної прокрутки');
    assert(!errs.length, 'без помилок ' + errs.join('; '));
  } finally { await browser.close(); srv.kill(); }
})();
