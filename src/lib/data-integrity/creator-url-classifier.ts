/**
 * Classifier for the Creator profile URL Data Integrity check.
 *
 * The check used to surface every regex failure flat in a 5-section list
 * (one section per URL field). With the canonicalizer (`cleanCreatorUrl`)
 * in hand, we can now triage each invalid value into one of three buckets
 * that map directly to a user action:
 *
 *   - "auto-fixable"        — `cleanCreatorUrl` returns `status: "fixed"`
 *                             AND the canonical doesn't collide with any
 *                             other record. Bulk-fix button writes it.
 *   - "duplicate-after-fix" — canonical exists but another record (or
 *                             another invalid row that cleans to the same
 *                             canonical) already owns it. Send to the
 *                             Duplicates page for a merge decision.
 *   - "manual"              — `cleanCreatorUrl` returns `status: "invalid"`,
 *                             or the proposed URL fails the strict regex
 *                             double-gate. User must edit the value by
 *                             hand in HubSpot.
 *
 * The classifier is pure: same input → same output. It does NOT call out
 * to HubSpot or Supabase. Resolutions are passed in as a Map so the caller
 * can fetch them once per page load and reuse across renders.
 *
 * Safety rails baked in:
 *
 *   1. Every proposed fix is re-validated against `CREATOR_URL_RULES[field].regex`
 *      before landing in the `auto-fixable` bucket. If the canonicalizer
 *      ever drifts from the rule file, the row is demoted to `manual`
 *      rather than producing a non-compliant write.
 *   2. Self-collisions (two bad rows that clean to the same canonical, or
 *      a bad row whose canonical matches another record's existing URL)
 *      always land in `duplicate-after-fix`. Auto-fix never touches them.
 *   3. Within-record collisions (primary + secondary on the SAME creator
 *      cleaning to the same canonical) land in `manual` with a reason
 *      string — silently overwriting one of the two fields would surprise
 *      the user.
 *   4. Pairs already marked `resolved` or `dismissed` in
 *      `duplicate_pair_resolutions` no longer appear in
 *      `duplicate-after-fix`. If the resolution status is `resolved` and
 *      the row's creator survived as the winner, the value is promoted
 *      back to `auto-fixable` (the merge cleaned up the duplicate; we
 *      can now safely write the canonical). Otherwise it's dropped
 *      because the loser was archived in HubSpot.
 *   5. Multi-URL cells (whitespace-glued URLs) and YouTube `@handle` /
 *      `/c/` / `/user/` URLs both fail `cleanCreatorUrl` with explicit
 *      reasons and route to `manual`.
 */

import { cleanCreatorUrl } from "@/lib/creator-url-canonicalize";
import type { CreatorRowFull } from "@/lib/data-integrity/creator-csv";
import type { DuplicatePairResolution } from "@/lib/duplicates/supabase";
import {
  CREATOR_URL_FIELDS,
  CREATOR_URL_RULES,
  type CreatorUrlField,
} from "./creator-url-rules";

export type ClassifiedBucket =
  | "auto-fixable"
  | "duplicate-after-fix"
  | "manual"
  | "fixed-this-session";

export interface ClassifiedCollision {
  creatorId: string;
  creatorName: string;
  field: CreatorUrlField;
  rawValue: string;
  /** Stable pair key `${min(rid_a,rid_b)}:${max(rid_a,rid_b)}` matching the
   *  shape used everywhere else (find-pairs.ts, duplicate_pair_resolutions). */
  pairKey: string;
}

export interface ClassifiedIssue {
  /** Stable id across renders — `${creatorId}:${field}`. */
  id: string;
  bucket: ClassifiedBucket;
  creatorId: string;
  creatorName: string;
  field: CreatorUrlField;
  /** Raw value from the CSV (trimmed). Always present. */
  rawValue: string;
  /** Canonical URL we'd write if the user clicks Fix-All. Present for
   *  `auto-fixable` and `duplicate-after-fix`. */
  proposedUrl?: string;
  /** Human-readable transformation hints from the canonicalizer
   *  (e.g. ["lowercased handle", "added trailing /"]). */
  proposedIssues?: string[];
  /** Only set when `bucket === "duplicate-after-fix"`. The other side(s) of
   *  the collision so the row can deep-link to the Duplicates page. */
  collidesWith?: ClassifiedCollision[];
  /** Only set when `bucket === "manual"`. First non-empty hint from
   *  `cleanCreatorUrl(...)` issues array, or a default fallback. */
  manualReason?: string;
}

