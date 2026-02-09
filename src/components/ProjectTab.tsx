import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  FolderOpen,
  Plus,
  Download,
  Loader2,
  CheckCircle,
  XCircle,
  Trash2,
} from "lucide-react";
import type { AppSettings, Project, ProjectClip } from "@/types";

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
  error: string | null;
}

export function ProjectTab({ settings, project, setProject, removeClip }: Props) {
  const [newName, setNewName] = useState("");
  const [existingProjects, setExistingProjects] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();

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
          <div className="flex flex-col gap-2 pr-4">
            {project.clips.map((clip) => (
              <ClipDownloadRow
                key={clip.hubspotId}
                clip={clip}
                onDownload={() => downloadClip(clip)}
                onRemove={() => removeClip(clip.hubspotId)}
              />
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

function ClipDownloadRow({
  clip,
  onDownload,
  onRemove,
}: {
  clip: ProjectClip;
  onDownload: () => void;
  onRemove: () => void;
}) {
  const statusIcon = {
    pending: null,
    downloading: <Loader2 className="h-4 w-4 animate-spin text-blue-500" />,
    complete: <CheckCircle className="h-4 w-4 text-green-500" />,
    failed: <XCircle className="h-4 w-4 text-destructive" />,
  }[clip.downloadStatus];

  return (
    <Card className="flex flex-col gap-1 p-3">
      <div className="flex items-center gap-3">
        <div className="w-5 flex-shrink-0">{statusIcon}</div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm">{clip.link}</p>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {clip.creatorName}
            </span>
            {clip.tags.slice(0, 3).map((tag) => (
              <Badge key={tag} variant="outline" className="text-xs">
                {tag}
              </Badge>
            ))}
          </div>
        </div>
        <div className="flex gap-1">
          {(clip.downloadStatus === "pending" ||
            clip.downloadStatus === "failed") && (
            <Button size="icon" variant="ghost" onClick={onDownload} className="h-8 w-8">
              <Download className="h-4 w-4" />
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            onClick={onRemove}
            className="h-8 w-8 text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {clip.downloadStatus === "failed" && clip.downloadError && (
        <p className="ml-8 text-xs text-destructive">{clip.downloadError}</p>
      )}
    </Card>
  );
}
