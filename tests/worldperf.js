// Вимірювання мапи цілі: відкриття, кадри під час перетягування, простій, шари, вузли, підписи.
// Нічого не змінює в застосунку; варіанти вимикають підозрювані частини стилем, щоб знайти, що скільки коштує.
// Запуск: node tests/worldperf.js [варіант ...] [--check]   (без аргументів — base; all — усі варіанти)
// --check: перевірити критерії з промпту й вийти з кодом 1, якщо щось не виконано.
// Headless без GPU малює програмно: мілісекунди відносні, порівнювати лише до/після в одному середовищі.
// Кадри рахуємо за трасою компоновщика (DrawFrame — показаний кадр), а не за requestAnimationFrame:
// головний потік може встигати 60 Гц, поки компоновщик пропускає більшість кадрів.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const PORT = 8830, SITE = `http://localhost:${PORT}`;
const SB = /url:\s*'([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8'))[1];
const VW = 1600, VH = 950;

const VARIANTS = {
  base: '',
  'no-anim': '*,*::before,*::after{animation:none!important;transition:none!important}',
  'no-backdrop': '.w-mini{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}',
  'no-filter': '.w-me,.w-node,.w-pin{filter:none!important}',
  'no-decor': '.w-tree{display:none!important}',
  'no-clouds': '.w-cloud,.w-cloud2d{display:none!important}',
  'no-ground-anim': '.wr-shine,.w-water{animation:none!important}',
  'no-pulse': '.w-node.now{animation:none!important}',
  'ground-only': '.w-bb,.w-cloud,.w-node,.w-sky>*{display:none!important}',
  'no-svg-anim': '.world .smoke circle,.world .f1,.world .f2,.world .fg{animation:none!important}',
  'no-haze': '.w-haze{display:none!important}',
  'no-vig': '.w-vig{display:none!important}',
  'no-edges': '.w-edge{display:none!important}',
  'no-clip': '.w-edge{clip-path:none!important}'
};

const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const day = n => iso(new Date(Date.now() + n * 864e5)), T0 = day(0);
/** Ціль як у користувача: 13 кроків з довгими назвами, 6 пройдено, у поточного є термін. */
function rows() {
  const r = new Map();
  const put = (kind, d) => { if (kind === 'todo_task' && !d.seen) d.seen = T0; r.set(kind + '/' + d.id, { kind, id: d.id, data: d, deleted: false, updated_at: new Date().toISOString() }); };
  put('todo_list', { id: 'my', name: 'Мої завдання', order: 0, visible: true });
  put('todo_task', { id: 'g', listId: 'my', title: 'Пройти курс з Data Analysis до кінця', goal: true, order: 1 });
  ['To correct HW_2', 'To watch SQL lecture of lesson 5', 'To do HW of lesson 5', 'To watch SQL lecture of lesson 6', 'To do HW_3',
    'To watch SQL lecture of lesson 7', 'To watch SQL lecture of lesson 8', 'To watch SQL lecture of lesson 9', 'To watch SQL lecture of lesson 10',
    'To watch videos of lesson 10', 'Final project', 'Certificate', 'Share on LinkedIn'].forEach((t, i) =>
    put('todo_task', { id: 's' + i, listId: 'my', parentId: 'g', title: t, order: i + 1, done: i < 6, doneAt: i < 6 ? day(i - 14) : '', due: i === 6 ? day(2) : '' }));
  return r;
}

