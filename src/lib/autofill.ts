import { searchClips, type HubSpotFilter } from "@/lib/hubspot";
import {
  matchesDateRange,
  matchesLicenseFilters,
  matchesNumericRange,
  matchesProvider,
} from "@/lib/clipFilters";
import { SUPPORTED_PLATFORMS, type SupportedPlatform } from "@/lib/getPlatform";
import type { LicenseTypeOption } from "@/components/LicenseTypePicker";
import type {
  AutofillBucket,
  AutofillConfig,
  BucketFilter,
  BucketFilterField,
  BucketFilterOperator,
  Clip,
  Project,
} from "@/types";

// ── Defaults & metadata ────────────────────────────────────────────────────

/** Hard cap on filters per bucket. Documented in the plan and enforced by
 *  the UI (add-filter button disables at this count). */
export const MAX_FILTERS_PER_BUCKET = 5;

/** Cap on per-bucket pagination loops, to bound HubSpot calls if a bucket's
 *  filters are too narrow to ever hit `count`. */
const MAX_PAGES_PER_BUCKET = 6;

/** Maximum number of clips a bucket can request. Matches the rest of the
 *  app's per-search caps to keep memory predictable. */
export const MAX_BUCKET_COUNT = 100;

/** Default starter config used when the user opens Autofill on a project
 *  that has no `autofillConfig` yet. Two empty buckets so the page is not
 *  empty on first open. */
export function defaultAutofillConfig(): AutofillConfig {
  return {
    globalNeverUsed: true,
    globalLicenseTypes: [],
    buckets: [createBucket(), createBucket()],
  };
}

/** Allocate a fresh bucket with no filters. */
export function createBucket(): AutofillBucket {
  return {
    id: randomId("bucket"),
    count: 10,
    sort: "newest",
    filters: [],
  };
}

/** Allocate a fresh filter row with a sensible default for the given field. */
export function createFilter(field: BucketFilterField = "tag"): BucketFilter {
  const operator = defaultOperatorForField(field);
  return {
    id: randomId("filter"),
    field,
    operator,
    value: defaultValueFor(field, operator),
  };
}

/** Deep-copy a bucket with a fresh ID. Used by the "duplicate bucket"
 *  action so React keys stay stable. */
export function duplicateBucket(source: AutofillBucket): AutofillBucket {
  return {
    ...source,
    id: randomId("bucket"),
    filters: source.filters.map((f) => ({ ...f, id: randomId("filter") })),
  };
}

function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

// ── Field / operator metadata ──────────────────────────────────────────────

/** Display label per field — also used by the field picker. */
export const FIELD_LABELS: Record<BucketFilterField, string> = {
  tag: "Tag",
  score: "Score",
  creator: "Creator",
  dateFound: "Date found",
  duration: "Duration (s)",
  licenseType: "License",
  usedCount: "Times used",
  provider: "Provider",
  likes: "Likes",
  plays: "Plays",
  comments: "Comments",
  caption: "Caption",
  availableAskFirst: "Ask First available",
};

/** Operators allowed per field. Keep aligned with the value-input UI in
 *  `AutofillFilterRow`. */
export const OPERATORS_BY_FIELD: Record<BucketFilterField, BucketFilterOperator[]> = {
  tag: ["contains", "in"],
  score: ["equals", "in"],
  creator: ["equals"],
  dateFound: ["gte", "lte", "between"],
  duration: ["gte", "lte", "between"],
  licenseType: ["in"],
  usedCount: ["equals", "gte", "lte"],
  provider: ["in"],
  likes: ["gte", "lte", "between"],
  plays: ["gte", "lte", "between"],
  comments: ["gte", "lte", "between"],
  caption: ["contains"],
  availableAskFirst: ["equals"],
};

/** Human-readable operator label. */
export const OPERATOR_LABELS: Record<BucketFilterOperator, string> = {
  equals: "is",
  in: "is one of",
  contains: "contains",
  gte: "≥",
  lte: "≤",
  between: "between",
};

