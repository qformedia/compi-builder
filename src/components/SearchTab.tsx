import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, X, Cookie, ExternalLink } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { TagPicker } from "@/components/TagPicker";
import { ClipCard } from "@/components/ClipCard";
import { searchClipsByTags, searchCreatorClips } from "@/lib/hubspot";
import type { AppSettings, Clip, Project } from "@/types";

interface Props {
  settings: AppSettings;
  project: Project | null;
  addClip: (clip: Clip) => void;
  removeClip: (hubspotId: string) => void;
}

export function SearchTab({ settings, project, addClip, removeClip }: Props) {
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  // Initial search results (used to determine creator order)
  const [initialClips, setInitialClips] = useState<Clip[]>([]);
  const [total, setTotal] = useState(0);
  const [nextAfter, setNextAfter] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [activePreviewId, setActivePreviewId] = useState<string | null>(null);
  const [cookieWarning, setCookieWarning] = useState<string | null>(null);

  // Per-creator fully-loaded clips
  const [creatorClipsMap, setCreatorClipsMap] = useState<Map<string, Clip[]>>(new Map());
  const [creatorLoadState, setCreatorLoadState] = useState<Map<string, "pending" | "loading" | "loaded">>(new Map());

  const thumbCache = useRef(new Map<string, string | null>());

  // Extract unique creator names in order of first appearance (= most recent clip first)
  const creatorOrder = useMemo(() => {
    const seen = new Set<string>();
    const order: string[] = [];
    for (const clip of initialClips) {
      if (!seen.has(clip.creatorName)) {
        seen.add(clip.creatorName);
        order.push(clip.creatorName);
      }
    }
    return order;
  }, [initialClips]);

  // For each creator, get the clips to display:
  // - If fully loaded from creatorClipsMap, use that
  // - Otherwise, use partial clips from initialClips
  const getCreatorClips = useCallback(
    (creatorName: string): Clip[] => {
      if (creatorClipsMap.has(creatorName)) {
        return creatorClipsMap.get(creatorName)!;
      }
      return initialClips.filter((c) => c.creatorName === creatorName);
    },
    [initialClips, creatorClipsMap],
  );

  // Get first clip for a creator (for creator-level metadata like creatorId, mainLink)
  const getFirstClip = useCallback(
    (creatorName: string): Clip | undefined => {
      return creatorClipsMap.get(creatorName)?.[0]
        ?? initialClips.find((c) => c.creatorName === creatorName);
    },
    [initialClips, creatorClipsMap],
  );

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

      if (loadMore) {
        // Append new clips, dedup against already-loaded creators
        const loadedIds = new Set<string>();
        for (const clips of creatorClipsMap.values()) {
          for (const c of clips) loadedIds.add(c.id);
        }
        // Also dedup against existing initial clips
        for (const c of initialClips) loadedIds.add(c.id);

        const newClips = result.clips.filter(
          (c) => !loadedIds.has(c.id),
        );
        setInitialClips((prev) => [...prev, ...newClips]);
      } else {
        // Fresh search: reset everything
        setInitialClips(result.clips);
        setCreatorClipsMap(new Map());
        setCreatorLoadState(new Map());
        setActivePreviewId(null);
      }

      setTotal(result.total);
      setNextAfter(result.nextAfter);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  // Load all clips for a creator
  const loadCreator = useCallback(
    async (creatorName: string) => {
      const state = creatorLoadState.get(creatorName);
      if (state === "loading" || state === "loaded") return;

      setCreatorLoadState((prev) => new Map(prev).set(creatorName, "loading"));
      try {
        const clips = await searchCreatorClips(
          settings.hubspotToken,
          selectedTags,
          creatorName,
        );
        setCreatorClipsMap((prev) => new Map(prev).set(creatorName, clips));
        setCreatorLoadState((prev) => new Map(prev).set(creatorName, "loaded"));
      } catch {
        // On failure, revert to pending so it can retry
        setCreatorLoadState((prev) => new Map(prev).set(creatorName, "pending"));
      }
    },
    [settings.hubspotToken, selectedTags, creatorLoadState],
  );

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

      {!project && initialClips.length === 0 && (
        <p className="text-sm text-orange-500">
          Create a project in the Project tab first to add clips.
        </p>
      )}

      {initialClips.length > 0 && (
        <p className="text-sm text-muted-foreground">
          {total} clip{total !== 1 ? "s" : ""} found
        </p>
      )}

      {/* Results: horizontal scroll rows per creator */}
      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col gap-5 pb-4">
          {creatorOrder.map((creator) => (
            <CreatorRow
              key={creator}
              creatorName={creator}
              clips={getCreatorClips(creator)}
              firstClip={getFirstClip(creator)}
              loadState={creatorLoadState.get(creator) ?? "pending"}
              onVisible={() => loadCreator(creator)}
              thumbCache={thumbCache}
              settings={settings}
              selectedTags={selectedTags}
              activePreviewId={activePreviewId}
              setActivePreviewId={setActivePreviewId}
              project={project}
              isInProject={isInProject}
              addClip={addClip}
              removeClip={removeClip}
              onCookieError={setCookieWarning}
            />
          ))}

          {nextAfter && (
            <Button
              variant="outline"
              onClick={() => search(true)}
              disabled={loading}
            >
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Load more creators
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── CreatorRow: lazy-loads full clip set when scrolled into view ─────────────

interface CreatorRowProps {
  creatorName: string;
  clips: Clip[];
  firstClip?: Clip;
  loadState: "pending" | "loading" | "loaded";
  onVisible: () => void;
  thumbCache: React.RefObject<Map<string, string | null>>;
  settings: AppSettings;
  selectedTags: string[];
  activePreviewId: string | null;
  setActivePreviewId: (id: string | null) => void;
  project: Project | null;
  isInProject: (clipId: string) => boolean;
  addClip: (clip: Clip) => void;
  removeClip: (hubspotId: string) => void;
  onCookieError: (msg: string) => void;
}

function CreatorRow({
  creatorName,
  clips,
  firstClip,
  loadState,
  onVisible,
  thumbCache,
  settings,
  selectedTags,
  activePreviewId,
  setActivePreviewId,
  project,
  isInProject,
  addClip,
  removeClip,
  onCookieError,
}: CreatorRowProps) {
  const rowRef = useRef<HTMLDivElement>(null);

  // Trigger per-creator load when row scrolls into view
  useEffect(() => {
    const el = rowRef.current;
    if (!el || loadState !== "pending") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          onVisible();
          observer.disconnect();
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadState, onVisible]);

  const creatorId = firstClip?.creatorId;
  const creatorMainLink = firstClip?.creatorMainLink;

  return (
    <div ref={rowRef} key={creatorName}>
      <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
        {creatorId ? (
          <button
            className="hover:underline"
            onClick={() =>
              openUrl(`https://app-eu1.hubspot.com/contacts/146859718/record/2-191972671/${creatorId}`)
            }
            title="Open creator in HubSpot"
          >
            {creatorName}
          </button>
        ) : (
          <span>{creatorName}</span>
        )}
        {creatorMainLink && (
          <button
            className="text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => openUrl(creatorMainLink)}
            title="Open creator profile"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        )}
        <span className="font-normal text-muted-foreground">
          ({clips.length})
          {loadState === "loading" && (
            <Loader2 className="ml-1 inline h-3 w-3 animate-spin" />
          )}
        </span>
      </h3>
      <div className="flex gap-3 overflow-x-auto pb-2 scroll-smooth snap-x snap-mandatory">
        {clips.map((clip) => (
          <ClipCard
            key={clip.id}
            clip={clip}
            thumbCache={thumbCache}
            cookiesBrowser={settings.cookiesBrowser}
            cookiesFile={settings.cookiesFile}
            onCookieError={onCookieError}
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
  );
}
