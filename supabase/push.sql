-- Нагадування «Справ» на телефон (Web Push). Запуск: Supabase → SQL Editor → вставити → Run.
-- Повторний запуск безпечний. Ваші справи й списки не змінює.

create extension if not exists pg_net;
create extension if not exists pg_cron;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.push_subs (
  endpoint text primary key,
  owner uuid not null references auth.users(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  tz text not null default 'Europe/Kyiv',
  created_at timestamptz not null default now()
);
create table if not exists private.push_log (
  owner uuid not null references auth.users(id) on delete cascade,
  key text not null,
  at timestamptz not null default now(),
  primary key (owner, key)
);
create table if not exists private.push_cfg (k text primary key, v text not null);
insert into private.push_cfg (k, v) values ('cron_key', encode(extensions.gen_random_bytes(24), 'hex')) on conflict (k) do nothing;

-- ---------- для браузера: лише свої підписки ----------
create or replace function public.push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_tz text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Потрібен вхід'; end if;
  insert into private.push_subs (endpoint, owner, p256dh, auth, tz) values (p_endpoint, auth.uid(), p_p256dh, p_auth, coalesce(nullif(p_tz, ''), 'Europe/Kyiv'))
  on conflict (endpoint) do update set owner = auth.uid(), p256dh = excluded.p256dh, auth = excluded.auth, tz = excluded.tz;
end $$;

create or replace function public.push_unsubscribe(p_endpoint text) returns void
language sql security definer set search_path = '' as $$
  delete from private.push_subs where endpoint = p_endpoint and owner = auth.uid();
$$;

revoke all on function public.push_subscribe(text, text, text, text), public.push_unsubscribe(text) from public, anon;
grant execute on function public.push_subscribe(text, text, text, text), public.push_unsubscribe(text) to authenticated;

-- ---------- лише для серверної функції nudge ----------
create or replace function public.push_targets(p_owner uuid default null) returns table (owner uuid, endpoint text, p256dh text, auth text, tz text)
language sql security definer set search_path = '' stable as $$
  select s.owner, s.endpoint, s.p256dh, s.auth, s.tz from private.push_subs s where p_owner is null or s.owner = p_owner;
$$;

create or replace function public.push_tasks(p_owner uuid) returns setof jsonb
language sql security definer set search_path = '' stable as $$
  select r.data from public.records r
   where r.owner = p_owner and r.kind = 'todo_task' and not r.deleted and not coalesce((r.data->>'done')::boolean, false);
$$;

create or replace function public.push_sent(p_owner uuid) returns table (key text)
language sql security definer set search_path = '' stable as $$
  select l.key from private.push_log l where l.owner = p_owner and l.at > now() - interval '3 days';
$$;

-- true — ключ новий (можна надсилати); false — вже було
create or replace function public.push_claim(p_owner uuid, p_key text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  delete from private.push_log where at < now() - interval '14 days';
  insert into private.push_log (owner, key) values (p_owner, p_key) on conflict do nothing;
  return found;
end $$;

create or replace function public.push_drop(p_endpoint text) returns void
language sql security definer set search_path = '' as $$
  delete from private.push_subs where endpoint = p_endpoint;
$$;

-- Ключі VAPID: повертає збережені; якщо їх ще немає й передано нові — зберігає їх.
create or replace function public.push_vapid(p_pub text, p_priv text) returns table (pub text, priv text)
language plpgsql security definer set search_path = '' as $$
begin
  if p_pub is not null and p_priv is not null then
    insert into private.push_cfg (k, v) values ('vapid_pub', p_pub), ('vapid_priv', p_priv) on conflict (k) do nothing;
  end if;
  return query select (select v from private.push_cfg where k = 'vapid_pub'), (select v from private.push_cfg where k = 'vapid_priv');
end $$;

create or replace function public.push_cron_key() returns text
language sql security definer set search_path = '' stable as $$
  select v from private.push_cfg where k = 'cron_key';
$$;

revoke all on function public.push_targets(uuid), public.push_tasks(uuid), public.push_sent(uuid), public.push_claim(uuid, text),
  public.push_drop(text), public.push_vapid(text, text), public.push_cron_key() from public, anon, authenticated;
grant execute on function public.push_targets(uuid), public.push_tasks(uuid), public.push_sent(uuid), public.push_claim(uuid, text),
  public.push_drop(text), public.push_vapid(text, text), public.push_cron_key() to service_role;

-- ---------- раз на 5 хвилин ----------
select cron.unschedule('spravy-nudge') where exists (select 1 from cron.job where jobname = 'spravy-nudge');
select cron.schedule('spravy-nudge', '*/5 * * * *', $cron$
  select net.http_post(
    url := 'https://kcxqienzhopnsqmykhqv.supabase.co/functions/v1/nudge',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-key', (select v from private.push_cfg where k = 'cron_key')),
    body := '{}'::jsonb);
$cron$);