function defaultOperatorForField(field: BucketFilterField): BucketFilterOperator {
  return OPERATORS_BY_FIELD[field][0] ?? "equals";
}

function defaultValueFor(field: BucketFilterField, op: BucketFilterOperator): unknown {
  if (op === "in") return [] as string[];
  if (op === "between") return [undefined, undefined] as [number?, number?];
  if (op === "equals" && field === "availableAskFirst") return true;
  if (field === "score") return "XL";
  return "";
}

// ── HubSpot filter shaping ─────────────────────────────────────────────────

/** Whether a field is filterable server-side via HubSpot's CRM Search v3.
 *  The remaining fields are applied client-side after fetch. */
const SERVER_SIDE_FIELDS: ReadonlySet<BucketFilterField> = new Set([
  "tag",
  "score",
  "creator",
  "dateFound",
  "duration",
  "usedCount",
  "likes",
  "plays",
  "comments",
  "caption",
]);

/** Group bucket filters by where they execute. The runner sends server-side
 *  ones as `extraFilters` (or via the dedicated args for tag/creator/date/
 *  caption that the existing builder already supports) and runs the rest as
 *  predicates on the returned page. */
interface ShapedFilters {
  /** Tag values to AND into the curated tag filter. */
  tags: string[];
  /** Score values for the IN operator. */
  scores: string[];
  /** Inclusive `date_found` lower bound (`YYYY-MM-DD`) or null. */
  dateFrom: string | null;
  /** Inclusive `date_found` upper bound (`YYYY-MM-DD`) or null. */
  dateTo: string | null;
  /** Substring matched against `social_media_caption` / `social_media_tags`. */
  textQuery: string | null;
  /** Creator main link for the EQ shared filter. */
  creatorMainLink: string | null;
  /** Filters that don't map onto the existing builder args (numeric ranges,
   *  usedCount custom comparisons) — get AND'd via `extraFilters`. */
  extraFilters: HubSpotFilter[];
  /** Filters applied client-side after fetch. */
  clientFilters: BucketFilter[];
}

function numericFilter(propertyName: string, operator: "GTE" | "LTE" | "EQ", value: number): HubSpotFilter {
  return { propertyName, operator, value: String(value) };
}

/** Reduce a bucket's filter rows into the shape consumed by `searchClips`.
 *  Returns null when a row is malformed in a way that should suppress the
 *  whole bucket (e.g. an empty `in` value silently matches everything,
 *  which is rarely what users want; we treat those as no-op instead). */
function shapeBucketFilters(bucket: AutofillBucket): ShapedFilters {
  const out: ShapedFilters = {
    tags: [],
    scores: [],
    dateFrom: null,
    dateTo: null,
    textQuery: null,
    creatorMainLink: null,
    extraFilters: [],
    clientFilters: [],
  };

  for (const filter of bucket.filters) {
    if (!SERVER_SIDE_FIELDS.has(filter.field)) {
      out.clientFilters.push(filter);
      continue;
    }
    addServerSide(out, filter);
  }

  return out;
}

function addServerSide(out: ShapedFilters, filter: BucketFilter): void {
  switch (filter.field) {
    case "tag": {
      const vals = asStringArray(filter.value);
      out.tags.push(...vals);
      return;
    }
    case "score": {
      const vals = asStringArray(filter.value);
      out.scores.push(...vals);
      return;
    }
    case "creator": {
      const v = asString(filter.value);
      if (v) out.creatorMainLink = v;
      return;
    }
    case "dateFound": {
      const range = asDateRange(filter);
      if (range.from) out.dateFrom = range.from;
      if (range.to) out.dateTo = range.to;
      return;
    }
    case "duration": {
      out.extraFilters.push(...numericRangeToHubSpot("edited_duration", filter));
      return;
    }
    case "usedCount": {
      const v = asNumber(filter.value);
      if (v === undefined) return;
      const op = filter.operator === "equals" ? "EQ" : filter.operator === "gte" ? "GTE" : "LTE";
      out.extraFilters.push(numericFilter("num_of_published_video_project", op, v));
      return;
    }
    case "likes":
      out.extraFilters.push(...numericRangeToHubSpot("likes", filter));
      return;
    case "plays":
      out.extraFilters.push(...numericRangeToHubSpot("plays", filter));
      return;
    case "comments":
      out.extraFilters.push(...numericRangeToHubSpot("comments", filter));
      return;
    case "caption": {
      const v = asString(filter.value);
      if (v) out.textQuery = v;
      return;
    }
    default:
      return;
  }
}

