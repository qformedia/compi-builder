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
 * pre-swap-then-merge. `count` is the number of *new* winner-side
 * associations the workaround created (i.e. excluding records that were
 * already on the winner before the pre-swap ran). The remaining fields
 * are diagnostic-only and may be absent on older payloads:
 *
 * - `loserBefore`: total peer records associated to the loser before
 *   the workaround ran.
 * - `overlap`: records that were already on the winner; archived from
 *   the loser-side only (no winner-side create needed).
 * - `detachedFromLoser`: records archived from the loser to bring the
 *   `Creator → peer` cap into compliance. These records lose their
 *   Creator link entirely (the winner's own records take priority).
 */
export interface Reassignment {
  objectTypeId: string;
  objectTypeLabel: string;
  count: number;
  loserBefore?: number;
  overlap?: number;
  detachedFromLoser?: number;
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
 * `duplicate_pair_events` payload after a workaround merge. Combines:
 *
 *   * Reassignments — records moved from loser to winner.
 *     "Reassigned 47 External Clips and 3 Contacts before merging."
 *   * Detachments — loser records dropped to honour a `Creator → peer`
 *     cap. The winner's records always take priority, so the loser's
 *     overflow loses its Creator link.
 *     "Detached 1 Deals from the loser to honour per-Creator caps."
 *
 * Both sentences are concatenated when both are non-empty. Returns
 * `null` only when there is nothing of either kind to report, so the
 * caller can decide whether to render any banner at all.
 */
export function formatReassignmentSummary(
  reassignments: readonly Reassignment[],
): string | null {
  const moved = reassignments.filter((r) => r.count > 0);
  const detached = reassignments.filter((r) => (r.detachedFromLoser ?? 0) > 0);

  const sentences: string[] = [];
  if (moved.length > 0) {
    sentences.push(`Reassigned ${joinPeerCounts(moved, (r) => r.count)} before merging.`);
  }
  if (detached.length > 0) {
    const labels = joinPeerCounts(detached, (r) => r.detachedFromLoser ?? 0);
    sentences.push(`Detached ${labels} from the loser to honour per-Creator caps.`);
  }
  if (sentences.length === 0) return null;
  return sentences.join(" ");
}

/**
 * Join `"N Label"` fragments for a list of peer entries using an Oxford
 * comma for three-or-more peers, a plain "and" for two, and a bare
 * fragment for one. Extracted so reassignment and detachment summaries
 * format identically.
 */
function joinPeerCounts(
  items: readonly Reassignment[],
  getCount: (r: Reassignment) => number,
): string {
  const parts = items.map((r) => `${getCount(r)} ${r.objectTypeLabel}`);
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
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
