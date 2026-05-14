/**
 * Helpers for the merge flow on the Duplicates page.
 *
 * HubSpot's merge endpoint rejects merges when an admin-configured
 * association cap (e.g. "1 Creator per External Clip") would be
 * exceeded. The fix in CompiFlow is two-phase:
 *
 *   1. Try the regular `merge_creators` Tauri command. ~99% of merges
 *      succeed here.
 *   2. If it fails with the specific "Association configuration limits
 *      are exceeded" error, automatically retry with
 *      `merge_creators_with_reassign`, which pre-swaps the constrained
 *      associations from loser to winner before invoking the merge.
 *
 * This module isolates the small bits of logic that BOTH the component
 * and its tests need without forcing the component to mock the Tauri
 * `invoke` boundary just to test string parsing:
 *
 *   - `isAssociationLimitError` — pure substring check on the raw
 *     HubSpot error message.
 *   - `Reassignment` / `MergeReassignResult` — the JSON shape returned
 *     by `merge_creators_with_reassign` on success (camelCase, mirrors
 *     the Rust serializer).
 *   - `formatReassignmentSummary` — turns the per-peer counts into the
 *     one-line note we surface in the success banner and the audit log.
 *
 * Keep the substring in `isAssociationLimitError` in lock-step with the
 * Rust helper `helpers::is_association_limit_error` — both detect the
 * same HubSpot phrase so a regression on one side would silently break
 * the workaround on the other.
 */

/**
 * Per-peer entry returned by the Rust command after a successful
 * pre-swap-then-merge. `count` is the number of records moved from
 * loser to winner for that peer object type.
 */
export interface Reassignment {
  objectTypeId: string;
  objectTypeLabel: string;
  count: number;
}

/**
 * Full success payload returned by `merge_creators_with_reassign`.
 * `merged` is always `true` when the command resolves — failures throw
 * a string instead. `reassignments` is always an array (possibly empty
 * if no peers were capped). `mergeResponse` is the raw HubSpot merge
 * response, kept for parity with the regular merge flow.
 */
export interface MergeReassignResult {
  merged: true;
  reassignments: Reassignment[];
  mergeResponse: unknown;
}

/**
 * True when an error string from `merge_creators` is the HubSpot
 * "association configuration limits exceeded" payload. The check is a
 * plain substring match because HubSpot wraps the same phrase in a
 * stable JSON envelope and we don't need (or want) to parse it just to
 * route the error.
 */
export function isAssociationLimitError(message: string | null | undefined): boolean {
  if (!message) return false;
  return message.includes("Association configuration limits are exceeded");
}

/**
 * Build the one-line summary used in the success banner and the
 * `duplicate_pair_events` payload after a workaround merge. Produces:
 *
 *   "Reassigned 47 External Clips and 3 Contacts before merging."
 *
 * Returns `null` when there's nothing to report (no peers reassigned),
 * so the caller can decide whether to render any banner at all.
 */
export function formatReassignmentSummary(
  reassignments: readonly Reassignment[],
): string | null {
  const items = reassignments.filter((r) => r.count > 0);
  if (items.length === 0) return null;

  const parts = items.map((r) => `${r.count} ${r.objectTypeLabel}`);
  let joined: string;
  if (parts.length === 1) {
    joined = parts[0];
  } else if (parts.length === 2) {
    joined = `${parts[0]} and ${parts[1]}`;
  } else {
    // Oxford comma — three-or-more peers reassigned in the same merge
    // is rare, but reads cleaner than a trailing-and join.
    joined = `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
  }
  return `Reassigned ${joined} before merging.`;
}

/**
 * Total count of records moved across all peers. Used in the audit log
 * row alongside the per-peer breakdown so analytics queries can
 * `sum()` without unpacking the JSON.
 */
export function totalReassignedRecords(
  reassignments: readonly Reassignment[],
): number {
  return reassignments.reduce((sum, r) => sum + Math.max(0, r.count), 0);
}
