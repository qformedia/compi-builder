/**
 * Duplicate-pair detection over the all-creators export.
 *
 * Implementation of the workhorse patterns described in
 * `~/Documents/QforMedia/Tastic ExClips Clean Up/spec-for-compiflow/duplicate-detection-spec.md`.
 *
 * v1 covers:
 *   - Pattern 1 — cross-record canonical-URL collision (the workhorse, ~313
 *     of the 327 pairs in the reference dataset).
 *   - Pattern 3 — multi-URL cell collision (a creator with two URLs glued
 *     into a single cell, where one of those URLs collides with another
 *     creator's existing canonical URL after autofix).
 *   - Pattern 5 — bare-handle promotion (handled inside `cleanCreatorUrl`,
 *     no separate branch here).
 *
 * Out of scope for v1:
 *   - Pattern 2 (External Clips IG-post cross-reference) — needs an external-
 *     clips export pipeline that doesn't exist yet in CompiFlow.
 *   - Pattern 4 (within-record duplicates) — separate report; emitted to a
 *     different surface because it's a property-clear, not a merge.
 *
 * The detector consumes `CreatorRowFull` rows from `parseCreatorsCsvFull` and
 * returns one `DuplicatePair` per cross-record collision. The caller is
 * responsible for joining with `duplicate_pair_resolutions` to filter out
 * already-handled pairs.
 */

import { cleanCreatorUrl } from "@/lib/creator-url-canonicalize";
import type { CreatorRowFull } from "@/lib/data-integrity/creator-csv";

export type CreatorUrlColumn =
  | "Instagram"
  | "Secondary Instagram"
  | "TikTok"
  | "Secondary TikTok"
  | "Youtube";

export const CREATOR_URL_COLUMNS: CreatorUrlColumn[] = [
  "Instagram",
  "Secondary Instagram",
  "TikTok",
  "Secondary TikTok",
  "Youtube",
];

export type DuplicatePairSource =
  | "canonical_collision"
  | "multi_url_collision"
  | "bare_handle_promotion";

export type DuplicatePairNetwork = "instagram" | "tiktok" | "youtube";

export interface DuplicatePairSide {
  rid: string;
  name: string;
  /** Which in-scope columns on this creator hold the duplicate URL. */
  columns: CreatorUrlColumn[];
  /** True if at least one of those slots came from a multi-URL cell. */
  fromMultiUrlCell?: boolean;
  /** True if at least one of those slots came from a bare-handle promotion. */
  fromBareHandlePromotion?: boolean;
}

export interface DuplicatePair {
  /** Stable across runs and across networks: `${min(rid_a,rid_b)}:${max(rid_a,rid_b)}`. */
  pairKey: string;
  network: DuplicatePairNetwork;
  canonicalUrl: string;
  /** Patterns that contributed to flagging this pair (deduplicated, sorted). */
  source: DuplicatePairSource[];
  /** "Broken" side for Patterns 3/bare-handle when applicable; otherwise the
   *  smaller record id by lexicographic order. */
  a: DuplicatePairSide;
  b: DuplicatePairSide;
}

/**
 * Internal indexing entry. One per (creator, column, canonical-URL) tuple.
 * A creator can appear multiple times in the same bucket if they hold the
 * same canonical URL across primary + secondary on the same network — those
 * are de-duped by `rid` before pair emission.
 */
interface Slot {
  rid: string;
  name: string;
  column: CreatorUrlColumn;
  fromMultiUrlCell: boolean;
  fromBareHandlePromotion: boolean;
}

const BARE_HANDLE_RE = /^@[A-Za-z0-9_.]+$/;

/**
 * Split a multi-URL cell on whitespace, canonicalize each token, and return
 * the canonical URLs that survived. Used by Pattern 3 to extract candidate
 * URLs from cells the canonicalizer would otherwise reject as `invalid` for
 * containing whitespace.
 */
function extractMultiUrlCanonicals(raw: string): {
  network: DuplicatePairNetwork;
  canonical: string;
}[] {
  const out: { network: DuplicatePairNetwork; canonical: string }[] = [];
  const tokens = raw.split(/\s+/).map((t) => t.trim()).filter(Boolean);
  if (tokens.length < 2) return out;
  for (const token of tokens) {
    const c = cleanCreatorUrl(token);
    if (c.status === "invalid") continue;
    if (c.network !== "instagram" && c.network !== "tiktok" && c.network !== "youtube") {
      continue;
    }
    out.push({ network: c.network, canonical: c.fixedUrl });
  }
  return out;
}

function pairKeyOf(ridA: string, ridB: string): string {
  return ridA < ridB ? `${ridA}:${ridB}` : `${ridB}:${ridA}`;
}

/**
 * Find every potential duplicate pair across the supplied creator rows.
 *
 * The returned list is stable: same input produces the same output, sorted by
 * network → canonical URL → pairKey for deterministic display.
 */
