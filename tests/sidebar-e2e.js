// Ліва панель згортається як шторка: лишається смужка з іконками розділів; стан пам'ятається; «[» — згорнути/розгорнути.
// На телефоні — без змін (там своє меню). Запуск: node tests/sidebar-e2e.js
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const PORT = 8816, SITE = `http://localhost:${PORT}`;
const SB = /url:\s*'([^']+)'/.exec(fs.readFileSync(path.join(__dirname, '..', 'config.js'), 'utf8'))[1];
const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const T0 = iso(new Date());
const rows = new Map();
function put(kind, data) { if (kind === 'todo_task' && !data.seen) data.seen = T0; rows.set(kind + '/' + data.id, { kind, id: data.id, data, deleted: false, updated_at: new Date().toISOString() }); }
put('todo_list', { id: 'my', name: 'Мої завдання', order: 0, visible: true });
put('todo_list', { id: 'wm', name: 'WORK_MATH', order: 1, visible: true });
put('todo_task', { id: 'a', listId: 'my', title: 'First', due: T0, order: 1 });
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
async function open(browser, opts) {
  const ctx = await browser.newContext(opts);
  await ctx.route(SB + '/**', sb);
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
  await p.goto(SITE + '/'); await p.fill('#lgEmail', 'me@x'); await p.fill('#lgPass', 'p'); await p.click('#lgBtn');
  await p.waitForSelector('#app:not([hidden])'); await sleep(1200);
  return p;
}
const width = (p, sel) => p.evaluate(s => document.querySelector(s).getBoundingClientRect().width, sel);
const left = (p, sel) => p.evaluate(s => document.querySelector(s).getBoundingClientRect().left, sel);
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: path.join(__dirname, '..'), stdio: 'ignore' });
  await sleep(800);
  const browser = await chromium.launch();
  try {
    const D = await open(browser, { viewport: { width: 1600, height: 950 } });
    assert(await width(D, '#side') > 240, 'спершу панель розгорнута');
    const mainLeft0 = await left(D, '.main');
    const toggle = D.locator('#sideToggle');
    assert(await toggle.isVisible() && /Згорнути/.test(await toggle.getAttribute('aria-label')), 'біля логотипа — кнопка «Згорнути панель»');
    await toggle.click(); await sleep(500);
    assert(await width(D, '#side') <= 80, 'згорнута — вузька смужка: ' + await width(D, '#side') + ' px');
    assert(mainLeft0 - await left(D, '.main') >= 160, 'справи посунулись ліворуч і стали ширшими');
    assert(await D.locator('#side .nav-item .lbl').first().isVisible() === false, 'у смужці — лише іконки, без підписів');
    assert(!(await D.locator('#lists').isVisible()) && !(await D.locator('#themes').isVisible()), 'списки й налаштування сховані');
    assert(/Розгорнути/.test(await toggle.getAttribute('aria-label')) && await toggle.getAttribute('aria-expanded') === 'false', 'кнопка тепер «Розгорнути панель»');
    // іконки працюють: «Сьогодні»
    const todayIcon = D.locator('#views .nav-item[title="Сьогодні"]');
    assert(await todayIcon.isVisible(), 'іконка «Сьогодні» з підказкою');
    await todayIcon.click(); await sleep(400);
    assert(await D.locator('#board .today-main').count() === 1, 'клік по іконці відкриває розділ');
    assert(await D.locator('#create').isVisible(), '«Нове завдання» лишається кнопкою з плюсом');
    // стан пам'ятається
    await D.reload(); await D.waitForSelector('#app:not([hidden])').catch(() => {}); await sleep(1200);
    if (await D.locator('#lgBtn').isVisible().catch(() => false)) { await D.fill('#lgEmail', 'me@x'); await D.fill('#lgPass', 'p'); await D.click('#lgBtn'); await sleep(1200); }
    assert(await width(D, '#side') <= 80, 'після перезавантаження — так само згорнута');
    // «[» — розгорнути
    await D.locator('body').click({ position: { x: 900, y: 30 } }).catch(() => {});
    await D.keyboard.press('['); await sleep(500);
    assert(await width(D, '#side') > 240, '«[» розгортає панель назад');
    await D.keyboard.press('['); await sleep(500);
    assert(await width(D, '#side') <= 80, '«[» знову згортає');
    // телефон: своє меню, кнопки-шторки немає
    const M = await open(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    assert(!(await M.locator('#sideToggle').isVisible().catch(() => false)), 'телефон: кнопки-шторки немає');
    assert(await M.evaluate(() => document.documentElement.scrollWidth <= 392), 'телефон: без горизонтальної прокрутки');
    assert(!errs.length, 'без помилок ' + errs.join('; '));
  } finally { await browser.close(); srv.kill(); }
})();
