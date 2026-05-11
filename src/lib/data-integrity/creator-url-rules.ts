/**
 * Strict patterns for the 5 creator URL columns we validate against the
 * all-creators HubSpot export.
 *
 * Patterns are intentionally minimal — they accept ONLY the canonical
 * profile-URL form for each network. The data integrity card surfaces any
 * non-empty value that fails the regex so the user can clean it up in
 * HubSpot.
 *
 * The patterns themselves are mirrored from the user-facing rules:
 *   Instagram / Secondary Instagram → https://www.instagram.com/handle/
 *   TikTok / Secondary TikTok       → https://www.tiktok.com/@handle
 *   Youtube                         → https://www.youtube.com/channel/UC<22 chars>
 */

export type CreatorUrlField =
  | "instagram"
  | "secondary_instagram"
  | "tiktok"
  | "secondary_tiktok"
  | "youtube";

export interface CreatorUrlRule {
  /** Header label as it appears in the HubSpot CSV export. */
  csvHeader: string;
  /** Human-friendly label used in the UI section title. */
  label: string;
  /** Strict regex — only the canonical profile-URL form passes. */
  regex: RegExp;
  /** Short message (≤100 chars) shown next to invalid values. */
  invalidMessage: string;
}

export const CREATOR_URL_RULES: Record<CreatorUrlField, CreatorUrlRule> = {
  instagram: {
    csvHeader: "Instagram",
    label: "Instagram",
    regex: /^https:\/\/www\.instagram\.com\/[a-z0-9_.]+\/$/,
    invalidMessage:
      "Must be https://www.instagram.com/handle/ (lowercase, with trailing /)",
  },
  secondary_instagram: {
    csvHeader: "Secondary Instagram",
    label: "Secondary Instagram",
    regex: /^https:\/\/www\.instagram\.com\/[a-z0-9_.]+\/$/,
    invalidMessage:
      "Must be https://www.instagram.com/handle/ (lowercase, with trailing /)",
  },
  tiktok: {
    csvHeader: "TikTok",
    label: "TikTok",
    regex: /^https:\/\/www\.tiktok\.com\/@[a-z0-9_.]+$/,
    invalidMessage:
      "Must be https://www.tiktok.com/@handle (lowercase, no trailing slash)",
  },
  secondary_tiktok: {
    csvHeader: "Secondary TikTok",
    label: "Secondary TikTok",
    regex: /^https:\/\/www\.tiktok\.com\/@[a-z0-9_.]+$/,
    invalidMessage:
      "Must be https://www.tiktok.com/@handle (lowercase, no trailing slash)",
  },
  youtube: {
    csvHeader: "Youtube",
    label: "Youtube",
    regex: /^https:\/\/www\.youtube\.com\/channel\/UC[A-Za-z0-9_\-]{22}$/,
    invalidMessage:
      "Must be https://www.youtube.com/channel/UC... (Channel ID, not @handle)",
  },
};

export const CREATOR_URL_FIELDS: CreatorUrlField[] = [
  "instagram",
  "secondary_instagram",
  "tiktok",
  "secondary_tiktok",
  "youtube",
];
