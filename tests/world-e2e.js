// Мапа цілі на весь екран: 3D-світ від «Старту» до «Фінішу», усі кроки, персонаж, прогулянка й дії з кроками.
// Запуск: node tests/world-e2e.js
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const PORT = 8813, SITE = `http://localhost:${PORT}`;
const SB = /url:\s*'([^']+)'/.exec(fs.readFileSync(path.join(__dirname, '..', 'config.js'), 'utf8'))[1];
const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const day = n => iso(new Date(Date.now() + n * 864e5)), T0 = day(0);
const rows = new Map();
function put(kind, data) { if (kind === 'todo_task' && !data.seen) data.seen = T0; rows.set(kind + '/' + data.id, { kind, id: data.id, data, deleted: false, updated_at: new Date().toISOString() }); }
put('todo_list', { id: 'my', name: 'Мої завдання', order: 0, visible: true });
put('todo_task', { id: 'g', listId: 'my', title: 'Finish DA course', goal: true, order: 1 });
for (let i = 1; i <= 13; i++) put('todo_task', { id: 's' + i, listId: 'my', parentId: 'g', title: 'Lesson ' + i, order: i, done: i <= 6, doneAt: i <= 6 ? day(i - 14) : '' });
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
const SHOT = '/tmp/claude-0/-home-user/bafb89b7-c7f8-578b-95e4-6ee3fa365e31/scratchpad/';
async function open(browser, opts) {
  const ctx = await browser.newContext(opts);
  await ctx.route(SB + '/**', sb);
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
  await p.goto(SITE + '/'); await p.fill('#lgEmail', 'me@x'); await p.fill('#lgPass', 'p'); await p.click('#lgBtn');
  await p.waitForSelector('#app:not([hidden])'); await sleep(1200);
  return p;
}
const camOf = p => p.evaluate(() => getComputedStyle(document.querySelector('.w-ground')).transform);
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: path.join(__dirname, '..'), stdio: 'ignore' });
  await sleep(800);
  const browser = await chromium.launch();
  try {
    const D = await open(browser, { viewport: { width: 1600, height: 950 } });
    await D.click('#views .nav-item:has-text("Ціль")'); await sleep(300);
    // на доріжці видно, що попереду вікна ще є пройдені кроки — і де старт
    assert(/ще 4/.test(await D.locator('#board .rm-more').textContent().catch(() => '')), 'на доріжці: «ще 4» до старту');
    // мапа
    await D.locator('#board .rm-world-btn').click(); await sleep(700);
    const w = D.locator('.world');
    assert(await w.count() === 1 && await w.isVisible(), 'мапа відкрилась на весь екран');
    assert(await w.locator('.w-start').count() === 1 && /Старт/.test(await w.locator('.w-start').textContent()), 'є «Старт»');
    assert(await w.locator('.w-finish').count() === 1 && /Finish DA course/.test(await w.locator('.w-finish').textContent()), 'є фініш з назвою цілі');
    assert(await w.locator('.w-node').count() === 13, 'усі 13 кроків на мапі');
    assert(await w.locator('.w-node.done').count() === 6 && await w.locator('.w-node.now').count() === 1, '6 пройдено, 1 поточний');
    const lab = await w.locator('.w-label').allTextContents();
    assert(lab.some(t => /1 · Lesson 1/.test(t)) && lab.some(t => /13 · Lesson 13/.test(t)), 'кроки підписані від 1 до 13');
    assert(await w.locator('.w-me svg.avatar').count() === 1, 'персонаж у світі');
    assert(await w.locator('canvas.w-sprites').count() === 1 && await D.evaluate(() => window.SpravyWorld.layout(13).decor.length) >= 10, 'світ: дерева навколо (на полотні)');
    assert(await w.locator('.w-fog').count() === 1, 'туман над непройденим');
    await D.screenshot({ path: SHOT + 'world.png' });
    // прогулянка: тягнути мишею й колесо
    const c0 = await camOf(D);
    await D.mouse.move(800, 500); await D.mouse.down(); await D.mouse.move(800, 300, { steps: 6 }); await D.mouse.up(); await sleep(200);
    assert(await camOf(D) !== c0, 'перетягування рухає камеру');
    await w.locator('button', { hasText: 'Старт' }).click(); await sleep(900);
    const st = await w.locator('.w-start').boundingBox();
    assert(st && st.y > 0 && st.y < 950 && st.x > 0 && st.x < 1600, '«Старт» переносить до початку шляху');
    await D.screenshot({ path: SHOT + 'world-start.png' });
    await w.locator('button', { hasText: 'До мене' }).click(); await sleep(900);
    // клік по поточному кроку: картка з діями
    await w.locator('.w-node.now').click(); await sleep(300);
    const pop = w.locator('.w-pop');
    assert(/Крок 7 з 13/.test(await pop.textContent()) && /Lesson 7/.test(await pop.textContent()), 'картка кроку: «Крок 7 з 13»');
    await pop.locator('button', { hasText: 'Зроблено' }).click(); await sleep(1700);
    assert(rows.get('todo_task/s7').data.done === true, 'крок відмічено просто з мапи');
    assert(await w.locator('.w-node.done').count() === 7 && /Lesson 8/.test(await w.locator('.w-node.now').getAttribute('aria-label')), 'персонаж іде до кроку 8');
    // відкрити картку справи з мапи
    await w.locator('button', { hasText: 'Старт' }).click(); await sleep(900);
    await w.locator('.w-node.done').first().click(); await sleep(300);
    await w.locator('.w-pop button', { hasText: 'Відкрити картку' }).click(); await sleep(500);
    assert(await D.locator('.world').count() === 0 && await D.locator('.drawer').count() === 1, 'мапа закрилась, відкрилась картка кроку');
    await D.keyboard.press('Escape'); await sleep(400);
    // Esc закриває мапу
    await D.locator('#board .rm-world-btn').click(); await sleep(500);
    await D.keyboard.press('Escape'); await sleep(400);
    assert(await D.locator('.world').count() === 0, 'Esc закриває мапу');
    // з «Зараз» теж
    await D.click('#views .nav-item:has-text("Зараз")'); await sleep(300);
    assert(await D.locator('.roadmap .rm-world-btn').count() === 1, 'кнопка мапи є і в картці на «Зараз»');
    // телефон
    const M = await open(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await M.locator('.roadmap .rm-world-btn').first().tap(); await sleep(700);
    assert(await M.locator('.world').isVisible(), 'телефон: мапа відкрилась');
    assert(await M.locator('.world .w-close').isVisible(), 'телефон: видно «Закрити»');
    await M.screenshot({ path: SHOT + 'world-phone.png' });
    await M.goBack().catch(() => {}); await sleep(500);
    assert(await M.locator('.world').count() === 0, 'телефон: «Назад» закриває мапу');
    assert(!errs.length, 'без помилок ' + errs.join('; '));
  } finally { await browser.close(); srv.kill(); }
})();
