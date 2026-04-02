import { useState, useEffect, useMemo, useCallback, useRef, Component, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Clock, Film, CheckCircle, Loader2, Sparkles, RefreshCw, X, RulerDimensionLine, AlertTriangle, Search, ListOrdered, MessageSquarePlus, Globe, Tags } from "lucide-react";
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
import { SettingsPage } from "@/components/SettingsPage";
import { Sidebar, type Page } from "@/components/Sidebar";
import { FeedbackDialog } from "@/components/FeedbackDialog";
import { SearchTab } from "@/components/SearchTab";
import { ArrangeTab, decodeEditingNotes } from "@/components/ArrangeTab";
import { GeneralSearchTab } from "@/components/GeneralSearchTab";
import { TagClipsTab } from "@/components/TagClipsTab";
import { fetchTagOptions, invalidateTagCache } from "@/lib/tags";
import type { TagOption } from "@/lib/tags";
import { DEFAULT_DOWNLOAD_PROVIDERS } from "@/types";
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
  preferHubSpotPreview: true,
  evil0ctalApiUrl: "https://web-production-04050.up.railway.app",
  downloadProviders: DEFAULT_DOWNLOAD_PROVIDERS,
  ownerEmail: "",
  ownerId: "",
};

function App() {
  const [settings, setSettings] = useState<AppSettings>(() => {
    const saved = localStorage.getItem("compi-settings");
    return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : DEFAULT_SETTINGS;
  });
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [project, setProject] = useState<Project | null>(null);
  const [activePage, setActivePage] = useState<Page>("videos");
  const [activeVideoTab, setActiveVideoTab] = useState("search");
  const [activeClipTab, setActiveClipTab] = useState("general-search");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    return localStorage.getItem("sidebar-collapsed") === "true";
  });
  const [thumbWidth, setThumbWidth] = useState(110);

  // Tag options for TagClipsTab (loaded from HubSpot, cached)
  const [appTagOptions, setAppTagOptions] = useState<TagOption[]>([]);
  useEffect(() => {
    if (settings.hubspotToken) {
      fetchTagOptions(settings.hubspotToken).then(setAppTagOptions).catch(() => {});
    }
  }, [settings.hubspotToken]);

  // Finish video flow
  type StepStatus = "pending" | "working" | "done" | "error";
  const [finishDialogOpen, setFinishDialogOpen] = useState(false);
  const [finishPhase, setFinishPhase] = useState<"confirm" | "working">("confirm");
  const [stepStatuses, setStepStatuses] = useState<[StepStatus, StepStatus, StepStatus]>(["pending", "pending", "pending"]);
  const [stepErrors, setStepErrors] = useState<[string?, string?, string?]>([]);
  const [hubspotProjectId, setHubspotProjectId] = useState<string>();
  const [csvPath, setCsvPath] = useState<string>();
  const [clipsDir, setClipsDir] = useState<string>();

  // Update state
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);
  const [updateStatus, setUpdateStatus] = useState<"idle" | "downloading" | "installed">("idle");
  const [updateDismissed, setUpdateDismissed] = useState(false);

  const checkForUpdates = useCallback(async (): Promise<"up-to-date" | "available" | { error: string }> => {
    try {
      const update = await check();
      if (!update) return "up-to-date";
      setPendingUpdate(update);
      setUpdateDismissed(false);
      setUpdateStatus("idle");
      return "available";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Update check failed:", msg);
      return { error: msg };
    }
  }, []);

  const installUpdate = useCallback(async () => {
    if (!pendingUpdate) return;
    setUpdateStatus("downloading");
    try {
      await pendingUpdate.downloadAndInstall();
      setUpdateStatus("installed");
      // On macOS, relaunch immediately after install to avoid the Tauri v2 race
      // condition where the app exits before the new process launches.
      // We add a short delay so the UI can show "installed" briefly.
      setTimeout(() => relaunch(), 1500);
    } catch (e) {
      console.error("Update install failed:", e);
      setUpdateStatus("idle");
    }
  }, [pendingUpdate]);

  // Auto-check on startup
  useEffect(() => {
    let cancelled = false;
    checkForUpdates().then((result) => {
      if (cancelled || result !== "available") return;
    });
    return () => { cancelled = true; };
  }, [checkForUpdates]);



  // ── Download-progress listener (moved from ProjectTab) ──────────────────
  interface DownloadProgress {
    clipId: string;
    status: string;
    progress: number | null;
    localFile: string | null;
    localDuration: number | null;
    error: string | null;
  }

  const projectRef = useRef(project);
  projectRef.current = project;

  // ── Video upload queue (sequential, paced for HubSpot API limits) ──────
  // Each entry stores clipId + the resolved absolute file path so we don't
  // depend on projectRef having the latest localFile at dequeue time.
  const uploadQueueRef = useRef<Array<{ clipId: string; filePath: string }>>([]);
  const uploadRunningRef = useRef(false);

  const processUploadQueue = useCallback(() => {
    if (uploadRunningRef.current) return;
    const entry = uploadQueueRef.current.shift();
    if (!entry) return;
    const proj = projectRef.current;
    if (!proj || !settings.hubspotToken) return;
    const clip = proj.clips.find((c) => c.hubspotId === entry.clipId);
    if (clip?.originalClip) {
      setTimeout(processUploadQueue, 100);
      return;
    }
    uploadRunningRef.current = true;
    invoke<string>("upload_clip_video", {
      token: settings.hubspotToken,
      clipId: entry.clipId,
      filePath: entry.filePath,
    })
      .then((hubspotUrl) => {
        const current = projectRef.current;
        if (!current) return;
        const updatedClips = current.clips.map((c) =>
          c.hubspotId === entry.clipId ? { ...c, originalClip: hubspotUrl } : c,
        );
        const updated = { ...current, clips: updatedClips };
        setProject(updated);
        invoke("save_project_data", {
          rootFolder: settings.rootFolder,
          project: updated,
        }).catch(() => {});
      })
      .catch((e) => console.warn("Video upload to HubSpot failed:", e))
      .finally(() => {
        uploadRunningRef.current = false;
        setTimeout(processUploadQueue, 2000);
      });
  }, [settings.hubspotToken, settings.rootFolder]);

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

      // Enqueue video upload to HubSpot after successful download
      if (dp.status === "complete" && dp.localFile && settings.hubspotToken) {
        const clip = prev.clips.find((c) => c.hubspotId === dp.clipId);
        if (!clip?.originalClip) {
          const filePath = `${settings.rootFolder}/${prev.name}/${dp.localFile}`;
          uploadQueueRef.current.push({ clipId: dp.clipId, filePath });
          processUploadQueue();
        }
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [settings.rootFolder, settings.hubspotToken, processUploadQueue]);

  // ── Staggered auto-download on project open ────────────────────────────
  const downloadQueueRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!project) return;
    const pending = project.clips.filter(
      (c) => c.downloadStatus === "pending" || c.downloadStatus === "failed",
    );
    if (pending.length === 0) return;

    if (downloadQueueRef.current) clearTimeout(downloadQueueRef.current);

    let i = 0;
    const downloadNext = () => {
      if (i >= pending.length) return;
      const clip = pending[i++];
      const hasHubSpotVideo = !!clip.originalClip;
      invoke("download_clip", {
        rootFolder: settings.rootFolder,
        projectName: project.name,
        clipId: clip.hubspotId,
        url: clip.link,
        cookiesBrowser: settings.cookiesBrowser || null,
        cookiesFile: settings.cookiesFile || null,
        hubspotUrl: clip.originalClip || null,
        evil0ctalApiUrl: settings.evil0ctalApiUrl || null,
        downloadProviders: JSON.stringify(settings.downloadProviders ?? DEFAULT_DOWNLOAD_PROVIDERS),
      }).catch(() => {});
      const delay = hasHubSpotVideo ? 500 : 2500;
      downloadQueueRef.current = setTimeout(downloadNext, delay);
    };
    downloadQueueRef.current = setTimeout(downloadNext, 500);

    return () => {
      if (downloadQueueRef.current) clearTimeout(downloadQueueRef.current);
    };
  }, [project?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-upload already-downloaded clips that haven't been synced to HubSpot
  useEffect(() => {
    if (!project || !settings.hubspotToken) return;
    const needUpload = project.clips.filter(
      (c) => c.downloadStatus === "complete" && c.localFile && !c.originalClip,
    );
    if (needUpload.length === 0) return;
    const queued = new Set(uploadQueueRef.current.map((e) => e.clipId));
    for (const clip of needUpload) {
      if (!queued.has(clip.hubspotId) && clip.localFile) {
        const filePath = `${settings.rootFolder}/${project.name}/${clip.localFile}`;
        uploadQueueRef.current.push({ clipId: clip.hubspotId, filePath });
      }
    }
    processUploadQueue();
  }, [project?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveSettings = (next: AppSettings) => {
    setSettings(next);
    localStorage.setItem("compi-settings", JSON.stringify(next));
  };

  const isConfigured = settings.hubspotToken && settings.rootFolder;

  useEffect(() => {
    if (!isConfigured) setActivePage("settings");
  }, [isConfigured]);

  const [syncing, setSyncing] = useState(false);

  /** Sync clips from HubSpot (reusable from any tab) */
  const syncFromHubSpot = async () => {
    if (!project?.hubspotVideoProjectId) return;
    setSyncing(true);
    try {
      // Fetch clips and VP record (for clips_order) in parallel
      const [hsClips, vpData] = await Promise.all([
        fetchVideoProjectClips(settings.hubspotToken, project.hubspotVideoProjectId),
        invoke<{ results: Array<{ id: string; properties: Record<string, string | null> }> }>(
          "fetch_video_projects_by_ids",
          { token: settings.hubspotToken, projectIds: [project.hubspotVideoProjectId] },
        ),
      ]);

      // Parse clips_order and editing_notes from the VP record
      const vpRecord = vpData.results?.[0];
      const clipsOrderStr = vpRecord?.properties?.clips_order;
      const orderMap = new Map<string, number>();
      if (clipsOrderStr) {
        try {
          const ids = JSON.parse(clipsOrderStr) as string[];
          ids.forEach((id, i) => orderMap.set(id, i));
        } catch { /* invalid JSON, keep local order */ }
      }
      const editingNotesStr = vpRecord?.properties?.editing_notes;
      const notesMap = editingNotesStr ? decodeEditingNotes(editingNotesStr) : {};

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
          order: orderMap.get(c.id) ?? project.clips.length + i,
          licenseType: c.licenseType,
          notes: c.notes,
          editingNotes: notesMap[c.id] ?? undefined,
          fetchedThumbnail: c.fetchedThumbnail,
          originalClip: c.originalClip,
          creatorId: c.creatorId,
          creatorStatus: c.creatorStatus,
          clipMixLinks: c.clipMixLinks,
          availableAskFirst: c.availableAskFirst,
        }));

      // Build a lookup from HubSpot data to refresh metadata on existing clips
      const hsClipMap = new Map(hsClips.map((c) => [c.id, c]));
      const keptClips = project.clips
        .filter((c) => hsClipIds.has(c.hubspotId))
        .map((c) => {
          const hs = hsClipMap.get(c.hubspotId);
          if (!hs) return c;
          const newOriginalClip = hs.originalClip ?? c.originalClip;
          // If a clip failed but now has a CDN URL from a teammate, retry via CDN
          const shouldRetry = c.downloadStatus === "failed" && !c.originalClip && newOriginalClip;
          return {
            ...c,
            downloadStatus: shouldRetry ? "pending" as const : c.downloadStatus,
            downloadError: shouldRetry ? undefined : c.downloadError,
            tags: hs.tags,
            score: hs.score,
            editedDuration: hs.editedDuration,
            licenseType: hs.licenseType,
            notes: hs.notes,
            editingNotes: c.editingNotes || notesMap[c.hubspotId] || undefined,
            fetchedThumbnail: hs.fetchedThumbnail,
            originalClip: newOriginalClip,
            creatorId: hs.creatorId,
            creatorStatus: hs.creatorStatus,
            clipMixLinks: hs.clipMixLinks,
            availableAskFirst: hs.availableAskFirst,
          };
        });

      // If we have a clips_order, use it for all clips; otherwise keep local order for kept clips
      let allClips = [...keptClips, ...newClips];
      if (orderMap.size > 0) {
        allClips.sort((a, b) => {
          const oa = orderMap.get(a.hubspotId) ?? Infinity;
          const ob = orderMap.get(b.hubspotId) ?? Infinity;
          return oa - ob;
        });
      }
      allClips = allClips.map((c, i) => ({ ...c, order: i }));

      const updated = { ...project, clips: allClips };
      setProject(updated);
      await invoke("save_project_data", {
        rootFolder: settings.rootFolder,
        project: updated,
      });

      // Auto-download new clips (prefer HubSpot CDN)
      for (const clip of newClips) {
        invoke("download_clip", {
          rootFolder: settings.rootFolder,
          projectName: project.name,
          clipId: clip.hubspotId,
          url: clip.link,
          cookiesBrowser: settings.cookiesBrowser || null,
          cookiesFile: settings.cookiesFile || null,
          hubspotUrl: clip.originalClip || null,
          evil0ctalApiUrl: settings.evil0ctalApiUrl || null,
          downloadProviders: JSON.stringify(settings.downloadProviders ?? DEFAULT_DOWNLOAD_PROVIDERS),
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
      originalClip: clip.originalClip,
      creatorId: clip.creatorId,
      creatorStatus: clip.creatorStatus,
      clipMixLinks: clip.clipMixLinks,
      availableAskFirst: clip.availableAskFirst,
    };
    const updated = { ...project, clips: [...project.clips, newClip] };
    setProject(updated);

    // Save locally
    invoke("save_project_data", {
      rootFolder: settings.rootFolder,
      project: updated,
    }).catch(() => {});

    // Associate in HubSpot + sync order (fire and forget)
    if (project.hubspotVideoProjectId) {
      invoke("associate_clips_to_project", {
        token: settings.hubspotToken,
        projectId: project.hubspotVideoProjectId,
        clipIds: [clip.id],
      }).catch((e) => console.warn("HubSpot association failed:", e));
      invoke("update_video_project_property", {
        token: settings.hubspotToken,
        projectId: project.hubspotVideoProjectId,
        propertyName: "clips_order",
        propertyValue: JSON.stringify(updated.clips.map((c) => c.hubspotId)),
      }).catch((e) => console.warn("Order sync failed:", e));
    }

    // Auto-download (prefer HubSpot CDN if available)
    invoke("download_clip", {
      rootFolder: settings.rootFolder,
      projectName: project.name,
      clipId: clip.id,
      url: clip.link,
      cookiesBrowser: settings.cookiesBrowser || null,
      cookiesFile: settings.cookiesFile || null,
      hubspotUrl: clip.originalClip || null,
      evil0ctalApiUrl: settings.evil0ctalApiUrl || null,
      downloadProviders: JSON.stringify(settings.downloadProviders ?? DEFAULT_DOWNLOAD_PROVIDERS),
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

    // Disassociate in HubSpot + sync order (fire and forget)
    if (project.hubspotVideoProjectId) {
      invoke("disassociate_clip_from_project", {
        token: settings.hubspotToken,
        projectId: project.hubspotVideoProjectId,
        clipIds: [hubspotId],
      }).catch((e) => console.warn("HubSpot disassociation failed:", e));
      invoke("update_video_project_property", {
        token: settings.hubspotToken,
        projectId: project.hubspotVideoProjectId,
        propertyName: "clips_order",
        propertyValue: JSON.stringify(updated.clips.map((c) => c.hubspotId)),
      }).catch((e) => console.warn("Order sync failed:", e));
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

    // All clips sorted by order — used for CSV (all rows) and zip (with null gaps)
    const allClipsSorted = [...project.clips].sort((a, b) => a.order - b.order);
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

    // Step 2: Generate CSV (fetch creator data from HubSpot, then merge)
    const step2 = (async () => {
      try {
        // Collect unique creator IDs from ALL clips (completed only have creator data)
        const creatorIds = [...new Set(
          allClipsSorted.map((c) => c.creatorId).filter((id): id is string => !!id)
        )];

        type CreatorRecord = { id: string; properties: Record<string, string | null> };
        let creatorMap = new Map<string, Record<string, string | null>>();

        if (creatorIds.length > 0) {
          const creatorsResult = await invoke<{ results: CreatorRecord[] }>(
            "fetch_creators_batch",
            { token: settings.hubspotToken, creatorIds },
          );
          creatorMap = new Map(
            creatorsResult.results.map((r) => [r.id, r.properties])
          );
        }

        const vpId = project.hubspotVideoProjectId ?? "";

        // Build one row per clip in project order; missing clips get missing:true
        const clipsData = allClipsSorted.map((c, idx) => {
          const isMissing = c.downloadStatus !== "complete" || !c.localFile;
          const cr = c.creatorId ? creatorMap.get(c.creatorId) : undefined;
          const noVal = (v?: string | null) => v || "";
          return {
            order: idx + 1,
            missing: isMissing,
            downloadStatus: c.downloadStatus,
            duration: isMissing ? null : (c.editedDuration ?? c.localDuration ?? null),
            link: c.link,
            mainLink: noVal(cr?.main_link),
            mainAccount: noVal(cr?.main_account),
            name: noVal(cr?.name),
            douyinId: noVal(cr?.douyin_id),
            kuaishouId: noVal(cr?.kuaishou_id),
            xiaohongshuId: noVal(cr?.xiaohongshu_id),
            clipMixLinks: (c.clipMixLinks ?? []).join(", "),
            specialRequests: noVal(cr?.special_requests),
            notes: noVal(cr?.notes),
            licenseChecked: noVal(cr?.license_checked),
            licenseType: noVal(cr?.license_type),
            availableAskFirst: c.availableAskFirst ? "Yes" : "",
            score: c.score ?? "",
            externalClipId: c.hubspotId,
            creatorId: c.creatorId ?? "",
            videoProjectId: vpId,
            editingNotes: isMissing
              ? `Missing file in zip${c.editingNotes ? ` - ${c.editingNotes}` : ""}`
              : (c.editingNotes ?? ""),
          };
        });

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
        // Pass all clips in order; null entries mark missing clips so position
        // numbers are preserved in the renamed files (no gap-shifting)
        const result = await invoke<{ dir: string; zipPath: string; newPaths: (string | null)[] }>(
          "order_and_zip_clips",
          {
            rootFolder: settings.rootFolder,
            projectName: project.name,
            clipFiles: allClipsSorted.map((c) =>
              c.downloadStatus === "complete" && c.localFile ? c.localFile : null
            ),
          },
        );
        setClipsDir(result.dir);

        // Update localFile paths in project data (only for downloaded clips)
        const updatedClips = project.clips.map((c) => {
          const idx = allClipsSorted.findIndex((cc) => cc.hubspotId === c.hubspotId);
          const newPath = idx >= 0 ? result.newPaths[idx] : null;
          if (newPath) {
            return { ...c, localFile: newPath };
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

  // Arrange tab stats — use editedDuration (from HubSpot) or localDuration (probed from file)
  const arrangeStats = useMemo(() => {
    if (!project || project.clips.length === 0) return null;
    const totalSec = project.clips.reduce(
      (sum, c) => sum + (c.editedDuration ?? c.localDuration ?? 0),
      0,
    );
    const m = Math.floor(totalSec / 60);
    const s = Math.round(totalSec % 60);
    return {
      count: project.clips.length,
      duration: `${m}:${s.toString().padStart(2, "0")}`,
    };
  }, [project]);

  const handleToggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("sidebar-collapsed", String(next));
      return next;
    });
  }, []);

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
            onClick={() => setFeedbackOpen(true)}
            title="Share feedback"
          >
            <MessageSquarePlus className="h-5 w-5" />
          </Button>
        </div>
      </header>

      {/* Update notification banner */}
      {pendingUpdate && !updateDismissed && (
        <div className={`flex items-center justify-between gap-3 border-b px-4 py-2 text-sm font-medium ${
          updateStatus === "installed"
            ? "bg-green-500 text-white"
            : updateStatus === "downloading"
            ? "bg-primary text-primary-foreground"
            : "bg-gradient-to-r from-amber-400 to-orange-400 text-white"
        }`}>
          {updateStatus === "installed" ? (
            <span className="flex items-center gap-2">
              <CheckCircle className="h-4 w-4" />
              Update v{pendingUpdate.version} installed — restarting...
            </span>
          ) : updateStatus === "downloading" ? (
            <span className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Installing v{pendingUpdate.version}...
            </span>
          ) : (
            <span className="flex items-center gap-2">
              <Sparkles className="h-4 w-4" />
              Version {pendingUpdate.version} is available!
            </span>
          )}
          <div className="flex items-center gap-1.5">
            {updateStatus === "idle" && (
              <Button size="sm" className="h-6 px-3 text-xs bg-white text-orange-600 hover:bg-white/90 cursor-pointer font-bold" onClick={installUpdate}>
                Install now
              </Button>
            )}
            {updateStatus === "installed" && (
              <Button size="sm" className="h-6 px-3 text-xs bg-white text-green-700 hover:bg-white/90 cursor-pointer font-bold" onClick={() => relaunch()}>
                Restart now
              </Button>
            )}
            <button onClick={() => setUpdateDismissed(true)} className="rounded p-0.5 text-white/70 hover:text-white cursor-pointer">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* Sidebar + Content */}
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          activePage={activePage}
          onPageChange={setActivePage}
          collapsed={sidebarCollapsed}
          onToggleCollapse={handleToggleSidebar}
        />

        <main className="flex flex-1 flex-col overflow-hidden">
          {/* ── Videos page ── */}
          <div className={`flex flex-1 flex-col overflow-hidden ${activePage === "videos" ? "" : "hidden"}`}>
            {!isConfigured ? (
              <div className="flex flex-1 items-center justify-center">
                <div className="text-center">
                  <p className="mb-4 text-muted-foreground">
                    Configure your HubSpot token and project folder to get started.
                  </p>
                  <Button onClick={() => setActivePage("settings")}>
                    Open Settings
                  </Button>
                </div>
              </div>
            ) : (
              <Tabs
                value={activeVideoTab}
                onValueChange={setActiveVideoTab}
                className="flex flex-1 flex-col overflow-hidden"
              >
                <div className="flex items-center justify-between mx-4 mt-2">
                  <TabsList className="w-fit">
                    <TabsTrigger value="search">
                      <Search className="mr-1.5 h-4 w-4" />
                      Search
                    </TabsTrigger>
                    <TabsTrigger value="arrange">
                      <ListOrdered className="mr-1.5 h-4 w-4" />
                      Arrange
                    </TabsTrigger>
                  </TabsList>

                  {activeVideoTab === "arrange" && arrangeStats && (
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-3 text-sm text-muted-foreground mr-2">
                        <span className="flex items-center gap-1.5">
                          <RulerDimensionLine className="h-3.5 w-3.5 flex-shrink-0" />
                          <input
                            type="range"
                            min={60}
                            max={200}
                            value={thumbWidth}
                            onChange={(e) => setThumbWidth(Number(e.target.value))}
                            className="w-20 accent-primary cursor-pointer"
                          />
                        </span>
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

                <div className={`flex-1 overflow-auto px-4 ${activeVideoTab === "search" ? "" : "hidden"}`}>
                  <TabErrorBoundary name="Search">
                    <SearchTab
                      settings={settings}
                      project={project}
                      setProject={setProject}
                      addClip={addClipToProject}
                      removeClip={removeClipFromProject}
                    />
                  </TabErrorBoundary>
                </div>
                <div className={`flex-1 overflow-auto px-4 ${activeVideoTab === "arrange" ? "" : "hidden"}`}>
                  <TabErrorBoundary name="Arrange">
                    <ArrangeTab
                      settings={settings}
                      project={project}
                      setProject={setProject}
                      isActive={activeVideoTab === "arrange"}
                      removeClip={removeClipFromProject}
                      thumbWidth={thumbWidth}
                      suppressAutoPlay={finishDialogOpen}
                    />
                  </TabErrorBoundary>
                </div>
              </Tabs>
            )}
          </div>

          {/* ── Clips page ── */}
          <div className={`flex flex-1 flex-col overflow-hidden ${activePage === "clips" ? "" : "hidden"}`}>
            {!isConfigured ? (
              <div className="flex flex-1 items-center justify-center">
                <div className="text-center">
                  <p className="mb-4 text-muted-foreground">
                    Configure your HubSpot token and project folder to get started.
                  </p>
                  <Button onClick={() => setActivePage("settings")}>
                    Open Settings
                  </Button>
                </div>
              </div>
            ) : (
              <Tabs
                value={activeClipTab}
                onValueChange={setActiveClipTab}
                className="flex flex-1 flex-col overflow-hidden"
              >
                <div className="flex items-center justify-between mx-4 mt-2">
                  <TabsList className="w-fit">
                    <TabsTrigger value="general-search">
                      <Globe className="mr-1.5 h-4 w-4" />
                      Create
                    </TabsTrigger>
                    <TabsTrigger value="tag-clips">
                      <Tags className="mr-1.5 h-4 w-4" />
                      Tag
                    </TabsTrigger>
                  </TabsList>
                </div>

                <div className={`flex-1 overflow-hidden ${activeClipTab === "general-search" ? "" : "hidden"}`}>
                  <TabErrorBoundary name="Create Clips">
                    <GeneralSearchTab
                      settings={settings}
                      onSettingsChange={saveSettings}
                    />
                  </TabErrorBoundary>
                </div>
                <div className={`flex-1 overflow-hidden ${activeClipTab === "tag-clips" ? "" : "hidden"}`}>
                  <TabErrorBoundary name="Tag Clips">
                    <TagClipsTab
                      token={settings.hubspotToken}
                      tagOptions={appTagOptions}
                      settings={settings}
                      onTagsCreated={() => {
                        invalidateTagCache();
                        fetchTagOptions(settings.hubspotToken).then(setAppTagOptions).catch(() => {});
                      }}
                    />
                  </TabErrorBoundary>
                </div>
              </Tabs>
            )}
          </div>

          {/* ── Settings page ── */}
          <div className={`flex flex-1 flex-col overflow-hidden ${activePage === "settings" ? "" : "hidden"}`}>
            <SettingsPage
              settings={settings}
              onSave={saveSettings}
              onCheckUpdate={checkForUpdates}
            />
          </div>
        </main>
      </div>

      <FeedbackDialog
        open={feedbackOpen}
        onOpenChange={setFeedbackOpen}
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
              {(() => {
                const missingClips = project?.clips.filter(
                  (c) => c.downloadStatus !== "complete" || !c.localFile
                ) ?? [];
                if (missingClips.length === 0) return null;
                return (
                  <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs space-y-1.5">
                    <p className="flex items-center gap-1.5 font-semibold text-amber-800">
                      <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
                      {missingClips.length} clip{missingClips.length !== 1 ? "s" : ""} not downloaded
                    </p>
                    <ul className="space-y-0.5 text-amber-700 pl-5">
                      {missingClips.map((c, i) => {
                        const pos = (project?.clips.findIndex((x) => x.hubspotId === c.hubspotId) ?? 0) + 1;
                        return (
                          <li key={i}>#{pos} {c.creatorName} <span className="opacity-60">({c.downloadStatus})</span></li>
                        );
                      })}
                    </ul>
                    <p className="text-amber-700">These will appear as <strong>⚠ MISSING</strong> rows in the CSV. The zip will only contain downloaded clips.</p>
                  </div>
                );
              })()}
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
                            if (actionUrl.startsWith("http")) {
                              import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
                                openUrl(actionUrl)
                              );
                            } else {
                              import("@tauri-apps/plugin-opener").then(({ revealItemInDir }) =>
                                revealItemInDir(actionUrl)
                              );
                            }
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
