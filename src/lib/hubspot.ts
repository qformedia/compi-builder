import { invoke } from "@tauri-apps/api/core";
import { resolveTagLabel } from "@/lib/tags";
import type { Clip } from "@/types";

interface HubSpotSearchResponse {
  total: number;
  results: Array<{
    id: string;
    properties: Record<string, string | null>;
  }>;
  paging?: {
    next?: { after: string };
  };
  capped?: boolean;
}

interface ClipsMissingCreatorCountResponse {
  inPublished: number;
  other: number;
}

interface ClipVpTagsResponseRow {
  clipId: string;
  vpTags: string[];
}

/** A single HubSpot CRM Search filter dict (`{ propertyName, operator, value | values }`).
 *  Used as the on-the-wire shape for autofill's extra per-bucket filters. */
export type HubSpotFilter = Record<string, unknown>;

/** Named parameters for {@link searchClips}. All fields except `token` are
 *  optional so the same function serves both the External Clips search page
 *  (rich filter UI) and the Autofill runner (per-bucket queries). */
export interface ClipSearchParams {
  token: string;
  tags?: string[];
  /** How multi-tag selections combine inside HubSpot filter groups. */
  tagMode?: "AND" | "OR";
  scores?: string[];
  neverUsed?: boolean;
  creatorMainLink?: string;
  /** Cursor returned from a previous page. */
  after?: string;
  /** Inclusive lower bound on HubSpot `date_found` (`YYYY-MM-DD`). */
  dateFrom?: string | null;
  /** Inclusive upper bound on HubSpot `date_found` (`YYYY-MM-DD`). */
  dateTo?: string | null;
  /** Free-text query matched against `social_media_caption` OR `social_media_tags`. */
  textQuery?: string | null;
  /** How to combine the text filter with curated tags. Defaults to "AND". */
  textMode?: "AND" | "OR";
  /** Fully-formed HubSpot filter dicts that get AND'd into every group built
   *  server-side. Autofill uses this to inject numeric range / contains
   *  filters (duration, likes, plays, comments, caption) without forking the
   *  Rust filter builder. */
  extraFilters?: HubSpotFilter[];
}

/** Search External Clips via the Rust backend. Single function shared by the
 *  search page and the Autofill runner. */
export async function searchClips(
  params: ClipSearchParams,
): Promise<{ clips: Clip[]; total: number; nextAfter?: string }> {
  const data = await invoke<HubSpotSearchResponse>("search_clips", {
    token: params.token,
    tags: params.tags ?? [],
    scores: params.scores ?? [],
    neverUsed: params.neverUsed ?? false,
    tagMode: params.tagMode ?? "AND",
    creatorMainLink: params.creatorMainLink ?? null,
    after: params.after ?? null,
    dateFrom: params.dateFrom?.trim() || null,
    dateTo: params.dateTo?.trim() || null,
    textQuery: params.textQuery?.trim() || null,
    textMode: params.textMode ?? "AND",
    extraFilters: params.extraFilters ?? [],
  });

  return {
    clips: data.results.map(parseClip),
    total: data.total,
    nextAfter: data.paging?.next?.after,
  };
}

/** Max clips loaded per creator in search UI (HubSpot may have more). */
export const DEFAULT_CREATOR_CLIP_CAP = 200;

/** Named parameters for {@link searchCreatorClips}. */
export interface CreatorClipsParams extends Omit<ClipSearchParams, "after"> {
  creatorName: string;
  maxResults?: number;
}

/** Fetch clips for a specific creator matching the same filters (capped for memory). */
export async function searchCreatorClips(
  params: CreatorClipsParams,
): Promise<{ clips: Clip[]; capped: boolean }> {
  const data = await invoke<HubSpotSearchResponse>("search_creator_clips", {
    token: params.token,
    tags: params.tags ?? [],
    scores: params.scores ?? [],
    neverUsed: params.neverUsed ?? false,
    tagMode: params.tagMode ?? "AND",
    creatorMainLink: params.creatorMainLink ?? null,
    creatorName: params.creatorName,
    maxResults: params.maxResults ?? DEFAULT_CREATOR_CLIP_CAP,
    dateFrom: params.dateFrom?.trim() || null,
    dateTo: params.dateTo?.trim() || null,
    textQuery: params.textQuery?.trim() || null,
    textMode: params.textMode ?? "AND",
    extraFilters: params.extraFilters ?? [],
  });

  return {
    clips: data.results.map(parseClip),
    capped: data.capped ?? false,
  };
}

/** A creator record returned from the Creators object */
export interface CreatorOption {
  id: string;
  name: string;
  mainLink: string;
}

/** Search Creators by name or main link */
export async function searchCreators(
  token: string,
  query: string,
): Promise<CreatorOption[]> {
  const data = await invoke<{
    results: Array<{ id: string; properties: Record<string, string | null> }>;
  }>("search_creators", { token, query });

  return data.results.map((r) => ({
    id: r.id,
    name: r.properties.name ?? "",
    mainLink: r.properties.main_link ?? "",
  }));
}

/** Search Video Projects by name */
export interface VideoProjectSummary {
  id: string;
  name: string;
  status: string;
  tag: string;
  pubDate: string;
  clipsOrder?: string;
  editingNotes?: string;
}

export async function searchVideoProjects(
  token: string,
  query: string,
): Promise<VideoProjectSummary[]> {
  const data = await invoke<{
    results: Array<{ id: string; properties: Record<string, string | null> }>;
  }>("search_video_projects", { token, query });

  return data.results.map((r) => ({
    id: r.id,
    name: r.properties.name ?? "Unnamed",
    status: r.properties.status ?? "",
    tag: r.properties.tag ?? "",
    pubDate: r.properties.pub_date ?? "",
    clipsOrder: r.properties.clips_order ?? undefined,
    editingNotes: r.properties.editing_notes ?? undefined,
  }));
}

