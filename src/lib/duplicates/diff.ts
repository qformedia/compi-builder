/**
 * Property-by-property diff used by the Duplicates side-by-side detail view.
 *
 * Bucket order (matches the user's requested layout):
 *   1. mismatch — both filled, different values  (most actionable, shown first)
 *   2. only_a   — filled in A but not B
 *   3. only_b   — filled in B but not A
 *   4. equal    — both filled and identical      (least interesting, shown last)
 *
 * Properties empty on both sides are dropped entirely so the table only
 * surfaces information the reviewer can actually act on. Within a bucket,
 * rows are sorted alphabetically by friendly label.
 *
 * Equality is exact-string after trim. URL-normalization-aware comparison
 * (e.g. treating `instagram.com/foo` and `https://www.instagram.com/foo/`
 * as equal) is a v2 nicety once the merge UI lands.
 */

export type PropDiffBucket = "mismatch" | "only_a" | "only_b" | "equal";

export interface PropDiff {
  /** HubSpot internal property name (e.g. `main_link`). */
  key: string;
  /** Friendly display label (e.g. `Main Link`). Falls back to `key` when no label is registered. */
  label: string;
  valueA: string;
  valueB: string;
  bucket: PropDiffBucket;
}

/**
 * Friendly labels for the HubSpot internal creator-property names returned
 * by `fetch_creators_batch` (see `helpers::full_creator_properties` in Rust).
 *
 * Keys MUST match the Rust property list. Anything missing here renders with
 * its raw HubSpot internal name so a forgotten label is loud, not silent.
 */
export const CREATOR_PROPERTY_LABELS: Record<string, string> = {
  // Identity / classification
  name: "Name",
  email: "Email",
  main_link: "Main Link",
  main_account: "Main Account",
  status: "Status",
  category: "Category",
  tags: "Tags",
  hubspot_owner_id: "Owner",
  license_type: "License Type",
  license_checked: "License Checked",
  license_file: "License File",
  traceability_file: "Traceability File",
  available_channels: "Available Channels",
  available_platforms: "Available Platforms",
  date_granted: "Date Granted",
  // Profile URLs (in-scope for duplicate detection)
  instagram: "Instagram",
  secondary_instagram: "Secondary Instagram",
  tiktok: "TikTok",
  secondary_tiktok: "Secondary TikTok",
  youtube: "YouTube",
  // Profile URLs (out of scope but useful side-by-side context)
  facebook: "Facebook",
  x: "X",
  web: "Web",
  other_links: "Other Links",
  // China-network handles (URL property + bare-handle *_id)
  from_china: "From China",
  bilibili: "Bilibili",
  douyin: "Douyin",
  douyin_id: "Douyin ID",
  ixigua: "Ixigua",
  kuaishou: "Kuaishou",
  kuaishou_id: "Kuaishou ID",
  weibo: "Weibo",
  wechat: "WeChat",
  xiaohongshu: "Xiaohongshu",
  xiaohongshu_id: "Xiaohongshu ID",
  // Notes / follow-up
  notes: "Notes",
  keep_up_1: "Keep Up 1",
  keep_up_2: "Keep Up 2",
  keep_up_3: "Keep Up 3",
  date_found: "Date Found",
  date_initial_contact: "Date Initial Contact",
  video_types_could_do: "Video Types Could Do",
  discarded: "Discarded",
  special_requests: "Special Requests",
  // System / activity
  hs_createdate: "Object create date/time",
  hs_lastmodifieddate: "Object last modified date/time",
};

/**
 * Rollup property keys that are displayed in the dedicated Associations card
 * on the Duplicates detail page (not in the property diff buckets).
 */
export const ASSOCIATION_ROLLUP_KEYS = [
  "num_of_contacts",
  "num_of_external_clips",
  "num_of_public_video_projects",
  "num_of_send_link_actions",
  "num_of_social_interactions",
  "num_of_video_projects",
] as const;

export const ASSOCIATION_ROLLUP_LABELS: Record<string, string> = {
  num_of_contacts: "Num of Contacts",
  num_of_external_clips: "Num of External Clips",
  num_of_public_video_projects: "Num of Public Video Projects",
  num_of_send_link_actions: "Num of Send Link Actions",
  num_of_social_interactions: "Num of Social Interactions",
  num_of_video_projects: "Num of Video Projects",
};

/**
 * License-related property keys, in the display order used by the
 * "License Information" card on the Duplicates detail and Merge History
 * pages. `status` is intentionally first because it's the highest-signal
 * field when triaging a duplicate (e.g. Granted vs. Declined). The rest
 * follow the order of HubSpot's own License Information property card so
 * a reviewer who is used to that layout can scan it without re-orienting.
 *
 * Used in two places:
 *   - As the row order for the License Information card.
 *   - As `SKIP_KEYS` membership so these properties don't show up again
 *     in the bucketed Property diff below the card. The dedicated card
 *     is the canonical surface for these fields; rendering them twice
 *     just clutters the page.
 */
