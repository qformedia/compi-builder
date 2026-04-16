/** In-memory thumbnail URL cache size (LRU by insertion order on set). */
export const MAX_IN_MEMORY_THUMB_CACHE = 500;

/** Set a thumbnail cache entry and evict oldest keys when over capacity. */
export function setThumbCacheEntry(
  cache: Map<string, string | null>,
  key: string,
  value: string | null,
  maxSize = MAX_IN_MEMORY_THUMB_CACHE,
) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > maxSize) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}