export function findDuplicatePairs(creators: CreatorRowFull[]): DuplicatePair[] {
  // Index keyed by `${network}|${canonical_url}`.
  const index = new Map<string, Slot[]>();

  for (const creator of creators) {
    const rid = creator.id;
    const name = creator.name;
    if (!rid) continue;

    for (const column of CREATOR_URL_COLUMNS) {
      const raw = (creator.raw[column] ?? "").trim();
      if (!raw) continue;

      // Pattern 5 visibility: track whether this slot was rescued by the
      // bare-handle promotion path so the UI can surface it.
      const fromBareHandle = BARE_HANDLE_RE.test(raw);

      const c = cleanCreatorUrl(raw);
      if (c.status !== "invalid" && (c.network === "instagram" || c.network === "tiktok" || c.network === "youtube")) {
        const key = `${c.network}|${c.fixedUrl}`;
        const slot: Slot = {
          rid,
          name,
          column,
          fromMultiUrlCell: false,
          fromBareHandlePromotion: fromBareHandle,
        };
        const slots = index.get(key) ?? [];
        slots.push(slot);
        index.set(key, slots);
        continue;
      }

      // Pattern 3: cell was rejected (often because it contains multiple
      // whitespace-glued URLs). Try to extract each candidate and index it
      // under the SAME column with a fromMultiUrlCell tag.
      const multi = extractMultiUrlCanonicals(raw);
      for (const m of multi) {
        const key = `${m.network}|${m.canonical}`;
        const slot: Slot = {
          rid,
          name,
          column,
          fromMultiUrlCell: true,
          fromBareHandlePromotion: false,
        };
        const slots = index.get(key) ?? [];
        slots.push(slot);
        index.set(key, slots);
      }
    }
  }

  // Emit pairs from buckets with ≥2 distinct record IDs.
  const pairs: DuplicatePair[] = [];

  for (const [key, slots] of index) {
    const [networkStr, canonicalUrl] = key.split("|", 2);
    const network = networkStr as DuplicatePairNetwork;

    // Group slots by record ID so within-record dups (same canonical URL
    // across primary + secondary on the same record) collapse into one
    // entry — those don't emit cross-record pairs.
    const byRid = new Map<string, Slot[]>();
    for (const s of slots) {
      const list = byRid.get(s.rid) ?? [];
      list.push(s);
      byRid.set(s.rid, list);
    }
    if (byRid.size < 2) continue;

    const rids = [...byRid.keys()].sort();
    for (let i = 0; i < rids.length; i++) {
      for (let j = i + 1; j < rids.length; j++) {
        const ridA = rids[i];
        const ridB = rids[j];
        const slotsA = byRid.get(ridA)!;
        const slotsB = byRid.get(ridB)!;

        const sideA: DuplicatePairSide = aggregateSide(ridA, slotsA);
        const sideB: DuplicatePairSide = aggregateSide(ridB, slotsB);

        const sources = new Set<DuplicatePairSource>(["canonical_collision"]);
        if (sideA.fromMultiUrlCell || sideB.fromMultiUrlCell) {
          sources.add("multi_url_collision");
        }
        if (sideA.fromBareHandlePromotion || sideB.fromBareHandlePromotion) {
          sources.add("bare_handle_promotion");
        }

        // Direction rule: when one side came from a multi-URL cell or a
        // bare-handle promotion, that's the "broken" side and should be
        // shown as A. Otherwise default to lexicographic rid ordering
        // (the inner loop already enforces that).
        const aIsBroken = sideA.fromMultiUrlCell || sideA.fromBareHandlePromotion;
        const bIsBroken = sideB.fromMultiUrlCell || sideB.fromBareHandlePromotion;
        const swap = !aIsBroken && bIsBroken;

        pairs.push({
          pairKey: pairKeyOf(ridA, ridB),
          network,
          canonicalUrl,
          source: [...sources].sort(),
          a: swap ? sideB : sideA,
          b: swap ? sideA : sideB,
        });
      }
    }
  }

  // Two pairs may exist for the same (a, b) across different networks (rare
  // but possible). Keep them — same pairKey, but the user may want to see
  // both findings. Deterministic sort: network → canonical URL → pairKey.
  pairs.sort((p, q) => {
    if (p.network !== q.network) return p.network < q.network ? -1 : 1;
    if (p.canonicalUrl !== q.canonicalUrl) {
      return p.canonicalUrl < q.canonicalUrl ? -1 : 1;
    }
    return p.pairKey < q.pairKey ? -1 : p.pairKey > q.pairKey ? 1 : 0;
  });

  return pairs;
}

function aggregateSide(rid: string, slots: Slot[]): DuplicatePairSide {
  // Preserve column order from CREATOR_URL_COLUMNS and de-dup.
  const seen = new Set<CreatorUrlColumn>();
  const columns: CreatorUrlColumn[] = [];
  let fromMulti = false;
  let fromBare = false;
  let name = "";
  for (const s of slots) {
    if (!seen.has(s.column)) {
      seen.add(s.column);
      columns.push(s.column);
    }
    if (s.fromMultiUrlCell) fromMulti = true;
    if (s.fromBareHandlePromotion) fromBare = true;
    if (!name && s.name) name = s.name;
  }
  columns.sort((a, b) => CREATOR_URL_COLUMNS.indexOf(a) - CREATOR_URL_COLUMNS.indexOf(b));
  return {
    rid,
    name,
    columns,
    ...(fromMulti ? { fromMultiUrlCell: true } : {}),
    ...(fromBare ? { fromBareHandlePromotion: true } : {}),
  };
}
