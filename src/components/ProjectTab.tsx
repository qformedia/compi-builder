import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Plus, Download, Loader2, Search, Globe, RefreshCw } from "lucide-react";
import { searchVideoProjects, fetchVideoProjectClips } from "@/lib/hubspot";
import type { VideoProjectSummary } from "@/lib/hubspot";
import { ClipCard, HubSpotIcon } from "@/components/ClipCard";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AppSettings, Project, ProjectClip } from "@/types";
import type { ClipCardData } from "@/components/ClipCard";

interface Props {
  settings: AppSettings;
  project: Project | null;
  setProject: (p: Project | null) => void;
  removeClip: (hubspotId: string) => void;
}

interface DownloadProgress {
  clipId: string;
  status: string;
  progress: number | null;
  localFile: string | null;
  localDuration: number | null;
  error: string | null;
}

/** Convert a ProjectClip to the shared ClipCardData format */
function toCardData(clip: ProjectClip): ClipCardData {
  return {
    id: clip.hubspotId,
    link: clip.link,
    tags: clip.tags,
    creatorName: clip.creatorName,
    score: clip.score,
    editedDuration: clip.editedDuration,
    downloadStatus: clip.downloadStatus,
    downloadError: clip.downloadError,
    licenseType: clip.licenseType,
    notes: clip.notes,
  };
}

