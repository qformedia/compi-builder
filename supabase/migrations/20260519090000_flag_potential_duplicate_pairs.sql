-- Flag potential duplicate pairs (Integrity button + external cleanup scripts).
--
-- The desktop app already computes duplicate pairs on demand from the cached
-- all-creators export. That covers the canonical-URL collision case but it
-- can't catch pairs that look unrelated by URL — different handles for the
-- same person, freshly imported data still being cleaned up out-of-band, etc.
--
-- This migration extends the existing duplicate_pair_resolutions table so
-- the desktop app AND a separate cleanup script can flag two HubSpot creator
-- records as a "potential duplicate" pair. Flagged pairs use the existing
-- status='pending' value (already in the CHECK constraint but unused until
-- now). Two new columns provide provenance:
--
--   * source       — 'integrity-mark', 'integrity-mark-bulk',
--                    'external-script:<name>'. Null on legacy rows
--                    (resolved/dismissed merges that pre-date this change).
--   * flagged_at   — when the pair was first marked. Distinct from
--                    created_at, which historically aligns with the merge or
--                    dismiss timestamp on those rows.
--
-- duplicate_pair_events.event_type also gains 'flagged' so the audit log
-- can record who put a pair in the queue and from where.
--
-- All changes are additive — no row rewrites, no type changes, no policy
-- tightening. Safe to apply ahead of the desktop rollout window.

-- ──────────────────────────────────────────────────────────────────────
-- duplicate_pair_resolutions: add source + flagged_at
-- ──────────────────────────────────────────────────────────────────────

alter table public.duplicate_pair_resolutions
  add column if not exists source text;

alter table public.duplicate_pair_resolutions
  add column if not exists flagged_at timestamptz;

-- Selecting active (pending/reopened) rows across all pairs is the new
-- hot path for the Duplicates page list builder. The existing status_idx
-- already covers it, but we add a partial index focused on the active
-- subset so a growing archive of resolved/dismissed rows stays cheap.
create index if not exists duplicate_pair_resolutions_active_idx
  on public.duplicate_pair_resolutions (flagged_at desc)
  where status in ('pending', 'reopened');

-- ──────────────────────────────────────────────────────────────────────
-- duplicate_pair_events: allow event_type='flagged'
-- ──────────────────────────────────────────────────────────────────────
--
-- CHECK constraints can't be ALTERed in place — drop and recreate. The
-- table is append-only so there's nothing to rewrite; existing rows all
-- have one of the previously-allowed values.

alter table public.duplicate_pair_events
  drop constraint if exists duplicate_pair_events_event_type_check;

alter table public.duplicate_pair_events
  add constraint duplicate_pair_events_event_type_check
  check (event_type in ('resolved', 'dismissed', 'reopened', 'note', 'merged', 'flagged'));
