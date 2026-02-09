import { useState, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, X, Cookie } from "lucide-react";
import { TagPicker } from "@/components/TagPicker";
import { ClipCard } from "@/components/ClipCard";
import { searchClipsByTags } from "@/lib/hubspot";
import type { AppSettings, Clip, Project } from "@/types";

interface Props {
  settings: AppSettings;
  project: Project | null;
  addClip: (clip: Clip) => void;
  removeClip: (hubspotId: string) => void;
}

export function SearchTab({ settings, project, addClip, removeClip }: Props) {
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [clips, setClips] = useState<Clip[]>([]);
  const [total, setTotal] = useState(0);
  const [nextAfter, setNextAfter] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [activePreviewId, setActivePreviewId] = useState<string | null>(null);
  const [cookieWarning, setCookieWarning] = useState<string | null>(null);

  const thumbCache = useRef(new Map<string, string | null>());

  const grouped = useMemo(() => {
    const map = new Map<string, Clip[]>();
    for (const clip of clips) {
      const key = clip.creatorName;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(clip);
    }
    return map;
  }, [clips]);

  const search = async (loadMore = false) => {
    if (selectedTags.length === 0) return;
    setLoading(true);
    setError(undefined);
    try {
      const result = await searchClipsByTags(
        settings.hubspotToken,
        selectedTags,
        loadMore ? nextAfter : undefined,
      );
      setClips(loadMore ? [...clips, ...result.clips] : result.clips);
      setTotal(result.total);
      setNextAfter(result.nextAfter);
      if (!loadMore) setActivePreviewId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const isInProject = (clipId: string) =>
    project?.clips.some((c) => c.hubspotId === clipId) ?? false;

  return (
    <div className="flex h-full flex-col gap-3 py-4">
      {/* Search controls */}
      <div className="flex gap-2">
        <div className="flex-1">
          <TagPicker selected={selectedTags} onChange={setSelectedTags} />
        </div>
        <Button
          onClick={() => search(false)}
          disabled={selectedTags.length === 0 || loading}
        >
          {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Search
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {cookieWarning && (
        <div className="flex items-start gap-2 rounded-md border border-orange-300 bg-orange-50 p-2.5 text-xs text-orange-800 dark:border-orange-800 dark:bg-orange-950/30 dark:text-orange-300">
          <Cookie className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <div className="flex-1">
            <p className="font-medium">Cookie / Login Issue</p>
            <p className="mt-0.5">{cookieWarning}</p>
          </div>
          <button
            onClick={() => setCookieWarning(null)}
            className="flex-shrink-0 rounded p-0.5 hover:bg-orange-200 dark:hover:bg-orange-900"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {!project && clips.length === 0 && (
        <p className="text-sm text-orange-500">
          Create a project in the Project tab first to add clips.
        </p>
      )}

      {clips.length > 0 && (
        <p className="text-sm text-muted-foreground">
          {total} clip{total !== 1 ? "s" : ""} found ({clips.length} loaded)
        </p>
      )}

      {/* Results: horizontal scroll rows per creator */}
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-5 pb-4">
          {Array.from(grouped.entries()).map(([creator, creatorClips]) => (
            <div key={creator}>
              <h3 className="mb-2 text-sm font-semibold">
                {creator}{" "}
                <span className="font-normal text-muted-foreground">
                  ({creatorClips.length})
                </span>
              </h3>
              <div className="flex gap-3 overflow-x-auto pb-2 scroll-smooth snap-x snap-mandatory">
                {creatorClips.map((clip) => (
                  <ClipCard
                    key={clip.id}
                    clip={clip}
                    thumbCache={thumbCache}
                    cookiesBrowser={settings.cookiesBrowser}
                    cookiesFile={settings.cookiesFile}
                    onCookieError={setCookieWarning}
                    isActive={activePreviewId === clip.id}
                    onTogglePreview={() =>
                      setActivePreviewId(
                        activePreviewId === clip.id ? null : clip.id,
                      )
                    }
                    inProject={isInProject(clip.id)}
                    hasProject={!!project}
                    onToggleProject={() =>
                      isInProject(clip.id)
                        ? removeClip(clip.id)
                        : addClip(clip)
                    }
                    hubspotToken={settings.hubspotToken}
                    searchTags={selectedTags}
                  />
                ))}
              </div>
            </div>
          ))}

          {nextAfter && (
            <Button
              variant="outline"
              onClick={() => search(true)}
              disabled={loading}
            >
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Load more
            </Button>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
