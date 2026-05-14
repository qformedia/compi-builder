-- Append-only audit log for the Creator URL auto-fix flow on the Data
-- Integrity page.
--
-- The Creator URL check classifies invalid values into three buckets
-- (auto-fixable / duplicate-after-fix / manual) and offers a bulk "Fix all"
-- action for the auto-fixable rows. Each successful PATCH to HubSpot writes
-- one row here so the team has a shared, auditable trail of which records
-- CompiFlow rewrote, when, and what the values were before / after.
--
-- Run ids group every row written by a single bulk-apply click so the UI
-- (and any future "view recent auto-fixes" surface) can render the run as
-- one unit and the user can roll back the whole batch if needed.
--
-- Like `duplicate_pair_events`, this table is append-only from the client.
-- Inserts and selects are allowed; updates and deletes are blocked at the
-- RLS layer so historical events cannot be rewritten.
--
-- Run via Supabase SQL Editor or `supabase db push`.

create extension if not exists pgcrypto;

create table if not exists public.creator_url_autofix_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  creator_id text not null,
  creator_name text,
  -- One of the five validated URL fields (creator_url_rules.ts). Kept as
  -- free text so a future rule addition does not require a migration.
  field text not null,
  -- The HubSpot internal property name we actually wrote (e.g. "instagram",
  -- "secondary_tiktok"). Stored explicitly so a forensic reader does not
  -- have to re-derive it from the `field` column.
  property text not null,
  before_value text,
  after_value text not null,
  applied_by text,
  app_version text,
  created_at timestamptz not null default now()
);

create index if not exists creator_url_autofix_events_run_id_idx
  on public.creator_url_autofix_events (run_id);
create index if not exists creator_url_autofix_events_created_at_idx
  on public.creator_url_autofix_events (created_at desc);
create index if not exists creator_url_autofix_events_creator_id_idx
  on public.creator_url_autofix_events (creator_id);

alter table public.creator_url_autofix_events enable row level security;

drop policy if exists "creator_url_autofix_events_select_anon"
  on public.creator_url_autofix_events;
create policy "creator_url_autofix_events_select_anon"
on public.creator_url_autofix_events
for select
to anon, authenticated
using (true);

drop policy if exists "creator_url_autofix_events_insert_anon"
  on public.creator_url_autofix_events;
create policy "creator_url_autofix_events_insert_anon"
on public.creator_url_autofix_events
for insert
to anon, authenticated
with check (true);

-- Audit log is immutable from the client. Same shape as
-- duplicate_pair_events: blocking update/delete means a corrupted or
-- malicious client cannot rewrite history.
drop policy if exists "creator_url_autofix_events_update_block"
  on public.creator_url_autofix_events;
create policy "creator_url_autofix_events_update_block"
on public.creator_url_autofix_events
for update
to anon, authenticated
using (false)
with check (false);

drop policy if exists "creator_url_autofix_events_delete_block"
  on public.creator_url_autofix_events;
create policy "creator_url_autofix_events_delete_block"
on public.creator_url_autofix_events
for delete
to anon, authenticated
using (false);