function numericRangeToHubSpot(propertyName: string, filter: BucketFilter): HubSpotFilter[] {
  if (filter.operator === "between") {
    const [min, max] = asNumberRange(filter.value);
    const out: HubSpotFilter[] = [];
    if (min !== undefined) out.push(numericFilter(propertyName, "GTE", min));
    if (max !== undefined) out.push(numericFilter(propertyName, "LTE", max));
    return out;
  }
  const v = asNumber(filter.value);
  if (v === undefined) return [];
  const op = filter.operator === "gte" ? "GTE" : "LTE";
  return [numericFilter(propertyName, op, v)];
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  }
  const single = asString(value);
  return single ? [single] : [];
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function asNumberRange(value: unknown): [number | undefined, number | undefined] {
  if (!Array.isArray(value)) return [undefined, undefined];
  return [asNumber(value[0]), asNumber(value[1])];
}

function asDateRange(filter: BucketFilter): { from: string | null; to: string | null } {
  if (filter.operator === "between") {
    const v = filter.value;
    if (Array.isArray(v)) {
      return { from: asString(v[0]), to: asString(v[1]) };
    }
    return { from: null, to: null };
  }
  const v = asString(filter.value);
  if (!v) return { from: null, to: null };
  return filter.operator === "gte" ? { from: v, to: null } : { from: null, to: v };
}

// ── Client-side predicates ─────────────────────────────────────────────────

function matchesClientFilter(clip: Clip, filter: BucketFilter): boolean {
  switch (filter.field) {
    case "licenseType": {
      const selected = asStringArray(filter.value) as LicenseTypeOption[];
      return matchesLicenseFilters(clip, selected);
    }
    case "availableAskFirst": {
      const required = filter.value === true || filter.value === "true";
      return required ? clip.availableAskFirst === true : clip.availableAskFirst !== true;
    }
    case "provider": {
      const providers = asStringArray(filter.value).filter((p): p is SupportedPlatform =>
        SUPPORTED_PLATFORMS.includes(p as SupportedPlatform),
      );
      return matchesProvider(clip, providers);
    }
    default:
      return true;
  }
}

/** Apply global filters (always AND) + bucket-local client filters. */
function clipPassesAll(clip: Clip, globals: AutofillConfig, bucket: AutofillBucket): boolean {
  if (globals.globalNeverUsed && (clip.numPublishedVideoProjects ?? 0) > 0) return false;
  if (globals.globalLicenseTypes.length > 0) {
    if (!matchesLicenseFilters(clip, globals.globalLicenseTypes as LicenseTypeOption[])) return false;
  }
  for (const filter of bucket.filters) {
    if (SERVER_SIDE_FIELDS.has(filter.field)) {
      // Server-side filters already passed at fetch time, except numeric
      // ranges where we want a defensive client-side double-check (HubSpot
      // stringly-typed comparisons can be quirky).
      if (filter.field === "duration") {
        if (!checkNumericRange(clip.editedDuration, filter)) return false;
      } else if (filter.field === "likes") {
        if (!checkNumericRange(clip.likes, filter)) return false;
      } else if (filter.field === "plays") {
        if (!checkNumericRange(clip.plays, filter)) return false;
      } else if (filter.field === "comments") {
        if (!checkNumericRange(clip.comments, filter)) return false;
      } else if (filter.field === "usedCount") {
        if (!checkNumericRange(clip.numPublishedVideoProjects, filter)) return false;
      } else if (filter.field === "dateFound") {
        const { from, to } = asDateRange(filter);
        if (!matchesDateRange(clip.dateFound, from ?? undefined, to ?? undefined)) return false;
      }
      continue;
    }
    if (!matchesClientFilter(clip, filter)) return false;
  }
  return true;
}

