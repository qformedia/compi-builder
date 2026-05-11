-- HubSpot export cache (currently used for the all-creators CSV powering the
-- "Creator profile URLs" Data Integrity check).
--
-- The desktop app pulls a fresh CSV from HubSpot's async Export API when the
-- latest cached export is older than 24h, uploads it to the `hs-exports`
-- storage bucket, and inserts a pointer row here. Other clients only need to
-- read the latest row and download the CSV.
--
-- Run via Supabase SQL Editor or `supabase db push`.

create extension if not exists pgcrypto;

create table if not exists public.hs_exports (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (char_length(kind) between 1 and 64),
  storage_path text not null check (char_length(storage_path) between 1 and 512),
  generated_at timestamptz not null default now(),
  row_count int,
  app_version text
);

create index if not exists hs_exports_kind_generated_at_idx
  on public.hs_exports (kind, generated_at desc);

alter table public.hs_exports enable row level security;

-- Any app client can insert a new export pointer and read the latest one.
-- The actual CSV is gated by storage-bucket policies below; this table is
-- only metadata (storage path + timestamp + row count).
drop policy if exists "hs_exports_insert_anon" on public.hs_exports;
create policy "hs_exports_insert_anon"
on public.hs_exports
for insert
to anon, authenticated
with check (true);

drop policy if exists "hs_exports_select_anon" on public.hs_exports;
create policy "hs_exports_select_anon"
on public.hs_exports
for select
to anon, authenticated
using (true);

insert into storage.buckets (id, name, public)
values ('hs-exports', 'hs-exports', false)
on conflict (id) do update set public = excluded.public;

-- Allow app clients to upload new exports and read existing ones. We keep the
-- bucket non-public so the CSV requires a Supabase session/anon key to read.
drop policy if exists "hs_exports_insert" on storage.objects;
create policy "hs_exports_insert"
on storage.objects
for insert
to anon, authenticated
with check (bucket_id = 'hs-exports');

drop policy if exists "hs_exports_select" on storage.objects;
create policy "hs_exports_select"
on storage.objects
for select
to anon, authenticated
using (bucket_id = 'hs-exports');

-- Prevent client-side overwrite/delete; we always upload new timestamped
-- filenames and keep the history in the metadata table.
drop policy if exists "hs_exports_update_block" on storage.objects;
create policy "hs_exports_update_block"
on storage.objects
for update
to anon, authenticated
using (false)
with check (false);

drop policy if exists "hs_exports_delete_block" on storage.objects;
create policy "hs_exports_delete_block"
on storage.objects
for delete
to anon, authenticated
using (false);
