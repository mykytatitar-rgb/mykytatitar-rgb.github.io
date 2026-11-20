// Нагадування «Справ» на телефон (Web Push).
//   GET  ?pub=1                       — публічний ключ VAPID для підписки в браузері
//   POST (x-cron-key)                 — кожні 5 хв з pg_cron: кому що надіслати (logic.mjs)
//   POST ?test=1 (Authorization: JWT) — пробне нагадування на пристрої цієї людини
// Ключі VAPID функція створює сама при першому запуску й тримає в приватній таблиці:
// жоден секрет не проходить через браузер чи чат.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import webpush from 'npm:web-push@3.6.7';
import { decide } from './logic.mjs';

const SITE = 'https://mykytatitar-rgb.github.io';
const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const CORS = { 'Access-Control-Allow-Origin': SITE, 'Access-Control-Allow-Headers': 'authorization, apikey, content-type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };

function b64url(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64url(s: string) { return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)); }

/** Ключі VAPID: узяти збережені або створити й зберегти (перший виграє, якщо двоє одночасно). */
async function vapid() {
  const { data } = await db.rpc('push_vapid', { p_pub: null, p_priv: null });
  if (data && data[0]?.pub) return data[0];
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pub = b64url(new Uint8Array([4, ...unb64url(jwk.x!), ...unb64url(jwk.y!)]));
  const { data: saved, error } = await db.rpc('push_vapid', { p_pub: pub, p_priv: jwk.d });
  if (error) throw error;
  return saved[0];
}

async function send(sub: { endpoint: string; p256dh: string; auth: string }, msg: { title: string; body: string; url: string; key: string }) {
  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify({ title: msg.title, body: msg.body, url: msg.url, tag: msg.key }), { TTL: 3600 });
    return true;
  } catch (e) {
    const code = (e as { statusCode?: number }).statusCode;
    if (code === 404 || code === 410) await db.rpc('push_drop', { p_endpoint: sub.endpoint });   // підписку скасовано на телефоні
    console.error('push', code, String(e));
    return false;
  }
}

async function run(onlyOwner?: string, test = false) {
  const keys = await vapid();
  webpush.setVapidDetails(SITE, keys.pub, keys.priv);
  const { data: subs, error } = await db.rpc('push_targets', { p_owner: onlyOwner ?? null });
  if (error) throw error;
  const byOwner = new Map<string, typeof subs>();
  for (const s of subs ?? []) byOwner.set(s.owner, [...(byOwner.get(s.owner) ?? []), s]);
  let sent = 0;
  for (const [owner, list] of byOwner) {
    let msgs;
    if (test) msgs = [{ key: 't:' + Date.now(), title: 'Справи', body: 'Нагадування працюють. Так виглядатиме поштовх.', url: './?view=now' }];
    else {
      const { data: tasks } = await db.rpc('push_tasks', { p_owner: owner });
      const { data: log } = await db.rpc('push_sent', { p_owner: owner });
      msgs = decide(Date.now(), list[0].tz, tasks ?? [], new Set((log ?? []).map((x: { key: string }) => x.key)));
    }
    for (const m of msgs) {
      if (!test) {
        const { data: fresh } = await db.rpc('push_claim', { p_owner: owner, p_key: m.key });   // ще раз не надсилаємо
        if (!fresh) continue;
      }
      for (const s of list) if (await send(s, m)) sent++;
    }
  }
  return sent;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
  try {
    if (req.method === 'GET' && url.searchParams.has('pub')) return json({ publicKey: (await vapid()).pub });
    if (req.method !== 'POST') return json({ error: 'method' }, 405);
    if (url.searchParams.has('test')) {
      const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
      const { data: u } = await db.auth.getUser(jwt);
      if (!u?.user) return json({ error: 'auth' }, 401);
      return json({ sent: await run(u.user.id, true) });
    }
    const { data: key } = await db.rpc('push_cron_key');
    if (!key || req.headers.get('x-cron-key') !== key) return json({ error: 'forbidden' }, 403);
    return json({ sent: await run() });
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});
