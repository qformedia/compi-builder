import { useState, useEffect, useMemo, useCallback, useRef, Component, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Clock, Film, CheckCircle, Loader2, Sparkles, RefreshCw, X, RulerDimensionLine, AlertTriangle, Search, ListOrdered, MessageSquarePlus, Globe, Tags, ShieldAlert, ArrowRight, ScrollText, Bot } from "lucide-react";
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
import { ChangelogDialog } from "@/components/ChangelogDialog";
import { FeedbackDialog } from "@/components/FeedbackDialog";
import { DownloadsLogDialog } from "@/components/DownloadsLogDialog";
import { SearchTab } from "@/components/SearchTab";
import { ArrangeTab, decodeEditingNotes } from "@/components/ArrangeTab";
import { GeneralSearchTab } from "@/components/GeneralSearchTab";
import { DataIntegrityPage } from "@/components/DataIntegrityPage";
import { DuplicatesPage } from "@/components/DuplicatesPage";
import { isSupabaseConfigured } from "@/lib/supabase";
import { IntegrityProvider, useIntegrity } from "@/lib/data-integrity/use-data-integrity";
import {
  describeCreatorExportProgress,
  isCreatorExportInProgress,
  useCreatorExportProgress,
} from "@/lib/creator-export";
import { TagClipsTab } from "@/components/TagClipsTab";
import { TagPicker } from "@/components/TagPicker";
import { ClipTagEditorRow } from "@/components/ClipTagEditorRow";
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
  socialkitApiKey: "",
  socialfetchApiKey: "",
};

function buildIntegrityAlertText(c: number, w: number): string {
  if (c > 0 && w > 0) {
    return `${c} critical and ${w} warning${w === 1 ? "" : "s"} need fixing`;
  }
  if (c > 0) {
    return c === 1 ? "1 critical issue needs fixing" : `${c} critical issues need fixing`;
  }
  if (w === 1) {
    return "1 warning needs fixing";
  }
  return `${w} warnings need fixing`;
}

