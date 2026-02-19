import { useState, useMemo, Component, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Clock, Film, CheckCircle, Loader2, Sparkles, RefreshCw } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { HubSpotIcon } from "@/components/ClipCard";
import { fetchVideoProjectClips } from "@/lib/hubspot";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Settings, Search, Download, ListOrdered, AlertTriangle } from "lucide-react";
import { SettingsDialog } from "@/components/SettingsDialog";
import { SearchTab } from "@/components/SearchTab";
import { ProjectTab } from "@/components/ProjectTab";
import { ArrangeTab } from "@/components/ArrangeTab";
import type { AppSettings, Clip, Project, ProjectClip } from "@/types";
import logo from "@/assets/logotipo-quantastic.png";
import "./App.css";

class TabErrorBoundary extends Component<
  { name: string; children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-destructive p-8">
          <AlertTriangle className="h-8 w-8" />
          <p className="font-semibold">{this.props.name} tab crashed</p>
          <pre className="max-w-full overflow-auto rounded bg-muted p-3 text-[11px] text-muted-foreground whitespace-pre-wrap">
            {this.state.error.message}
          </pre>
          <button
            className="mt-2 rounded bg-primary px-4 py-1.5 text-xs text-primary-foreground hover:bg-primary/90"
            onClick={() => this.setState({ error: null })}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const FINISH_STEPS: { label: string; buttonLabel: string }[] = [
  { label: "Verify Video Project in HubSpot", buttonLabel: "Open VP in HS" },
  { label: "Generate CSV with clip order and creators", buttonLabel: "Open CSV" },
  { label: "Rename clips and create zip for sharing", buttonLabel: "Open Local Folder" },
];

const DEFAULT_SETTINGS: AppSettings = {
  hubspotToken: "",
  rootFolder: "",
  cookiesBrowser: "chrome",
  cookiesFile: "",
};

function App() {
  const [settings, setSettings] = useState<AppSettings>(() => {
    const saved = localStorage.getItem("compi-settings");
    return saved ? JSON.parse(saved) : DEFAULT_SETTINGS;
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [project, setProject] = useState<Project | null>(null);
  const [activeTab, setActiveTab] = useState("project");

  // Finish video flow
  type StepStatus = "pending" | "working" | "done" | "error";
  const [finishDialogOpen, setFinishDialogOpen] = useState(false);
  const [finishPhase, setFinishPhase] = useState<"confirm" | "working">("confirm");
  const [stepStatuses, setStepStatuses] = useState<[StepStatus, StepStatus, StepStatus]>(["pending", "pending", "pending"]);
  const [stepErrors, setStepErrors] = useState<[string?, string?, string?]>([]);
  const [hubspotProjectId, setHubspotProjectId] = useState<string>();
  const [csvPath, setCsvPath] = useState<string>();
  const [clipsDir, setClipsDir] = useState<string>();

  const saveSettings = (next: AppSettings) => {
    setSettings(next);
    localStorage.setItem("compi-settings", JSON.stringify(next));
  };

  const isConfigured = settings.hubspotToken && settings.rootFolder;

  const [syncing, setSyncing] = useState(false);

  /** Sync clips from HubSpot (reusable from any tab) */
  const syncFromHubSpot = async () => {
    if (!project?.hubspotVideoProjectId) return;
    setSyncing(true);
    try {
      const hsClips = await fetchVideoProjectClips(
        settings.hubspotToken,
        project.hubspotVideoProjectId,
      );
      const hsClipIds = new Set(hsClips.map((c) => c.id));
      const localClipIds = new Set(project.clips.map((c) => c.hubspotId));

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
          fetchedThumbnail: c.fetchedThumbnail,
        }));

      // Build a lookup from HubSpot data to refresh metadata on existing clips
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
            fetchedThumbnail: hs.fetchedThumbnail,
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
      console.error("Sync failed:", e);
    } finally {
      setSyncing(false);
    }
  };

  /** Add clip to project, associate in HubSpot, and trigger download */
  const addClipToProject = (clip: Clip) => {
    if (!project) return;
    if (project.clips.some((c) => c.hubspotId === clip.id)) return;

    const newClip: ProjectClip = {
      hubspotId: clip.id,
      link: clip.link,
      creatorName: clip.creatorName,
      tags: clip.tags,
      score: clip.score,
      editedDuration: clip.editedDuration,
      downloadStatus: "pending",
      order: project.clips.length,
      licenseType: clip.licenseType,
      notes: clip.notes,
      fetchedThumbnail: clip.fetchedThumbnail,
    };
    const updated = { ...project, clips: [...project.clips, newClip] };
    setProject(updated);

    // Save locally
    invoke("save_project_data", {
      rootFolder: settings.rootFolder,
      project: updated,
    }).catch(() => {});

    // Associate in HubSpot (fire and forget, don't block)
    if (project.hubspotVideoProjectId) {
      invoke("associate_clips_to_project", {
        token: settings.hubspotToken,
        projectId: project.hubspotVideoProjectId,
        clipIds: [clip.id],
      }).catch((e) => console.warn("HubSpot association failed:", e));
    }

    // Auto-download
    invoke("download_clip", {
      rootFolder: settings.rootFolder,
      projectName: project.name,
      clipId: clip.id,
      url: clip.link,
      cookiesBrowser: settings.cookiesBrowser || null,
      cookiesFile: settings.cookiesFile || null,
    }).catch(() => {});
  };

  /** Remove clip from project and disassociate in HubSpot */
  const removeClipFromProject = (hubspotId: string) => {
    if (!project) return;
    const updated = {
      ...project,
      clips: project.clips
        .filter((c) => c.hubspotId !== hubspotId)
        .map((c, i) => ({ ...c, order: i })),
    };
    setProject(updated);
    invoke("save_project_data", {
      rootFolder: settings.rootFolder,
      project: updated,
    }).catch(() => {});

    // Disassociate in HubSpot (fire and forget)
    if (project.hubspotVideoProjectId) {
      invoke("disassociate_clip_from_project", {
        token: settings.hubspotToken,
        projectId: project.hubspotVideoProjectId,
        clipIds: [hubspotId],
      }).catch((e) => console.warn("HubSpot disassociation failed:", e));
    }
  };

  /** Finish Video: run all 3 steps in parallel */
  const handleFinishVideo = async () => {
    if (!project || !arrangeStats) return;
    setFinishPhase("working");
    setStepStatuses(["working", "working", "working"]);
    setStepErrors([]);
    setHubspotProjectId(undefined);
    setCsvPath(undefined);
    setClipsDir(undefined);

    const completedClips = project.clips.filter(
      (c) => c.downloadStatus === "complete" && c.localFile,
    );

    const updateStep = (idx: 0 | 1 | 2, status: StepStatus, error?: string) => {
      setStepStatuses((prev) => {
        const next = [...prev] as [StepStatus, StepStatus, StepStatus];
        next[idx] = status;
        return next;
      });
      if (error) {
        setStepErrors((prev) => {
          const next = [...prev] as [string?, string?, string?];
          next[idx] = error;
          return next;
        });
      }
    };

    // Step 1: Verify Video Project exists in HubSpot (already created + clips already associated)
    const step1 = (async () => {
      try {
        const vpId = project.hubspotVideoProjectId;
        if (!vpId) {
          updateStep(0, "error", "No HubSpot Video Project linked. Create or open one first.");
          return;
        }
        setHubspotProjectId(vpId);
        updateStep(0, "done");
      } catch (e) {
        updateStep(0, "error", e instanceof Error ? e.message : String(e));
      }
    })();

    // Step 2: Generate CSV
    const step2 = (async () => {
      try {
        const clipsData = completedClips.map((c) => ({
          creatorName: c.creatorName,
          link: c.link,
          hubspotId: c.hubspotId,
          score: c.score ?? null,
          editedDuration: c.editedDuration ?? c.localDuration ?? null,
        }));
        const csvResult = await invoke<string>("generate_clips_csv", {
          rootFolder: settings.rootFolder,
          projectName: project.name,
          clips: clipsData,
        });
        setCsvPath(csvResult);
        updateStep(1, "done");
      } catch (e) {
        updateStep(1, "error", e instanceof Error ? e.message : String(e));
      }
    })();

    // Step 3: Rename clips + create zip (includes CSV)
    const step3 = (async () => {
      try {
        // Wait for CSV to be ready before zipping (so it's included)
        await step2;
        const result = await invoke<{ dir: string; zipPath: string; newPaths: string[] }>(
          "order_and_zip_clips",
          {
            rootFolder: settings.rootFolder,
            projectName: project.name,
            clipFiles: completedClips.map((c) => c.localFile!),
          },
        );
        setClipsDir(result.dir);

        // Update localFile paths in project data
        const updatedClips = project.clips.map((c) => {
          const idx = completedClips.findIndex((cc) => cc.hubspotId === c.hubspotId);
          if (idx >= 0 && result.newPaths[idx]) {
            return { ...c, localFile: result.newPaths[idx] };
          }
          return c;
        });
        const updatedProject = { ...project, clips: updatedClips };
        setProject(updatedProject);
        invoke("save_project_data", {
          rootFolder: settings.rootFolder,
          project: updatedProject,
        }).catch(() => {});

        updateStep(2, "done");
      } catch (e) {
        updateStep(2, "error", e instanceof Error ? e.message : String(e));
      }
    })();

    await Promise.all([step1, step2, step3]);
  };

  // Arrange tab stats
  const arrangeStats = useMemo(() => {
    if (!project) return null;
    const completed = project.clips.filter(
      (c) => c.downloadStatus === "complete" && c.localFile,
    );
    if (completed.length === 0) return null;
    const totalSec = completed.reduce(
      (sum, c) => sum + (c.editedDuration ?? c.localDuration ?? 0),
      0,
    );
    const m = Math.floor(totalSec / 60);
    const s = Math.round(totalSec % 60);
    return {
      count: completed.length,
      duration: `${m}:${s.toString().padStart(2, "0")}`,
    };
  }, [project]);

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <header className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <img src={logo} alt="Quantastic" className="h-6" />
          <h1 className="text-lg font-semibold">COMPIFLOW</h1>
        </div>
        <div className="flex items-center gap-2">
          {project && (
            <span className="text-sm text-muted-foreground">
              Project: {project.name}
            </span>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings className="h-5 w-5" />
          </Button>
        </div>
      </header>

      {/* Main content */}
      {!isConfigured ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <p className="mb-4 text-muted-foreground">
              Configure your HubSpot token and project folder to get started.
            </p>
            <Button onClick={() => setSettingsOpen(true)}>
              Open Settings
            </Button>
          </div>
        </div>
      ) : (
        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className="flex flex-1 flex-col overflow-hidden"
        >
          <div className="flex items-center justify-between mx-4 mt-2">
            <TabsList className="w-fit">
              <TabsTrigger value="project">
                <Download className="mr-1.5 h-4 w-4" />
                Project
              </TabsTrigger>
              <TabsTrigger value="search">
                <Search className="mr-1.5 h-4 w-4" />
                Search
              </TabsTrigger>
              <TabsTrigger value="arrange">
                <ListOrdered className="mr-1.5 h-4 w-4" />
                Arrange
              </TabsTrigger>
            </TabsList>

            {activeTab === "arrange" && arrangeStats && (
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-3 text-sm text-muted-foreground mr-2">
                  <span className="flex items-center gap-1">
                    <Film className="h-3.5 w-3.5" />
                    {arrangeStats.count} clip{arrangeStats.count !== 1 ? "s" : ""}
                  </span>
                  <span className="flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" />
                    {arrangeStats.duration}
                  </span>
                </div>
                {project?.hubspotVideoProjectId && (
                  <>
                    <Button
                      onClick={() =>
                        openUrl(`https://app-eu1.hubspot.com/contacts/146859718/record/2-192286893/${project.hubspotVideoProjectId}`)
                      }
                      size="sm"
                      variant="outline"
                      title="Open in HubSpot"
                      className="cursor-pointer h-8 w-8 p-0"
                    >
                      <HubSpotIcon className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      onClick={syncFromHubSpot}
                      disabled={syncing}
                      size="sm"
                      variant="outline"
                      title="Sync clips from HubSpot"
                      className="cursor-pointer h-8 w-8 p-0"
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
                    </Button>
                  </>
                )}
                <Button
                  size="sm"
                  onClick={() => {
                    // If already ran, just re-open with results
                    if (finishPhase === "working" && !stepStatuses.every((s) => s === "pending")) {
                      setFinishDialogOpen(true);
                      return;
                    }
                    setFinishPhase("confirm");
                    setFinishDialogOpen(true);
                  }}
                  className="gap-1.5 cursor-pointer"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  Finish Video
                </Button>
              </div>
            )}
          </div>

          {/* Keep all tabs mounted, toggle visibility with CSS */}
          <div className={`flex-1 overflow-auto px-4 ${activeTab === "project" ? "" : "hidden"}`}>
            <TabErrorBoundary name="Project">
              <ProjectTab
                settings={settings}
                project={project}
                setProject={setProject}
                removeClip={removeClipFromProject}
              />
            </TabErrorBoundary>
          </div>
          <div className={`flex-1 overflow-auto px-4 ${activeTab === "search" ? "" : "hidden"}`}>
            <TabErrorBoundary name="Search">
              <SearchTab
                settings={settings}
                project={project}
                addClip={addClipToProject}
                removeClip={removeClipFromProject}
              />
            </TabErrorBoundary>
          </div>
          <div className={`flex-1 overflow-auto px-4 ${activeTab === "arrange" ? "" : "hidden"}`}>
            <TabErrorBoundary name="Arrange">
              <ArrangeTab
                settings={settings}
                project={project}
                setProject={setProject}
                isActive={activeTab === "arrange"}
              />
            </TabErrorBoundary>
          </div>
        </Tabs>
      )}

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        onSave={saveSettings}
      />

      {/* Finish Video Dialog */}
      <Dialog open={finishDialogOpen} onOpenChange={setFinishDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              Finish Video
            </DialogTitle>
            <DialogDescription>
              {finishPhase === "confirm"
                ? <>Finalize <strong>{project?.name}</strong> with {arrangeStats?.count} clips.</>
                : stepStatuses.every((s) => s === "done" || s === "error")
                  ? stepStatuses.every((s) => s === "done")
                    ? "All done! Your video project is ready."
                    : "Finished with some errors."
                  : "Processing..."}
            </DialogDescription>
          </DialogHeader>

          {finishPhase === "confirm" ? (
            <div className="space-y-3 text-sm">
              <p className="font-medium">This will:</p>
              <ol className="space-y-2 text-muted-foreground">
                {FINISH_STEPS.map((step, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className="mt-0.5 inline-block h-4 w-4 rounded-full bg-green-100 text-center text-[10px] font-bold leading-4 text-green-700">{i + 1}</span>
                    <span>{step.label}</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <div className="rounded-md border overflow-hidden">
              {FINISH_STEPS.map((step, i) => {
                const status = stepStatuses[i];
                const error = stepErrors[i];
                const actionUrl =
                  i === 0 && hubspotProjectId
                    ? `https://app-eu1.hubspot.com/contacts/146859718/record/2-192286893/${hubspotProjectId}`
                    : i === 1 && csvPath
                      ? csvPath
                      : i === 2 && clipsDir
                        ? clipsDir
                        : undefined;

                return (
                  <div
                    key={i}
                    className={`flex items-center gap-3 px-3 py-2.5 text-sm ${i > 0 ? "border-t" : ""}`}
                  >
                    {/* Status icon */}
                    <div className="flex-shrink-0 w-5 flex justify-center">
                      {status === "working" && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
                      {status === "done" && <CheckCircle className="h-4 w-4 text-green-500" />}
                      {status === "error" && <span className="inline-block h-4 w-4 rounded-full bg-destructive text-center text-[10px] font-bold leading-4 text-white">!</span>}
                      {status === "pending" && <span className="inline-block h-4 w-4 rounded-full bg-muted" />}
                    </div>

                    {/* Step label */}
                    <div className="flex-1 min-w-0">
                      <p className={status === "done" ? "text-muted-foreground" : ""}>{step.label}</p>
                      {error && <p className="text-[11px] text-destructive mt-0.5 leading-tight">{error}</p>}
                    </div>

                    {/* Action button */}
                    <div className="flex-shrink-0 w-[120px] text-right">
                      {status === "done" && actionUrl ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-xs h-7 px-3 cursor-pointer"
                          onClick={() => {
                            import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
                              openUrl(actionUrl)
                            );
                          }}
                        >
                          {step.buttonLabel}
                        </Button>
                      ) : status === "working" ? (
                        <span className="text-[11px] text-muted-foreground">Working...</span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <DialogFooter>
            {finishPhase === "confirm" ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => setFinishDialogOpen(false)}
                  className="cursor-pointer"
                >
                  Cancel
                </Button>
                <Button onClick={handleFinishVideo} className="gap-1.5 cursor-pointer">
                  <Sparkles className="h-3.5 w-3.5" />
                  Confirm
                </Button>
              </>
            ) : stepStatuses.some((s) => s === "working") ? (
              <Button variant="outline" disabled className="cursor-not-allowed">
                Working...
              </Button>
            ) : (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setFinishPhase("confirm");
                    setStepStatuses(["pending", "pending", "pending"]);
                    setStepErrors([]);
                    setHubspotProjectId(undefined);
                    setCsvPath(undefined);
                    setClipsDir(undefined);
                  }}
                  className="cursor-pointer"
                >
                  Run Again
                </Button>
                <Button
                  onClick={() => setFinishDialogOpen(false)}
                  className="cursor-pointer"
                >
                  Keep Editing
                </Button>
              </div>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default App;
