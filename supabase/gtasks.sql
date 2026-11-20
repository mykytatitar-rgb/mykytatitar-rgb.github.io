-- «Окей Google» → Google Tasks → «Справи».
-- Ключ доступу до Google живе лише тут, у приватній схемі: браузер його ніколи не бачить.
-- Запуск: Supabase → SQL Editor → вставити весь файл → Run. Повторний запуск безпечний.

create extension if not exists pg_net;
create extension if not exists pg_cron;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.gtasks_links (
  owner uuid primary key references auth.users(id) on delete cascade,
  refresh_token text not null,
  connected_at timestamptz not null default now(),
  last_pull_at timestamptz,
  last_count int not null default 0,
  last_error text
);
create table if not exists private.gtasks_nonces (
  nonce text primary key,
  owner uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create table if not exists private.gtasks_cfg (k text primary key, v text not null);
insert into private.gtasks_cfg (k, v) values ('cron_key', encode(extensions.gen_random_bytes(24), 'hex')) on conflict (k) do nothing;

-- ---------- для браузера: кожен бачить і змінює лише своє ----------
create or replace function public.gtasks_begin() returns text
language plpgsql security definer set search_path = '' as $$
declare n text;
begin
  if auth.uid() is null then raise exception 'Потрібен вхід'; end if;
  delete from private.gtasks_nonces where created_at < now() - interval '15 minutes' or owner = auth.uid();
  n := encode(extensions.gen_random_bytes(24), 'hex');
  insert into private.gtasks_nonces (nonce, owner) values (n, auth.uid());
  return n;
end $$;

create or replace function public.gtasks_status() returns jsonb
language sql security definer set search_path = '' stable as $$
  select coalesce((select jsonb_build_object('connected', true, 'last_pull_at', l.last_pull_at, 'last_count', l.last_count, 'last_error', l.last_error)
                   from private.gtasks_links l where l.owner = auth.uid()), jsonb_build_object('connected', false));
$$;

create or replace function public.gtasks_disconnect() returns void
language sql security definer set search_path = '' as $$
  delete from private.gtasks_links where owner = auth.uid();
$$;

revoke all on function public.gtasks_begin(), public.gtasks_status(), public.gtasks_disconnect() from public, anon;
grant execute on function public.gtasks_begin(), public.gtasks_status(), public.gtasks_disconnect() to authenticated;

-- ---------- лише для серверної функції gtasks ----------
create or replace function public.gtasks_claim(p_nonce text) returns uuid
language sql security definer set search_path = '' as $$
  delete from private.gtasks_nonces where nonce = p_nonce and created_at > now() - interval '15 minutes' returning owner;
$$;

create or replace function public.gtasks_save_link(p_owner uuid, p_refresh text) returns void
language sql security definer set search_path = '' as $$
  insert into private.gtasks_links (owner, refresh_token) values (p_owner, p_refresh)
  on conflict (owner) do update set refresh_token = excluded.refresh_token, connected_at = now(), last_error = null;
$$;

create or replace function public.gtasks_links(p_owner uuid default null) returns table (owner uuid, refresh_token text)
language sql security definer set search_path = '' stable as $$
  select l.owner, l.refresh_token from private.gtasks_links l where p_owner is null or l.owner = p_owner;
$$;

create or replace function public.gtasks_cron_key() returns text
language sql security definer set search_path = '' stable as $$
  select v from private.gtasks_cfg where k = 'cron_key';
$$;

create or replace function public.gtasks_mark(p_owner uuid, p_count int, p_error text) returns void
language sql security definer set search_path = '' as $$
  update private.gtasks_links set last_pull_at = now(), last_count = p_count, last_error = p_error where owner = p_owner;
$$;

/* Покласти справи з Google у «Мої завдання» (або перший список). p_items: [{gid, title, notes, due}].
   id запису 'g_<id у Google>': повторний запуск після збою дублів не дасть. Повертає, скільки додано. */
create or replace function public.gtasks_import(p_owner uuid, p_items jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare
  lst text; base numeric; added int := 0; it jsonb; rid text; i int := 0;
begin
  select r.id into lst from public.records r
   where r.owner = p_owner and r.kind = 'todo_list' and not r.deleted
   order by (r.data->>'name') = 'Мої завдання' desc, (r.data->>'order')::numeric nulls last limit 1;
  if lst is null then return 0; end if;
  select coalesce(min((r.data->>'order')::numeric), 0) into base from public.records r
   where r.owner = p_owner and r.kind = 'todo_task' and not r.deleted;
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    continue when coalesce(trim(it->>'title'), '') = '' or coalesce(it->>'gid', '') = '';
    rid := 'g_' || (it->>'gid');
    i := i + 1;
    insert into public.records (owner, kind, id, data, rev, deleted, device)
    values (p_owner, 'todo_task', rid, jsonb_build_object(
      'id', rid, 'listId', lst, 'title', left(trim(it->>'title'), 500), 'notes', left(coalesce(it->>'notes', ''), 5000),
      'due', case when coalesce(it->>'due', '') ~ '^\d{4}-\d{2}-\d{2}' then left(it->>'due', 10) else '' end,
      'repeat', 'none', 'starred', false, 'done', false, 'doneAt', '', 'parentId', '', 'order', base - i,
      'focus', '', 'postponed', 0, 'blocker', '', 'blockerAt', '', 'start', '', 'end', '', 'color', '', 'est', 0, 'images', '[]'::jsonb),
      1, false, 'Google Tasks')
    on conflict (owner, kind, id) do nothing;
    if found then added := added + 1; end if;
  end loop;
  return added;
end $$;

revoke all on function public.gtasks_claim(text), public.gtasks_save_link(uuid, text), public.gtasks_links(uuid),
  public.gtasks_cron_key(), public.gtasks_mark(uuid, int, text), public.gtasks_import(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.gtasks_claim(text), public.gtasks_save_link(uuid, text), public.gtasks_links(uuid),
  public.gtasks_cron_key(), public.gtasks_mark(uuid, int, text), public.gtasks_import(uuid, jsonb) to service_role;