export interface ClassifierInput {
  creators: CreatorRowFull[];
  /**
   * Existing resolution rows keyed by pair key. Pass an empty Map (or
   * omit entirely) if the resolutions surface isn't available yet — the
   * classifier degrades gracefully into "show everything as if pending".
   */
  resolutions?: Map<string, DuplicatePairResolution>;
}

export interface ClassifierResult {
  issues: ClassifiedIssue[];
  /** Distinct invalid-row counts per bucket. Used by the UI section headers. */
  counts: Record<ClassifiedBucket, number>;
}

interface Slot {
  creatorId: string;
  creatorName: string;
  field: CreatorUrlField;
  rawValue: string;
  /**
   * True if this slot represents a CURRENTLY valid value (it passes the
   * strict regex as-is). Currently-valid slots take part in collision
   * detection — a bad row that cleans to the same canonical as a valid
   * neighbour is a `duplicate-after-fix`. They do not themselves produce
   * any output issue.
   */
  alreadyValid: boolean;
  /**
   * True if `cleanCreatorUrl(rawValue).status === "fixed"`. These are the
   * candidates for `auto-fixable`. Always false when `alreadyValid` is true.
   */
  isFixable: boolean;
  /** The cleaned canonical URL for this slot, only set when the cleaner
   *  returned status "ok" or "fixed". `undefined` for invalid slots. */
  canonical?: string;
  /** Hints from the canonicalizer; only meaningful for fixable slots. */
  cleanerIssues?: string[];
  /** First reason string for slots that fall through to the manual bucket. */
  manualReason?: string;
}

