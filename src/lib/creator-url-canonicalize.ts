/**
 * Creator-profile URL canonicalization.
 *
 * Sibling to `src/lib/url-compliance.ts` (which handles External Clip *video*
 * URLs — `/reel/`, `/video/`, `/shorts/`). This module handles the Creator
 * object's *profile/channel* URLs in the five in-scope columns:
 *
 *   Instagram, Secondary Instagram, TikTok, Secondary TikTok, Youtube
 *
 * Source of truth: `creators/creator-url-rules.md` in the QforMedia ExClips
 * Clean Up repo (mirrored at
 * `~/Documents/QforMedia/Tastic ExClips Clean Up/spec-for-compiflow/creator-url-rules.md`).
 *
 * The reference implementation is `creator_url_cleaner.py` in the same repo;
 * this file is a faithful TypeScript port. Any rule change MUST land in the
 * spec first, then mirror through every implementation (Python, this file,
 * and any other Quantastic repo that ingests creator URLs).
 *
 * Public contract:
 *
 *   const { fixedUrl, network, status, issues } = cleanCreatorUrl(input);
 *
 * The dedup layer should use `fixedUrl` as the lookup key only when
 * `status !== "invalid"`. Invalid URLs are excluded from automatic dedup and
 * routed to manual-review surfaces (see Pattern 2 in the duplicate detection
 * spec for IG `/p/` posts in profile fields).
 */

export type CreatorUrlNetwork =
  | "instagram"
  | "tiktok"
  | "youtube"
  | "other"
  | "empty";

export type CreatorUrlStatus = "ok" | "fixed" | "invalid";

export interface CreatorUrlCanonical {
  originalUrl: string;
  fixedUrl: string;
  network: CreatorUrlNetwork;
  status: CreatorUrlStatus;
  issues: string[];
}

const INSTAGRAM_NON_PROFILE_PATHS = [
  "/p/",
  "/reel/",
  "/reels/",
  "/tv/",
  "/share/",
  "/stories/",
  "/explore/",
  "/tag/",
  "/profilecard/",
  "/direct/",
] as const;

const TIKTOK_NON_PROFILE_MARKERS = ["/video/", "/photo/", "/live"] as const;

const YT_SUFFIXES = [
  "/featured",
  "/videos",
  "/shorts",
  "/streams",
  "/playlists",
  "/community",
  "/about",
  "/store",
] as const;

const IG_HANDLE_RE = /^[a-z0-9_.]+$/;
const TT_HANDLE_RE = /^[a-z0-9_.]+$/;
const YT_CHANNEL_ID_RE = /^UC[A-Za-z0-9_\-]{22}$/;

/**
 * Heuristic: a bare `@handle` (no domain) is almost always a TikTok handle in
 * the wild, so we promote it to a canonical TikTok URL before network
 * detection runs. See "Bare-handle promotion" in the spec / Pattern 5 in the
 * duplicate detection spec.
 */
const BARE_HANDLE_RE = /^@[A-Za-z0-9_.]+$/;

function detectNetwork(url: string): Exclude<CreatorUrlNetwork, "empty"> {
  const lower = url.toLowerCase();
  if (lower.includes("instagram.com")) return "instagram";
  if (lower.includes("tiktok.com")) return "tiktok";
  if (lower.includes("youtube.com") || lower.includes("youtu.be")) return "youtube";
  return "other";
}

function stripQueryFragment(url: string): { url: string; issues: string[] } {
  const issues: string[] = [];
  if (url.includes("?")) {
    url = url.split("?", 1)[0];
    issues.push("stripped query params");
  }
  if (url.includes("#")) {
    url = url.split("#", 1)[0];
  }
  return { url, issues };
}

interface PreprocessResult {
  url: string;
  issues: string[];
  earlyInvalid?: string;
}

function universalPreprocess(url: string): PreprocessResult {
  const issues: string[] = [];

  if (/[\s]/.test(url)) {
    return { url, issues, earlyInvalid: "multiple URLs or free text in field — manual review" };
  }

  // Count "http" occurrences case-insensitively to catch glued-together URLs
  // even when one of them is uppercase.
  const httpCount = (url.toLowerCase().match(/http/g) ?? []).length;
  if (httpCount > 1) {
    return { url, issues, earlyInvalid: "multiple URLs in same field — manual review" };
  }

  if (!/^https?:\/\//i.test(url)) {
    url = "https://" + url;
    issues.push("added https://");
  } else if (/^http:\/\//i.test(url)) {
    url = "https://" + url.slice("http://".length);
    issues.push("upgraded http → https");
  }

  if (url.includes("www.ww.")) {
    url = url.replace("www.ww.", "www.");
    issues.push("fixed www.ww. typo");
  }
  if (url.includes("www.www.")) {
    url = url.replace("www.www.", "www.");
    issues.push("fixed www.www. typo");
  }

  return { url, issues };
}

