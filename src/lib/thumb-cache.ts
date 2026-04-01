const THUMB_STORAGE_KEY = "compi-thumb-cache";

export function getPersistedThumb(clipUrl: string): string | null {
  try {
    const raw = localStorage.getItem(THUMB_STORAGE_KEY);
    if (!raw) return null;
    const cache = JSON.parse(raw);
    return cache[clipUrl] ?? null;
  } catch {
    return null;
  }
}

export function persistThumb(clipUrl: string, thumbUrl: string) {
  try {
    const raw = localStorage.getItem(THUMB_STORAGE_KEY);
    const cache = raw ? JSON.parse(raw) : {};
    cache[clipUrl] = thumbUrl;
    localStorage.setItem(THUMB_STORAGE_KEY, JSON.stringify(cache));
  } catch { /* localStorage full or unavailable */ }
}

export function clearPersistedThumb(clipUrl: string) {
  try {
    const raw = localStorage.getItem(THUMB_STORAGE_KEY);
    if (!raw) return;
    const cache = JSON.parse(raw);
    delete cache[clipUrl];
    localStorage.setItem(THUMB_STORAGE_KEY, JSON.stringify(cache));
  } catch { /* ignore */ }
}
