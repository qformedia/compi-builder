-- Full pre-merge snapshots for the Duplicates page history view.
--
-- Background: HubSpot's native merge endpoint is destructive — once two
-- creators are merged, you cannot easily reconstruct what the loser looked
-- like beforehand (HubSpot only exposes that history for merges performed
-- via the Data Quality tool, not the API). To give the team an
-- archaeological surface for reviewing past merges, we capture a full
-- snapshot of both records (properties + associations) at merge time and
-- persist it here.
--
-- Pair_key matches the key shape used in `duplicate_pair_resolutions` and
-- `duplicate_pair_events` (the canonical sorted `${min}:${max}` of the two
-- detection ids), so all three tables can be joined on it.
--
-- Snapshots are immutable (no update/delete RLS policy) — the whole point
-- is to preserve a faithful pre-merge view, so mutating it later would
-- defeat the purpose. Only the audit log mutations live in
-- `duplicate_pair_events`.
--
-- Run via Supabase SQL Editor or `supabase db push`.

create extension if not exists pgcrypto;

create table if not exists public.duplicate_merge_snapshots (
  id uuid primary key default gen_random_uuid(),
  pair_key text not null,
  merged_at timestamptz not null default now(),
  actor text,

  -- Original detection pair (canonical sort, matches pair_key).
  record_id_a text not null,
  record_id_b text not null,

  -- Merge decision: which side survived, which was archived.
  winner_record_id text not null,
  loser_record_id text not null,

  -- Display labels denormalized so the history list view can render
  -- without a join back to the snapshot props.
  winner_name text,
  loser_name text,
  network text,
  canonical_url text,

  -- Full HubSpot property bags captured at merge time. Keys match
  -- `helpers::full_creator_properties` in the Rust backend.
  winner_props jsonb not null default '{}'::jsonb,
  loser_props  jsonb not null default '{}'::jsonb,

  -- Associations as returned by `fetch_creator_associations_batch`:
  -- { videoProjects: AssociatedRecord[], externalClips: AssociatedRecord[] }.
  -- Nullable because the associations fetch can fail independently and we
  -- still want to record the property snapshot on a best-effort basis.
  winner_associations jsonb,
  loser_associations  jsonb,

  -- Owner-id -> display-name map (from `list_owners`) at merge time so the
  -- diff in the history view renders the same human label even after an
  -- owner's name changes or they leave the org.
  owners_by_id jsonb,

  created_at timestamptz not null default now(),

  constraint duplicate_merge_snapshots_canonical_order
    check (record_id_a < record_id_b)
);

create index if not exists duplicate_merge_snapshots_merged_at_idx
  on public.duplicate_merge_snapshots (merged_at desc);
create index if not exists duplicate_merge_snapshots_pair_key_idx
  on public.duplicate_merge_snapshots (pair_key);

alter table public.duplicate_merge_snapshots enable row level security;

drop policy if exists "duplicate_merge_snapshots_select_anon"
  on public.duplicate_merge_snapshots;
create policy "duplicate_merge_snapshots_select_anon"
on public.duplicate_merge_snapshots
for select
to anon, authenticated
using (true);

drop policy if exists "duplicate_merge_snapshots_insert_anon"
  on public.duplicate_merge_snapshots;
create policy "duplicate_merge_snapshots_insert_anon"
on public.duplicate_merge_snapshots
for insert
to anon, authenticated
with check (true);

-- Snapshots are immutable from the client. Capturing a snapshot then
-- editing it would let someone rewrite history in a way that defeats the
-- whole point of the table.
drop policy if exists "duplicate_merge_snapshots_update_block"
  on public.duplicate_merge_snapshots;
create policy "duplicate_merge_snapshots_update_block"
on public.duplicate_merge_snapshots
for update
to anon, authenticated
using (false)
with check (false);

drop policy if exists "duplicate_merge_snapshots_delete_block"
  on public.duplicate_merge_snapshots;
create policy "duplicate_merge_snapshots_delete_block"
on public.duplicate_merge_snapshots
for delete
to anon, authenticated
using (false);
