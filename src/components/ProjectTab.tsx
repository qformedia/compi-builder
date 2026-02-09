import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FolderOpen, Plus, Download, Loader2 } from "lucide-react";
import { ClipCard } from "@/components/ClipCard";
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
  };
}

export function ProjectTab({ settings, project, setProject, removeClip }: Props) {
  const [newName, setNewName] = useState("");
  const [existingProjects, setExistingProjects] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();

  const thumbCache = useRef(new Map<string, string | null>());

  useEffect(() => {
    if (!settings.rootFolder) return;
    invoke<string[]>("list_projects", { rootFolder: settings.rootFolder })
      .then(setExistingProjects)
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

  const createProject = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    setError(undefined);
    try {
      const p = await invoke<Project>("create_project", {
        rootFolder: settings.rootFolder,
        name: newName.trim(),
      });
      setProject(p);
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

  const downloadAll = () => {
    if (!project) return;
    project.clips
      .filter((c) => c.downloadStatus === "pending" || c.downloadStatus === "failed")
      .forEach(downloadClip);
  };

  // ── No project: create / open ──────────────────────────────────────────────

  if (!project) {
    return (
      <div className="flex h-full flex-col gap-6 py-4">
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">Create new project</h2>
          <div className="flex gap-2">
            <Input
              placeholder="Project name (e.g. Minecraft Compilation)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createProject()}
            />
            <Button onClick={createProject} disabled={!newName.trim() || creating}>
              {creating ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Plus className="mr-2 h-4 w-4" />
              )}
              Create
            </Button>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        {existingProjects.length > 0 && (
          <div className="flex flex-col gap-2">
            <h2 className="text-sm font-medium">Open existing project</h2>
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
          {pendingCount > 0 && (
            <Button onClick={downloadAll} size="sm">
              <Download className="mr-2 h-4 w-4" />
              Download all ({pendingCount})
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setProject(null)}
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
              />
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
