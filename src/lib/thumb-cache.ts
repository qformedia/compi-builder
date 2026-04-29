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

const DURABLE_HOST_PATTERNS = [
  /(?:^|\.)hubspotusercontent-eu1\.net$/i,
  /(?:^|\.)hubspotusercontent\d*\.net$/i,
  /(?:^|\.)hubspot\.com$/i,
  /(?:^|\.)cdn\d*\.hubspot\.com$/i,
];

const EPHEMERAL_HOST_PATTERNS = [
  /(?:^|\.)tiktokcdn(?:-us)?\.com$/i,
  /(?:^|\.)byteimg\.com$/i,
  /(?:^|\.)muscdn\.com$/i,
  /(?:^|\.)cdninstagram\.com$/i,
  /(?:^|\.)fbcdn\.net$/i,
  /(?:^|\.)pinimg\.com$/i,
];

const EPHEMERAL_QUERY_KEYS = [
  "signature",
  "sig",
  "expires",
  "expiry",
  "exp",
  "policy",
  "x-amz-signature",
  "x-amz-security-token",
  "x-amz-credential",
  "x-goog-signature",
  "x-goog-credential",
  "token",
  "auth",
];

/** Never persist base64 data URLs — they can be huge and blow localStorage / RAM. */
export function isPersistableThumbUrl(url: string): boolean {
  if (!url || url.startsWith("data:")) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  if (DURABLE_HOST_PATTERNS.some((rx) => rx.test(host))) return true;

  const queryKeys = new Set(Array.from(parsed.searchParams.keys()).map((k) => k.toLowerCase()));
  const hasEphemeralKey = EPHEMERAL_QUERY_KEYS.some((k) => queryKeys.has(k));
  if (hasEphemeralKey) return false;
  if (EPHEMERAL_HOST_PATTERNS.some((rx) => rx.test(host))) return false;

  return true;
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
