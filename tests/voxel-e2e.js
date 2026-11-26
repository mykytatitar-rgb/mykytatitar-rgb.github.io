// Блоковий світ цілі: відкривається ліниво, будувати лише заробленим, зберігається, поточний крок під рукою.
// Запуск: node tests/voxel-e2e.js
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const PORT = 8818, SITE = `http://localhost:${PORT}`;
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
const build = () => (rows.get('goal_build/g') || { data: { blocks: [] } }).data.blocks;
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: path.join(__dirname, '..'), stdio: 'ignore' });
  await sleep(800);
  const browser = await chromium.launch();
  try {
    const D = await open(browser, { viewport: { width: 1600, height: 950 } });
    await D.click('#views .nav-item:has-text("Ціль")'); await sleep(300);
    assert(await D.evaluate(() => !window.SpravyVoxel), 'світ не вантажиться, доки його не відкрили');
    await D.locator('#board .rm-build-btn').click(); await sleep(1500);
    const vx = D.locator('.vx');
    assert(await vx.isVisible() && await vx.locator('canvas').count() === 1, '«Будувати» відкриває блоковий світ');
    assert(/72/.test(await vx.locator('.vx-budget').textContent()), 'за 6 пройдених кроків — 72 блоки: ' + await vx.locator('.vx-budget').textContent());
    assert(/Lesson 7/.test(await vx.locator('.vx-step').textContent()) && await vx.locator('.vx-step button', { hasText: 'Почати' }).count() === 1, 'поточний крок і «Почати» під рукою');
    await D.screenshot({ path: SHOT + 'voxel.png' });
    const c = await vx.locator('canvas').boundingBox(), cx = c.x + c.width / 2, cy = c.y + c.height / 2;
    await vx.locator('.vx-pal button', { hasText: 'Цегла' }).click();
    await D.mouse.click(cx, cy); await sleep(1700);
    assert(build().length === 1 && build()[0][3] === 6, 'клік ставить цеглу, і вона зберігається: ' + JSON.stringify(build()));
    assert(/71/.test(await vx.locator('.vx-budget').textContent()), 'запас зменшився до 71');
    await D.keyboard.down('Shift'); await D.mouse.click(cx, cy); await D.keyboard.up('Shift'); await sleep(1700);
    assert(build().length === 0 && /72/.test(await vx.locator('.vx-budget').textContent()), 'Shift+клік прибирає свій блок, запас повертається');
    await D.mouse.click(cx, cy); await sleep(1700);
    await D.keyboard.press('Escape'); await sleep(400);
    assert(await D.locator('.vx').count() === 0, 'Esc закриває світ');
    // після перезавантаження збудоване на місці
    await D.reload(); await sleep(1500);
    await D.click('#views .nav-item:has-text("Ціль")'); await sleep(300);
    await D.locator('#board .rm-build-btn').click(); await sleep(1500);
    assert(/71/.test(await D.locator('.vx .vx-budget').textContent()), 'після перезавантаження збудоване на місці');
    await D.locator('.vx .vx-step button', { hasText: 'Почати' }).click(); await sleep(500);
    assert(await D.locator('.vx').count() === 0 && await D.locator('#kick').evaluate(e => e.children.length > 0), '«Почати»: світ закрився, пішов таймер кроку');
    assert(!errs.length, 'без помилок ' + errs.join('; '));
  } finally { await browser.close(); srv.kill(); }
})();
