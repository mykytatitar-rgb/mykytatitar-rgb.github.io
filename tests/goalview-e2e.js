// Розділ «Ціль» у меню: велика дорожня карта, усі кроки (і виконані), «Зняти ціль»; на телефоні — у меню ☰
// Запуск: node tests/goalview-e2e.js
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const PORT = 8809, SITE = `http://localhost:${PORT}`;
const SB = /url:\s*'([^']+)'/.exec(fs.readFileSync(path.join(__dirname, '..', 'config.js'), 'utf8'))[1];
const iso = d => d.toISOString().slice(0, 10), day = n => iso(new Date(Date.now() + n * 864e5)), T0 = day(0);
const rows = new Map();
function put(kind, data) { if (kind === 'todo_task' && !data.seen) data.seen = T0; rows.set(kind + '/' + data.id, { kind, id: data.id, data, deleted: false, updated_at: new Date().toISOString() }); }
put('todo_list', { id: 'my', name: 'Мої завдання', order: 0, visible: true });
put('todo_task', { id: 'g', listId: 'my', title: 'Finish DA course', goal: true, due: day(10), order: 1 });
put('todo_task', { id: 's0', listId: 'my', parentId: 'g', title: 'Module 1', done: true, doneAt: day(-3), order: 0 });
put('todo_task', { id: 's1', listId: 'my', parentId: 'g', title: 'Module 2', order: 1 });
put('todo_task', { id: 's2', listId: 'my', parentId: 'g', title: 'Module 3', order: 2 });
function json(route, status, body) { return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: { 'access-control-allow-origin': '*' } }); }
async function sb(route) {
  const req = route.request(), url = new URL(req.url());
  if (url.pathname === '/auth/v1/token') return json(route, 200, { access_token: 'a', refresh_token: 'r', user: { id: 'u1', email: 'me@x' } });
  if (url.pathname === '/rest/v1/records') return json(route, 200, [...rows.values()]);
  if (url.pathname.endsWith('save_record')) { const b = JSON.parse(req.postData()); put(b.p_kind, b.p_data); return json(route, 200, 1); }
  return json(route, 200, 1);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function assert(c, m) { console.log((c ? 'ok: ' : 'FAIL: ') + m); if (!c) process.exitCode = 1; }
const errs = [];
async function open(browser, opts) {
  const ctx = await browser.newContext(opts);
  await ctx.route(SB + '/**', sb);
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
  await p.goto(SITE + '/'); await p.fill('#lgEmail', 'me@x'); await p.fill('#lgPass', 'p'); await p.click('#lgBtn');
  await p.waitForSelector('#app:not([hidden])'); await sleep(1200);
  return p;
}
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: path.join(__dirname, '..'), stdio: 'ignore' });
  await sleep(800);
  const browser = await chromium.launch();
  try {
    const D = await open(browser, { viewport: { width: 1300, height: 900 } });
    const nav = D.locator('#views .nav-item', { hasText: 'Ціль' });
    assert(await nav.count() === 1, 'у меню є розділ «Ціль»');
    assert(/1\/3/.test(await nav.textContent()), 'біля нього прогрес 1/3: ' + await nav.textContent());
    await nav.click(); await sleep(300);
    assert(await D.locator('#board .roadmap').count() === 1, 'у розділі — дорожня карта');
    const steps = D.locator('#board .goal-steps');
    assert(await steps.count() === 1, 'і список усіх кроків');
    const open1 = await steps.locator('.task:not(.done) .task-title').allTextContents();
    assert(open1.join() === 'Module 2,Module 3', 'кроки по порядку: ' + open1);
    assert(/Module 1/.test(await steps.textContent()), 'пройдені кроки теж видно');
    // відмітити крок у списку — доріжка рушає
    await steps.locator('.task', { hasText: 'Module 2' }).locator('.check').click(); await sleep(1800);
    assert(rows.get('todo_task/s1').data.done === true, 'крок відмічено');
    assert(/2\/3/.test(await D.locator('#board .roadmap .rm-info').textContent()), 'доріжка: 2/3');
    // зняти ціль
    await D.locator('#board button', { hasText: 'Зняти ціль' }).click(); await sleep(1600);
    assert(rows.get('todo_task/g').data.goal === false, 'ціль знято');
    assert(await D.locator('#board .roadmap.rm-empty').count() === 1, 'у розділі — запрошення поставити ціль');
    // телефон: у меню ☰
    const M = await open(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await M.locator('#menuBtn, .menu-btn, [aria-label="Меню"]').first().click(); await sleep(400);
    assert(await M.locator('#views .nav-item', { hasText: 'Ціль' }).isVisible(), 'телефон: «Ціль» у меню');
    await M.locator('#views .nav-item', { hasText: 'Ціль' }).click(); await sleep(400);
    assert(await M.locator('#board .roadmap').count() === 1, 'телефон: розділ відкрився');
    assert(await M.evaluate(() => document.documentElement.scrollWidth <= 392), 'телефон: без горизонтальної прокрутки');
    assert(!errs.length, 'без помилок ' + errs.join('; '));
  } finally { await browser.close(); srv.kill(); }
})();