async function measure(browser, name) {
  const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1 });
  await ctx.clock.setFixedTime(new Date(T0 + 'T12:00:00'));
  const data = rows();
  const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body), headers: { 'access-control-allow-origin': '*' } });
  await ctx.route(SB + '/**', route => {
    const u = new URL(route.request().url());
    if (u.pathname === '/auth/v1/token') return json(route, { access_token: 'a', refresh_token: 'r', user: { id: 'u1', email: 'me@x' } });
    if (u.pathname === '/rest/v1/records') return json(route, [...data.values()]);
    return json(route, 1);
  });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(SITE + '/'); await p.fill('#lgEmail', 'me@x'); await p.fill('#lgPass', 'p'); await p.click('#lgBtn');
  await p.waitForSelector('#app:not([hidden])'); await p.waitForTimeout(1200);
  if (VARIANTS[name]) await p.addStyleTag({ content: VARIANTS[name] });
  await p.click('#views .nav-item:has-text("Ціль")'); await p.waitForTimeout(400);
  const cdp = await ctx.newCDPSession(p);
  await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));

  // 1) відкриття: обробник кліку (синхронна побудова сцени) і перший намальований кадр
  const open = await p.evaluate(async () => {
    const btn = document.querySelector('#board .rm-world-btn');
    const t0 = performance.now();
    btn.click();
    const t1 = performance.now();
    await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
    const b = performance.getEntriesByName('world:build').pop();
    return { sync: t1 - t0, first: performance.now() - t0, build: b ? b.duration : null };
  });
  await p.waitForTimeout(2600);                       // переліт камери до вас закінчився

  // 2) простій: скільки роботи головного потоку за 2 с без жодної дії (ціна анімацій)
  const m0 = await metrics();
  await p.waitForTimeout(2000);
  const m1 = await metrics();
  const idle = { task: (m1.TaskDuration - m0.TaskDuration) * 1000 / 2, paint: null };

  // 3) перетягування: 150 кадрів, на кожному — один рух вказівника (як миша на 60 Гц)
  const m2 = await metrics();
  await browser.startTracing(p, { categories: ['disabled-by-default-devtools.timeline.frame'] });
  const drag = await p.evaluate(async () => {
    const st = document.querySelector('.w-stage');
    const x0 = innerWidth / 2, y0 = innerHeight / 2;
    st.dispatchEvent(new PointerEvent('pointerdown', { clientX: x0, clientY: y0, pointerId: 7, bubbles: true }));
    const ts = [];
    await new Promise(res => {
      let i = 0;
      (function tick(t) {
        ts.push(t);
        if (i >= 150) return res();
        i++;
        st.dispatchEvent(new PointerEvent('pointermove', { clientX: x0 + Math.sin(i / 18) * 220, clientY: y0 - 200 + i * 4, pointerId: 7, bubbles: true }));
        requestAnimationFrame(tick);
      })(performance.now());
    });
    st.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, bubbles: true }));
    const d = ts.slice(2).map((t, k) => t - ts[k + 1]).sort((a, b) => a - b);
    const q = f => d[Math.min(d.length - 1, Math.floor(d.length * f))];
    return { raf: q(0.5), total: ts[ts.length - 1] - ts[0] };
  });
  const tr = JSON.parse((await browser.stopTracing()).toString()).traceEvents;
  const shown = tr.filter(e => e.name === 'DrawFrame').map(e => e.ts).sort((a, b) => a - b);
  const gaps = shown.slice(1).map((t, k) => (t - shown[k]) / 1000).sort((a, b) => a - b);
  const g = f => gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * f))] : null;
  Object.assign(drag, { shown: shown.length, dropped: tr.filter(e => e.name === 'DroppedFrame').length, med: g(0.5), p95: g(0.95), max: gaps.length ? gaps[gaps.length - 1] : null,
    over50: gaps.filter(x => x > 50).length, fps: shown.length / (drag.total / 1000) });
  const m3 = await metrics();
  drag.script = (m3.ScriptDuration - m2.ScriptDuration) * 1000;
  drag.style = (m3.RecalcStyleDuration - m2.RecalcStyleDuration) * 1000;
  drag.layout = (m3.LayoutDuration - m2.LayoutDuration) * 1000;
  drag.task = (m3.TaskDuration - m2.TaskDuration) * 1000;

  // 3б) будова кадру: скільки проходів рендерингу й прямокутників малює компоновщик (короткий слід)
  await browser.startTracing(p, { categories: ['viz'] });
  await p.evaluate(async () => {
    const st = document.querySelector('.w-stage'), x0 = innerWidth / 2, y0 = innerHeight / 2;
    st.dispatchEvent(new PointerEvent('pointerdown', { clientX: x0, clientY: y0, pointerId: 8, bubbles: true }));
    await new Promise(res => { let i = 0; (function tick() { if (i++ >= 20) return res(); st.dispatchEvent(new PointerEvent('pointermove', { clientX: x0, clientY: y0 - i * 6, pointerId: 8, bubbles: true })); requestAnimationFrame(tick); })(); });
    st.dispatchEvent(new PointerEvent('pointerup', { pointerId: 8, bubbles: true }));
  });
  const vz = JSON.parse((await browser.stopTracing()).toString()).traceEvents;
  const draws = vz.filter(e => e.name === 'Display::DrawAndSwap' && e.ph === 'X').length || 1;
  const frame = { passes: vz.filter(e => e.name === 'DirectRenderer::DrawRenderPass' && e.ph === 'X').length / draws,
    quads: vz.filter(e => e.name === 'SoftwareRenderer::DoDrawQuad').length / draws };

  // 4) шари компоновщика й вузли сцени (камера — на вашому кроці)
  await p.locator('.w-ctrl button', { hasText: 'До мене' }).click(); await p.waitForTimeout(1200);
  await cdp.send('LayerTree.enable');
  let layers = null;
  cdp.on('LayerTree.layerTreeDidChange', e => { if (e.layers) layers = e.layers.length; });
  await p.evaluate(() => { document.querySelector('.w-ctrl button.me').click(); });
  await p.waitForTimeout(1200);
  await cdp.send('LayerTree.disable');
  const nodes = await p.evaluate(() => document.querySelectorAll('.world *').length);

  // 5) підписи поточного і двох наступних кроків: розмір шрифту на екрані й перекриття тим, що ближче
  const labels = await p.evaluate(() => {
    const all = [...document.querySelectorAll('.w-label')];
    const nowI = all.findIndex(l => l.classList.contains('now'));
    const front = [...document.querySelectorAll('.w-bb, .w-node')].concat([...document.querySelectorAll('.w-bar, .w-mini, .w-ctrl, .w-pop')]);
    const area = r => Math.max(0, r.width) * Math.max(0, r.height);
    return all.slice(nowI, nowI + 3).map(l => {
      const r = l.getBoundingClientRect(), y = parseFloat((l.closest('.w-bb') || l).style.top);
      const px = parseFloat(getComputedStyle(l).fontSize) * (r.height / l.offsetHeight);
      let cover = 0;
      front.forEach(o => {
        if (o === l || l.contains(o) || o.contains(l)) return;
        const ui = !o.closest('.w-ground');
        const oy = parseFloat(o.style.top);
        if (!ui && !(oy > y)) return;                         // заступає лише те, що ближче до камери, або інтерфейс поверх
        const b = o.getBoundingClientRect();
        const w = Math.max(0, Math.min(r.right, b.right) - Math.max(r.left, b.left)), h = Math.max(0, Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top));
        cover += w * h;
      });
      const inView = r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
      return { text: l.textContent.slice(0, 24), px: +px.toFixed(1), cover: Math.min(100, Math.round(cover / area(r) * 100)), inView, area: Math.round(area(r)) };
    });
  });
  await ctx.close();
  return { name, open, idle, drag, frame, layers, nodes, labels, errs };
}