export function ProjectTab({ settings, project, setProject, removeClip }: Props) {
  const [newName, setNewName] = useState("");
  const [existingProjects, setExistingProjects] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();

  // HubSpot project search
  const [hsQuery, setHsQuery] = useState("");
  const [hsResults, setHsResults] = useState<VideoProjectSummary[]>([]);
  const [hsSearching, setHsSearching] = useState(false);
  const [hsOpening, setHsOpening] = useState<string | null>(null);

  const thumbCache = useRef(new Map<string, string | null>());

  // Retry failed thumbnails when window regains focus (cookies may have refreshed)
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

  useEffect(() => {
    if (!settings.rootFolder) return;
    invoke<string[]>("list_projects", { rootFolder: settings.rootFolder })
      .then(async (names) => {
        // Only show local projects linked to a still-existing HubSpot Video Project
        const candidates: { name: string; vpId: string }[] = [];
        for (const name of names) {
          try {
            const p = await invoke<Project>("load_project", { rootFolder: settings.rootFolder, name });
            if (p.hubspotVideoProjectId) candidates.push({ name, vpId: p.hubspotVideoProjectId });
          } catch { /* skip broken projects */ }
        }
        if (candidates.length === 0) { setExistingProjects([]); return; }

        // Verify they still exist in HubSpot (batch read)
        try {
          const res = await invoke<{ results?: Array<{ id: string }> }>("fetch_video_projects_by_ids", {
            token: settings.hubspotToken,
            projectIds: candidates.map((c) => c.vpId),
          });
          const validIds = new Set((res.results ?? []).map((r) => r.id));
          setExistingProjects(candidates.filter((c) => validIds.has(c.vpId)).map((c) => c.name));
        } catch {
          // If HubSpot check fails (offline?), show all linked projects
          setExistingProjects(candidates.map((c) => c.name));
        }
      })
      .catch(() => {});
  }, [settings.rootFolder, project]);

  const projectRef = useRef(project);
  projectRef.current = project;

  useEffect(() => {
    const unlisten = listen<DownloadProgress>("download-progress", (event) => {
      const dp = event.payload;
      const prev = projectRef.current;
      if (!prev) return;
      const clips = prev.clips.map((c) => {
        if (c.hubspotId !== dp.clipId) return c;
        return {
          ...c,
          downloadStatus: dp.status as ProjectClip["downloadStatus"],
          localFile: dp.localFile ?? c.localFile,
          localDuration: dp.localDuration ?? c.localDuration,
          downloadError: dp.error ?? undefined,
        };
      });
      const updated = { ...prev, clips };
      setProject(updated);
      invoke("save_project_data", {
        rootFolder: settings.rootFolder,
        project: updated,
      }).catch(() => {});
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [settings.rootFolder, setProject]);

  /** Create a new Video Project in HubSpot, then create local folder and open */
  const createProjectInHubSpot = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    setError(undefined);
    try {
      // 1. Create in HubSpot
      const result = await invoke<{ id: string; name: string }>(
        "create_video_project",
        { token: settings.hubspotToken, name: newName.trim(), clipIds: [] },
      );

      // 2. Create local folder
      await invoke("create_project", {
        rootFolder: settings.rootFolder,
        name: result.name,
      }).catch(() => {}); // ignore if already exists

      // 3. Save project.json with HubSpot link
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
      setError(String(e));
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
      setError(String(e));
    }
  };

  const searchHubSpotProjects = async () => {
    if (!hsQuery.trim()) return;
    setHsSearching(true);
    try {
      const results = await searchVideoProjects(settings.hubspotToken, hsQuery.trim());
      setHsResults(results.filter((vp) => vp.status !== "Published"));
    } catch (e) {
      setError(String(e));
    } finally {
      setHsSearching(false);
    }
  };

  const openFromHubSpot = async (vp: VideoProjectSummary) => {
    setHsOpening(vp.id);
    setError(undefined);
    try {
      // Fetch associated clips
      const clips = await fetchVideoProjectClips(settings.hubspotToken, vp.id);

      // Create local folder if it doesn't exist
      const projectName = vp.name;
      await invoke("create_project", {
        rootFolder: settings.rootFolder,
        name: projectName,
      }).catch(() => {}); // ignore if already exists

      // Build the project with clips
      const projectClips: ProjectClip[] = clips.map((clip, i) => ({
        hubspotId: clip.id,
        link: clip.link,
        creatorName: clip.creatorName,
        tags: clip.tags,
        score: clip.score,
        editedDuration: clip.editedDuration,
        downloadStatus: "pending" as const,
        order: i,
      }));

      const project: Project = {
        name: projectName,
        createdAt: new Date().toISOString(),
        clips: projectClips,
        hubspotVideoProjectId: vp.id,
      };

      await invoke("save_project_data", {
        rootFolder: settings.rootFolder,
        project,
      });

      setProject(project);
    } catch (e) {
      setError(String(e));
    } finally {
      setHsOpening(null);
    }
  };

  const [syncing, setSyncing] = useState(false);

  /** Refresh: full sync clips from HubSpot */
  const syncFromHubSpot = async () => {
    if (!project?.hubspotVideoProjectId) return;
    setSyncing(true);
    setError(undefined);
    try {
      const hsClips = await fetchVideoProjectClips(
        settings.hubspotToken,
        project.hubspotVideoProjectId,
      );
      const hsClipIds = new Set(hsClips.map((c) => c.id));
      const localClipIds = new Set(project.clips.map((c) => c.hubspotId));

      // New clips from HubSpot (not in local)
      const newClips: ProjectClip[] = hsClips
        .filter((c) => !localClipIds.has(c.id))
        .map((c, i) => ({
          hubspotId: c.id,
          link: c.link,
          creatorName: c.creatorName,
          tags: c.tags,
          score: c.score,
          editedDuration: c.editedDuration,
          downloadStatus: "pending" as const,
          order: project.clips.length + i,
          licenseType: c.licenseType,
          notes: c.notes,
        }));

      // Keep only clips that still exist in HubSpot, refresh metadata
      const hsClipMap = new Map(hsClips.map((c) => [c.id, c]));
      const keptClips = project.clips
        .filter((c) => hsClipIds.has(c.hubspotId))
        .map((c) => {
          const hs = hsClipMap.get(c.hubspotId);
          if (!hs) return c;
          return {
            ...c,
            tags: hs.tags,
            score: hs.score,
            editedDuration: hs.editedDuration,
            licenseType: hs.licenseType,
            notes: hs.notes,
          };
        });

      const allClips = [...keptClips, ...newClips].map((c, i) => ({ ...c, order: i }));
      const updated = { ...project, clips: allClips };
      setProject(updated);
      await invoke("save_project_data", {
        rootFolder: settings.rootFolder,
        project: updated,
      });

      // Auto-download new clips
      for (const clip of newClips) {
        invoke("download_clip", {
          rootFolder: settings.rootFolder,
          projectName: project.name,
          clipId: clip.hubspotId,
          url: clip.link,
          cookiesBrowser: settings.cookiesBrowser || null,
          cookiesFile: settings.cookiesFile || null,
        }).catch(() => {});
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncing(false);
    }
  };

  const downloadClip = async (clip: ProjectClip) => {
    try {
      await invoke("download_clip", {
        rootFolder: settings.rootFolder,
        projectName: project!.name,
        clipId: clip.hubspotId,
        url: clip.link,
        cookiesBrowser: settings.cookiesBrowser || null,
        cookiesFile: settings.cookiesFile || null,
      });
    } catch {
      // Handled via event listener
    }
  };

  const importClipFile = async (clip: ProjectClip) => {
    try {
      const filePath = await openFileDialog({
        title: "Select video file to import",
        filters: [{ name: "Video", extensions: ["mp4", "webm", "mkv", "mov", "avi", "flv"] }],
      });
      if (!filePath) return; // cancelled
      const result = await invoke<{ localFile: string; localDuration: number | null }>(
        "import_clip_file",
        {
          rootFolder: settings.rootFolder,
          projectName: project!.name,
          clipId: clip.hubspotId,
          sourcePath: filePath,
        },
      );

      const prev = projectRef.current;
      if (!prev) return;
      const clips = prev.clips.map((c) => {
        if (c.hubspotId !== clip.hubspotId) return c;
        return {
          ...c,
          downloadStatus: "complete" as const,
          localFile: result.localFile,
          localDuration: result.localDuration ?? undefined,
          downloadError: undefined,
        };
      });
      const updated = { ...prev, clips };
      setProject(updated);
      invoke("save_project_data", {
        rootFolder: settings.rootFolder,
        project: updated,
      }).catch(() => {});
    } catch (e) {
      // Could show an error toast, but for now just log
      console.error("Import failed:", e);
    }
  };

  const downloadAll = () => {
    if (!project) return;
    project.clips
      .filter((c) => c.downloadStatus === "pending" || c.downloadStatus === "failed")
      .forEach(downloadClip);
  };

  // ── No project: search HubSpot / create / open local ────────────────────────

  if (!project) {
    return (
      <div className="flex h-full flex-col gap-6 py-4">
        {error && <p className="text-sm text-destructive">{error}</p>}

        {/* 1. Search HubSpot Video Projects */}
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium flex items-center gap-1.5">
            <Search className="h-4 w-4" />
            Open Video Project from HubSpot
          </h2>
          <div className="flex gap-2">
            <Input
              placeholder="Search by name..."
              value={hsQuery}
              onChange={(e) => setHsQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && searchHubSpotProjects()}
            />
            <Button onClick={searchHubSpotProjects} disabled={!hsQuery.trim() || hsSearching} variant="outline">
              {hsSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
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

        {/* Divider */}
        <div className="flex items-center gap-3">
          <div className="flex-1 border-t" />
          <span className="text-xs text-muted-foreground">or</span>
          <div className="flex-1 border-t" />
        </div>

        {/* 2. Create new Video Project in HubSpot */}
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

        {/* 3. Open local project (offline fallback) */}
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

  // ── Project loaded: show clips as cards ────────────────────────────────────

  const pendingCount = project.clips.filter(
    (c) => c.downloadStatus === "pending" || c.downloadStatus === "failed",
  ).length;

  return (
    <div className="flex h-full flex-col gap-3 py-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-medium">{project.name}</h2>
          <p className="text-sm text-muted-foreground">
            {project.clips.length} clip{project.clips.length !== 1 ? "s" : ""}
          </p>
        </div>
        <div className="flex gap-2">
          {project.hubspotVideoProjectId && (
            <>
              <Button
                onClick={() =>
                  openUrl(`https://app-eu1.hubspot.com/contacts/146859718/record/2-192286893/${project.hubspotVideoProjectId}`)
                }
                size="sm"
                variant="outline"
                title="Open Video Project in HubSpot"
                className="cursor-pointer"
              >
                <HubSpotIcon className="h-3.5 w-3.5" />
              </Button>
              <Button
                onClick={syncFromHubSpot}
                disabled={syncing}
                size="sm"
                variant="outline"
                title="Sync clips from HubSpot"
                className="cursor-pointer"
              >
                <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
                {syncing ? "Syncing..." : "Sync"}
              </Button>
            </>
          )}
          {pendingCount > 0 && (
            <Button onClick={downloadAll} size="sm" className="cursor-pointer">
              <Download className="mr-2 h-4 w-4" />
              Download all ({pendingCount})
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setProject(null)}
            className="cursor-pointer"
          >
            Close project
          </Button>
        </div>
      </div>

      {project.clips.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">
            No clips yet. Go to the Search tab to add clips.
          </p>
        </div>
      ) : (
        <ScrollArea className="flex-1">
          <div className="flex flex-wrap gap-3 pb-4">
            {project.clips.map((clip) => (
              <ClipCard
                key={clip.hubspotId}
                clip={toCardData(clip)}
                thumbCache={thumbCache}
                cookiesBrowser={settings.cookiesBrowser}
                cookiesFile={settings.cookiesFile}
                onRemove={() => removeClip(clip.hubspotId)}
                onRetryDownload={
                  clip.downloadStatus === "pending" || clip.downloadStatus === "failed"
                    ? () => downloadClip(clip)
                    : undefined
                }
                onImportFile={
                  clip.downloadStatus === "pending" || clip.downloadStatus === "failed"
                    ? () => importClipFile(clip)
                    : undefined
                }
                thumbRetryKey={thumbRetryKey}
              />
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
