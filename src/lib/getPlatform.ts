/** Provider names we recognise from External Clip source URLs. Order matters
 *  because we check substring containment — keep more-specific hosts first. */
export const SUPPORTED_PLATFORMS = [
  "TikTok",
  "Instagram",
  "YouTube",
  "Pinterest",
  "Douyin",
  "Bilibili",
  "Xiaohongshu",
  "Kuaishou",
] as const;

export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];

/** Best-effort platform name for a clip URL. Returns "Video" when nothing
 *  matches. This is the single source of truth for provider detection across
 *  the app (ClipCard chrome, autofill provider filter, etc.). */
export function getPlatform(url: string): SupportedPlatform | "Video" {
  if (url.includes("tiktok.com")) return "TikTok";
  if (url.includes("instagram.com")) return "Instagram";
  if (url.includes("youtube.com") || url.includes("youtu.be")) return "YouTube";
  if (url.includes("pinterest.com") || url.includes("pin.it")) return "Pinterest";
  if (url.includes("douyin.com")) return "Douyin";
  if (url.includes("bilibili.com")) return "Bilibili";
  if (url.includes("xiaohongshu.com")) return "Xiaohongshu";
  if (url.includes("kuaishou.com")) return "Kuaishou";
  return "Video";
}