export const LICENSE_INFO_KEYS = [
  "status",
  "license_type",
  "license_checked",
  "license_file",
  "traceability_file",
  "available_channels",
  "available_platforms",
  "date_granted",
  "special_requests",
] as const;

const SKIP_KEYS = new Set<string>([
  ...ASSOCIATION_ROLLUP_KEYS,
  ...LICENSE_INFO_KEYS,
]);

const BUCKET_ORDER: Record<PropDiffBucket, number> = {
  mismatch: 0,
  only_a: 1,
  only_b: 2,
  equal: 3,
};

function labelFor(key: string): string {
  return CREATOR_PROPERTY_LABELS[key] ?? key;
}

function normalize(value: string | null | undefined): string {
  if (value == null) return "";
  return String(value).trim();
}

/**
 * Build a sorted side-by-side diff between two creators' property maps.
 *
 * The union of property keys across A and B is considered (so a property
 * present only in one side still surfaces). Keys with empty values on both
 * sides are dropped.
 */
export function sortPropertiesForDiff(
  a: Record<string, string>,
  b: Record<string, string>,
): PropDiff[] {
  const keys = new Set<string>();
  for (const k of Object.keys(a)) keys.add(k);
  for (const k of Object.keys(b)) keys.add(k);

  const rows: PropDiff[] = [];
  for (const key of keys) {
    if (SKIP_KEYS.has(key)) continue;
    const valueA = normalize(a[key]);
    const valueB = normalize(b[key]);
    if (!valueA && !valueB) continue;
    let bucket: PropDiffBucket;
    if (!valueA) bucket = "only_b";
    else if (!valueB) bucket = "only_a";
    else if (valueA === valueB) bucket = "equal";
    else bucket = "mismatch";
    rows.push({ key, label: labelFor(key), valueA, valueB, bucket });
  }

  rows.sort((x, y) => {
    const bo = BUCKET_ORDER[x.bucket] - BUCKET_ORDER[y.bucket];
    if (bo !== 0) return bo;
    return x.label.localeCompare(y.label);
  });
  return rows;
}

// ──────────────────────────────────────────────────────────────────────────
// Native-merge preview
//
// HubSpot's `POST /crm/v3/objects/{id}/merge` endpoint merges the secondary
// (loser) into the primary (winner) using a deterministic rule:
//
//   - For every property, keep the primary's value if it's non-empty.
//   - Otherwise fall back to the secondary's value.
//   - Conflicting non-empty values: primary always wins.
//
// `predictMergedProperties` reproduces that rule locally so the Duplicates
// detail view can show an "A Merged" / "B Merged" preview column that
// matches what HubSpot will produce, *before* the irreversible call. Stay
// faithful to the rule — any deviation here means the preview lies.
//
// Rollup counts (`num_of_*`) are calculated server-side from the actual
// associations after merge; we predict them as the simple sum because
// every association from the loser is transferred to the winner. This is
// an upper bound (HubSpot would deduplicate a record associated to both
// sides, which is rare) but good enough for the preview signal.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Predict the property map of the post-merge winner record.
 *
 * Returns `winner[key] || loser[key]` for every key in the union of the
 * two input maps. Whitespace-only values count as empty (matches the
 * existing `normalize` used by `sortPropertiesForDiff`, so the preview
 * stays consistent with the diff buckets).
 */
export function predictMergedProperties(
  winner: Record<string, string>,
  loser: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const keys = new Set<string>();
  for (const k of Object.keys(winner)) keys.add(k);
  for (const k of Object.keys(loser)) keys.add(k);
  for (const key of keys) {
    const w = normalize(winner[key]);
    const l = normalize(loser[key]);
    out[key] = w !== "" ? w : l;
  }
  return out;
}

/**
 * Predict the post-merge value for a single rollup key. Inputs are the
 * raw HubSpot strings ("0" / "" / "5"); the output is the numeric sum
 * rendered back as a string so the rollup table stays string-typed.
 */
export function predictMergedAssociationRollup(
  winnerValue: string | undefined,
  loserValue: string | undefined,
): string {
  const w = parseRollup(winnerValue);
  const l = parseRollup(loserValue);
  return String(w + l);
}

/**
 * Convenience wrapper: build the predicted-rollup map for every key in
 * `ASSOCIATION_ROLLUP_KEYS`. Useful when wiring the preview column into
 * the existing rollup table.
 */
export function predictMergedAssociationRollups(
  winnerProps: Record<string, string>,
  loserProps: Record<string, string>,
): Record<(typeof ASSOCIATION_ROLLUP_KEYS)[number], string> {
  const out = {} as Record<(typeof ASSOCIATION_ROLLUP_KEYS)[number], string>;
  for (const key of ASSOCIATION_ROLLUP_KEYS) {
    out[key] = predictMergedAssociationRollup(winnerProps[key], loserProps[key]);
  }
  return out;
}

function parseRollup(value: string | undefined): number {
  if (value == null) return 0;
  const trimmed = String(value).trim();
  if (!trimmed) return 0;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : 0;
}