/** Критерії з промпту; BASE — виміри до оптимізації в цьому середовищі (для «−50%»). */
const BASE = { layers: 299, nodes: 2796 };
function check(o) {
  const fails = [];
  const want = (ok, what) => { console.log((ok ? 'ok: ' : 'FAIL: ') + what); if (!ok) fails.push(what); };
  want(o.drag.med <= 16.7 && o.drag.over50 === 0, `перетягування: медіанний показаний кадр ${o.drag.med && o.drag.med.toFixed(1)} мс (≤ 16,7), кадрів > 50 мс: ${o.drag.over50}`);
  want(o.open.first <= 250, `відкриття до першого кадру ${o.open.first.toFixed(0)} мс (≤ 250)`);
  want(o.layers <= BASE.layers / 2 && o.nodes <= BASE.nodes / 2, `шари ${o.layers} (≤ ${BASE.layers / 2}), вузли ${o.nodes} (≤ ${BASE.nodes / 2})`);
  want(o.labels.length === 3 && o.labels.every(l => l.px >= 13 && l.cover === 0 && l.inView), 'підписи поточного й двох наступних: ≥ 13 px, не закриті, у кадрі');
  want(o.idle.task <= 25, `простій: ${o.idle.task.toFixed(0)} мс/с роботи головного потоку (≤ 25)`);
  return fails;
}

(async () => {
  const doCheck = process.argv.includes('--check');
  let names = process.argv.slice(2).filter(a => a !== '--check');
  if (!names.length) names = ['base'];
  if (names[0] === 'all') names = Object.keys(VARIANTS);
  const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  const browser = await chromium.launch();
  const out = [];
  try {
    for (const n of names) out.push(await measure(browser, n));
  } finally { await browser.close(); srv.kill(); }
  const f = v => v == null ? '—' : (Math.round(v * 10) / 10).toString();
  console.log('варіант        | клік,мс | 1-й кадр | показано к/с | кадр мед | макс | >50мс | пропущено | проходи/кадр | прямок./кадр | простій мс/с | шари | вузли');
  out.forEach(o => console.log([o.name.padEnd(14), f(o.open.sync).padStart(7), f(o.open.first).padStart(8), f(o.drag.fps).padStart(12), f(o.drag.med).padStart(8),
    f(o.drag.max).padStart(4), String(o.drag.over50).padStart(5), String(o.drag.dropped).padStart(9), f(o.frame.passes).padStart(12), f(o.frame.quads).padStart(12),
    f(o.idle.task).padStart(12), String(o.layers).padStart(4), String(o.nodes).padStart(5)].join(' | ')));
  out.forEach(o => {
    console.log(o.name + ' · підписи (поточний і 2 наступні): ' + o.labels.map(l => `«${l.text}» ${l.px}px, перекрито ${l.cover}%${l.inView ? '' : ', поза кадром'}`).join(' · '));
    if (o.errs.length) console.log(o.name + ' · помилки: ' + o.errs.join('; '));
  });
  if (process.env.WORLDPERF_JSON) fs.writeFileSync(process.env.WORLDPERF_JSON, JSON.stringify(out, null, 2));
  if (doCheck) { const fails = out.flatMap(check); if (fails.length || out.some(o => o.errs.length)) process.exitCode = 1; }
})();
