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
  /** Number of times the user has manually retried downloading this clip */
  retryCount?: number;
}

/** Resolve a relative localFile path to an absolute path.
 *  Handles legacy absolute paths gracefully (returns them as-is). */
export function resolveClipPath(rootFolder: string, projectName: string, relativePath: string): string {
  if (relativePath.startsWith("/") || relativePath.includes(":\\")) return relativePath;
  return `${rootFolder}/${projectName}/${relativePath}`;
}

/** App settings persisted locally */
export interface AppSettings {
  hubspotToken: string;
  rootFolder: string;
  cookiesBrowser: string; // "chrome" | "firefox" | "safari" | "edge" | "brave" | "opera" | "chromium" | ""
  cookiesFile: string;    // manual cookies.txt fallback
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
