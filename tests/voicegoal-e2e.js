// Голос для цілі: мікрофон біля поля «Крок» одразу додає крок; у вікні голосу — «куди: в ціль»
// Запуск: node tests/voicegoal-e2e.js (розпізнавання мовлення підмінене)
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const PORT = 8811, SITE = `http://localhost:${PORT}`;
const SB = /url:\s*'([^']+)'/.exec(fs.readFileSync(path.join(__dirname, '..', 'config.js'), 'utf8'))[1];
const T0 = new Date().toISOString().slice(0, 10);
const rows = new Map();
function put(kind, data) { if (kind === 'todo_task' && !data.seen) data.seen = T0; rows.set(kind + '/' + data.id, { kind, id: data.id, data, deleted: false, updated_at: new Date().toISOString() }); }
put('todo_list', { id: 'my', name: 'Мої завдання', order: 0, visible: true });
put('todo_task', { id: 'g', listId: 'my', title: 'Finish DA course', goal: true, order: 1 });
put('todo_task', { id: 's1', listId: 'my', parentId: 'g', title: 'Module 1', order: 1 });
// фальшиве розпізнавання: window.__say('текст') — і воно «чує»
const FAKE = `
  class FakeRec { constructor() { this.lang = ''; } start() { window.__live = this; } stop() { if (window.__live === this) { window.__live = null; this.onend && this.onend(); } } abort() { this.stop(); } }
  window.SpeechRecognition = FakeRec;
  window.__say = (text) => { const r = window.__live; if (!r) return false; const res = [[{ transcript: text }]]; res[0].isFinal = true;
    r.onresult && r.onresult({ results: res }); window.__live = null; r.onend && r.onend(); return true; };`;
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
const steps = () => [...rows.values()].filter(r => r.data.parentId === 'g').sort((a, b) => a.data.order - b.data.order).map(r => r.data.title);
async function open(browser, opts) {
  const ctx = await browser.newContext(opts);
  await ctx.addInitScript(FAKE);
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
    // 1) комп'ютер, розділ «Ціль»: мікрофон біля «Крок»
    const D = await open(browser, { viewport: { width: 1300, height: 900 } });
    await D.click('#views .nav-item:has-text("Ціль")'); await sleep(300);
    const mic = D.locator('#board .roadmap .rm-add .mic');
    assert(await mic.count() === 1, 'біля поля «Крок» — мікрофон');
    await mic.click(); await sleep(150);
    await D.evaluate(() => window.__say('Module 2')); await sleep(1700);
    assert(steps().join() === 'Module 1,Module 2', 'сказаний крок одразу на доріжці, без Enter: ' + steps());
    await D.locator('#board .roadmap .rm-add .mic').click(); await sleep(150);
    await D.evaluate(() => window.__say('Final project')); await sleep(1700);
    assert(steps().join() === 'Module 1,Module 2,Final project', 'наступний — у кінець: ' + steps());
    // 2) телефон: вікно голосу — «куди: в ціль»
    const M = await open(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await M.locator('#fabMic').tap(); await sleep(250);
    const target = M.locator('.vcap .vcap-target');
    assert(await target.count() === 1, 'у вікні голосу — куди додавати');
    await target.tap(); await sleep(250);
    assert(/Finish DA course/.test(await target.textContent()), 'обрано «в ціль»: ' + await target.textContent());
    await M.evaluate(() => window.__say('Certificate')); await sleep(400);
    assert(/крок цілі/i.test(await M.locator('.vcap').textContent()), 'показує, що додано кроком цілі');
    await M.locator('.vcap button', { hasText: 'Ще одну' }).tap(); await sleep(200);
    await M.evaluate(() => window.__say('Share on LinkedIn')); await sleep(400);
    await M.locator('.vcap button', { hasText: 'Готово' }).tap(); await sleep(1700);
    assert(steps().slice(-2).join() === 'Certificate,Share on LinkedIn', 'обидва — кроки цілі, по порядку: ' + steps());
    // вибір запам'ятовується
    await M.locator('#fabMic').tap(); await sleep(250);
    assert(/Finish DA course/.test(await M.locator('.vcap .vcap-target').textContent()), 'наступного разу — знову в ціль');
    assert(!errs.length, 'без помилок ' + errs.join('; '));
  } finally { await browser.close(); srv.kill(); }
})();
