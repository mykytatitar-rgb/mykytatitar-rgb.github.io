// Сервер на паузі через вичерпаний ліміт Supabase (402 exceed_egress_quota):
// зрозуміле пояснення, зміни лишаються на пристрої, повтори не засипають сервер.
// Запуск: node tests/quota-e2e.js
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const PORT = 8805, SITE = `http://localhost:${PORT}`;
const SB = 'https://kcxqienzhopnsqmykhqv.supabase.co';
const T0 = new Date().toISOString().slice(0, 10);
const rows = [{ kind: 'todo_list', id: 'my', data: { id: 'my', name: 'Мої завдання', order: 0, visible: true }, deleted: false, updated_at: new Date().toISOString() },
  { kind: 'todo_task', id: 'a', data: { id: 'a', listId: 'my', title: 'Old task', order: 1, seen: T0 }, deleted: false, updated_at: new Date().toISOString() }];
let blocked = false, hits = 0;
const QUOTA = { code: '402', message: 'Service for this project is restricted due to the following violations: exceed_egress_quota. The project owner must upgrade their plan or remove spend caps to restore service.' };
function json(route, status, body) { return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: { 'access-control-allow-origin': '*' } }); }
async function sb(route) {
  const url = new URL(route.request().url());
  if (url.pathname === '/auth/v1/token') return json(route, 200, { access_token: 'a', refresh_token: 'r', user: { id: 'u1', email: 'me@x' } });
  if (blocked) { hits++; return json(route, 402, QUOTA); }
  if (url.pathname === '/rest/v1/records') return json(route, 200, rows);
  return json(route, 200, 1);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function assert(c, m) { console.log((c ? 'ok: ' : 'FAIL: ') + m); if (!c) process.exitCode = 1; }
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: path.join(__dirname, '..'), stdio: 'ignore' });
  await sleep(800);
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.route(SB + '/**', sb);
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    const D = await ctx.newPage();
    await D.goto(SITE + '/'); await D.fill('#lgEmail', 'me@x'); await D.fill('#lgPass', 'p'); await D.click('#lgBtn');
    await D.waitForSelector('#app:not([hidden])'); await sleep(1200);
    blocked = true;
    await D.click('#views .nav-item:has-text("Усі списки")'); await sleep(300);
    await D.locator('.col .add-row').first().click();
    await D.locator('.col .add-input input').first().fill('Offline task');
    await D.locator('.col .add-input input').first().press('Enter'); await sleep(2500);
    const msg = await D.locator('#sync').textContent();
    assert(/ліміт/i.test(msg) && !/exceed_egress_quota/.test(msg), 'зрозуміле пояснення замість англійської помилки: ' + msg);
    assert(/збережен/i.test(msg), 'каже, що зміни збережено на пристрої');
    assert(await D.locator('.col .task-title', { hasText: 'Offline task' }).count() === 1, 'нова справа лишилась на екрані');
    const before = hits;
    await sleep(40000);   // звичайно це 2 повтори й 2 опитування
    assert(hits - before === 0, 'за 40 с жодного повтору до заблокованого сервера (було б ~4): ' + (hits - before));
    // сервер ожив: вручну «Спробувати зараз» — усе поїхало
    blocked = false;
    const retry = D.locator('#sync button', { hasText: 'Спробувати' });
    assert(await retry.count() === 1, 'є «Спробувати зараз»');
    await retry.click(); await sleep(2500);
    assert(/Синхронізовано/.test(await D.locator('#sync').textContent()), 'після відновлення — синхронізовано');
  } finally { await browser.close(); srv.kill(); }
})();
