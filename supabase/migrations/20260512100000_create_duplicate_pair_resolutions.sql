-- Duplicate-pair resolution + audit log for the Duplicates page.
--
-- The desktop app computes potential duplicate creator pairs on demand from
-- the cached all-creators export (see src/lib/duplicates/find-pairs.ts). The
-- pair list itself is not persisted — same input + same algorithm produces
-- the same pairs deterministically. What IS persisted here is the team's
-- shared resolution state for each pair so:
--
--   1. Pairs already resolved/dismissed disappear from everyone's list
--      automatically (filter on status).
--   2. There's an auditable trail of who decided what, when (events table).
--
-- Pair identity is the stable key `${min(rid_a,rid_b)}:${max(rid_a,rid_b)}`
-- so the same two creators always map to the same row regardless of which
-- network/column flagged them, and regardless of run order.
--
-- v1 of the Duplicates page is view-only: no UI buttons write to these
-- tables yet. Schema is provisioned now so v2 (resolution actions, in-app
-- merge) can plug in without a migration.
--
-- Run via Supabase SQL Editor or `supabase db push`.

create extension if not exists pgcrypto;

-- ──────────────────────────────────────────────────────────────────────
-- Current state — one row per pair
-- ──────────────────────────────────────────────────────────────────────

create table if not exists public.duplicate_pair_resolutions (
  pair_key text primary key,
  record_id_a text not null,
  record_id_b text not null,
  status text not null default 'pending'
    check (status in ('pending', 'resolved', 'dismissed', 'reopened')),
  resolved_by text,
  resolved_at timestamptz,
  resolution_notes text,
  winner_record_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The PK is the canonical pair (sorted ids), so the two ids must follow
  -- the same ordering for callers to stay consistent.
  constraint duplicate_pair_resolutions_canonical_order
    check (record_id_a < record_id_b)
);

create index if not exists duplicate_pair_resolutions_status_idx
  on public.duplicate_pair_resolutions (status);

-- updated_at maintenance trigger
create or replace function public.duplicate_pair_resolutions_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists duplicate_pair_resolutions_set_updated_at
  on public.duplicate_pair_resolutions;
create trigger duplicate_pair_resolutions_set_updated_at
  before update on public.duplicate_pair_resolutions
  for each row execute function public.duplicate_pair_resolutions_set_updated_at();

alter table public.duplicate_pair_resolutions enable row level security;

drop policy if exists "duplicate_pair_resolutions_select_anon"
  on public.duplicate_pair_resolutions;
create policy "duplicate_pair_resolutions_select_anon"
on public.duplicate_pair_resolutions
for select
to anon, authenticated
using (true);

drop policy if exists "duplicate_pair_resolutions_insert_anon"
  on public.duplicate_pair_resolutions;
create policy "duplicate_pair_resolutions_insert_anon"
on public.duplicate_pair_resolutions
for insert
to anon, authenticated
with check (true);

-- Resolution rows are mutated via upsert (status flips, notes added, etc.)
-- so unlike the hs_exports/storage policies, update is allowed.
drop policy if exists "duplicate_pair_resolutions_update_anon"
  on public.duplicate_pair_resolutions;
create policy "duplicate_pair_resolutions_update_anon"
on public.duplicate_pair_resolutions
for update
to anon, authenticated
using (true)
with check (true);

drop policy if exists "duplicate_pair_resolutions_delete_block"
  on public.duplicate_pair_resolutions;
create policy "duplicate_pair_resolutions_delete_block"
on public.duplicate_pair_resolutions
for delete
to anon, authenticated
using (false);

-- ──────────────────────────────────────────────────────────────────────
-- Append-only audit log — many rows per pair
-- ──────────────────────────────────────────────────────────────────────

create table if not exists public.duplicate_pair_events (
  id uuid primary key default gen_random_uuid(),
  pair_key text not null,
  actor text,
  event_type text not null
    check (event_type in ('resolved', 'dismissed', 'reopened', 'note', 'merged')),
  payload jsonb,
  created_at timestamptz not null default now()
);

create index if not exists duplicate_pair_events_pair_key_created_at_idx
  on public.duplicate_pair_events (pair_key, created_at desc);

alter table public.duplicate_pair_events enable row level security;

drop policy if exists "duplicate_pair_events_select_anon"
  on public.duplicate_pair_events;
create policy "duplicate_pair_events_select_anon"
on public.duplicate_pair_events
for select
to anon, authenticated
using (true);

drop policy if exists "duplicate_pair_events_insert_anon"
  on public.duplicate_pair_events;
create policy "duplicate_pair_events_insert_anon"
on public.duplicate_pair_events
for insert
to anon, authenticated
with check (true);

-- Audit log is immutable from the client side.
drop policy if exists "duplicate_pair_events_update_block"
  on public.duplicate_pair_events;
create policy "duplicate_pair_events_update_block"
on public.duplicate_pair_events
for update
to anon, authenticated
using (false)
with check (false);

drop policy if exists "duplicate_pair_events_delete_block"
  on public.duplicate_pair_events;
create policy "duplicate_pair_events_delete_block"
on public.duplicate_pair_events
for delete
to anon, authenticated
using (false);