function IntegrityAlertBanner({ onNavigate }: { onNavigate: () => void }) {
  const { errors, hasLoadedOnce, loadAll, summary } = useIntegrity();
  const c = summary.critical;
  const w = summary.warning;
  const firstError = errors[0];
  const exportProgress = useCreatorExportProgress();
  const exportBusy = isCreatorExportInProgress(exportProgress);
  const exportMessage = describeCreatorExportProgress(exportProgress);

  // While the creators export is still being prepared the integrity check has
  // not had a chance to finish — surface that in plain language so the user
  // doesn't see a confusing "Couldn't check data integrity" flash. Progress
  // takes precedence over an error from the same check.
  if (exportBusy && exportMessage) {
    return (
      <button
        type="button"
        onClick={onNavigate}
        className="flex w-full cursor-pointer items-center justify-between gap-3 border-b bg-gradient-to-r from-sky-500 to-indigo-500 px-4 py-2 text-left text-sm font-medium text-white"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin" />
          <span className="min-w-0 truncate">{exportMessage}</span>
        </span>
        <span className="flex shrink-0 items-center gap-0.5 text-xs font-bold text-white/95">
          Details
          <ArrowRight className="h-3.5 w-3.5" />
        </span>
      </button>
    );
  }

  if (firstError) {
    const text =
      firstError.kind === "rateLimit"
        ? "HubSpot rate limit hit while checking integrity"
        : `Couldn't check data integrity: ${firstError.checkTitle}`;
    return (
      <div className="flex w-full items-center justify-between gap-3 border-b bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-2 text-left text-sm font-medium text-white">
        <button
          type="button"
          onClick={onNavigate}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
        >
          <ShieldAlert className="h-4 w-4 flex-shrink-0" />
          <span className="min-w-0 truncate">{text}</span>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            size="sm"
            className="h-6 cursor-pointer bg-white px-3 text-xs font-bold text-orange-600 hover:bg-white/90"
            onClick={() => void loadAll({ force: true })}
          >
            Retry
          </Button>
          <button
            type="button"
            onClick={onNavigate}
            className="flex cursor-pointer items-center gap-0.5 text-xs font-bold text-white/95"
          >
            Open
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    );
  }
  if (!hasLoadedOnce || c + w <= 0) {
    return null;
  }
  const isCritical = c > 0;
  return (
    <button
      type="button"
      onClick={onNavigate}
      className={`flex w-full cursor-pointer items-center justify-between gap-3 border-b px-4 py-2 text-left text-sm font-medium ${
        isCritical
          ? "bg-gradient-to-r from-red-500 to-rose-500 text-white"
          : "bg-gradient-to-r from-amber-500 to-orange-500 text-white"
      }`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <ShieldAlert className="h-4 w-4 flex-shrink-0" />
        <span className="min-w-0">{buildIntegrityAlertText(c, w)}</span>
      </span>
      <span className="flex shrink-0 items-center gap-0.5 text-xs font-bold text-white/95">
        Fix now
        <ArrowRight className="h-3.5 w-3.5" />
      </span>
    </button>
  );
}

function App() {
  const [settings, setSettings] = useState<AppSettings>(() => {
    const saved = localStorage.getItem("compi-settings");
    return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : DEFAULT_SETTINGS;
  });
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [downloadsLogOpen, setDownloadsLogOpen] = useState(false);
  const [project, setProject] = useState<Project | null>(null);
  const [activePage, setActivePage] = useState<Page>("videos");
  const [activeVideoTab, setActiveVideoTab] = useState("search");
  const [activeClipTab, setActiveClipTab] = useState("general-search");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    return localStorage.getItem("sidebar-collapsed") === "true";
  });
  const [thumbWidth, setThumbWidth] = useState(110);
  /** Live download progress per clip ID (0-100). Streamed from yt-dlp; not
   *  persisted. Cleared when the clip finishes or fails. */
  const [downloadProgress, setDownloadProgress] = useState<Record<string, number>>({});

  // Tag options for TagClipsTab (loaded from HubSpot, cached)
  const [appTagOptions, setAppTagOptions] = useState<TagOption[]>([]);
  useEffect(() => {
    if (settings.hubspotToken) {
      fetchTagOptions(settings.hubspotToken).then(setAppTagOptions).catch(() => {});
    }
  }, [settings.hubspotToken]);

  // Finish video flow
  type StepStatus = "pending" | "working" | "done" | "error";
  type FinishPhase = "tagPrecheck" | "confirm" | "working";
  const [finishDialogOpen, setFinishDialogOpen] = useState(false);
  const [finishPhase, setFinishPhase] = useState<FinishPhase>("confirm");
  const [stepStatuses, setStepStatuses] = useState<[StepStatus, StepStatus, StepStatus]>(["pending", "pending", "pending"]);
  const [stepErrors, setStepErrors] = useState<[string?, string?, string?]>([]);
  const [hubspotProjectId, setHubspotProjectId] = useState<string>();
  const [csvPath, setCsvPath] = useState<string>();
  const [clipsDir, setClipsDir] = useState<string>();
  const [finishTagDrafts, setFinishTagDrafts] = useState<Record<string, string[]>>({});
  const [finishApplyAllTags, setFinishApplyAllTags] = useState<string[]>([]);
  const [savingFinishTagClipIds, setSavingFinishTagClipIds] = useState<Set<string>>(() => new Set());
  const [finishTagInfo, setFinishTagInfo] = useState<string | null>(null);
  const [finishTagError, setFinishTagError] = useState<string | null>(null);
  const [isBulkApplyingFinishTags, setIsBulkApplyingFinishTags] = useState(false);

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

  // Open MiniMiki on Telegram. Uploads a screenshot + page/project context
  // unless Shift is held. Falls back to a context-less deep link if the
  // handoff fails (e.g. Supabase not configured, screen-recording perm).
  const openMiniMiki = useCallback(async (event: React.MouseEvent) => {
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? "";
    const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? "";
    const botUsername = import.meta.env.VITE_MINIMIKI_BOT_USERNAME ?? "minimiki_bot";
    const includeScreenshot = !event.shiftKey;
    try {
      const url = await invoke<string>("prepare_minimiki_handoff", {
        supabaseUrl,
        supabaseAnonKey,
        botUsername,
        context: {
          appVersion: __APP_VERSION__,
          page: activePage,
          projectName: project?.name,
        },
        includeScreenshot,
      });
      await openUrl(url);
    } catch (err) {
      console.error("MiniMiki handoff failed; opening bot directly:", err);
      await openUrl(`https://t.me/${botUsername}`);
    }
  }, [activePage, project]);

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
  // Currently-uploading clip (so the auto-queue effect can dedup against it).
  const uploadInFlightRef = useRef<string | null>(null);
  // Per-session failed-upload attempts. Capped to avoid tight retry loops if
  // HubSpot is rejecting the file (e.g. auth/permissions). Cleared on project
  // change so reopening the project gives the user a fresh chance.
  const uploadAttemptsRef = useRef<Map<string, number>>(new Map());
  const MAX_AUTO_UPLOAD_ATTEMPTS = 3;

  // Render-visible set of clips currently queued OR uploading to HubSpot.
  // Drives the per-clip "Uploading…" loader in ArrangeTab so users can tell
  // the difference between "needs upload" and "upload already in progress".
  const [uploadingClipIds, setUploadingClipIds] = useState<Set<string>>(() => new Set());

  const markUploadActive = useCallback((clipId: string) => {
    setUploadingClipIds((prev) => {
      if (prev.has(clipId)) return prev;
      const next = new Set(prev);
      next.add(clipId);
      return next;
    });
  }, []);

  const markUploadInactive = useCallback((clipId: string) => {
    setUploadingClipIds((prev) => {
      if (!prev.has(clipId)) return prev;
      const next = new Set(prev);
      next.delete(clipId);
      return next;
    });
  }, []);

  const processUploadQueue = useCallback(() => {
    if (uploadRunningRef.current) return;
    const entry = uploadQueueRef.current.shift();
    if (!entry) return;
    const proj = projectRef.current;
    if (!proj || !settings.hubspotToken) {
      markUploadInactive(entry.clipId);
      return;
    }
    const clip = proj.clips.find((c) => c.hubspotId === entry.clipId);
    if (clip?.originalClip) {
      markUploadInactive(entry.clipId);
      setTimeout(processUploadQueue, 100);
      return;
    }
    uploadRunningRef.current = true;
    uploadInFlightRef.current = entry.clipId;
    invoke<string>("upload_clip_video", {
      token: settings.hubspotToken,
      clipId: entry.clipId,
      filePath: entry.filePath,
    })
      .then((hubspotUrl) => {
        uploadAttemptsRef.current.delete(entry.clipId);
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
      .catch((e) => {
        console.warn("Video upload to HubSpot failed:", e);
        const prev = uploadAttemptsRef.current.get(entry.clipId) ?? 0;
        uploadAttemptsRef.current.set(entry.clipId, prev + 1);
      })
      .finally(() => {
        uploadRunningRef.current = false;
        uploadInFlightRef.current = null;
        markUploadInactive(entry.clipId);
        setTimeout(processUploadQueue, 2000);
      });
  }, [settings.hubspotToken, settings.rootFolder, markUploadInactive]);

  // Single source of truth for "what should be auto-uploaded": any clip that
  // is downloaded locally but has no HubSpot CDN URL yet, and isn't already
  // queued/in-flight or out of retry budget. Re-runs whenever the project's
  // clips list changes (new download finishes, sync, manual import, etc.).
  const ensureUploadsQueued = useCallback(() => {
    const proj = projectRef.current;
    if (!proj || !settings.hubspotToken) return;
    const queued = new Set(uploadQueueRef.current.map((e) => e.clipId));
    for (const clip of proj.clips) {
      if (clip.downloadStatus !== "complete" || !clip.localFile || clip.originalClip) continue;
      if (queued.has(clip.hubspotId)) continue;
      if (uploadInFlightRef.current === clip.hubspotId) continue;
      if ((uploadAttemptsRef.current.get(clip.hubspotId) ?? 0) >= MAX_AUTO_UPLOAD_ATTEMPTS) continue;
      const filePath = `${settings.rootFolder}/${proj.name}/${clip.localFile}`;
      uploadQueueRef.current.push({ clipId: clip.hubspotId, filePath });
      queued.add(clip.hubspotId);
      markUploadActive(clip.hubspotId);
    }
    processUploadQueue();
  }, [settings.hubspotToken, settings.rootFolder, processUploadQueue, markUploadActive]);

  // Manual "Upload to HubSpot" trigger from ArrangeTab. Resets the per-clip
  // retry budget (so users can force-retry after MAX_AUTO_UPLOAD_ATTEMPTS) and
  // delegates to the central queue, sharing the same in-progress loader UI.
  const enqueueClipUpload = useCallback((clipId: string) => {
    uploadAttemptsRef.current.delete(clipId);
    ensureUploadsQueued();
  }, [ensureUploadsQueued]);

  useEffect(() => {
    const unlisten = listen<DownloadProgress>("download-progress", (event) => {
      const dp = event.payload;

      // Update live progress map regardless of project. Cleared on terminal states.
      setDownloadProgress((prev) => {
        if (dp.status === "downloading" && typeof dp.progress === "number") {
          if (prev[dp.clipId] === dp.progress) return prev;
          return { ...prev, [dp.clipId]: dp.progress };
        }
        if (dp.status === "complete" || dp.status === "failed") {
          if (!(dp.clipId in prev)) return prev;
          const next = { ...prev };
          delete next[dp.clipId];
          return next;
        }
        return prev;
      });

      const prev = projectRef.current;
      if (!prev) return;

      let statusTransition = false;
      const clips = prev.clips.map((c) => {
        if (c.hubspotId !== dp.clipId) return c;
        const isComplete = c.downloadStatus === "complete" && !!c.localFile;
        const isDowngrade = dp.status === "downloading" || dp.status === "failed";
        if (isComplete && isDowngrade) return c;
        if (c.downloadStatus !== dp.status) statusTransition = true;
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

      // Never persist transient "downloading" states. Persist only terminal
      // states so crashes/restarts cannot leave project.json stuck forever.
      const shouldPersistTerminal =
        dp.status === "complete" || dp.status === "failed";
      if (shouldPersistTerminal) {
        invoke("save_project_data", {
          rootFolder: settings.rootFolder,
          project: updated,
        }).catch(() => {});
        return;
      }

      // Keep transition visibility in-memory (spinner/status text) but avoid
      // disk writes for high-frequency progress updates.
      if (!statusTransition) return;
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [settings.rootFolder]);

  // ── Staggered auto-download on project open ────────────────────────────
  const downloadQueueRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!project) return;
    const pending = project.clips.filter(
      (c) =>
        (
          c.downloadStatus === "pending" ||
          c.downloadStatus === "failed" ||
          c.downloadStatus === "downloading"
        ) &&
        !c.localFile,
    );
    const complete = project.clips.filter((c) => c.downloadStatus === "complete" && !!c.localFile).length;
    invoke("log_event", {
      level: "info",
      source: "auto-download",
      clipId: null,
      message: `project-open scan: total=${project.clips.length}, queued=${pending.length}, complete=${complete}`,
    }).catch(() => {});
    if (pending.length === 0) return;

    if (downloadQueueRef.current) clearTimeout(downloadQueueRef.current);

    let i = 0;
    const downloadNext = () => {
      if (i >= pending.length) return;
      const clip = pending[i++];
      const hasHubSpotVideo = !!clip.originalClip;
      invoke("log_event", {
        level: "debug",
        source: "auto-download",
        clipId: clip.hubspotId,
        message: `queue download (status=${clip.downloadStatus}, hasOriginalClip=${hasHubSpotVideo})`,
      }).catch(() => {});
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
        socialfetchApiKey: settings.socialfetchApiKey || null,
      }).catch((err) => {
        invoke("log_event", {
          level: "error",
          source: "auto-download",
          clipId: clip.hubspotId,
          message: "invoke(download_clip) failed",
          detail: String(err),
        }).catch(() => {});
      });
      const delay = hasHubSpotVideo ? 500 : 2500;
      downloadQueueRef.current = setTimeout(downloadNext, delay);
    };
    downloadQueueRef.current = setTimeout(downloadNext, 500);

    return () => {
      if (downloadQueueRef.current) clearTimeout(downloadQueueRef.current);
    };
  }, [project?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-upload eligible clips to HubSpot ───────────────────────────────
  // Whenever the project's clips list changes (new download completes, sync
  // adds clips, manual import sets localFile, etc.), make sure any clip that
  // is downloaded-but-not-yet-uploaded gets enqueued. This is the single
  // source of truth for auto-upload eligibility.
  useEffect(() => {
    ensureUploadsQueued();
  }, [project?.clips, ensureUploadsQueued]);

  // Reset retry budget when switching projects so reopening gives a fresh
  // chance for any clip that exhausted MAX_AUTO_UPLOAD_ATTEMPTS earlier.
  // Also clear the in-progress UI markers — leftover ids from another project
  // would otherwise show stale loaders on unrelated clips.
  useEffect(() => {
    uploadAttemptsRef.current.clear();
    setUploadingClipIds(new Set());
  }, [project?.name]);

  // Keep HubSpot-hosted media URLs fresh in local project state. This is a
  // lightweight metadata refresh (only originalClip + fetchedThumbnail), not a
  // full project sync/reorder. Without it, old project.json files can miss
  // thumbnails that already exist in HubSpot, causing unnecessary Instagram
  // fallback thumbnail fetches.
  useEffect(() => {
    if (!project?.hubspotVideoProjectId || !settings.hubspotToken || !settings.rootFolder) return;
    let cancelled = false;

    (async () => {
      try {
        const hsClips = await fetchVideoProjectClips(settings.hubspotToken, project.hubspotVideoProjectId!);
        if (cancelled) return;
        const mediaById = new Map(
          hsClips.map((c) => [c.id, {
            fetchedThumbnail: c.fetchedThumbnail,
            originalClip: c.originalClip,
          }]),
        );

        let changed = false;
        const updatedClips = project.clips.map((clip) => {
          const media = mediaById.get(clip.hubspotId);
          if (!media) return clip;
          const nextFetchedThumbnail = media.fetchedThumbnail ?? clip.fetchedThumbnail;
          const nextOriginalClip = media.originalClip ?? clip.originalClip;
          if (
            nextFetchedThumbnail === clip.fetchedThumbnail &&
            nextOriginalClip === clip.originalClip
          ) {
            return clip;
          }
          changed = true;
          return {
            ...clip,
            fetchedThumbnail: nextFetchedThumbnail,
            originalClip: nextOriginalClip,
          };
        });

        if (!changed || cancelled) return;
        const updated = { ...project, clips: updatedClips };
        setProject(updated);
        await invoke("save_project_data", {
          rootFolder: settings.rootFolder,
          project: updated,
        });
        invoke("log_event", {
          level: "info",
          source: "hubspot",
          clipId: null,
          message: "refreshed HubSpot media URLs for project clips",
        }).catch(() => {});
      } catch (err) {
        invoke("log_event", {
          level: "warn",
          source: "hubspot",
          clipId: null,
          message: "failed to refresh HubSpot media URLs for project clips",
          detail: String(err),
        }).catch(() => {});
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [project?.hubspotVideoProjectId, project?.name, settings.hubspotToken, settings.rootFolder]); // eslint-disable-line react-hooks/exhaustive-deps

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
          socialfetchApiKey: settings.socialfetchApiKey || null,
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
      socialfetchApiKey: settings.socialfetchApiKey || null,
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

  const normalizeTagValues = useCallback((values: string[]) => {
    const normalized = values.map((t) => t.trim()).filter(Boolean);
    return [...new Set(normalized)];
  }, []);

  const toTagLabels = useCallback((values: string[]) => {
    const labelByValue = new Map(appTagOptions.map((o) => [o.value, o.label]));
    return values.map((value) => labelByValue.get(value) ?? value);
  }, [appTagOptions]);

  const listEmptyTagClips = useCallback((candidate: Project | null): ProjectClip[] => {
    if (!candidate) return [];
    return [...candidate.clips]
      .filter((clip) => clip.tags.length === 0)
      .sort((a, b) => a.order - b.order);
  }, []);

  const getInitialFinishPhase = useCallback((candidate: Project | null): FinishPhase => {
    return listEmptyTagClips(candidate).length > 0 ? "tagPrecheck" : "confirm";
  }, [listEmptyTagClips]);

  const resetFinishTagEditor = useCallback(() => {
    setFinishTagDrafts({});
    setFinishApplyAllTags([]);
    setSavingFinishTagClipIds(new Set());
    setFinishTagInfo(null);
    setFinishTagError(null);
    setIsBulkApplyingFinishTags(false);
  }, []);

  const markFinishTagClipSaving = useCallback((clipId: string, saving: boolean) => {
    setSavingFinishTagClipIds((prev) => {
      const next = new Set(prev);
      if (saving) next.add(clipId);
      else next.delete(clipId);
      return next;
    });
  }, []);

  const setProjectClipTags = useCallback((clipId: string, tagValues: string[]) => {
    const current = projectRef.current;
    if (!current) return;
    const labels = toTagLabels(tagValues);
    const updated = {
      ...current,
      clips: current.clips.map((clip) =>
        clip.hubspotId === clipId ? { ...clip, tags: labels } : clip
      ),
    };
    setProject(updated);
    invoke("save_project_data", {
      rootFolder: settings.rootFolder,
      project: updated,
    }).catch(() => {});
  }, [settings.rootFolder, toTagLabels]);

  const saveExternalClipTags = useCallback(async (clipId: string, tagValues: string[]) => {
    const normalized = normalizeTagValues(tagValues);
    if (normalized.length === 0) {
      throw new Error("Select at least one tag.");
    }
    await invoke("update_clip_properties", {
      token: settings.hubspotToken,
      clipId,
      properties: { tags: normalized.join(";") },
    });
    setProjectClipTags(clipId, normalized);
  }, [normalizeTagValues, setProjectClipTags, settings.hubspotToken]);

  const emptyTagClips = useMemo(() => listEmptyTagClips(project), [listEmptyTagClips, project]);

  const openFinishDialog = useCallback(() => {
    if (finishPhase === "working" && !stepStatuses.every((s) => s === "pending")) {
      setFinishDialogOpen(true);
      return;
    }
    resetFinishTagEditor();
    setFinishPhase(getInitialFinishPhase(projectRef.current));
    setFinishDialogOpen(true);
  }, [finishPhase, getInitialFinishPhase, resetFinishTagEditor, stepStatuses]);

  /**
   * Stage the "apply to all" selection into local drafts only. No HubSpot
   * write happens here — the user reviews drafts and commits them all at once
   * via the footer Save button (`commitDraftedTags`).
   */
  const stageTagsForAllEmptyClips = useCallback(() => {
    const selectedTags = normalizeTagValues(finishApplyAllTags);
    if (selectedTags.length === 0) {
      setFinishTagError("Select tags first to apply to all empty clips.");
      return;
    }

    const targets = listEmptyTagClips(projectRef.current);
    if (targets.length === 0) {
      setFinishTagInfo("No clips with empty tags remaining.");
      return;
    }

    setFinishTagError(null);
    setFinishTagInfo(null);
    setFinishTagDrafts((prev) => {
      const next = { ...prev };
      for (const clip of targets) {
        next[clip.hubspotId] = selectedTags;
      }
      return next;
    });
  }, [finishApplyAllTags, listEmptyTagClips, normalizeTagValues]);

  /** Drafts ready to be committed (non-empty after normalization). */
  const draftedTagEntries = useMemo(
    () =>
      Object.entries(finishTagDrafts)
        .map(([clipId, tags]) => [clipId, normalizeTagValues(tags)] as const)
        .filter(([, tags]) => tags.length > 0),
    [finishTagDrafts, normalizeTagValues],
  );

  const hasUncommittedDrafts = draftedTagEntries.length > 0;

  /**
   * Commit every staged draft to HubSpot in sequence. Runs from the footer
   * Save button — partial failures are reported but do not abort the loop so
   * the user gets the maximum number of saves through.
   */
  const commitDraftedTags = useCallback(async () => {
    if (draftedTagEntries.length === 0) {
      setFinishTagError("Nothing to save yet.");
      return;
    }

    setFinishTagError(null);
    setFinishTagInfo(null);
    setIsBulkApplyingFinishTags(true);
    let successCount = 0;
    let failureCount = 0;

    for (const [clipId, tags] of draftedTagEntries) {
      markFinishTagClipSaving(clipId, true);
      try {
        await saveExternalClipTags(clipId, tags);
        setFinishTagDrafts((prev) => {
          const next = { ...prev };
          delete next[clipId];
          return next;
        });
        successCount += 1;
      } catch {
        failureCount += 1;
      } finally {
        markFinishTagClipSaving(clipId, false);
      }
    }

    if (failureCount > 0) {
      setFinishTagError(`Saved ${successCount} clip${successCount === 1 ? "" : "s"}, ${failureCount} failed.`);
    } else {
      setFinishTagInfo(`Saved ${successCount} clip${successCount === 1 ? "" : "s"}.`);
    }
    setIsBulkApplyingFinishTags(false);
  }, [
    draftedTagEntries,
    markFinishTagClipSaving,
    saveExternalClipTags,
  ]);

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
    <IntegrityProvider token={settings.hubspotToken}>
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
            onClick={openMiniMiki}
            title="Ask MiniMiki on Telegram (Shift-click for no screenshot)"
          >
            <Bot className="h-5 w-5" />
          </Button>
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

      <IntegrityAlertBanner onNavigate={() => setActivePage("data-integrity")} />

      {/* Sidebar + Content */}
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          activePage={activePage}
          onPageChange={setActivePage}
          collapsed={sidebarCollapsed}
          onToggleCollapse={handleToggleSidebar}
          onOpenChangelog={() => setChangelogOpen(true)}
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
                        onClick={() => setDownloadsLogOpen(true)}
                        size="sm"
                        variant="outline"
                        title="Downloads log (technical)"
                        className="cursor-pointer h-8 w-8 p-0"
                      >
                        <ScrollText className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        onClick={openFinishDialog}
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
                      uploadingClipIds={uploadingClipIds}
                      enqueueClipUpload={enqueueClipUpload}
                      downloadProgress={downloadProgress}
                    />
                  </TabErrorBoundary>
                </div>
              </Tabs>
            )}
          </div>

          {/* ── Data integrity page ── */}
          <div className={`flex flex-1 flex-col overflow-hidden ${activePage === "data-integrity" ? "" : "hidden"}`}>
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
              <div className="flex-1 overflow-hidden">
                <TabErrorBoundary name="Data integrity">
                  <DataIntegrityPage
                    isActive={activePage === "data-integrity"}
                    settings={settings}
                  />
                </TabErrorBoundary>
              </div>
            )}
          </div>

          {/* ── Duplicates page ── */}
          <div className={`flex flex-1 flex-col overflow-hidden ${activePage === "duplicates" ? "" : "hidden"}`}>
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
            ) : !isSupabaseConfigured ? (
              <div className="flex flex-1 items-center justify-center">
                <div className="max-w-md text-center">
                  <p className="mb-2 text-muted-foreground">
                    Set up Supabase to use the Duplicates page.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Presence indicators and resolution-status sync require
                    <code className="mx-1">VITE_SUPABASE_URL</code>
                    and
                    <code className="mx-1">VITE_SUPABASE_ANON_KEY</code>
                    in your environment.
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex-1 overflow-hidden">
                <TabErrorBoundary name="Duplicates">
                  <DuplicatesPage
                    isActive={activePage === "duplicates"}
                    settings={settings}
                  />
                </TabErrorBoundary>
              </div>
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

      <ChangelogDialog
        open={changelogOpen}
        onOpenChange={setChangelogOpen}
      />

      <DownloadsLogDialog
        open={downloadsLogOpen}
        onOpenChange={setDownloadsLogOpen}
        hubspotToken={settings.hubspotToken}
      />

      {/* Finish Video Dialog */}
      <Dialog
        open={finishDialogOpen}
        onOpenChange={(open) => {
          setFinishDialogOpen(open);
          if (!open) resetFinishTagEditor();
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[80vw]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              Finish Video
            </DialogTitle>
            <DialogDescription>
              {finishPhase === "tagPrecheck"
                ? (
                    <>
                      We found <strong>{emptyTagClips.length}</strong> clip
                      {emptyTagClips.length !== 1 ? "s" : ""} in this project with empty <strong>Tags</strong>.
                      Fill them now, or skip.
                    </>
                  )
                : finishPhase === "confirm"
                ? <>Finalize <strong>{project?.name}</strong> with {arrangeStats?.count} clips.</>
                : stepStatuses.every((s) => s === "done" || s === "error")
                  ? stepStatuses.every((s) => s === "done")
                    ? "All done! Your video project is ready."
                    : "Finished with some errors."
                  : "Processing..."}
            </DialogDescription>
          </DialogHeader>

          {finishPhase === "tagPrecheck" ? (
            <div className="space-y-3 text-sm">
              <div className="flex items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-800">
                  <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
                  {emptyTagClips.length} clip{emptyTagClips.length !== 1 ? "s" : ""} missing Tags
                </p>
                <div className="flex items-center gap-2">
                  <div className="w-56">
                    <TagPicker
                      options={appTagOptions}
                      selected={finishApplyAllTags}
                      onChange={setFinishApplyAllTags}
                      hideBadges
                    />
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={stageTagsForAllEmptyClips}
                    disabled={
                      isBulkApplyingFinishTags ||
                      finishApplyAllTags.length === 0 ||
                      emptyTagClips.length === 0
                    }
                    className="cursor-pointer h-7 px-3 text-xs"
                  >
                    Apply to all
                  </Button>
                </div>
              </div>

              {finishTagInfo && (
                <p className="text-xs text-emerald-700">{finishTagInfo}</p>
              )}
              {finishTagError && (
                <p className="text-xs text-destructive">{finishTagError}</p>
              )}

              {emptyTagClips.length === 0 ? (
                <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-700">
                  All clips in this project have tags.
                </div>
              ) : (
                <div className="space-y-2">
                  {emptyTagClips.map((clip) => (
                    <ClipTagEditorRow
                      key={clip.hubspotId}
                      clip={clip}
                      tagOptions={appTagOptions}
                      selected={finishTagDrafts[clip.hubspotId] ?? []}
                      onChange={(values) =>
                        setFinishTagDrafts((prev) => ({ ...prev, [clip.hubspotId]: values }))
                      }
                      isSaving={savingFinishTagClipIds.has(clip.hubspotId)}
                      hubspotRecordUrl={`https://app-eu1.hubspot.com/contacts/146859718/record/2-192287471/${clip.hubspotId}`}
                    />
                  ))}
                </div>
              )}
            </div>
          ) : finishPhase === "confirm" ? (
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
            {finishPhase === "tagPrecheck" ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setFinishPhase("confirm");
                    setFinishTagInfo(null);
                    setFinishTagError(null);
                  }}
                  disabled={isBulkApplyingFinishTags}
                  className="cursor-pointer text-xs text-muted-foreground hover:text-foreground"
                >
                  Skip
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setFinishDialogOpen(false)}
                  disabled={isBulkApplyingFinishTags}
                  className="cursor-pointer"
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => void commitDraftedTags()}
                  disabled={!hasUncommittedDrafts || isBulkApplyingFinishTags}
                  className="gap-1.5 cursor-pointer"
                >
                  {isBulkApplyingFinishTags ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    "Save"
                  )}
                </Button>
              </>
            ) : finishPhase === "confirm" ? (
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
                    resetFinishTagEditor();
                    setFinishPhase(getInitialFinishPhase(projectRef.current));
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
    </IntegrityProvider>
  );
}

export default App;