function pairKeyOf(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function networkOfField(field: CreatorUrlField): "instagram" | "tiktok" | "youtube" {
  if (field === "instagram" || field === "secondary_instagram") return "instagram";
  if (field === "tiktok" || field === "secondary_tiktok") return "tiktok";
  return "youtube";
}

/**
 * Pull every non-empty URL slot off the creator export and classify each
 * one upfront. Done in a single pass so the canonical index can see both
 * "currently valid" and "would-be-fixed-to" values for collision detection.
 */
function buildSlots(creators: CreatorRowFull[]): Slot[] {
  const slots: Slot[] = [];
  for (const creator of creators) {
    const id = creator.id;
    if (!id) continue;
    const name = creator.name || `Creator ${id}`;
    for (const field of CREATOR_URL_FIELDS) {
      const header = CREATOR_URL_RULES[field].csvHeader;
      const raw = (creator.raw[header] ?? "").trim();
      if (!raw) continue;

      const rule = CREATOR_URL_RULES[field];
      if (rule.regex.test(raw)) {
        slots.push({
          creatorId: id,
          creatorName: name,
          field,
          rawValue: raw,
          alreadyValid: true,
          isFixable: false,
          canonical: raw,
        });
        continue;
      }

      const cleaned = cleanCreatorUrl(raw);
      const net = networkOfField(field);
      // Reject any cleaner result that doesn't match the field's network
      // (e.g. a TikTok URL pasted into the Instagram column). Those need
      // a human decision — we don't know whether to move or delete.
      const sameNetwork = cleaned.network === net;

      if (cleaned.status === "fixed" && sameNetwork) {
        // Double-gate: the canonical MUST also pass the strict regex. If
        // the cleaner ever drifts from the rule file, demote to manual
        // instead of producing a non-compliant write.
        if (rule.regex.test(cleaned.fixedUrl)) {
          slots.push({
            creatorId: id,
            creatorName: name,
            field,
            rawValue: raw,
            alreadyValid: false,
            isFixable: true,
            canonical: cleaned.fixedUrl,
            cleanerIssues: cleaned.issues.slice(),
          });
          continue;
        }
      }

      // Anything that gets here is manual. Pick the first reason if any.
      let manualReason: string | undefined;
      if (!sameNetwork && cleaned.network !== "empty" && cleaned.network !== "other") {
        manualReason = `${cleaned.network} URL in ${rule.label} field — move or delete`;
      } else if (cleaned.issues.length > 0) {
        manualReason = cleaned.issues.find((i) => i.toLowerCase().includes("manual")) ?? cleaned.issues[0];
      } else {
        manualReason = rule.invalidMessage;
      }

      slots.push({
        creatorId: id,
        creatorName: name,
        field,
        rawValue: raw,
        alreadyValid: false,
        isFixable: false,
        manualReason,
      });
    }
  }
  return slots;
}

/**
 * Classify every invalid creator URL into one of three buckets.
 *
 * See module doc for the bucket definitions and safety rails. Output is
 * sorted by bucket → field → creatorId for deterministic rendering.
 */
export function classifyCreatorUrls(input: ClassifierInput): ClassifierResult {
  const resolutions = input.resolutions ?? new Map<string, DuplicatePairResolution>();
  const slots = buildSlots(input.creators);

  // Index ALL slots that have a canonical (valid or fixable) by their
  // network-scoped canonical URL. Collision detection works against this
  // index — a fixable slot that lands in a bucket alongside another
  // creator is a `duplicate-after-fix`.
  const canonicalIndex = new Map<string, Slot[]>();
  for (const slot of slots) {
    if (!slot.canonical) continue;
    const key = `${networkOfField(slot.field)}|${slot.canonical}`;
    const list = canonicalIndex.get(key) ?? [];
    list.push(slot);
    canonicalIndex.set(key, list);
  }

  const issues: ClassifiedIssue[] = [];

  for (const slot of slots) {
    if (slot.alreadyValid) continue;

    if (!slot.isFixable) {
      issues.push({
        id: `${slot.creatorId}:${slot.field}`,
        bucket: "manual",
        creatorId: slot.creatorId,
        creatorName: slot.creatorName,
        field: slot.field,
        rawValue: slot.rawValue,
        manualReason: slot.manualReason,
      });
      continue;
    }

    // Fixable slot — figure out if it would collide with another record.
    const key = `${networkOfField(slot.field)}|${slot.canonical}`;
    const bucket = canonicalIndex.get(key) ?? [];
    // Anyone else in the bucket (different creator id) is a potential
    // collision. Same-creator other slots are tracked separately — they
    // mean primary + secondary would collapse to the same URL.
    const otherCreators = bucket.filter((other) => other.creatorId !== slot.creatorId);
    const selfOthers = bucket.filter(
      (other) => other.creatorId === slot.creatorId && other !== slot,
    );

    if (selfOthers.length > 0) {
      issues.push({
        id: `${slot.creatorId}:${slot.field}`,
        bucket: "manual",
        creatorId: slot.creatorId,
        creatorName: slot.creatorName,
        field: slot.field,
        rawValue: slot.rawValue,
        proposedUrl: slot.canonical,
        proposedIssues: slot.cleanerIssues,
        manualReason: `Primary and secondary ${networkOfField(slot.field)} would be identical after fix — pick one`,
      });
      continue;
    }

    if (otherCreators.length === 0) {
      issues.push({
        id: `${slot.creatorId}:${slot.field}`,
        bucket: "auto-fixable",
        creatorId: slot.creatorId,
        creatorName: slot.creatorName,
        field: slot.field,
        rawValue: slot.rawValue,
        proposedUrl: slot.canonical,
        proposedIssues: slot.cleanerIssues,
      });
      continue;
    }

    // Collision against ≥1 other creator. Honor existing resolutions —
    // resolved/dismissed pairs drop out so the integrity card doesn't
    // keep nagging after the user merged in HubSpot.
    const liveCollisions: ClassifiedCollision[] = [];
    let allDismissed = otherCreators.length > 0; // start optimistic
    let promotedByMerge = false;
    for (const other of otherCreators) {
      const pk = pairKeyOf(slot.creatorId, other.creatorId);
      const res = resolutions.get(pk);
      if (!res || res.status === "pending" || res.status === "reopened") {
        liveCollisions.push({
          creatorId: other.creatorId,
          creatorName: other.creatorName,
          field: other.field,
          rawValue: other.rawValue,
          pairKey: pk,
        });
        allDismissed = false;
        continue;
      }
      if (res.status === "resolved") {
        // If THIS slot's creator was the merge winner, the loser is gone
        // in HubSpot and this slot can now be auto-fixed. If our creator
        // was the loser, dropping the row entirely is honest — the
        // record we're looking at no longer exists in HubSpot.
        if (res.winnerRecordId === slot.creatorId) {
          promotedByMerge = true;
          allDismissed = false;
          continue;
        }
        // Winner is the other side OR winner unknown — drop the row
        // entirely. We can't safely write to a record that was merged
        // into another.
        allDismissed = false;
        continue;
      }
      if (res.status === "dismissed") {
        // "Not a duplicate" — treat the collision as gone. If every other
        // collision is dismissed, the slot promotes back to auto-fixable.
        continue;
      }
    }

    if (liveCollisions.length > 0) {
      // Sort collisions by creator id for deterministic display.
      liveCollisions.sort((x, y) => (x.creatorId < y.creatorId ? -1 : x.creatorId > y.creatorId ? 1 : 0));
      issues.push({
        id: `${slot.creatorId}:${slot.field}`,
        bucket: "duplicate-after-fix",
        creatorId: slot.creatorId,
        creatorName: slot.creatorName,
        field: slot.field,
        rawValue: slot.rawValue,
        proposedUrl: slot.canonical,
        proposedIssues: slot.cleanerIssues,
        collidesWith: liveCollisions,
      });
      continue;
    }

    // No live collisions left. If every other-creator entry was either
    // dismissed or this creator survived a merge, we can auto-fix.
    if (allDismissed || promotedByMerge) {
      issues.push({
        id: `${slot.creatorId}:${slot.field}`,
        bucket: "auto-fixable",
        creatorId: slot.creatorId,
        creatorName: slot.creatorName,
        field: slot.field,
        rawValue: slot.rawValue,
        proposedUrl: slot.canonical,
        proposedIssues: slot.cleanerIssues,
      });
      continue;
    }
    // Fall-through: every other-creator was `resolved` with a different
    // winner — our record was merged away. Drop silently.
  }

  // Deterministic sort: bucket priority → field → creator id. Auto-fixable
  // goes first because it's the most actionable; manual last because the
  // user needs the least context to start with the easier work.
  const bucketRank: Record<ClassifiedBucket, number> = {
    "fixed-this-session": -1,
    "auto-fixable": 0,
    "duplicate-after-fix": 1,
    manual: 2,
  };
  const fieldRank = (f: CreatorUrlField) => CREATOR_URL_FIELDS.indexOf(f);
  issues.sort((a, b) => {
    if (a.bucket !== b.bucket) return bucketRank[a.bucket] - bucketRank[b.bucket];
    if (a.field !== b.field) return fieldRank(a.field) - fieldRank(b.field);
    return a.creatorId < b.creatorId ? -1 : a.creatorId > b.creatorId ? 1 : 0;
  });

  const counts: Record<ClassifiedBucket, number> = {
    "fixed-this-session": 0,
    "auto-fixable": 0,
    "duplicate-after-fix": 0,
    manual: 0,
  };
  for (const issue of issues) counts[issue.bucket]++;

  return { issues, counts };
}

/** Group classified issues by bucket, preserving the classifier's sort order. */
export function groupIssuesByBucket(
  issues: ClassifiedIssue[],
): Record<ClassifiedBucket, ClassifiedIssue[]> {
  const groups: Record<ClassifiedBucket, ClassifiedIssue[]> = {
    "fixed-this-session": [],
    "auto-fixable": [],
    "duplicate-after-fix": [],
    manual: [],
  };
  for (const issue of issues) groups[issue.bucket].push(issue);
  return groups;
}
