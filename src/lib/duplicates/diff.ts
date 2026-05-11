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
  main_link: "Main Link",
  main_account: "Main Account",
  status: "Status",
  category: "Category",
  tags: "Tags",
  hubspot_owner_id: "Owner",
  license_type: "License Type",
  license_checked: "License Checked",
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
  // China-network handles
  from_china: "From China",
  bilibili: "Bilibili",
  douyin_id: "Douyin",
  ixigua: "Ixigua",
  kuaishou_id: "Kuaishou",
  weibo: "Weibo",
  wechat: "WeChat",
  xiaohongshu_id: "Xiaohongshu",
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
  num_associated_video_projects: "# Video Projects",
  num_associated_external_clips: "# External Clips",
  num_associated_contacts: "# Contacts",
};

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
