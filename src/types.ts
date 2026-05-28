/** An External Clip from HubSpot */
export interface Clip {
  id: string;
  link: string;
  tags: string[];
  creatorName: string;
  creatorStatus: string;
  creatorMainLink?: string;
  creatorId?: string;
  score?: string;
  editedDuration?: number;
  dateFound?: string;
  linkNotWorking?: boolean;
  availableAskFirst?: boolean;
  numPublishedVideoProjects?: number;
  clipMixLinks: string[];
  notes?: string;
  licenseType?: string;
  fetchedThumbnail?: string;
  /** HubSpot CDN URL for the original video file (uploaded after download) */
  originalClip?: string;
  likes?: number;
  plays?: number;
  comments?: number;
  /** Free-text caption / description fetched from the source social platform */
  socialMediaCaption?: string;
  /** Hashtags fetched from the source social platform (raw `;`-joined HubSpot string) */
  socialMediaTags?: string;
}

/** A local video project */
export interface Project {
  name: string;
  createdAt: string;
  clips: ProjectClip[];
  /** HubSpot Video Project ID (set after "Finish Video" or when opened from HubSpot) */
  hubspotVideoProjectId?: string;
}

/** A clip within a project */
export interface ProjectClip {
  hubspotId: string;
  link: string;
  creatorName: string;
  tags: string[];
  score?: string;
  editedDuration?: number;
  localDuration?: number;
  /** Relative path from the project folder, e.g. "clips/12345_video.mp4" */
  localFile?: string;
  downloadStatus: "pending" | "downloading" | "complete" | "failed";
  downloadError?: string;
  order: number;
  licenseType?: string;
  notes?: string;
  fetchedThumbnail?: string;
  editingNotes?: string;
  creatorId?: string;
  creatorStatus?: string;
  clipMixLinks?: string[];
  availableAskFirst?: boolean;
  /** HubSpot CDN URL for the original video file */
  originalClip?: string;
  /** Number of times the user has manually retried downloading this clip */
  retryCount?: number;
}

/** Resolve a relative localFile path to an absolute path.
 *  Handles legacy absolute paths gracefully (returns them as-is). */
export function resolveClipPath(rootFolder: string, projectName: string, relativePath: string): string {
  if (relativePath.startsWith("/") || relativePath.includes(":\\")) return relativePath;
  return `${rootFolder}/${projectName}/${relativePath}`;
}

/** Ordered list of download provider IDs per platform key.
 *  The "default" key is used for platforms not explicitly listed. */
export type DownloadProviders = Record<string, string[]>;

export const DEFAULT_DOWNLOAD_PROVIDERS: DownloadProviders = {
  // Chinese platforms keep yt-dlp/Evil0ctal only — SocialFetch doesn't
  // cover Douyin / Kuaishou / Bilibili / Xiaohongshu.
  douyin:   ["evil0ctal", "ytdlp"],
  bilibili: ["evil0ctal", "ytdlp"],
  // SocialFetch covers TikTok and Instagram media download. It only runs
  // when both yt-dlp and (where applicable) the user's browser cookies
  // didn't get the file. Skipped automatically when no API key is set.
  tiktok:    ["ytdlp", "socialfetch"],
  instagram: ["ytdlp", "socialfetch"],
  default:   ["ytdlp"],
};

/** App settings persisted locally */
export interface AppSettings {
  hubspotToken: string;
  rootFolder: string;
  cookiesBrowser: string; // "chrome" | "firefox" | "safari" | "edge" | "brave" | "opera" | "chromium" | ""
  cookiesFile: string;    // manual cookies.txt fallback
  preferHubSpotPreview: boolean;
  evil0ctalApiUrl: string;
  downloadProviders: DownloadProviders;
  ownerEmail: string;
  /** Cached HubSpot numeric owner ID resolved from ownerEmail */
  ownerId: string;
  /**
   * Optional key for socialkit.dev — Instagram-only fallback when oEmbed + embed
   * scrape both fail. Leave empty to use manual pick on those edge cases.
   */
  socialkitApiKey: string;
  /**
   * Optional key for socialfetch.dev — paid last-resort fallback for both
   * creator resolution (TikTok / Instagram / YouTube) and media download
   * (TikTok / Instagram). Only runs when cheaper / cookie-aware paths have
   * already failed. Leave empty to skip entirely (never billed).
   */
  socialfetchApiKey: string;
}

export type FeedbackType = "bug" | "feature";
export type FeedbackFrequency = "once" | "sometimes" | "always";
export type FeedbackImportance = "nice_to_have" | "important" | "critical";

export interface FeedbackPayload {
  type: FeedbackType;
  title: string;
  description: string;
  frequency?: FeedbackFrequency;
  importance?: FeedbackImportance;
  reporter_name?: string;
  screenshots: string[];
  app_version?: string;
  os_info?: string;
}
