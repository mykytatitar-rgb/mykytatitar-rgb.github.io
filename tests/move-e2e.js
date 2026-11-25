// Переїзд на окремий сервер Supabase: старий пристрій просить увійти ще раз і перечитує все;
// «Забули пароль?» і посилання з листа. Запуск: node tests/move-e2e.js
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const PORT = 8806, SITE = `http://localhost:${PORT}`;
const cfg = fs.readFileSync(path.join(__dirname, '..', 'config.js'), 'utf8');
const SB = /url:\s*'([^']+)'/.exec(cfg)[1];
const T0 = new Date().toISOString().slice(0, 10);
const calls = [];
const rows = [{ kind: 'todo_list', id: 'my', data: { id: 'my', name: 'Мої завдання', order: 0, visible: true }, deleted: false, updated_at: '2026-11-01T10:00:00Z' },
  { kind: 'todo_task', id: 'srv', data: { id: 'srv', listId: 'my', title: 'From server', order: 1, seen: T0 }, deleted: false, updated_at: '2026-11-01T10:00:00Z' }];
function json(route, status, body) { return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: { 'access-control-allow-origin': '*' } }); }
async function sb(route) {
  const req = route.request(), url = new URL(req.url());
  calls.push([req.method(), url.pathname + url.search, req.postData() || '', req.headers()['authorization'] || '']);
  if (url.pathname === '/auth/v1/token') return json(route, 200, { access_token: 'new-at', refresh_token: 'new-rt', user: { id: 'u1', email: 'me@x' } });
  if (url.pathname === '/auth/v1/recover') return json(route, 200, {});
  if (url.pathname === '/auth/v1/user') return json(route, 200, { id: 'u1', email: 'me@x' });
  if (url.pathname === '/rest/v1/records') return json(route, 200, rows);
  if (url.pathname.endsWith('save_record')) { const b = JSON.parse(req.postData()); rows.push({ kind: b.p_kind, id: b.p_id, data: b.p_data, deleted: false, updated_at: new Date().toISOString() }); }
  return json(route, 200, 1);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function assert(c, m) { console.log((c ? 'ok: ' : 'FAIL: ') + m); if (!c) process.exitCode = 1; }
const errs = [];
async function ctxWith(browser, init) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 860 } });
  if (init) await ctx.addInitScript(init);
  await ctx.route(SB + '/**', sb);
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
  return p;
}
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: path.join(__dirname, '..'), stdio: 'ignore' });
  await sleep(800);
  const browser = await chromium.launch();
  try {
    // 1) пристрій зі старого сервера: сесія, справи, черга й «since» звідти
    const OLD = `if (!sessionStorage.getItem('seeded')) {
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('spravy.auth', JSON.stringify({ access_token: 'old-at', refresh_token: 'old-rt', email: 'me@x' }));
      localStorage.setItem('spravy.owner', 'me@x');
      localStorage.setItem('spravy.since', '2026-11-20T10:00:00Z');
      localStorage.setItem('spravy.db', JSON.stringify({ lists: { my: { id: 'my', name: 'Мої завдання', order: 0, visible: true } },
        tasks: { loc: { id: 'loc', listId: 'my', title: 'Unsent local', order: 2, seen: '${T0}' } } }));
      localStorage.setItem('spravy.outbox', JSON.stringify({ 'todo_task/loc': 5 }));
    }`;
    const A = await ctxWith(browser, OLD);
    await A.goto(SITE + '/'); await sleep(1200);
    assert(await A.locator('#login').isVisible(), 'після переїзду просить увійти');
    assert(/сервер/i.test(await A.locator('#lgErr').textContent()) && /той самий|тим самим/i.test(await A.locator('#lgErr').textContent()), 'пояснює переїзд і що пароль той самий: ' + await A.locator('#lgErr').textContent());
    assert(!calls.some(c => c[3] === 'Bearer old-at'), 'старий ключ сесії на новий сервер не йде');
    assert(await A.inputValue('#lgEmail') === 'me@x', 'пошта вже вписана');
    await A.fill('#lgPass', 'p'); await A.click('#lgBtn');
    await A.waitForSelector('#app:not([hidden])'); await sleep(2500);
    const pull = calls.find(c => c[1].startsWith('/rest/v1/records'));
    assert(pull && !/updated_at=gte/.test(pull[1]), 'перше читання — повне, з нуля: ' + (pull && pull[1].slice(0, 80)));
    assert(calls.some(c => /save_record/.test(c[1]) && /Unsent local/.test(c[2])), 'невідправлене з черги поїхало на новий сервер');
    await A.click('#views .nav-item:has-text("Усі списки")'); await sleep(300);
    const titles = await A.locator('.col .task-title').allTextContents();
    assert(titles.includes('From server') && titles.includes('Unsent local'), 'на екрані й серверне, й локальне: ' + titles);
    // наступне відкриття — без повторного входу
    calls.length = 0;
    await A.reload(); await sleep(1500);
    assert(await A.locator('#app').isVisible() && !(await A.locator('#login').isVisible()), 'вдруге вхід не просить');
    // 2) «Забули пароль?»
    const B = await ctxWith(browser);
    await B.goto(SITE + '/'); await sleep(800);
    await B.fill('#lgEmail', 'me@x');
    await B.locator('#login button', { hasText: 'Забули пароль' }).click(); await sleep(800);
    const rec = calls.find(c => c[1].startsWith('/auth/v1/recover'));
    assert(rec && /me@x/.test(rec[2]) && /redirect_to=/.test(rec[1]), 'запит на лист для скидання: ' + (rec && rec[1]));
    assert(/лист/i.test(await B.locator('#lgErr').textContent()), 'каже перевірити пошту');
    // 3) посилання з листа: новий пароль
    const C = await ctxWith(browser);
    await C.goto(SITE + '/#access_token=rec-at&refresh_token=rec-rt&expires_in=3600&token_type=bearer&type=recovery'); await sleep(1200);
    assert(await C.locator('#newPass').isVisible(), 'форма нового пароля');
    assert(!/access_token/.test(C.url()), 'ключі з адреси прибрано');
    await C.fill('#newPass', 'brand-new-pass'); await C.locator('#login button', { hasText: 'Зберегти пароль' }).click(); await sleep(1500);
    const put = calls.find(c => c[0] === 'PUT' && c[1] === '/auth/v1/user');
    assert(put && /brand-new-pass/.test(put[2]) && put[3] === 'Bearer rec-at', 'пароль змінено ключем з листа');
    assert(await C.locator('#app').isVisible(), 'після цього — одразу в застосунку');
    assert(!errs.length, 'без помилок ' + errs.join('; '));
  } finally { await browser.close(); srv.kill(); }
})();