interface CleanResult {
  url: string;
  ok: boolean;
}

function cleanInstagram(url: string, issues: string[]): CleanResult {
  const stripped = stripQueryFragment(url);
  url = stripped.url;
  issues.push(...stripped.issues);

  const m = /^https:\/\/(www\.)?instagram\.com(\/.*)?$/i.exec(url);
  if (!m) return { url, ok: false };
  const hasWww = !!m[1];
  const path = m[2] ?? "/";

  const lowPath = path.toLowerCase();
  for (const bad of INSTAGRAM_NON_PROFILE_PATHS) {
    if (lowPath.startsWith(bad) || lowPath.includes(bad)) {
      issues.push("post or non-profile URL in profile field — manual review");
      return { url, ok: false };
    }
  }

  if (!hasWww) {
    url = "https://www.instagram.com" + path;
    issues.push("added www.");
  } else {
    url = "https://www.instagram.com" + path;
  }

  const segMatch = /^\/([^/]+)\/?$/.exec(path);
  if (!segMatch) return { url, ok: false };
  const handleRaw = segMatch[1];
  const handleLow = handleRaw.toLowerCase();
  if (handleLow !== handleRaw) issues.push("lowercased handle");
  const handle = handleLow;

  if (!IG_HANDLE_RE.test(handle)) return { url, ok: false };

  const fixed = `https://www.instagram.com/${handle}/`;
  if (!path.endsWith("/") && !issues.includes("added trailing /")) {
    issues.push("added trailing /");
  }
  return { url: fixed, ok: true };
}

function cleanTiktok(url: string, issues: string[]): CleanResult {
  const stripped = stripQueryFragment(url);
  url = stripped.url;
  issues.push(...stripped.issues);

  const low = url.toLowerCase();
  for (const bad of TIKTOK_NON_PROFILE_MARKERS) {
    if (low.includes(bad)) {
      issues.push("post or non-profile URL in profile field — manual review");
      return { url, ok: false };
    }
  }

  const m = /^https:\/\/(www\.)?tiktok\.com(\/.*)?$/i.exec(url);
  if (!m) return { url, ok: false };
  const hasWww = !!m[1];
  const path = m[2] ?? "/";

  if (!hasWww) {
    url = "https://www.tiktok.com" + path;
    issues.push("added www.");
  } else {
    url = "https://www.tiktok.com" + path;
  }

  const segMatch = /^\/(@[^/]+)\/?$/.exec(path);
  if (!segMatch) {
    issues.push("non-profile URL — manual review");
    return { url, ok: false };
  }
  const atHandleRaw = segMatch[1];
  const atHandleLow = atHandleRaw.toLowerCase();
  if (atHandleLow !== atHandleRaw) issues.push("lowercased handle");
  const handle = atHandleLow.slice(1);

  if (!TT_HANDLE_RE.test(handle)) return { url, ok: false };

  const fixed = `https://www.tiktok.com/@${handle}`;
  if (path.endsWith("/") && !issues.includes("removed trailing /")) {
    issues.push("removed trailing /");
  }
  return { url: fixed, ok: true };
}

