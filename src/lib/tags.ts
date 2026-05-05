import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface TagOption {
  label: string;
  value: string; // internal HubSpot value (may differ from label)
}

let cachedOptions: TagOption[] | null = null;

/** Reactive accessor for the tag taxonomy. Cached once globally; safe to call from any row. */
export function useTagOptions(token: string): TagOption[] {
  const [options, setOptions] = useState<TagOption[]>(() => cachedOptions ?? []);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void fetchTagOptions(token).then((opts) => {
      if (!cancelled) setOptions(opts);
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return options;
}

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

/**
 * Map a foreign tag string (e.g. a Video Project's `tag` value) to one or more
 * External Clips taxonomy values, splitting compound tags when no exact match
 * exists.
 *
 * Resolution order:
 *
 * 1. Exact match (case-insensitive) against an EC value or label.
 * 2. If the input contains separators (whitespace, `_`, `-`, `/`, `&`, `,`, `+`),
 *    split into parts and require **all** parts to resolve to a known EC value.
 *    Example: VP tag `Cute Art` resolves to `["Cute", "Art"]` when both exist
 *    in the EC taxonomy. If any part fails to resolve, the function returns
 *    `[]` — partial coverage is treated as "needs manual review" so we never
 *    silently drop a meaningful piece of a compound tag.
 *
 * Returns canonical EC tag values (not labels). Order follows the input order,
 * with duplicates removed.
 */
export function suggestEcTagsForForeignTag(
  foreignTag: string,
  options: TagOption[],
): string[] {
  const trimmed = foreignTag.trim();
  if (!trimmed) return [];

  const lookup = new Map<string, string>();
  for (const opt of options) {
    lookup.set(opt.value.toLowerCase(), opt.value);
    lookup.set(opt.label.toLowerCase(), opt.value);
  }

  const exact = lookup.get(trimmed.toLowerCase());
  if (exact) return [exact];

  const parts = trimmed
    .split(/[\s_\-/&,+]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (parts.length < 2) return [];

  const matched: string[] = [];
  for (const part of parts) {
    const value = lookup.get(part.toLowerCase());
    if (!value) return [];
    if (!matched.includes(value)) matched.push(value);
  }

  return matched;
}
