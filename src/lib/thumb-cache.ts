const THUMB_STORAGE_KEY = "compi-thumb-cache";
const MAX_PERSISTED_ENTRIES = 1000;

type PersistedShape = {
  order: string[];
  values: Record<string, string>;
};

function parseCache(raw: string): PersistedShape {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "order" in parsed &&
      "values" in parsed &&
      Array.isArray((parsed as PersistedShape).order) &&
      typeof (parsed as PersistedShape).values === "object"
    ) {
      return parsed as PersistedShape;
    }
  } catch {
    /* fall through */
  }
  // Legacy: flat object map clipUrl -> thumbUrl
  try {
    const legacy = JSON.parse(raw) as Record<string, string>;
    const order = Object.keys(legacy);
    return { order, values: legacy };
  } catch {
    return { order: [], values: {} };
  }
}

function trimToMax(shape: PersistedShape) {
  while (shape.order.length > MAX_PERSISTED_ENTRIES) {
    const k = shape.order.shift();
    if (k) delete shape.values[k];
  }
}

export function getPersistedThumb(clipUrl: string): string | null {
  try {
    const raw = localStorage.getItem(THUMB_STORAGE_KEY);
    if (!raw) return null;
    const { values } = parseCache(raw);
    return values[clipUrl] ?? null;
  } catch {
    return null;
  }
}

/** Never persist base64 data URLs — they can be huge and blow localStorage / RAM. */
function isPersistableThumbUrl(url: string): boolean {
  return !url.startsWith("data:");
}

export function persistThumb(clipUrl: string, thumbUrl: string) {
  if (!isPersistableThumbUrl(thumbUrl)) return;
  try {
    const raw = localStorage.getItem(THUMB_STORAGE_KEY);
    const shape = raw ? parseCache(raw) : { order: [], values: {} as Record<string, string> };
    if (shape.values[clipUrl] !== undefined) {
      shape.order = shape.order.filter((k) => k !== clipUrl);
    }
    shape.order.push(clipUrl);
    shape.values[clipUrl] = thumbUrl;
    trimToMax(shape);
    localStorage.setItem(THUMB_STORAGE_KEY, JSON.stringify(shape));
  } catch {
    /* localStorage full or unavailable */
  }
}

export function clearPersistedThumb(clipUrl: string) {
  try {
    const raw = localStorage.getItem(THUMB_STORAGE_KEY);
    if (!raw) return;
    const shape = parseCache(raw);
    delete shape.values[clipUrl];
    shape.order = shape.order.filter((k) => k !== clipUrl);
    localStorage.setItem(THUMB_STORAGE_KEY, JSON.stringify(shape));
  } catch {
    /* ignore */
  }
}
