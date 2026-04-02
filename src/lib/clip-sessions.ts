const STORAGE_KEY = "compi-clip-sessions";
const MAX_SESSIONS = 50;

export interface ClipSessionClip {
  clipId: string;
  link: string;
  platform: string;
  handle: string | null;
  profileUrl: string | null;
  creatorId: string | null;
  creatorName: string | null;
  creatorMainLink: string | null;
  caption: string | null;
  likes: number | null;
  comments: number | null;
  views: number | null;
  shares: number | null;
  postedDate: string | null;
  socialMediaTags: string | null;
  foundIn: string;
  existedAlready: boolean;
}

export interface ClipSessionRecord {
  id: string;
  date: string;
  searchType: "General Search" | "Specific Search";
  clipCount: number;
  clips: ClipSessionClip[];
}

export function getSessions(): ClipSessionRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveSession(session: ClipSessionRecord) {
  try {
    const sessions = getSessions();
    sessions.unshift(session);
    if (sessions.length > MAX_SESSIONS) sessions.length = MAX_SESSIONS;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  } catch { /* localStorage full or unavailable */ }
}
