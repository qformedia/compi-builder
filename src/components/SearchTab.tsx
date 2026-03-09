import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, X, Cookie, ExternalLink, Search as SearchIcon, Plus, Globe, FolderOpen } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { TagPicker } from "@/components/TagPicker";
import { CreatorPicker } from "@/components/CreatorPicker";
import { ClipCard, SCORE_COLORS } from "@/components/ClipCard";
import { searchClipsByTags, searchCreatorClips, searchVideoProjects, fetchVideoProjectClips } from "@/lib/hubspot";
import type { CreatorOption, VideoProjectSummary } from "@/lib/hubspot";
import { fetchTagOptions } from "@/lib/tags";
import type { TagOption } from "@/lib/tags";
import type { AppSettings, Clip, Project, ProjectClip } from "@/types";

const SCORE_OPTIONS = ["XL", "L", "M", "S", "XS"] as const;

interface Props {
  settings: AppSettings;
  project: Project | null;
  setProject: (p: Project | null) => void;
  addClip: (clip: Clip) => void;
  removeClip: (hubspotId: string) => void;
}

export function SearchTab({ settings, project, setProject, addClip, removeClip }: Props) {
  // ── Project lifecycle state ────────────────────────────────────────────
  const [newName, setNewName] = useState("");
  const [existingProjects, setExistingProjects] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [projectError, setProjectError] = useState<string>();
  const [hsQuery, setHsQuery] = useState("");
  const [hsResults, setHsResults] = useState<VideoProjectSummary[]>([]);
  const [hsSearching, setHsSearching] = useState(false);
  const [hsOpening, setHsOpening] = useState<string | null>(null);

  useEffect(() => {
    if (!settings.rootFolder) return;
    invoke<string[]>("list_projects", { rootFolder: settings.rootFolder })
      .then(async (names) => {
        const candidates: { name: string; vpId: string }[] = [];
        for (const name of names) {
          try {
            const p = await invoke<Project>("load_project", { rootFolder: settings.rootFolder, name });
            if (p.hubspotVideoProjectId) candidates.push({ name, vpId: p.hubspotVideoProjectId });
          } catch { /* skip broken projects */ }
        }
        if (candidates.length === 0) { setExistingProjects([]); return; }
        try {
          const res = await invoke<{ results?: Array<{ id: string }> }>("fetch_video_projects_by_ids", {
            token: settings.hubspotToken,
            projectIds: candidates.map((c) => c.vpId),
          });
          const validIds = new Set((res.results ?? []).map((r) => r.id));
          setExistingProjects(candidates.filter((c) => validIds.has(c.vpId)).map((c) => c.name));
        } catch {
          setExistingProjects(candidates.map((c) => c.name));
        }
      })
      .catch(() => {});
  }, [settings.rootFolder, project]);

  const createProjectInHubSpot = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    setProjectError(undefined);
    try {
      const result = await invoke<{ id: string; name: string }>(
        "create_video_project",
        { token: settings.hubspotToken, name: newName.trim(), clipIds: [] },
      );
      await invoke("create_project", {
        rootFolder: settings.rootFolder,
        name: result.name,
      }).catch(() => {});
      const newProject: Project = {
        name: result.name,
        createdAt: new Date().toISOString(),
        clips: [],
        hubspotVideoProjectId: result.id,
      };
      await invoke("save_project_data", {
        rootFolder: settings.rootFolder,
        project: newProject,
      });
      setProject(newProject);
      setNewName("");
    } catch (e) {
      setProjectError(String(e));
    } finally {
      setCreating(false);
    }
  };

  const openProject = async (name: string) => {
    try {
      const p = await invoke<Project>("load_project", {
        rootFolder: settings.rootFolder,
        name,
      });
      setProject(p);
    } catch (e) {
      setProjectError(String(e));
    }
  };

  const searchHubSpotProjects = async () => {
    if (!hsQuery.trim()) return;
    setHsSearching(true);
    try {
      const results = await searchVideoProjects(settings.hubspotToken, hsQuery.trim());
      setHsResults(results.filter((vp) => vp.status !== "Published"));
    } catch (e) {
      setProjectError(String(e));
    } finally {
      setHsSearching(false);
    }
  };

  useEffect(() => {
    if (!hsQuery.trim()) {
      setHsResults([]);
      return;
    }
    const timer = setTimeout(() => {
      searchHubSpotProjects();
    }, 400);
    return () => clearTimeout(timer);
  }, [hsQuery]);

  const openFromHubSpot = async (vp: VideoProjectSummary) => {
    setHsOpening(vp.id);
    setProjectError(undefined);
    try {
      const clips = await fetchVideoProjectClips(settings.hubspotToken, vp.id);
      await invoke("create_project", {
        rootFolder: settings.rootFolder,
        name: vp.name,
      }).catch(() => {});

      // Use clips_order from HubSpot to restore the correct arrangement
      const orderMap = new Map<string, number>();
      if (vp.clipsOrder) {
        try {
          const ids = JSON.parse(vp.clipsOrder) as string[];
          ids.forEach((id, i) => orderMap.set(id, i));
        } catch { /* invalid JSON, fall back to association order */ }
      }

      const projectClips: ProjectClip[] = clips.map((clip, i) => ({
        hubspotId: clip.id,
        link: clip.link,
        creatorName: clip.creatorName,
        tags: clip.tags,
        score: clip.score,
        editedDuration: clip.editedDuration,
        downloadStatus: "pending" as const,
        order: orderMap.get(clip.id) ?? clips.length + i,
        fetchedThumbnail: clip.fetchedThumbnail,
        originalClip: clip.originalClip,
        licenseType: clip.licenseType,
        notes: clip.notes,
        creatorId: clip.creatorId,
        creatorStatus: clip.creatorStatus,
        clipMixLinks: clip.clipMixLinks,
        availableAskFirst: clip.availableAskFirst,
      })).sort((a, b) => a.order - b.order)
        .map((c, i) => ({ ...c, order: i }));

      const proj: Project = {
        name: vp.name,
        createdAt: new Date().toISOString(),
        clips: projectClips,
        hubspotVideoProjectId: vp.id,
      };
      await invoke("save_project_data", {
        rootFolder: settings.rootFolder,
        project: proj,
      });
      setProject(proj);
    } catch (e) {
      setProjectError(String(e));
    } finally {
      setHsOpening(null);
    }
  };

  // ── Search state ───────────────────────────────────────────────────────
  const [tagOptions, setTagOptions] = useState<TagOption[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [tagMode, setTagMode] = useState<"AND" | "OR">("AND");
  const [selectedCreator, setSelectedCreator] = useState<CreatorOption | null>(null);

  const [thumbRetryKey, setThumbRetryKey] = useState(0);
  useEffect(() => {
    let lastRetry = 0;
    const onFocus = () => {
      const now = Date.now();
      if (now - lastRetry > 60_000) {
        lastRetry = now;
        setThumbRetryKey((k) => k + 1);
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Fetch tag options from HubSpot on mount
  useEffect(() => {
    if (settings.hubspotToken) {
      fetchTagOptions(settings.hubspotToken).then(setTagOptions).catch(() => {});
    }
  }, [settings.hubspotToken]);
  const [selectedScores, setSelectedScores] = useState<string[]>([]);
  const [neverUsed, setNeverUsed] = useState(false);
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
    if (selectedTags.length === 0 && selectedCreator === null) return;
    setLoading(true);
    setError(undefined);
    try {
      const result = await searchClipsByTags(
        settings.hubspotToken,
        selectedTags,
        selectedScores,
        neverUsed,
        tagMode,
        selectedCreator?.mainLink,
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
      setCreatorLoadState((prev) => {
        const state = prev.get(creatorName);
        if (state === "loading" || state === "loaded") return prev;
        return new Map(prev).set(creatorName, "loading");
      });

      try {
        const clips = await searchCreatorClips(
          settings.hubspotToken,
          selectedTags,
          selectedScores,
          neverUsed,
          tagMode,
          selectedCreator?.mainLink,
          creatorName,
        );
        setCreatorClipsMap((prev) => new Map(prev).set(creatorName, clips));
        setCreatorLoadState((prev) => new Map(prev).set(creatorName, "loaded"));
      } catch {
        setCreatorLoadState((prev) => new Map(prev).set(creatorName, "pending"));
      }
    },
    [settings.hubspotToken, selectedTags, selectedScores, neverUsed, tagMode, selectedCreator],
  );

  // Auto-search when filters change
  const searchRef = useRef(search);
  searchRef.current = search;
  useEffect(() => {
    if (selectedTags.length > 0 || selectedCreator !== null) {
      searchRef.current(false);
    }
  }, [selectedTags, selectedScores, neverUsed, tagMode, selectedCreator]);

  const isInProject = (clipId: string) =>
    project?.clips.some((c) => c.hubspotId === clipId) ?? false;

  // ── No project: show project lifecycle UI ────────────────────────────
  if (!project) {
    return (
      <div className="flex h-full flex-col gap-6 py-4">
        {projectError && <p className="text-sm text-destructive">{projectError}</p>}

        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium flex items-center gap-1.5">
            <SearchIcon className="h-4 w-4" />
            Open Video Project from HubSpot
          </h2>
          <div className="flex gap-2">
            <Input
              placeholder="Search by name..."
              value={hsQuery}
              onChange={(e) => setHsQuery(e.target.value)}
            />
            <Button onClick={searchHubSpotProjects} disabled={!hsQuery.trim() || hsSearching} variant="outline">
              {hsSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : <SearchIcon className="h-4 w-4" />}
            </Button>
          </div>
          {hsResults.length > 0 && (
            <div className="flex flex-col gap-1 max-h-48 overflow-y-auto rounded-md border">
              {hsResults.map((vp) => (
                <button
                  key={vp.id}
                  className="flex items-center gap-2 px-3 py-2 text-left hover:bg-muted transition-colors cursor-pointer border-b last:border-b-0"
                  disabled={hsOpening === vp.id}
                  onClick={() => openFromHubSpot(vp)}
                >
                  {hsOpening === vp.id ? (
                    <Loader2 className="h-4 w-4 animate-spin flex-shrink-0 text-muted-foreground" />
                  ) : (
                    <Globe className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                  )}
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{vp.name}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {vp.status}{vp.tag ? ` · ${vp.tag}` : ""}{vp.pubDate ? ` · ${vp.pubDate}` : ""}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3">
          <div className="flex-1 border-t" />
          <span className="text-xs text-muted-foreground">or</span>
          <div className="flex-1 border-t" />
        </div>

        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium flex items-center gap-1.5">
            <Plus className="h-4 w-4" />
            Create new Video Project
          </h2>
          <div className="flex gap-2">
            <Input
              placeholder="Project name (e.g. 260212 Minecraft)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createProjectInHubSpot()}
            />
            <Button onClick={createProjectInHubSpot} disabled={!newName.trim() || creating}>
              {creating ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Globe className="mr-2 h-4 w-4" />
              )}
              Create in HubSpot
            </Button>
          </div>
        </div>

        {existingProjects.length > 0 && (
          <>
            <div className="flex items-center gap-3">
              <div className="flex-1 border-t" />
              <span className="text-xs text-muted-foreground">recent</span>
              <div className="flex-1 border-t" />
            </div>
            <div className="flex flex-col gap-2">
              <h2 className="text-sm font-medium flex items-center gap-1.5">
                <FolderOpen className="h-4 w-4" />
                Recent projects
              </h2>
              <div className="flex flex-col gap-1">
                {existingProjects.map((name) => (
                  <Button
                    key={name}
                    variant="ghost"
                    className="justify-start"
                    onClick={() => openProject(name)}
                  >
                    <FolderOpen className="mr-2 h-4 w-4" />
                    {name}
                  </Button>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    );
  }

  // ── Project is open: show search interface ─────────────────────────────
  return (
    <div className="flex h-full flex-col gap-3 py-4">
      {/* Project header */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-muted-foreground">
          Project: <span className="text-foreground">{project.name}</span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setProject(null)}
          className="cursor-pointer text-xs h-7"
        >
          <X className="mr-1 h-3 w-3" />
          Close project
        </Button>
      </div>

      {/* Search controls */}
      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          <div className="flex-1">
            <TagPicker options={tagOptions} selected={selectedTags} onChange={setSelectedTags} />
          </div>
          <Button
            onClick={() => search(false)}
            disabled={selectedTags.length === 0 || loading}
          >
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Search
          </Button>
        </div>
        {/* Filters row */}
        <div className="flex items-center gap-1.5">
          {/* AND/OR toggle (only shown when 2+ tags selected) */}
          {selectedTags.length >= 2 && (
            <>
              <button
                onClick={() => setTagMode((m) => (m === "AND" ? "OR" : "AND"))}
                className={`rounded px-2 py-0.5 text-[11px] font-bold cursor-pointer transition-all ${
                  tagMode === "AND"
                    ? "bg-primary text-primary-foreground"
                    : "bg-blue-500 text-white"
                }`}
                title={tagMode === "AND" ? "Clips must match ALL tags" : "Clips must match ANY tag"}
              >
                {tagMode}
              </button>
              <span className="mx-1 text-muted-foreground/30">|</span>
            </>
          )}
          <span className="text-[11px] font-medium text-muted-foreground mr-1">Size:</span>
          {SCORE_OPTIONS.map((score) => {
            const active = selectedScores.includes(score);
            return (
              <button
                key={score}
                onClick={() =>
                  setSelectedScores((prev) =>
                    active ? prev.filter((s) => s !== score) : [...prev, score],
                  )
                }
                className={`rounded px-2 py-0.5 text-[11px] font-bold uppercase leading-none cursor-pointer transition-all ${
                  active
                    ? SCORE_COLORS[score]
                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                }`}
              >
                {score}
              </button>
            );
          })}
          {selectedScores.length > 0 && (
            <button
              onClick={() => setSelectedScores([])}
              className="ml-1 text-[10px] text-muted-foreground hover:text-foreground cursor-pointer"
              title="Clear score filter"
            >
              <X className="h-3 w-3" />
            </button>
          )}

          <span className="mx-2 text-muted-foreground/30">|</span>

          <button
            onClick={() => setNeverUsed((v) => !v)}
            className={`rounded px-2 py-0.5 text-[11px] font-medium cursor-pointer transition-all ${
              neverUsed
                ? "bg-green-500 text-white"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            }`}
          >
            Never used
          </button>

          <span className="mx-2 text-muted-foreground/30">|</span>

          <CreatorPicker
            token={settings.hubspotToken}
            value={selectedCreator}
            onChange={setSelectedCreator}
          />
        </div>
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
              thumbRetryKey={thumbRetryKey}
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
  thumbRetryKey: number;
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
  thumbRetryKey,
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
            thumbRetryKey={thumbRetryKey}
            preferHubSpotPreview={settings.preferHubSpotPreview}
          />
        ))}
      </div>
    </div>
  );
}
