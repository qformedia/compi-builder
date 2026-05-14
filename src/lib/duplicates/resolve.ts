/**
 * Manual resolution writes for the Duplicates page.
 *
 * `recordMergeResolution` in [supabase.ts](./supabase.ts) handles the
 * happy path where the user merges two creators via the in-app HubSpot
 * merge endpoint. This module covers the other write paths that the v1
 * resolutions schema supports but didn't surface yet:
 *
 *   - `markDismissed`  — "this isn't actually a duplicate" — keeps the
 *                        records as-is but tells CompiFlow to stop
 *                        flagging the pair.
 *   - `reopen`         — undoes a prior dismiss/merge so the pair shows
 *                        up in the pending list again.
 *
 * Every write does two things in order:
 *
 *   1. Append an event row to `duplicate_pair_events` (immutable audit
 *      trail). We do this first because losing the resolutions row is
 *      recoverable from events, but losing attribution is not.
 *   2. Upsert the canonical state row in `duplicate_pair_resolutions`
 *      with the new status. The CHECK constraint requires
 *      `record_id_a < record_id_b`, so callers MUST pass the canonical
 *      sorted pair.
 *
 * Errors from either step are bubbled up to the caller via
 * `describeSupabaseError`. The Duplicates page treats a write failure
 * as a soft warning — the local view still updates optimistically so
 * the user can continue working.
 */

import { getDuplicatesSupabaseClient } from "./supabase";

export interface ResolvePairArgs {
  /** Canonical key `${min(rid_a,rid_b)}:${max(rid_a,rid_b)}`. */
  pairKey: string;
  /** Sorted record ids matching the table CHECK constraint. */
  recordIdA: string;
  recordIdB: string;
  /** Display name for the audit log. Defaults to "compiflow" if blank. */
  actor: string;
  /** Free-text notes from the resolution dialog. Optional. */
  notes?: string;
}

/**
 * Mark a pair as "not a duplicate" — same audit-then-upsert shape as
 * the merge flow, but we don't set a winner record because neither side
 * wins; both remain as separate creators.
 */
export async function markDismissed(args: ResolvePairArgs): Promise<void> {
  const client = getDuplicatesSupabaseClient();
  const now = new Date().toISOString();
  const actor = (args.actor || "").trim() || null;

  const { error: eventErr } = await client.from("duplicate_pair_events").insert({
    pair_key: args.pairKey,
    actor,
    event_type: "dismissed",
    payload: { notes: args.notes ?? null },
  });
  if (eventErr) throw eventErr;

  const { error: resErr } = await client
    .from("duplicate_pair_resolutions")
    .upsert(
      {
        pair_key: args.pairKey,
        record_id_a: args.recordIdA,
        record_id_b: args.recordIdB,
        status: "dismissed",
        resolved_by: actor,
        resolved_at: now,
        resolution_notes: args.notes ?? "Marked as not a duplicate",
        // Explicitly null out any previous winner so a reopened-then-
        // dismissed pair doesn't carry stale merge data.
        winner_record_id: null,
      },
      { onConflict: "pair_key" },
    );
  if (resErr) throw resErr;
}

/**
 * Reopen a previously resolved/dismissed pair so it shows up in the
 * pending list again. We clear `winner_record_id` and `resolved_at`
 * because they no longer describe the current state — the audit log
 * keeps the prior values if anyone needs them.
 */
export async function reopen(args: ResolvePairArgs): Promise<void> {
  const client = getDuplicatesSupabaseClient();
  const actor = (args.actor || "").trim() || null;

  const { error: eventErr } = await client.from("duplicate_pair_events").insert({
    pair_key: args.pairKey,
    actor,
    event_type: "reopened",
    payload: { notes: args.notes ?? null },
  });
  if (eventErr) throw eventErr;

  const { error: resErr } = await client
    .from("duplicate_pair_resolutions")
    .upsert(
      {
        pair_key: args.pairKey,
        record_id_a: args.recordIdA,
        record_id_b: args.recordIdB,
        status: "reopened",
        resolved_by: actor,
        resolved_at: null,
        resolution_notes: args.notes ?? "Reopened",
        winner_record_id: null,
      },
      { onConflict: "pair_key" },
    );
  if (resErr) throw resErr;
}

/**
 * Canonical helper for callers that have an arbitrary (winner, loser)
 * pair and want the table-CHECK-compliant sorted ids. Sort matches the
 * pair key `${min}:${max}` used everywhere else.
 */
export function canonicalSortedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}
