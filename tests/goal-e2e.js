// Ціль з дорожньою картою, персонаж у «Зараз», новий вигляд у світлій і темній темі
// Запуск: node tests/goal-e2e.js
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const PORT = 8802, SITE = `http://localhost:${PORT}`;
const SB = 'https://erhtylomzzqojqarilje.supabase.co';
const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const day = n => iso(new Date(Date.now() + n * 864e5));
const T0 = day(0);
const rows = new Map();
function put(kind, data) { if (kind === 'todo_task' && !data.seen) data.seen = T0; rows.set(kind + '/' + data.id, { kind, id: data.id, data, deleted: false, updated_at: new Date().toISOString() }); }
put('todo_list', { id: 'my', name: 'Мої завдання', order: 0, color: '#5fa89a', visible: true });
put('todo_task', { id: 'g', listId: 'my', title: 'Finish ML course', due: day(6), order: 1 });
put('todo_task', { id: 's1', listId: 'my', parentId: 'g', title: 'Lesson 1', done: true, doneAt: day(-3), order: 1 });
put('todo_task', { id: 's2', listId: 'my', parentId: 'g', title: 'Lesson 2', done: true, doneAt: day(-1), order: 2 });
put('todo_task', { id: 's3', listId: 'my', parentId: 'g', title: 'Lesson 3', order: 3 });
put('todo_task', { id: 's4', listId: 'my', parentId: 'g', title: 'Final quiz', order: 4 });
put('todo_task', { id: 'gym', listId: 'my', title: 'Gym', due: T0, repeat: 'w3', order: 2 });
put('todo_task', { id: 'gc', listId: 'my', title: 'Gym', done: true, doneAt: T0, habit: 'gym', order: 9 });
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
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: 'dark' });
    await ctx.route(SB + '/**', sb);
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    const D = await ctx.newPage(); D.on('pageerror', e => errs.push(e.message));
    await D.goto(SITE + '/'); await D.fill('#lgEmail', 'me@x'); await D.fill('#lgPass', 'p'); await D.click('#lgBtn');
    await D.waitForSelector('#app:not([hidden])'); await sleep(1200);
    // «Зараз»: привітання з персонажем
    await D.click('#views .nav-item:has-text("Зараз")'); await sleep(300);
    assert(await D.locator('.hero svg.avatar').count() === 1, 'у «Зараз» — персонаж');
    assert(await D.locator('.roadmap').count() === 0, 'цілі ще немає — дорожньої карти немає');
    // зробити ціллю
    await D.click('#views .nav-item:has-text("Усі списки")'); await sleep(300);
    await D.locator('.col .done-toggle', { hasText: 'Заплановано' }).click(); await sleep(300);
    await D.locator('.col .task', { hasText: 'Finish ML course' }).locator('.task-body').click(); await D.waitForSelector('.drawer');
    await D.locator('.drawer .flag', { hasText: 'Ціль' }).click(); await sleep(300);
    await D.keyboard.press('Escape'); await sleep(1600);
    assert(rows.get('todo_task/g').data.goal === true, 'ціль збережено');
    await D.click('#views .nav-item:has-text("Зараз")'); await sleep(300);
    const rm = D.locator('.roadmap');
    assert(await rm.count() === 1, 'у «Зараз» дорожня карта цілі');
    assert(/Finish ML course/.test(await rm.textContent()) && /2\/4/.test(await rm.textContent()), 'назва й прогрес 2/4: ' + await rm.textContent());
    assert(/6 дн/.test(await rm.textContent()), 'скільки днів до дедлайну');
    assert(await rm.locator('.rm-node.done').count() === 2 && await rm.locator('.rm-node.now').count() === 1 && await rm.locator('.rm-node.locked').count() === 1, 'вузли: 2 пройдено, 1 поточний, 1 попереду');
    assert(await rm.locator('.rm-me svg.avatar').count() === 1, 'персонаж стоїть на поточному кроці');
    assert(/Lesson 3/.test(await rm.locator('.rm-step').textContent()), 'крок на сьогодні — Lesson 3');
    // виконати крок з карти — персонаж іде далі
    await rm.locator('.rm-step .check').click(); await sleep(1700);
    assert(rows.get('todo_task/s3').data.done === true, 'крок виконано');
    assert(await D.locator('.roadmap .rm-node.done').count() === 3, 'тепер 3 пройдено');
    // нова ціль замінює стару (ціль одна)
    await D.click('#views .nav-item:has-text("Усі списки")'); await sleep(300);
    await D.locator('.col .task', { hasText: 'Gym' }).filter({ hasNot: D.locator('.check[aria-label*="невиконаним"]') }).first().locator('.task-body').click();
    await D.waitForSelector('.drawer');
    await D.locator('.drawer .flag', { hasText: 'Ціль' }).click(); await sleep(300);
    await D.keyboard.press('Escape'); await sleep(1600);
    assert(rows.get('todo_task/g').data.goal === false && rows.get('todo_task/gym').data.goal === true, 'ціль одна: Gym замінила курс');
    await D.click('#views .nav-item:has-text("Сьогодні")'); await sleep(300);
    const rm2 = D.locator('.roadmap');
    assert(/1\/3/.test(await rm2.textContent()) && /тиж/.test(await rm2.textContent()), 'ціль-звичка: 1/3 цього тижня: ' + await rm2.textContent());
    assert(await rm2.locator('.rm-node').count() === 3 && await rm2.locator('.rm-node.done').count() === 1, 'вузли тижня: 3, пройдено 1');
    await D.screenshot({ path: path.join(require('os').tmpdir(), 'goal-dark.png') }).catch(() => {});
    // світла тема теж читається
    const L = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, colorScheme: 'light' });
    await L.route(SB + '/**', sb);
    await L.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    const P = await L.newPage(); P.on('pageerror', e => errs.push(e.message));
    await P.goto(SITE + '/'); await P.fill('#lgEmail', 'me@x'); await P.fill('#lgPass', 'p'); await P.click('#lgBtn');
    await P.waitForSelector('#app:not([hidden])'); await sleep(1200);
    assert(await P.locator('.hero svg.avatar').count() === 1 && await P.locator('.roadmap').count() === 1, 'телефон: персонаж і карта на «Зараз»');
    assert(await P.evaluate(() => document.documentElement.scrollWidth <= 392), 'телефон: без горизонтальної прокрутки');
    const contrast = await P.evaluate(() => {
      const el = document.querySelector('.now-go'); const c = getComputedStyle(el);
      return { fg: c.color, bg: c.backgroundImage + ' ' + c.backgroundColor };
    });
    assert(!!contrast.fg, 'кнопка «Почати» має колір: ' + JSON.stringify(contrast));
    assert(!errs.length, 'без помилок ' + errs.join('; '));
  } finally { await browser.close(); srv.kill(); }
})();
