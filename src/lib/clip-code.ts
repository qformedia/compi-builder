import type { UrlNetwork } from "@/lib/url-compliance";

/** True when the input looks like a full URL (has scheme or a known domain). */
export function looksLikeUrl(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;
  if (trimmed.includes("://")) return true;
  const lower = trimmed.toLowerCase();
  return (
    lower.includes(".com/") ||
    lower.includes(".com") ||
    lower.includes(".es/") ||
    lower.includes(".es") ||
    lower.includes(".be/") ||
    lower.includes(".be") ||
    lower.includes("instagram.") ||
    lower.includes("tiktok.") ||
    lower.includes("youtube.") ||
    lower.includes("youtu.be") ||
    lower.includes("pinterest.") ||
    lower.includes("bilibili.") ||
    lower.includes("douyin.") ||
    lower.includes("kuaishou.") ||
    lower.includes("xiaohongshu.")
  );
}

/** True when the input looks like a bare video code (no URL structure). */
export function looksLikeCode(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;
  if (looksLikeUrl(trimmed)) return false;
  // Instagram shortcodes, YouTube IDs, TikTok numeric IDs, Bilibili BV codes, etc.
  return /^[A-Za-z0-9_-]{6,30}$/.test(trimmed);
}

/** Extract the platform-specific video code from a normalized URL. */
export function extractCodeFromUrl(
  fixedUrl: string,
  network: UrlNetwork,
): string | null {
  switch (network) {
    case "instagram": {
      const m = fixedUrl.match(/\/(reel|tv|p)\/([A-Za-z0-9_-]+)\/?$/);
      return m?.[2] ?? null;
    }
    case "tiktok": {
      const m = fixedUrl.match(/\/video\/(\d{15,19})/);
      return m?.[1] ?? null;
    }
    case "youtube": {
      const shorts = fixedUrl.match(/\/shorts\/([A-Za-z0-9_-]{11})/);
      if (shorts) return shorts[1];
      const be = fixedUrl.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
      return be?.[1] ?? null;
    }
    case "pinterest": {
      const m = fixedUrl.match(/\/pin\/([A-Za-z0-9_-]+)\/?$/);
      return m?.[1] ?? null;
    }
    case "bilibili": {
      const m = fixedUrl.match(/\/video\/(BV[A-Za-z0-9]+)\/?$/);
      return m?.[1] ?? null;
    }
    case "douyin": {
      const m = fixedUrl.match(/\/video\/(\d{15,})/);
      return m?.[1] ?? null;
    }
    default:
      return null;
  }
}
