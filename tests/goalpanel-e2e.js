// Розділ «Ціль» на широкому екрані: підписані вузли доріжки, панель «Навіщо / Темп / Якщо-то / Перемоги»,
// упорядкування кроків за номером. Запуск: node tests/goalpanel-e2e.js
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const PORT = 8812, SITE = `http://localhost:${PORT}`;
const SB = /url:\s*'([^']+)'/.exec(fs.readFileSync(path.join(__dirname, '..', 'config.js'), 'utf8'))[1];
const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const day = n => iso(new Date(Date.now() + n * 864e5)), T0 = day(0);
const rows = new Map();
function put(kind, data) { if (kind === 'todo_task' && !data.seen) data.seen = T0; rows.set(kind + '/' + data.id, { kind, id: data.id, data, deleted: false, updated_at: new Date().toISOString() }); }
put('todo_list', { id: 'my', name: 'Мої завдання', order: 0, visible: true });
put('todo_task', { id: 'g', listId: 'my', title: 'Finish DA course', goal: true, due: day(14), order: 1 });
// 1–3 пройдено (за останні 2 тижні), 4–6 відкриті, але в зворотному порядку; «Final project» без номера — в кінці
put('todo_task', { id: 'a1', listId: 'my', parentId: 'g', title: 'Lesson 1', done: true, doneAt: day(-10), order: 1 });
put('todo_task', { id: 'a2', listId: 'my', parentId: 'g', title: 'Lesson 2', done: true, doneAt: day(-4), order: 2 });
put('todo_task', { id: 'a3', listId: 'my', parentId: 'g', title: 'Lesson 3', done: true, doneAt: day(-1), order: 3 });
put('todo_task', { id: 'a6', listId: 'my', parentId: 'g', title: 'Lesson 6', order: 4 });
put('todo_task', { id: 'a5', listId: 'my', parentId: 'g', title: 'Lesson 5', order: 5 });
put('todo_task', { id: 'a4', listId: 'my', parentId: 'g', title: 'Lesson 4', order: 6 });
put('todo_task', { id: 'fp', listId: 'my', parentId: 'g', title: 'Final project', order: 7 });
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
const task = id => rows.get('todo_task/' + id).data;
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
    const D = await open(browser, { viewport: { width: 1700, height: 1000 } });
    await D.click('#views .nav-item:has-text("Ціль")'); await sleep(300);
    // підписи на доріжці
    const labels = await D.locator('#board .rm-track .rm-label').allTextContents();
    assert(labels.length >= 5, 'вузли доріжки підписані: ' + labels.join(' | '));
    assert(labels.some(l => /^1\b.*Lesson 1/.test(l)), 'підпис з номером кроку: ' + labels[0]);
    assert(await D.locator('#board .rm-track .rm-node.locked', { hasText: /^\d+$/ }).count() >= 1, 'на закритих вузлах — номер, а не замок');
    // вузол відкриває картку кроку
    await D.locator('#board .rm-track .rm-node.done').first().click(); await D.waitForSelector('.drawer', { timeout: 3000 }).catch(() => {});
    assert(await D.locator('.drawer').count() === 1, 'клік по вузлу відкриває картку кроку');
    await D.keyboard.press('Escape'); await sleep(400);
    // панель праворуч, не порожнеча
    const side = D.locator('#board .goal-side');
    assert(await side.count() === 1, 'є бокова панель цілі');
    const box = await side.boundingBox(), main = await D.locator('#board .goal-main').boundingBox();
    assert(box && main && box.x > main.x + main.width - 4, 'панель стоїть праворуч від доріжки');
    // темп і прогноз
    const pace = await side.locator('.gp-pace').textContent();
    assert(/0[.,]8/.test(pace) && /тиж/.test(pace), 'темп: 3 кроки за 4 тижні = 0.8 на тиждень: ' + pace);
    assert(/фініш|прогноз/i.test(pace), 'є прогноз фінішу');
    assert(await side.locator('.gp-bars i').count() === 8, 'стовпчики за 8 тижнів');
    // перемоги
    const wins = await side.locator('.gp-wins li').allTextContents();
    assert(wins[0] && /Lesson 3/.test(wins[0]), 'перемоги: найсвіжіша зверху: ' + wins);
    // навіщо + якщо-то зберігаються
    await side.locator('textarea[name=why]').fill('Податися на junior DA');
    await side.locator('textarea[name=why]').blur(); await sleep(1700);
    assert(task('g').why === 'Податися на junior DA', '«Навіщо» збережено');
    // як людина: клік у поле й друк; перехід у сусіднє поле не губить фокус
    await side.locator('input[name=obstacle]').click(); await D.keyboard.type('втомився після роботи');
    await side.locator('input[name=ifThen]').click(); await sleep(100); await D.keyboard.type('дивлюсь 10 хвилин уроку');
    await D.locator('#board h2').click(); await sleep(1700);
    assert(task('g').obstacle === 'втомився після роботи' && task('g').ifThen === 'дивлюсь 10 хвилин уроку', '«Якщо… то…» збережено: ' + JSON.stringify([task('g').obstacle, task('g').ifThen]));
    // упорядкування за номером
    const fix = D.locator('#board button', { hasText: 'Упорядкувати за номером' });
    assert(await fix.count() === 1, 'кроки не по порядку — є кнопка «Упорядкувати за номером»');
    await fix.click(); await sleep(1700);
    const ord = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'fp'].map(id => task(id).order);
    assert(ord.every((o, i) => !i || o > ord[i - 1]), 'тепер 1…6, далі Final project: ' + ord);
    assert(/Lesson 4/.test(await D.locator('#board .rm-step').textContent()), 'крок на сьогодні — Lesson 4');
    assert(await D.locator('#board button', { hasText: 'Упорядкувати за номером' }).count() === 0, 'кнопка зникла');
    assert(await D.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'без горизонтальної прокрутки');
    // телефон: усе в одну колонку, без прокрутки вбік
    const M = await open(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await M.locator('#menuBtn, .menu-btn, [aria-label="Меню"]').first().click(); await sleep(400);
    await M.locator('#views .nav-item', { hasText: 'Ціль' }).click(); await sleep(400);
    assert(await M.locator('#board .goal-side').count() === 1, 'телефон: панель є (під доріжкою)');
    assert(await M.evaluate(() => document.documentElement.scrollWidth <= 392), 'телефон: без горизонтальної прокрутки');
    await D.screenshot({ path: '/tmp/claude-0/-home-user/bafb89b7-c7f8-578b-95e4-6ee3fa365e31/scratchpad/goalpanel.png' });
    assert(!errs.length, 'без помилок ' + errs.join('; '));
  } finally { await browser.close(); srv.kill(); }
})();
