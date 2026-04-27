import { invoke } from "@tauri-apps/api/core";

/** Where the resolved profile came from. Used by the UI to show "cached N days ago" badges. */
export type EnrichmentSource =
  | "hubspot_cache"
  | "tiktok_url"
  | "ig_oembed"
  | "ig_embed"
  | "ig_socialkit"
  | "yt_handle_url"
  | "ytdlp";

/** Confidence ladder for a single suggested HubSpot creator. */
export type MatchConfidence = "high" | "highish" | "medium" | "low";

export interface EnrichedProfile {
  platform: string;
  profileUrl: string;
  handle: string;
  displayName?: string;
  avatar?: string;
  /** Source string emitted by the Rust resolver — typed loosely to stay forward compatible. */
  source: EnrichmentSource | string;
  /** HubSpot `sk_last_enriched` (ms) when `source === "hubspot_cache"`. */
  cachedAt?: number;
}

export interface CreatorMatch {
  creatorId: string;
  name: string;
  mainLink?: string;
  instagram?: string;
  tiktok?: string;
  confidence: MatchConfidence;
  reason: string;
  /** "instagram" | "tiktok" for cross-network warning rows. */
  otherPlatformUrl?: string;
}

export function resolveCreatorFromClipUrl(
  token: string,
  clipId: string,
  clipUrl: string,
  opts: {
    socialkitApiKey?: string;
    cookiesBrowser?: string;
    cookiesFile?: string;
    forceLive?: boolean;
  } = {},
): Promise<EnrichedProfile> {
  return invoke<EnrichedProfile>("resolve_creator_from_clip_url", {
    token,
    clipId,
    clipUrl,
    socialkitApiKey: opts.socialkitApiKey || null,
    cookiesBrowser: opts.cookiesBrowser || null,
    cookiesFile: opts.cookiesFile || null,
    forceLive: opts.forceLive ?? null,
  });
}

export function matchCreatorsForHandle(
  token: string,
  profile: EnrichedProfile,
): Promise<CreatorMatch[]> {
  return invoke<CreatorMatch[]>("match_creators_for_handle", {
    token,
    profileUrl: profile.profileUrl,
    handle: profile.handle,
    displayName: profile.displayName ?? null,
    platform: profile.platform,
  });
}

export function createCreatorFromEnrichment(
  token: string,
  profile: EnrichedProfile,
): Promise<{ id: string; name: string }> {
  return invoke("create_creator_from_enrichment", { token, profile });
}
