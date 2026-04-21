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

/** Search External Clips by tags (and optionally scores) via the Rust backend */
export async function searchClipsByTags(
  token: string,
  tags: string[],
  scores: string[] = [],
  neverUsed = false,
  tagMode = "AND",
  creatorMainLink?: string,
  after?: string,
  /** Inclusive lower bound on HubSpot `date_found` (`YYYY-MM-DD`). */
  dateFrom?: string | null,
  /** Inclusive upper bound on HubSpot `date_found` (`YYYY-MM-DD`). */
  dateTo?: string | null,
): Promise<{ clips: Clip[]; total: number; nextAfter?: string }> {
  const data = await invoke<HubSpotSearchResponse>("search_clips", {
    token,
    tags,
    scores,
    neverUsed,
    tagMode,
    creatorMainLink: creatorMainLink ?? null,
    after: after ?? null,
    date_from: dateFrom?.trim() || null,
    date_to: dateTo?.trim() || null,
  });

  const clips = data.results.map(parseClip);

  return {
    clips,
    total: data.total,
    nextAfter: data.paging?.next?.after,
  };
}

/** Max clips loaded per creator in search UI (HubSpot may have more). */
export const DEFAULT_CREATOR_CLIP_CAP = 200;

/** Fetch clips for a specific creator matching the same filters (capped for memory). */
export async function searchCreatorClips(
  token: string,
  tags: string[],
  scores: string[],
  neverUsed: boolean,
  tagMode: string,
  creatorMainLink: string | undefined,
  creatorName: string,
  maxResults: number = DEFAULT_CREATOR_CLIP_CAP,
  dateFrom?: string | null,
  dateTo?: string | null,
): Promise<{ clips: Clip[]; capped: boolean }> {
  const data = await invoke<HubSpotSearchResponse>("search_creator_clips", {
    token,
    tags,
    scores,
    neverUsed,
    tagMode,
    creatorMainLink: creatorMainLink ?? null,
    creatorName,
    max_results: maxResults,
    date_from: dateFrom?.trim() || null,
    date_to: dateTo?.trim() || null,
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
  };
}
