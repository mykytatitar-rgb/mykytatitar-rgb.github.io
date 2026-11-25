-- Основа бази «Справ»: записи справ і списків, кожен бачить лише свої.
-- Окремий проєкт Supabase (організація Spravy), щоб ліміти не ділити з іншими застосунками.
-- Запуск: Supabase → SQL Editor → вставити → Run. Повторний запуск безпечний.

create table if not exists public.records (
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind text not null,
  id text not null,
  data jsonb not null,
  rev bigint not null default 1,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  device text,
  primary key (owner, kind, id)
);
create index if not exists records_owner_updated on public.records (owner, updated_at);

alter table public.records enable row level security;
drop policy if exists records_own on public.records;
create policy records_own on public.records for all to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));

-- читати напряму можна (лише своє), писати — тільки через функції нижче
revoke all on public.records from anon, authenticated;
grant select on public.records to authenticated;

create or replace function public.save_record(p_kind text, p_id text, p_data jsonb, p_device text default null) returns bigint
language plpgsql security definer set search_path = public as $$
declare new_rev bigint;
begin
  if auth.uid() is null then raise exception 'Потрібен вхід'; end if;
  insert into public.records (owner, kind, id, data, rev, deleted, device)
  values (auth.uid(), p_kind, p_id, p_data, 1, false, p_device)
  on conflict (owner, kind, id) do update
    set data = excluded.data, rev = public.records.rev + 1, deleted = false,
        updated_at = now(), device = excluded.device
  returning rev into new_rev;
  return new_rev;
end $$;

create or replace function public.delete_record(p_kind text, p_id text, p_device text default null) returns bigint
language plpgsql security definer set search_path = public as $$
declare new_rev bigint;
begin
  if auth.uid() is null then raise exception 'Потрібен вхід'; end if;
  update public.records set deleted = true, rev = rev + 1, updated_at = now(), device = p_device
   where owner = auth.uid() and kind = p_kind and id = p_id
  returning rev into new_rev;
  return coalesce(new_rev, 0);
end $$;

revoke all on function public.save_record(text, text, jsonb, text), public.delete_record(text, text, text) from public, anon;
grant execute on function public.save_record(text, text, jsonb, text), public.delete_record(text, text, text) to authenticated;

-- Фото до завдань: приватне сховище, кожен у своїй теці <uid>/
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('spravy', 'spravy', false, 5242880, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists spravy_read on storage.objects;
drop policy if exists spravy_write on storage.objects;
drop policy if exists spravy_delete on storage.objects;
create policy spravy_read on storage.objects for select to authenticated
  using (bucket_id = 'spravy' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy spravy_write on storage.objects for insert to authenticated
  with check (bucket_id = 'spravy' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy spravy_delete on storage.objects for delete to authenticated
  using (bucket_id = 'spravy' and (storage.foldername(name))[1] = (select auth.uid())::text);
