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
}

/** A local video project */
export interface Project {
  name: string;
  createdAt: string;
  clips: ProjectClip[];
}

/** A clip within a project */
export interface ProjectClip {
  hubspotId: string;
  link: string;
  creatorName: string;
  tags: string[];
  localFile?: string;
  downloadStatus: "pending" | "downloading" | "complete" | "failed";
  downloadError?: string;
  order: number;
}

/** App settings persisted locally */
export interface AppSettings {
  hubspotToken: string;
  rootFolder: string;
  cookiesBrowser: string; // "chrome" | "firefox" | "safari" | "edge" | "brave" | "opera" | "chromium" | ""
  cookiesFile: string;    // manual cookies.txt fallback
}
