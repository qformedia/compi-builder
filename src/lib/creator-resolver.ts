import { invoke } from "@tauri-apps/api/core";

/** Where the resolved profile came from. Used by the UI to show "cached N days ago" badges. */
export type EnrichmentSource =
  | "hubspot_cache"
  | "tiktok_url"
  | "ig_oembed"
  | "ig_embed"
  /** New in cascade refactor — yt-dlp + user's browser cookies. Resolves
   *  Instagram posts gated to logged-in viewers, where SocialKit / oEmbed
   *  / embed all hit IG unauthenticated. */
  | "ig_ytdlp_cookies"
  | "ig_socialkit"
  | "yt_handle_url"
  | "ytdlp"
  /** Paid socialfetch.dev fallback (TikTok / Instagram / YouTube). */
  | "socialfetch";

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

/**
 * Per-step audit log entry returned by the Rust resolver on cascade failure.
 * The `step` matches a step name in `src-tauri/src/resolver.rs` (e.g.
 * `"ig_oembed"`, `"ig_ytdlp_cookies"`, `"socialfetch"`). The `outcome`
 * distinguishes "we didn't even try" (`skipped`) from "we tried and it
 * failed" (`failed`). The `reason` is a stable identifier the UI smart
 * classifier keys off.
 */
export interface ResolveAttempt {
  step: string;
  outcome: "skipped" | "failed";
  reason: string;
}

/**
 * Structured error payload from `resolve_creator_from_clip_url`. The Tauri
 * command returns `Result<EnrichedProfile, String>` where the error string
 * is `JSON.stringify(ResolveCreatorError)` — call [`parseResolveError`] to
 * extract this shape from a caught error.
 */
export interface ResolveCreatorError {
  /** `"all_failed"` or `"unresolvable_platform"`. */
  code: "all_failed" | "unresolvable_platform";
  attempts: ResolveAttempt[];
}

/**
 * Parse a caught error into the structured shape, when possible. Falls back
 * to `null` when the error isn't a JSON-encoded `ResolveCreatorError` (older
 * commands, transport errors, etc.). Always safe to call.
 */
export function parseResolveError(err: unknown): ResolveCreatorError | null {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : null;
  if (!msg) return null;
  try {
    const parsed = JSON.parse(msg);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.code === "string" &&
      Array.isArray(parsed.attempts)
    ) {
      return parsed as ResolveCreatorError;
    }
  } catch {
    /* not JSON — caller falls back to legacy string match */
  }
  return null;
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
    socialfetchApiKey?: string;
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
    socialfetchApiKey: opts.socialfetchApiKey || null,
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