function checkNumericRange(value: number | undefined, filter: BucketFilter): boolean {
  if (filter.operator === "between") {
    const [min, max] = asNumberRange(filter.value);
    return matchesNumericRange(value, min, max);
  }
  const v = asNumber(filter.value);
  if (v === undefined) return true;
  if (filter.operator === "gte") return matchesNumericRange(value, v, undefined);
  if (filter.operator === "lte") return matchesNumericRange(value, undefined, v);
  return value === v;
}

// ── Bucket / config runners ────────────────────────────────────────────────

export interface BucketResult {
  bucketId: string;
  /** Clips selected for this bucket, capped at `bucket.count`. */
  clips: Clip[];
  /** True when HubSpot didn't have enough matching clips to fill the bucket. */
  partial: boolean;
}

export interface RunAutofillResult {
  results: BucketResult[];
}

interface RunBucketContext {
  token: string;
  globals: AutofillConfig;
  /** Clip IDs to skip during fetch — covers already-in-project + previous
   *  buckets + previously-shown picks during a re-roll. */
  excludeIds: ReadonlySet<string>;
}

/** Run a single bucket. Pages HubSpot until we have `bucket.count` matches
 *  after dedup + client filters, or we run out of results. */
export async function runBucket(
  bucket: AutofillBucket,
  ctx: RunBucketContext,
): Promise<BucketResult> {
  const shaped = shapeBucketFilters(bucket);
  const desired = clamp(bucket.count, 1, MAX_BUCKET_COUNT);

  const picks: Clip[] = [];
  const seen = new Set<string>(ctx.excludeIds);

  let after: string | undefined;
  let pagesFetched = 0;
  let hubspotExhausted = false;

  while (picks.length < desired && pagesFetched < MAX_PAGES_PER_BUCKET) {
    const { clips, nextAfter } = await searchClips({
      token: ctx.token,
      tags: shaped.tags,
      tagMode: "AND",
      scores: shaped.scores,
      neverUsed: ctx.globals.globalNeverUsed,
      creatorMainLink: shaped.creatorMainLink ?? undefined,
      dateFrom: shaped.dateFrom,
      dateTo: shaped.dateTo,
      textQuery: shaped.textQuery,
      textMode: "AND",
      extraFilters: shaped.extraFilters,
      after,
    });
    pagesFetched += 1;

    for (const clip of clips) {
      if (picks.length >= desired) break;
      if (seen.has(clip.id)) continue;
      if (!clipPassesAll(clip, ctx.globals, bucket)) continue;
      picks.push(clip);
      seen.add(clip.id);
    }

    if (!nextAfter) {
      hubspotExhausted = true;
      break;
    }
    after = nextAfter;
  }

  const ordered = applySort(picks, bucket.sort);
  const final = ordered.slice(0, desired);
  return {
    bucketId: bucket.id,
    clips: final,
    partial: final.length < desired && hubspotExhausted,
  };
}

function applySort(clips: Clip[], sort: AutofillBucket["sort"]): Clip[] {
  if (sort === "newest") return clips;
  if (sort === "oldest") return [...clips].reverse();
  if (sort === "random") return shuffle([...clips]);
  if (sort === "mostLiked") {
    return [...clips].sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0));
  }
  return clips;
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return Math.min(hi, Math.max(lo, Math.round(value)));
}

/** Run every bucket in order, deduping picks against the project and earlier
 *  bucket results. Returns one `BucketResult` per bucket, in the same order
 *  as the config. */
export async function runAutofill(
  config: AutofillConfig,
  project: Project,
  token: string,
): Promise<RunAutofillResult> {
  const exclude = new Set<string>(project.clips.map((c) => c.hubspotId));
  const results: BucketResult[] = [];
  for (const bucket of config.buckets) {
    const res = await runBucket(bucket, { token, globals: config, excludeIds: exclude });
    for (const clip of res.clips) exclude.add(clip.id);
    results.push(res);
  }
  return { results };
}