/** Look up an External Clip by its source URL. Returns the parsed clip if HubSpot has a match. */
export async function findClipByLink(
  token: string,
  link: string,
): Promise<{ found: boolean; clip?: Clip }> {
  const data = await invoke<{
    found: boolean;
    id?: string | null;
    result?: { id: string; properties: Record<string, string | null> } | null;
  }>("find_clip_by_link", { token, link });

  if (!data.found || !data.result) return { found: false };
  return { found: true, clip: parseClip(data.result) };
}

/** Search External Clips whose stored link contains the given video code token. */
export async function searchClipsByLinkToken(
  token: string,
  query: string,
): Promise<Clip[]> {
  const data = await invoke<{
    results: Array<{ id: string; properties: Record<string, string | null> }>;
  }>("search_clips_by_link_token", { token, query });
  return (data.results ?? []).map(parseClip);
}

/** Fetch all External Clips associated with a Video Project */
export async function fetchVideoProjectClips(
  token: string,
  projectId: string,
): Promise<Clip[]> {
  const data = await invoke<HubSpotSearchResponse>("fetch_video_project_clips", {
    token,
    projectId,
  });
  return data.results.map(parseClip);
}

/** One page of External Clips with no creator linked (Data Integrity). */
export async function fetchClipsMissingCreator(
  token: string,
  after?: string,
): Promise<{ clips: Clip[]; total: number; nextAfter?: string }> {
  const data = await invoke<HubSpotSearchResponse>("search_clips_missing_creator", {
    token,
    after: after ?? null,
  });
  return {
    clips: data.results.map(parseClip),
    total: data.total,
    nextAfter: data.paging?.next?.after,
  };
}

/** Count External Clips with no creator linked without fetching all matching records. */
export async function countClipsMissingCreator(
  token: string,
): Promise<ClipsMissingCreatorCountResponse> {
  return invoke<ClipsMissingCreatorCountResponse>("count_clips_missing_creator", { token });
}

/** One page of External Clips marked with To Delete = true (Data Integrity). */
export async function fetchClipsToDelete(
  token: string,
  after?: string,
): Promise<{ clips: Clip[]; total: number; nextAfter?: string }> {
  const data = await invoke<HubSpotSearchResponse>("search_clips_to_delete", {
    token,
    after: after ?? null,
  });
  return {
    clips: data.results.map(parseClip),
    total: data.total,
    nextAfter: data.paging?.next?.after,
  };
}

/** Count External Clips marked with To Delete = true without fetching all matching records. */
export async function countClipsToDelete(
  token: string,
): Promise<{ total: number }> {
  return invoke<{ total: number }>("count_clips_to_delete", { token });
}

/** One page of External Clips with unknown tags in published videos (Data Integrity). */
export async function fetchClipsMissingTagsInPublished(
  token: string,
  after?: string,
): Promise<{ clips: Clip[]; total: number; nextAfter?: string }> {
  const data = await invoke<HubSpotSearchResponse>("search_clips_missing_tags_in_published", {
    token,
    after: after ?? null,
  });
  return {
    clips: data.results.map(parseClip),
    total: data.total,
    nextAfter: data.paging?.next?.after,
  };
}

/** Count External Clips with unknown tags in published videos. */
export async function countClipsMissingTagsInPublished(
  token: string,
): Promise<{ total: number }> {
  return invoke<{ total: number }>("count_clips_missing_tags_in_published", { token });
}

/** Fetch associated published VP tags for a batch of External Clips. */
export async function fetchClipVpTagsBatch(
  token: string,
  clipIds: string[],
): Promise<Map<string, string[]>> {
  if (clipIds.length === 0) return new Map();
  const rows = await invoke<ClipVpTagsResponseRow[]>("fetch_clip_vp_tags_batch", {
    token,
    clipIds,
  });
  return new Map(rows.map((row) => [row.clipId, row.vpTags]));
}

function parseClip(record: {
  id: string;
  properties: Record<string, string | null>;
}): Clip {
  const p = record.properties;

  const clipMixLinks: string[] = [];
  for (let i = 1; i <= 10; i++) {
    const val = p[`clip_mix_link_${i}`];
    if (val) clipMixLinks.push(val);
  }

  return {
    id: record.id,
    link: p.link ?? "",
    tags: p.tags ? p.tags.split(";").map((t) => resolveTagLabel(t.trim())) : [],
    creatorName: p.creator_name ?? "Unknown",
    creatorStatus: p.creator_status ?? "",
    creatorMainLink: p.creator_main_link ?? undefined,
    creatorId: p.creator_id ?? undefined,
    score: p.score?.trim() || undefined,
    editedDuration: p.edited_duration ? Number(p.edited_duration) : undefined,
    dateFound: p.date_found ?? undefined,
    linkNotWorking: p.link_not_working_anymore === "true",
    availableAskFirst: p.available_ask_first === "true",
    numPublishedVideoProjects: p.num_of_published_video_project
      ? Number(p.num_of_published_video_project)
      : undefined,
    clipMixLinks,
    notes: p.creator_notes ?? p.notes ?? undefined,
    licenseType: p.creator_license_type ?? undefined,
    fetchedThumbnail: p.fetched_social_thumbnail ?? undefined,
    originalClip: p.original_clip ?? undefined,
    likes: parseOptionalMetric(p.likes),
    plays: parseOptionalMetric(p.plays),
    comments: parseOptionalMetric(p.comments),
    socialMediaCaption: p.social_media_caption ?? undefined,
    socialMediaTags: p.social_media_tags ?? undefined,
  };
}

function parseOptionalMetric(value: string | null | undefined): number | undefined {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