function cleanYoutube(url: string, issues: string[]): CleanResult {
  const lowFull = url.toLowerCase();

  // youtu.be is a video-shortener domain — never valid in a profile field.
  if (
    lowFull.includes("youtu.be/") ||
    lowFull.startsWith("https://youtu.be") ||
    lowFull.startsWith("http://youtu.be")
  ) {
    issues.push("youtu.be is a video URL — manual review");
    return { url, ok: false };
  }

  if (/youtube\.com\/(watch|embed\/|playlist)/.test(lowFull)) {
    issues.push("video/post URL in profile field — manual review");
    return { url, ok: false };
  }

  if (/youtube\.com\/shorts\//.test(lowFull)) {
    issues.push("video/post URL in profile field — manual review");
    return { url, ok: false };
  }

  if (/youtube\.com\/@/.test(lowFull)) {
    issues.push("@handle URL — manually convert to /channel/UC...");
    return { url, ok: false };
  }

  if (/youtube\.com\/c\//.test(lowFull)) {
    issues.push("legacy /c/ URL — manually convert to /channel/UC...");
    return { url, ok: false };
  }

  if (/youtube\.com\/user\//.test(lowFull)) {
    issues.push("legacy /user/ URL — manually convert to /channel/UC...");
    return { url, ok: false };
  }

  if (!/youtube\.com\/channel\//.test(lowFull)) {
    const vanity = /^https?:\/\/(?:www\.)?youtube\.com\/[^/?#]+\/?$/i.test(url);
    if (vanity) {
      issues.push("vanity URL — manually convert to /channel/UC...");
      return { url, ok: false };
    }
    return { url, ok: false };
  }

  const stripped = stripQueryFragment(url);
  url = stripped.url;
  issues.push(...stripped.issues);

  const m = /^https:\/\/(www\.)?youtube\.com(\/.*)$/i.exec(url);
  if (!m) return { url, ok: false };
  const hasWww = !!m[1];
  const path = m[2];

  if (!hasWww) {
    url = "https://www.youtube.com" + path;
    issues.push("added www.");
  } else {
    url = "https://www.youtube.com" + path;
  }

  const chanM = /^\/channel\/([^/?#]+)(\/.*)?$/.exec(path);
  if (!chanM) return { url, ok: false };
  let channelId = chanM[1];
  let rest = chanM[2] ?? "";

  if (rest) {
    let restClean = rest;
    for (const suffix of YT_SUFFIXES) {
      if (restClean.toLowerCase().startsWith(suffix)) {
        issues.push(`stripped ${suffix} suffix`);
        restClean = restClean.slice(suffix.length);
        break;
      }
    }
    if (restClean === "/") {
      issues.push("removed trailing /");
      restClean = "";
    }
    if (restClean) return { url, ok: false };
  }

  // `Uc...` typo (should be `UC...`) — auto-fix only if the rest of the ID
  // is intact 22 chars.
  if (
    channelId.startsWith("Uc") &&
    !channelId.startsWith("UC") &&
    /^Uc[A-Za-z0-9_\-]{22}$/.test(channelId)
  ) {
    channelId = "UC" + channelId.slice(2);
    issues.push("fixed channel-ID prefix casing");
  }

  if (!YT_CHANNEL_ID_RE.test(channelId)) return { url, ok: false };

  const fixed = `https://www.youtube.com/channel/${channelId}`;
  return { url: fixed, ok: true };
}

/**
 * Canonicalize a Creator profile/channel URL.
 *
 * See module doc for the full contract. Examples and edge cases live in the
 * spec — `creator-url-rules.md` → "Examples".
 */
export function cleanCreatorUrl(originalUrl: string): CreatorUrlCanonical {
  const trimmed = (originalUrl ?? "").trim();
  if (!trimmed) {
    return {
      originalUrl: trimmed,
      fixedUrl: "",
      network: "empty",
      status: "invalid",
      issues: ["empty URL"],
    };
  }

  // Bare-handle promotion (Pattern 5). Promote `@xxx` (no domain) to a
  // canonical TikTok URL BEFORE network detection so it flows through the
  // TikTok cleaner the same way a real `tiktok.com/@xxx` would.
  let working = trimmed;
  const promoIssues: string[] = [];
  if (BARE_HANDLE_RE.test(trimmed)) {
    working = `https://www.tiktok.com/${trimmed.toLowerCase()}`;
    promoIssues.push("promoted bare handle to tiktok.com/@…");
  }

  const network = detectNetwork(working);
  if (network === "other") {
    return {
      originalUrl: trimmed,
      fixedUrl: working,
      network: "other",
      status: "ok",
      issues: [],
    };
  }

  const pre = universalPreprocess(working);
  if (pre.earlyInvalid) {
    return {
      originalUrl: trimmed,
      fixedUrl: pre.url,
      network,
      status: "invalid",
      issues: [...promoIssues, ...pre.issues, pre.earlyInvalid],
    };
  }

  const issues: string[] = [...promoIssues, ...pre.issues];
  let result: CleanResult;
  switch (network) {
    case "instagram":
      result = cleanInstagram(pre.url, issues);
      break;
    case "tiktok":
      result = cleanTiktok(pre.url, issues);
      break;
    case "youtube":
      result = cleanYoutube(pre.url, issues);
      break;
  }

  if (result.ok) {
    if (result.url === originalUrl) {
      return {
        originalUrl: trimmed,
        fixedUrl: result.url,
        network,
        status: "ok",
        issues: [],
      };
    }
    return {
      originalUrl: trimmed,
      fixedUrl: result.url,
      network,
      status: "fixed",
      issues,
    };
  }

  return {
    originalUrl: trimmed,
    fixedUrl: result.url,
    network,
    status: "invalid",
    issues: issues.length > 0 ? issues : ["non-standard URL — manual review"],
  };
}
