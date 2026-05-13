-- Excluded HubSpot owners — shared across all CompiFlow installs.
--
-- When an owner is excluded they disappear from the Clips > Create owner
-- dropdown. This is a team-curated list (ex-teammates, pending invites, etc.)
-- synced via Supabase so every install sees the same filtered set.
--
-- Run via Supabase SQL Editor or `supabase db push`.

-- ──────────────────────────────────────────────────────────────────────
-- One row per excluded owner
-- ──────────────────────────────────────────────────────────────────────

create table if not exists public.hs_excluded_owners (
  owner_id text primary key,            -- HubSpot CRM owner id (string)
  email text,                           -- snapshot at exclude-time, for display
  display_name text,                    -- snapshot, e.g. "Pau Mas"
  excluded_by text,                     -- email of CompiFlow user who excluded them
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- updated_at maintenance trigger
create or replace function public.hs_excluded_owners_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists hs_excluded_owners_set_updated_at
  on public.hs_excluded_owners;
create trigger hs_excluded_owners_set_updated_at
  before update on public.hs_excluded_owners
  for each row execute function public.hs_excluded_owners_set_updated_at();

alter table public.hs_excluded_owners enable row level security;

drop policy if exists "hs_excluded_owners_select_anon"
  on public.hs_excluded_owners;
create policy "hs_excluded_owners_select_anon"
on public.hs_excluded_owners
for select
to anon, authenticated
using (true);

drop policy if exists "hs_excluded_owners_insert_anon"
  on public.hs_excluded_owners;
create policy "hs_excluded_owners_insert_anon"
on public.hs_excluded_owners
for insert
to anon, authenticated
with check (true);

drop policy if exists "hs_excluded_owners_update_anon"
  on public.hs_excluded_owners;
create policy "hs_excluded_owners_update_anon"
on public.hs_excluded_owners
for update
to anon, authenticated
using (true)
with check (true);

drop policy if exists "hs_excluded_owners_delete_anon"
  on public.hs_excluded_owners;
create policy "hs_excluded_owners_delete_anon"
on public.hs_excluded_owners
for delete
to anon, authenticated
using (true);
