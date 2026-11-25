// Ціль: додати наявні справи кроками (зокрема виконані); з картки справи — «Крок цілі»
// Запуск: node tests/attach-e2e.js
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const PORT = 8808, SITE = `http://localhost:${PORT}`;
const SB = /url:\s*'([^']+)'/.exec(fs.readFileSync(path.join(__dirname, '..', 'config.js'), 'utf8'))[1];
const iso = d => d.toISOString().slice(0, 10), day = n => iso(new Date(Date.now() + n * 864e5)), T0 = day(0);
const rows = new Map();
function put(kind, data) { if (kind === 'todo_task' && !data.seen) data.seen = T0; rows.set(kind + '/' + data.id, { kind, id: data.id, data, deleted: false, updated_at: new Date().toISOString() }); }
put('todo_list', { id: 'my', name: 'Мої завдання', order: 0, visible: true });
put('todo_list', { id: 'da', name: 'DA/ML', order: 1, visible: true });
put('todo_task', { id: 'g', listId: 'my', title: 'Finish DA course', goal: true, order: 1 });
put('todo_task', { id: 's1', listId: 'my', parentId: 'g', title: 'Module 3', order: 1 });
put('todo_task', { id: 'd1', listId: 'da', title: 'Module 1 watched', done: true, doneAt: day(-5), order: 5 });
put('todo_task', { id: 'd2', listId: 'da', title: 'Module 2 quiz', done: true, doneAt: day(-2), order: 6 });
put('todo_task', { id: 'o1', listId: 'da', title: 'Final project', order: 7 });
put('todo_task', { id: 'o2', listId: 'my', title: 'Certificate PDF', order: 8 });
put('todo_task', { id: 'h', listId: 'my', title: 'Daily SQL', due: T0, repeat: 'daily', order: 9 });
put('todo_task', { id: 'hc', listId: 'my', title: 'Daily SQL', done: true, doneAt: day(-1), habit: 'h', order: 9 });
put('todo_task', { id: 'p', listId: 'my', title: 'Has kids', order: 10 });
put('todo_task', { id: 'pk', listId: 'my', parentId: 'p', title: 'kid', order: 1 });
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
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: path.join(__dirname, '..'), stdio: 'ignore' });
  await sleep(800);
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
    await ctx.route(SB + '/**', sb);
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    const D = await ctx.newPage(); D.on('pageerror', e => errs.push(e.message));
    await D.goto(SITE + '/'); await D.fill('#lgEmail', 'me@x'); await D.fill('#lgPass', 'p'); await D.click('#lgBtn');
    await D.waitForSelector('#app:not([hidden])'); await sleep(1200);
    await D.click('#views .nav-item:has-text("Зараз")'); await sleep(300);
    await D.locator('.roadmap button', { hasText: 'Додати наявні' }).click({ timeout: 3000 }).catch(() => {}); await sleep(300);
    const pick = D.locator('.attach-pick');
    assert(await pick.count() === 1, 'відкрився вибір наявних справ');
    const names = await pick.locator('.cand-title').allTextContents();
    assert(names.includes('Module 1 watched') && names.includes('Module 2 quiz') && names.includes('Final project'), 'є й виконані, й відкриті: ' + names);
    assert(!names.includes('Daily SQL') && !names.includes('Has kids') && !names.includes('Finish DA course') && !names.includes('Module 3'), 'без звичок, справ з підзавданнями, самої цілі й наявних кроків');
    await pick.locator('input[type=search]').fill('module'); await sleep(200);
    assert((await pick.locator('.cand-title').allTextContents()).every(t => /module/i.test(t)), 'пошук фільтрує');
    await pick.locator('.cand', { hasText: 'Module 1 watched' }).click();
    await pick.locator('.cand', { hasText: 'Module 2 quiz' }).click();
    await pick.locator('input[type=search]').fill(''); await sleep(200);
    await pick.locator('.cand', { hasText: 'Final project' }).click();
    await pick.locator('button', { hasText: /Додати 3/ }).click(); await sleep(1700);
    assert(['d1', 'd2', 'o1'].every(id => task(id).parentId === 'g' && task(id).listId === 'my'), 'три справи стали кроками цілі');
    assert(task('d1').done && task('d2').done, 'виконані лишились виконаними');
    const rm = D.locator('.roadmap');
    assert(/2\/4/.test(await rm.textContent()), 'прогрес 2/4: ' + await rm.locator('.rm-info').textContent());
    const ord = ['d1', 'd2', 's1', 'o1'].map(id => task(id).order);
    assert(ord[0] < ord[1] && ord[1] < ord[2] && ord[2] < ord[3], 'порядок: виконані на початку (за датою), далі наявний крок, далі нові: ' + ord);
    assert(/Module 3/.test(await rm.locator('.rm-step').textContent()), 'крок на сьогодні — перший невиконаний');
    // «Скасувати» повертає як було
    await D.locator('.toast button', { hasText: /Скасувати|Повернути/ }).click(); await sleep(1700);
    assert(task('d1').parentId === '' && task('d1').listId === 'da' && task('o1').parentId === '', 'скасовано: справи на своїх місцях');
    // з картки справи
    await D.click('#views .nav-item:has-text("Усі списки")'); await sleep(300);
    await D.locator('.col .task', { hasText: 'Certificate PDF' }).locator('.task-body').click(); await D.waitForSelector('.drawer');
    await D.locator('.drawer button', { hasText: 'Крок цілі' }).click(); await sleep(1700);
    assert(task('o2').parentId === 'g', 'з картки: стала кроком цілі');
    assert(!errs.length, 'без помилок ' + errs.join('; '));
  } finally { await browser.close(); srv.kill(); }
})();
