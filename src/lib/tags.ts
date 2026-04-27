import { invoke } from "@tauri-apps/api/core";

export interface TagOption {
  label: string;
  value: string; // internal HubSpot value (may differ from label)
}

let cachedOptions: TagOption[] | null = null;

/** Parse HubSpot social media tags from legacy comma-separated and current semicolon-separated values. */
export function parseHashtagList(raw: string | null | undefined): string[] {
  if (!raw) return [];

  const seen = new Set<string>();
  const tags: string[] = [];

  for (const part of raw.split(/[,;]/)) {
    const tag = part.trim().replace(/^#+/, "");
    if (!tag) continue;

    const key = tag.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    tags.push(tag);
  }

  return tags;
}

/** Fetch tag options from HubSpot (cached after first call) */
export async function fetchTagOptions(token: string): Promise<TagOption[]> {
  if (cachedOptions) return cachedOptions;

  const data = await invoke<Array<{ label: string; value: string }>>(
    "fetch_tag_options",
    { token },
  );

  cachedOptions = data
    .filter((o) => o.label && o.value)
    .sort((a, b) => a.label.localeCompare(b.label));

  return cachedOptions;
}

/** Invalidate the cached tag options so the next fetchTagOptions call re-fetches */
export function invalidateTagCache() {
  cachedOptions = null;
}

/** Build a value→label map for display purposes */
export function buildLabelMap(options: TagOption[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const o of options) {
    map.set(o.value, o.label);
  }
  return map;
}

/** Resolve a tag value to its label (using cache). Falls back to the value itself. */
export function resolveTagLabel(value: string): string {
  if (!cachedOptions) return value;
  const opt = cachedOptions.find((o) => o.value === value);
  return opt ? opt.label : value;
}
