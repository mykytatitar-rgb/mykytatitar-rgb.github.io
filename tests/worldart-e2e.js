// Мапа цілі як живий світ (комп'ютер): небо за годиною доби, острів з урвищем і хмарами,
// етапи-місцевості з брамами, річка з мостом, хатинка на старті й замок на фініші, тіні,
// мінікарта, переліт камери від старту до вас, «Почати» просто з мапи, салют, коли все пройдено.
// Запуск: node tests/worldart-e2e.js
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const PORT = 8814, SITE = `http://localhost:${PORT}`;
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
const VW = 1600, VH = 950;
async function open(browser, hour) {
  const ctx = await browser.newContext({ viewport: { width: VW, height: VH } });
  await ctx.clock.setFixedTime(new Date('2026-11-25T' + hour + ':00'));
  await ctx.route(SB + '/**', sb);
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
  await p.goto(SITE + '/'); await p.fill('#lgEmail', 'me@x'); await p.fill('#lgPass', 'p'); await p.click('#lgBtn');
  await p.waitForSelector('#app:not([hidden])'); await sleep(1200);
  await p.click('#views .nav-item:has-text("Ціль")'); await sleep(300);
  return p;
}
const inView = b => !!b && b.x + b.width > 0 && b.x < VW && b.y + b.height > 0 && b.y < VH;
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: path.join(__dirname, '..'), stdio: 'ignore' });
  await sleep(800);
  const browser = await chromium.launch();
  try {
    // день
    const D = await open(browser, '12:00');
    await D.locator('#board .rm-world-btn').click(); await sleep(150);
    const w = D.locator('.world');
    // переліт: спершу старт, звідки ви вийшли, потім камера летить до вас
    assert(inView(await w.locator('.w-start').boundingBox()), 'переліт починається зі старту');
    await sleep(2300);
    const now = await w.locator('.w-node.now').boundingBox();
    assert(now && Math.abs(now.x + now.width / 2 - VW / 2) < VW * 0.3 && now.y > VH * 0.3 && now.y < VH * 0.9, 'і закінчується на вашому кроці');
    assert(await w.getAttribute('data-sky') === 'day', 'опівдні — денне небо');
    assert(await w.locator('.w-sun').count() === 1 && await w.locator('.w-stars').count() === 0, 'сонце, без зірок');
    // острів у небі
    assert(await w.locator('.w-edge').count() >= 1, 'острів має урвище');
    assert(await w.locator('.w-cloud').count() >= 3, 'хмари навколо острова');
    // етапи-місцевості
    assert(await w.locator('.w-zone').count() === 3, 'три місцевості на 13 кроків (по 5)');
    const gates = await w.locator('.w-gate').allTextContents();
    assert(gates.length === 2 && /Етап 2/.test(gates[0]) && /Ліс/.test(gates[0]) && /Етап 3/.test(gates[1]), 'брами етапів з назвами місцевостей: ' + gates.join(' | '));
    assert(await w.locator('.w-bridge').count() === 1, 'річка з мостом на дорозі');
    assert(await w.locator('.w-house').count() === 1 && await w.locator('.w-castle').count() === 1, 'хатинка на старті, замок на фініші');
    assert(await D.evaluate(() => window.SpravyWorld.layout(13).decor.length) >= 25, 'густіший світ: рослин ' + await D.evaluate(() => window.SpravyWorld.layout(13).decor.length));
    assert(await w.locator('.w-shadow').count() >= 25, 'у дерев і будинків є тіні');
    // рослини на екрані: свої кольори (не чорні силуети) і стоять там, куди їх ставить камера (на своїх тінях)
    const shot = (await D.screenshot()).toString('base64');
    const pines = await D.evaluate(async b64 => {
      const W = window.SpravyWorld;
      const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const cx = c.getContext('2d'); cx.drawImage(img, 0, 0);
      // камера — з того, як стоїть земля на екрані
      const m = new DOMMatrix(getComputedStyle(document.querySelector('.w-ground')).transform);
      const z = parseFloat(/scale\(([\d.]+)\)/.exec(document.querySelector('.w-tilt').style.transform)[1]);
      const cam = { x: -m.m41, y: -m.m42, z }, view = { w: innerWidth, h: innerHeight };
      const ui = [...document.querySelectorAll('.w-bar, .w-mini, .w-ctrl, .w-pop, .w-over .w-bb')].map(e => e.getBoundingClientRect());
      const out = [];
      W.layout(13).decor.filter(d => d.t === 'pine').forEach(d => {
        const p = W.project(cam, view, d.x, d.y); if (!p) return;
        const w = 70 * d.s * p.k, h = 124 * d.s * p.k;
        const sx = Math.round(p.x - w * 0.12), sy = Math.round(p.y - h * 0.42);
        if (sy < innerHeight * 0.3 || sy > innerHeight - 4 || sx < 4 || sx > innerWidth - 4 || w < 14) return;
        if (ui.some(u => sx > u.left - 4 && sx < u.right + 4 && sy > u.top - 4 && sy < u.bottom + 4)) return;
        const px = cx.getImageData(sx, sy, 1, 1).data;
        out.push([px[0], px[1], px[2]]);
      });
      const st = getComputedStyle(document.querySelector('.world'));
      const hex = v => { const x = st.getPropertyValue(v).trim().replace('#', ''); return [0, 2, 4].map(i => parseInt(x.slice(i, i + 2), 16)); };
      return { px: out, pine: [hex('--pine1'), hex('--pine2')] };
    }, shot);
    const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 24);
    const hit = pines.px.filter(px => pines.pine.some(c => near(px, c)));
    assert(pines.px.length >= 5 && hit.length >= pines.px.length * 0.7, 'ялинки зелені й стоять на своїх місцях: ' + hit.length + ' з ' + pines.px.length + ' ' + JSON.stringify(pines.px.slice(0, 4)));
    // табло: прогрес і етап
    const hud = await w.locator('.w-bar').textContent();
    assert(/6 з 13/.test(hud) && /Етап 2/.test(hud) && /Ліс/.test(hud), 'табло: «6 з 13 · Етап 2: Ліс»: ' + hud);
    const prog = await w.locator('.w-prog i').evaluate(e => parseFloat(e.style.width));
    assert(Math.abs(prog - 6 / 13 * 100) < 1, 'смужка прогресу ' + prog + '%');
    await D.screenshot({ path: SHOT + 'wa-day.png' });
    // брама перед кроком не закриває його підпис (підпис переходить на інший бік дороги)
    const hidden = await D.evaluate(() => {
      const lab = [...document.querySelectorAll('.w-label')].find(e => /^6 · /.test(e.textContent));
      const gate = document.querySelector('.w-gate');
      const a = lab.getBoundingClientRect(), b = gate.getBoundingClientRect();
      const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)), h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      return Math.round(w * h / (a.width * a.height) * 100);
    });
    assert(hidden < 5, 'брама «Етап 2» не закриває підпис кроку 6 (перекрито ' + hidden + '%)');
    // піни й підписи теж клікаються
    await w.locator('.w-pin[data-step="9"]').click(); await sleep(300);
    assert(/Крок 9 з 13/.test(await w.locator('.w-pop').textContent().catch(() => '')), 'клік по номеру кроку відкриває його');
    await w.locator('.w-pop .w-x').click(); await sleep(200);
    // мінікарта
    const mini = w.locator('.w-mini');
    assert(await mini.count() === 1 && await mini.locator('.w-mini-me').count() === 1, 'мінікарта з позначкою «ви тут»');
    const mb = await mini.boundingBox();
    await D.mouse.click(mb.x + mb.width / 2, mb.y + 10); await sleep(1100);
    assert(inView(await w.locator('.w-castle').boundingBox()), 'клік угорі мінікарти переносить до замку');
    // «Почати» з мапи: таймер фокусу
    await w.locator('button', { hasText: 'До мене' }).click(); await sleep(900);
    await w.locator('.w-node.now').click(); await sleep(300);
    await w.locator('.w-pop button', { hasText: 'Почати' }).click(); await sleep(500);
    assert(await D.locator('.world').count() === 0 && await D.locator('#kick').evaluate(e => e.children.length > 0), '«Почати»: мапа закрилась, пішов таймер');
    await D.keyboard.press('Escape'); await sleep(400);
    assert(await D.locator('#kick').evaluate(e => e.children.length === 0), 'таймер закрито');
    // вечір і ніч
    const E = await open(browser, '16:30');
    await E.locator('#board .rm-world-btn').click(); await sleep(400);
    assert(await E.locator('.world').getAttribute('data-sky') === 'dusk', 'о 16:30 у листопаді — захід сонця');
    await sleep(2000); await E.screenshot({ path: SHOT + 'wa-dusk.png' });
    const N = await open(browser, '22:00');
    await N.locator('#board .rm-world-btn').click(); await sleep(400);
    const nw = N.locator('.world');
    assert(await nw.getAttribute('data-sky') === 'night' && await nw.locator('.w-stars').count() === 1 && await nw.locator('.w-moon').count() === 1, 'о 22:00 — ніч: зорі й місяць');
    await sleep(2000); await N.screenshot({ path: SHOT + 'wa-night.png' });
    // усе пройдено — салют над замком
    for (let i = 7; i <= 13; i++) { const t = rows.get('todo_task/s' + i).data; t.done = true; t.doneAt = T0; }
    await D.reload(); await D.fill('#lgEmail', 'me@x').catch(() => {}); await sleep(1500);
    await D.click('#views .nav-item:has-text("Ціль")'); await sleep(300);
    await D.locator('#board .rm-world-btn').click(); await sleep(2500);
    assert(await D.locator('.world .w-fireworks').count() === 1, 'усе пройдено — салют');
    assert(/Фініш/.test(await D.locator('.world .w-bar').textContent()), 'табло: фініш');
    await D.screenshot({ path: SHOT + 'wa-finish.png' });
    assert(!errs.length, 'без помилок ' + errs.join('; '));
  } finally { await browser.close(); srv.kill(); }
})();
