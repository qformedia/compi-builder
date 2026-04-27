import { useState, useRef, useEffect, useCallback } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, CheckCircle, StickyNote, Download, FolderOpen, Loader2, Trash2, Maximize2, Minimize2, ImageIcon, RefreshCw, AlertTriangle, CheckCircle2, Copy, ClipboardCheck, CloudUpload, Cloud, Film, ChevronDown } from "lucide-react";
import { MediaPlayer, MediaProvider, type MediaPlayerInstance } from "@vidstack/react";
import { defaultLayoutIcons, DefaultVideoLayout } from "@vidstack/react/player/layouts/default";
import "@vidstack/react/player/styles/default/theme.css";
import "@vidstack/react/player/styles/default/layouts/video.css";
import { ClipCard, SCORE_COLORS, getPlatform, getNonVideoUrlWarning, PlatformIcon, HubSpotIcon } from "@/components/ClipCard";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { isSupabaseConfigured, reportDownloadIssue } from "@/lib/supabase";
import { resolveClipPath, DEFAULT_DOWNLOAD_PROVIDERS } from "@/types";
import type { AppSettings, Project, ProjectClip } from "@/types";
import type { ClipCardData } from "@/components/ClipCard";

interface Props {
  settings: AppSettings;
  project: Project | null;
  setProject: (p: Project | null) => void;
  isActive: boolean;
  removeClip?: (hubspotId: string) => void;
  thumbWidth?: number;
  /** When true, the player will not autoplay even if the clip key changes.
   *  Used to prevent unwanted playback when Finish Video renames localFiles. */
  suppressAutoPlay?: boolean;
  /** Clips currently queued or uploading to HubSpot. Drives the per-clip
   *  "Uploading…" loader so users can tell auto-upload is in progress. */
  uploadingClipIds?: Set<string>;
  /** Force-trigger a HubSpot upload for a clip (resets retry budget and
   *  routes through the central upload queue in App.tsx). */
  enqueueClipUpload?: (clipId: string) => void;
}

function Tip({ label, children }: { label: string; children: React.ReactNode }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={(e) => setPos({ x: e.clientX, y: e.clientY })}
      onMouseMove={(e) => setPos({ x: e.clientX, y: e.clientY })}
      onMouseLeave={() => setPos(null)}
    >
      {children}
      {pos && (
        <span
          className="fixed z-[9999] pointer-events-none -translate-x-1/2 rounded bg-foreground px-2 py-0.5 text-[10px] text-background whitespace-nowrap shadow-lg"
          style={{ left: pos.x, top: pos.y + 20 }}
        >
          {label}
        </span>
      )}
    </span>
  );
}

export function encodeEditingNotes(clips: ProjectClip[]): string {
  const map: Record<string, string> = {};
  for (const c of clips) {
    if (c.editingNotes?.trim()) map[c.hubspotId] = c.editingNotes.trim();
  }
  return JSON.stringify(map);
}

export function decodeEditingNotes(raw: string): Record<string, string> {
  try { return JSON.parse(raw) ?? {}; }
  catch { return {}; }
}

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
    fetchedThumbnail: clip.fetchedThumbnail,
    editingNotes: clip.editingNotes,
    localFile: clip.localFile,
    originalClip: clip.originalClip,
  };
}

const THUMB_DEFAULT = 110;

function getClipDuration(clip: ProjectClip): number {
  return clip.editedDuration ?? clip.localDuration ?? 0;
}

const LEFT_MIN = 180;
const LEFT_MAX = 560;
const LEFT_DEFAULT = 288;

export function ArrangeTab({ settings, project, setProject, isActive, removeClip, thumbWidth = THUMB_DEFAULT, suppressAutoPlay = false, uploadingClipIds, enqueueClipUpload }: Props) {
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const playerRef = useRef<MediaPlayerInstance>(null);
  const thumbCache = useRef(new Map<string, string | null>());
  const [cinemaMode, setCinemaMode] = useState(false);
  const [reportedClipId, setReportedClipId] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [scoreOpen, setScoreOpen] = useState(false);
  const [leftWidth, setLeftWidth] = useState(LEFT_DEFAULT);
  const isDraggingDivider = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(LEFT_DEFAULT);

  const onDividerMouseDown = useCallback((e: React.MouseEvent) => {
    isDraggingDivider.current = true;
    dragStartX.current = e.clientX;
    dragStartWidth.current = leftWidth;
    e.preventDefault();
  }, [leftWidth]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDraggingDivider.current) return;
      const delta = e.clientX - dragStartX.current;
      setLeftWidth(Math.min(LEFT_MAX, Math.max(LEFT_MIN, dragStartWidth.current + delta)));
    };
    const onMouseUp = () => { isDraggingDivider.current = false; };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  // Remove clip confirmation
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const skipConfirmRef = useRef(false);

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

  const [thumbModalOpen, setThumbModalOpen] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  // Pause video when leaving the tab
  useEffect(() => {
    if (!isActive && playerRef.current) {
      playerRef.current.pause();
    }
  }, [isActive]);

  // Pause the inline player before cinema mode mounts its own instance,
  // preventing two <video> elements from playing audio simultaneously.
  useEffect(() => {
    if (cinemaMode && playerRef.current) {
      playerRef.current.pause();
    }
  }, [cinemaMode]);

  const allClips = project?.clips ?? [];

  const selectedClip = allClips.find(
    (c) => c.hubspotId === selectedClipId,
  ) ?? allClips[0] ?? null;

  const selectedIndex = selectedClip
    ? allClips.findIndex((c) => c.hubspotId === selectedClip.hubspotId)
    : -1;

  const isPlayable = (c: ProjectClip) => c.downloadStatus === "complete" && !!c.localFile;

  // Track whether the user is editing notes (suppress autoplay-next)
  const notesActiveRef = useRef(false);

  const handleNextClip = useCallback(() => {
    if (!selectedClip || notesActiveRef.current) return;
    const currentIndex = allClips.findIndex(
      (c) => c.hubspotId === selectedClip.hubspotId,
    );
    for (let i = currentIndex + 1; i < allClips.length; i++) {
      if (isPlayable(allClips[i])) {
        setSelectedClipId(allClips[i].hubspotId);
        return;
      }
    }
  }, [allClips, selectedClip]);

  // Editing notes: local state synced from selected clip, debounced save
  const [notesText, setNotesText] = useState("");
  const [notesSaved, setNotesSaved] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync local notes text when selected clip changes
  useEffect(() => {
    setNotesText(selectedClip?.editingNotes ?? "");
    setNotesSaved(false);
    setThumbModalOpen(false);
  }, [selectedClip?.hubspotId]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveNotes = useCallback((clipId: string, text: string) => {
    if (!project) return;
    const updatedClips = project.clips.map((c) =>
      c.hubspotId === clipId ? { ...c, editingNotes: text || undefined } : c,
    );
    const updated = { ...project, clips: updatedClips };
    setProject(updated);
    invoke("save_project_data", {
      rootFolder: settings.rootFolder,
      project: updated,
    }).catch(() => {});
    if (project.hubspotVideoProjectId && settings.hubspotToken) {
      invoke("update_video_project_property", {
        token: settings.hubspotToken,
        projectId: project.hubspotVideoProjectId,
        propertyName: "editing_notes",
        propertyValue: encodeEditingNotes(updatedClips),
      }).catch((e) => console.warn("Editing notes sync failed:", e));
    }
    setNotesSaved(true);
  }, [project, setProject, settings.rootFolder, settings.hubspotToken]);

  const handleNotesChange = useCallback((text: string) => {
    setNotesText(text);
    setNotesSaved(false);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    if (!selectedClip) return;
    const clipId = selectedClip.hubspotId;
    saveTimerRef.current = setTimeout(() => saveNotes(clipId, text), 800);
  }, [selectedClip, saveNotes]);

  const handleNotesBlur = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    if (!selectedClip) return;
    saveNotes(selectedClip.hubspotId, notesText);
    notesActiveRef.current = false;
  }, [selectedClip, notesText, saveNotes]);

  // Helper to update a clip field locally + save project
  const updateClipField = useCallback((clipId: string, fields: Partial<ProjectClip>) => {
    if (!project) return;
    const updatedClips = project.clips.map((c) =>
      c.hubspotId === clipId ? { ...c, ...fields } : c,
    );
    const updated = { ...project, clips: updatedClips };
    setProject(updated);
    invoke("save_project_data", {
      rootFolder: settings.rootFolder,
      project: updated,
    }).catch(() => {});
  }, [project, setProject, settings.rootFolder]);

  const applyThumbnail = useCallback(async (clipId: string, imageUrl: string) => {
    updateClipField(clipId, { fetchedThumbnail: imageUrl });
    setThumbModalOpen(false);
    if (!settings.hubspotToken) return;

    try {
      let hubspotUrl: string;

      if (imageUrl.startsWith("data:")) {
        const match = imageUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
        if (!match) return;
        hubspotUrl = await invoke<string>("upload_clip_thumbnail_base64", {
          token: settings.hubspotToken,
          clipId,
          base64Data: match[2],
          mimeType: match[1],
        });
      } else if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://")) {
        if (imageUrl.includes("asset.localhost") || imageUrl.includes("localhost")) {
          return;
        }
        hubspotUrl = await invoke<string>("upload_clip_thumbnail", {
          token: settings.hubspotToken,
          clipId,
          thumbnailUrl: imageUrl,
        });
      } else {
        return;
      }

      updateClipField(clipId, { fetchedThumbnail: hubspotUrl });
    } catch (e) {
      console.warn("HubSpot thumbnail upload failed:", e);
    }
  }, [updateClipField, settings.hubspotToken]);

  // Update a HubSpot property and local state in one call
  const updateHubSpotField = useCallback((
    clipId: string,
    propertyName: string,
    propertyValue: string,
    localFields: Partial<ProjectClip>,
  ) => {
    updateClipField(clipId, localFields);
    if (settings.hubspotToken) {
      invoke("update_clip_property", {
        token: settings.hubspotToken,
        clipId,
        propertyName,
        propertyValue,
      }).catch((e) => console.warn("HubSpot update failed:", e));
    }
  }, [updateClipField, settings.hubspotToken]);

  const downloadClip = useCallback(async (clip: ProjectClip, force = false) => {
    if (!project) return;
    const isRetry = force || clip.downloadStatus === "failed";
    const updates: Partial<ProjectClip> = {
      retryCount: (clip.retryCount ?? 0) + (isRetry ? 1 : 0),
    };
    if (force) {
      updates.downloadStatus = "pending";
      updates.localFile = undefined;
      updates.localDuration = undefined;
    }
    updateClipField(clip.hubspotId, updates);
    try {
      await invoke("download_clip", {
        rootFolder: settings.rootFolder,
        projectName: project.name,
        clipId: clip.hubspotId,
        url: clip.link,
        cookiesBrowser: settings.cookiesBrowser || null,
        cookiesFile: settings.cookiesFile || null,
        force,
        evil0ctalApiUrl: settings.evil0ctalApiUrl || null,
        downloadProviders: JSON.stringify(settings.downloadProviders ?? DEFAULT_DOWNLOAD_PROVIDERS),
      });
    } catch { /* handled via event listener */ }
  }, [project, settings, updateClipField]);

  const importClipFile = useCallback(async (clip: ProjectClip) => {
    if (!project) return;
    try {
      const filePath = await openFileDialog({
        title: "Select video file to import",
        filters: [{ name: "Video", extensions: ["mp4", "webm", "mkv", "mov", "avi", "flv"] }],
      });
      if (!filePath) return;
      const result = await invoke<{ localFile: string; localDuration: number | null }>(
        "import_clip_file",
        {
          rootFolder: settings.rootFolder,
          projectName: project.name,
          clipId: clip.hubspotId,
          sourcePath: filePath,
        },
      );
      const updatedClips = project.clips.map((c) => {
        if (c.hubspotId !== clip.hubspotId) return c;
        return {
          ...c,
          downloadStatus: "complete" as const,
          localFile: result.localFile,
          localDuration: result.localDuration ?? undefined,
          downloadError: undefined,
        };
      });
      const updated = { ...project, clips: updatedClips };
      setProject(updated);
      invoke("save_project_data", {
        rootFolder: settings.rootFolder,
        project: updated,
      }).catch(() => {});
      // The new clip state (downloadStatus: complete + localFile set) is
      // picked up by the central upload effect in App.tsx, which queues the
      // upload through the shared HubSpot upload pipeline.
    } catch (e) {
      console.error("Import failed:", e);
    }
  }, [project, settings, setProject]);

  const handleReportIssue = useCallback(async (clip: ProjectClip) => {
    if (!isSupabaseConfigured || reporting) return;
    setReporting(true);
    try {
      await reportDownloadIssue({
        clipId: clip.hubspotId,
        clipUrl: clip.link,
        platform: getPlatform(clip.link),
        downloadStatus: clip.downloadStatus,
        localFile: clip.localFile,
        downloadError: clip.downloadError,
        retryCount: clip.retryCount ?? 0,
      });
      setReportedClipId(clip.hubspotId);
      setTimeout(() => setReportedClipId(null), 3000);
    } catch (e) {
      console.error("Report failed:", e);
    } finally {
      setReporting(false);
    }
  }, [reporting]);

  // Force-retry an upload via the central queue in App.tsx. Sharing the queue
  // means the same loader UI applies whether the upload was kicked off
  // automatically (post-download) or manually by clicking the orange button,
  // and avoids the double-upload race that direct invoke would create.
  const uploadClipToHubSpot = useCallback((clip: ProjectClip) => {
    if (!settings.hubspotToken || !clip.localFile || clip.originalClip) return;
    enqueueClipUpload?.(clip.hubspotId);
  }, [settings.hubspotToken, enqueueClipUpload]);

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <p>Open a project in the Search tab first.</p>
      </div>
    );
  }

  if (allClips.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <p>No clips yet. Add clips in the Search tab.</p>
      </div>
    );
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = allClips.findIndex(
      (c) => c.hubspotId === active.id,
    );
    const newIndex = allClips.findIndex(
      (c) => c.hubspotId === over.id,
    );
    const reordered = arrayMove(allClips, oldIndex, newIndex)
      .map((c, i) => ({ ...c, order: i }));

    const updated = { ...project, clips: reordered };
    setProject(updated);
    invoke("save_project_data", {
      rootFolder: settings.rootFolder,
      project: updated,
    }).catch(() => {});

    if (project.hubspotVideoProjectId && settings.hubspotToken) {
      invoke("update_video_project_property", {
        token: settings.hubspotToken,
        projectId: project.hubspotVideoProjectId,
        propertyName: "clips_order",
        propertyValue: JSON.stringify(reordered.map((c) => c.hubspotId)),
      }).catch((e) => console.warn("Order sync failed:", e));
    }
  };

  const formatDuration = (s?: number) => {
    if (s == null) return "—";
    const m = Math.floor(s / 60);
    const sec = Math.round(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  // Pre-compute cumulative durations for minute markers
  const cumulativeDurations: number[] = [];
  {
    let acc = 0;
    for (const clip of allClips) {
      acc += getClipDuration(clip);
      cumulativeDurations.push(acc);
    }
  }

  const getMinuteMarker = (index: number): number | null => {
    const prevEnd = index > 0 ? cumulativeDurations[index - 1] : 0;
    const curEnd = cumulativeDurations[index];
    const prevMinute = Math.floor(prevEnd / 60);
    const curMinute = Math.floor(curEnd / 60);
    if (curMinute > prevMinute && curEnd > 0) return curMinute;
    return null;
  };

  const handleMoveToPosition = (clipId: string, targetPos: number) => {
    const currentIndex = allClips.findIndex((c) => c.hubspotId === clipId);
    if (currentIndex < 0) return;
    const clampedTarget = Math.max(0, Math.min(allClips.length - 1, targetPos - 1));
    if (clampedTarget === currentIndex) return;
    const reordered = arrayMove(allClips, currentIndex, clampedTarget)
      .map((c, i) => ({ ...c, order: i }));
    const updated = { ...project, clips: reordered };
    setProject(updated);

    if (project.hubspotVideoProjectId && settings.hubspotToken) {
      invoke("update_video_project_property", {
        token: settings.hubspotToken,
        projectId: project.hubspotVideoProjectId,
        propertyName: "clips_order",
        propertyValue: JSON.stringify(reordered.map((c) => c.hubspotId)),
      }).catch((e) => console.warn("Order sync failed:", e));
    }

    invoke("save_project_data", {
      rootFolder: settings.rootFolder,
      project: updated,
    }).catch(() => {});
  };

  // Player content (shared between normal and cinema mode)
  const playerContent = selectedClip && isPlayable(selectedClip) ? (
    <>
      <MediaPlayer
        ref={playerRef}
        key={selectedClip.localFile}
        src={convertFileSrc(resolveClipPath(settings.rootFolder, project.name, selectedClip.localFile!), "localfile")}
        autoPlay={isActive && !suppressAutoPlay}
        onEnded={handleNextClip}
        onError={(detail) => {
          const msg = detail instanceof Event
            ? (detail as any)?.detail?.message ?? "Unknown playback error"
            : String(detail);
          console.error("Player error:", msg);
          setPlayerError(String(msg));
        }}
        onCanPlay={() => setPlayerError(null)}
        keyTarget="document"
        className="absolute inset-0 !w-full !h-full [&_video]:!absolute [&_video]:!inset-0 [&_video]:!w-full [&_video]:!h-full [&_video]:!object-contain"
      >
        <MediaProvider />
        <DefaultVideoLayout icons={defaultLayoutIcons} seekStep={5} slots={{ pipButton: null, fullscreenButton: null }} />
      </MediaPlayer>
      {playerError && (
        <div className="absolute bottom-12 left-2 right-2 rounded bg-destructive/90 px-3 py-2 text-xs text-white">
          <p className="font-medium">Playback error</p>
          <p className="mt-0.5 opacity-80 break-all">{playerError}</p>
        </div>
      )}
    </>
  ) : selectedClip ? (
    <div className="flex h-full flex-col items-center justify-center gap-3">
      {selectedClip.downloadStatus === "downloading" ? (
        <>
          <Loader2 className="h-6 w-6 animate-spin text-white/40" />
          <p className="text-sm text-white/40">Downloading...</p>
        </>
      ) : selectedClip.downloadStatus === "failed" ? (
        <p className="text-sm text-white/40">Download failed — use the buttons below to retry</p>
      ) : (
        <p className="text-sm text-white/40">Clip not downloaded yet</p>
      )}
    </div>
  ) : (
    <div className="flex h-full items-center justify-center">
      <p className="text-sm text-white/40">Select a clip to preview</p>
    </div>
  );

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Left column: Player + Metadata ── */}
      <div className="flex flex-shrink-0 flex-col pr-2" style={{ width: leftWidth }}>
        {/* Video player — hidden (not unmounted) while cinema mode is active so
            the cinema overlay is the sole live <video> element. */}
        <div className="relative aspect-[9/16] w-full rounded-lg bg-black overflow-hidden flex-shrink-0">
          {!cinemaMode && playerContent}
          {selectedClip && (
            <span className="absolute top-2 left-2 z-10 rounded-lg bg-black/60 px-3 py-1 text-2xl font-black text-white tabular-nums">
              #{selectedIndex + 1}
            </span>
          )}
          <button
            onClick={() => setCinemaMode(!cinemaMode)}
            className="absolute top-1.5 right-1.5 z-10 rounded-full bg-black/60 p-1 text-white hover:bg-black/80 cursor-pointer transition-colors"
            title={cinemaMode ? "Exit cinema mode" : "Cinema mode (16:9)"}
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Below-player panel */}
        {selectedClip && (() => {
          const ds = selectedClip.downloadStatus;
          const platform = getPlatform(selectedClip.link);
          const isChinese = ["Douyin", "Bilibili", "Xiaohongshu", "Kuaishou"].includes(platform);
          const retried = (selectedClip.retryCount ?? 0) >= 1;
          const urlWarning = getNonVideoUrlWarning(selectedClip.link);
          const iconBtn = "flex items-center justify-center rounded p-1.5 text-muted-foreground hover:bg-muted cursor-pointer transition-colors";

          return (
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">

              {/* Warning / error messages */}
              {(urlWarning || ds === "failed") && (
                <div className="flex flex-col gap-0.5 px-2 pt-1">
                  {urlWarning && (
                    <p className="flex items-center gap-1 text-[10px] text-orange-600 leading-snug">
                      <AlertTriangle className="h-3 w-3 flex-shrink-0" /> {urlWarning}
                    </p>
                  )}
                  {ds === "failed" && (
                    <p className="text-[10px] text-destructive leading-snug">
                      {selectedClip.downloadError ?? "Download failed"}
                    </p>
                  )}
                </div>
              )}

              {/* Row 1: Icon-only action toolbar */}
              <div className="flex items-center gap-0.5 border-b px-1.5 py-1 flex-wrap">
                {ds === "downloading" ? (
                  <span className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Downloading...
                  </span>
                ) : ds === "failed" ? (
                  <Tip label="Retry download"><button onClick={() => downloadClip(selectedClip)} className={iconBtn} title="Retry download">
                    <RefreshCw className="h-3.5 w-3.5" />
                  </button></Tip>
                ) : isPlayable(selectedClip) ? (
                  <Tip label="Re-download"><button onClick={() => downloadClip(selectedClip, true)} className={iconBtn} title="Re-download">
                    <RefreshCw className="h-3.5 w-3.5" />
                  </button></Tip>
                ) : (
                  <Tip label="Download"><button onClick={() => downloadClip(selectedClip)} className={iconBtn} title="Download">
                    <Download className="h-3.5 w-3.5" />
                  </button></Tip>
                )}

                <Tip label="Replace video with local file"><button onClick={() => importClipFile(selectedClip)} className={iconBtn} title="Replace video with local file">
                  <Film className="h-3.5 w-3.5" />
                </button></Tip>

                <Tip label="Change thumbnail"><button onClick={() => setThumbModalOpen(true)} className={iconBtn}>
                  <ImageIcon className="h-3.5 w-3.5" />
                </button></Tip>

                {ds === "complete" && selectedClip.localFile && settings.hubspotToken && (
                  selectedClip.originalClip ? (
                    <Tip label="Video synced to HubSpot"><span className="flex items-center justify-center rounded p-1.5 text-green-600">
                      <Cloud className="h-3.5 w-3.5" />
                    </span></Tip>
                  ) : uploadingClipIds?.has(selectedClip.hubspotId) ? (
                    <Tip label="Uploading to HubSpot..."><span className="flex items-center justify-center rounded p-1.5 text-blue-500" title="Uploading to HubSpot...">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    </span></Tip>
                  ) : (
                    <Tip label="Upload to HubSpot"><button onClick={() => uploadClipToHubSpot(selectedClip)} className={`${iconBtn} text-orange-500 hover:text-orange-600`} title="Upload to HubSpot">
                      <CloudUpload className="h-3.5 w-3.5" />
                    </button></Tip>
                  )
                )}

                <Tip label="Copy link">
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(selectedClip.link).then(() => {
                      setCopiedLink(true);
                      setTimeout(() => setCopiedLink(false), 2000);
                    });
                  }}
                  className={iconBtn}
                >
                  {copiedLink ? <ClipboardCheck className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
                </Tip>

                {removeClip && (
                  <Tip label="Remove clip"><button
                    onClick={() => {
                      if (skipConfirmRef.current) {
                        removeClip(selectedClip.hubspotId);
                        const next = allClips.find((c) => c.hubspotId !== selectedClip.hubspotId);
                        setSelectedClipId(next?.hubspotId ?? null);
                      } else {
                        setRemoveTarget(selectedClip.hubspotId);
                      }
                    }}
                    className="flex items-center justify-center rounded p-1.5 text-destructive hover:bg-destructive/10 cursor-pointer transition-colors"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button></Tip>
                )}

                {retried && isSupabaseConfigured && (
                  reportedClipId === selectedClip.hubspotId ? (
                    <Tip label="Issue reported"><span className="flex items-center justify-center rounded p-1.5 text-green-600">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    </span></Tip>
                  ) : (
                    <Tip label="Report issue"><button onClick={() => handleReportIssue(selectedClip)} disabled={reporting} className={`${iconBtn} disabled:opacity-50`} title="Report issue">
                      <AlertTriangle className="h-3.5 w-3.5" />
                    </button></Tip>
                  )
                )}

                {isChinese && (
                  <button onClick={() => openUrl("https://dy.kukutool.com/en")} className="flex items-center gap-0.5 rounded px-1.5 py-1 text-[10px] font-medium text-blue-600 hover:bg-blue-50 cursor-pointer transition-colors">
                    KuKuTool ↗
                  </button>
                )}
                {(platform === "Instagram" || platform === "TikTok") && ds === "failed" && (
                  <button onClick={() => openUrl("https://dy.kukutool.com/instagram-downloader")} className="flex items-center gap-0.5 rounded px-1.5 py-1 text-[10px] font-medium text-blue-600 hover:bg-blue-50 cursor-pointer transition-colors">
                    KuKuTool ↗
                  </button>
                )}
              </div>

              {/* Row 2: Links + Score */}
              <div className="flex items-center border-b px-2 py-1 text-[11px] gap-2">
                <button
                  onClick={() => openUrl(`https://app-eu1.hubspot.com/contacts/146859718/record/2-192287471/${selectedClip.hubspotId}`)}
                  className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
                >
                  <HubSpotIcon className="h-3 w-3" />
                  <span>HubSpot</span>
                </button>
                <span className="text-border">|</span>
                <button
                  onClick={() => {
                    let url = selectedClip.link;
                    if (url.includes("instagram.com")) url = url.replace(/\/reels?\//i, "/p/");
                    openUrl(url);
                  }}
                  className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
                >
                  <PlatformIcon platform={platform} className="h-3 w-3" />
                  <span>{platform}</span>
                </button>
                {/* Score — clickable badge with dropdown */}
                <div className="relative ml-auto">
                  <button
                    onClick={() => setScoreOpen(!scoreOpen)}
                    className={`flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-bold uppercase leading-none cursor-pointer transition-all ${
                      selectedClip.score
                        ? SCORE_COLORS[selectedClip.score as keyof typeof SCORE_COLORS] ?? "bg-muted text-muted-foreground"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {selectedClip.score || "Score"}
                    <ChevronDown className="h-2.5 w-2.5" />
                  </button>
                  {scoreOpen && (<>
                    <div className="fixed inset-0 z-40" onClick={() => setScoreOpen(false)} />
                    <div className="absolute right-0 top-full mt-1 z-50 flex gap-0.5 rounded-md border bg-background p-1 shadow-lg">
                      {(["XL", "L", "M", "S", "XS"] as const).map((s) => (
                        <button
                          key={s}
                          onClick={() => {
                            updateHubSpotField(selectedClip.hubspotId, "score", s, { score: s });
                            setScoreOpen(false);
                          }}
                          className={`rounded px-2 py-1 text-[10px] font-bold uppercase leading-none cursor-pointer transition-all ${
                            selectedClip.score === s
                              ? SCORE_COLORS[s]
                              : "bg-muted text-muted-foreground hover:bg-muted/80"
                          }`}
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  </>)}
                </div>
              </div>

              {/* Row 3: Creator + License badges */}
              <div className="flex items-center gap-2 px-3 pt-2 pb-1">
                <span className="truncate text-sm font-semibold flex-1 min-w-0">{selectedClip.creatorName}</span>
                <div className="flex items-center gap-1 flex-shrink-0 text-[10px]">
                  {selectedClip.creatorStatus && (
                    <span className={`rounded px-1.5 py-0.5 font-semibold ${
                      selectedClip.creatorStatus === "Granted"
                        ? "bg-green-100 text-green-700"
                        : "bg-muted text-muted-foreground"
                    }`}>
                      {selectedClip.creatorStatus}
                    </span>
                  )}
                  {selectedClip.licenseType && (
                    <span className={`rounded px-1.5 py-0.5 font-semibold ${
                      selectedClip.licenseType.toLowerCase() === "recurrent"
                        ? "bg-blue-100 text-blue-700"
                        : "bg-amber-100 text-amber-700"
                    }`}>
                      {selectedClip.licenseType}
                    </span>
                  )}
                </div>
              </div>

              {/* HubSpot notes (if any) */}
              {selectedClip.notes && (
                <p className="px-3 pb-1 text-[11px] text-muted-foreground italic leading-snug">
                  {selectedClip.notes}
                </p>
              )}

              {/* Row 4: Duration + Position */}
              <div className="border-t mx-3" />
              <div className="flex items-center gap-3 px-3 py-1.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-muted-foreground">Duration</span>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={selectedClip.editedDuration ?? ""}
                    placeholder={selectedClip.localDuration != null ? `${Math.round(selectedClip.localDuration)}` : "—"}
                    onChange={(e) => {
                      const val = e.target.value;
                      const num = val === "" ? undefined : Number(val);
                      updateClipField(selectedClip.hubspotId, { editedDuration: num });
                    }}
                    onBlur={(e) => {
                      const val = e.target.value;
                      const num = val === "" ? 0 : Number(val);
                      updateHubSpotField(
                        selectedClip.hubspotId,
                        "edited_duration",
                        String(num),
                        { editedDuration: num || undefined },
                      );
                    }}
                    className="w-12 rounded border bg-background px-1.5 py-0.5 text-[11px] text-center focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                  <span className="text-[10px] text-muted-foreground">/ {formatDuration(selectedClip.localDuration)}s</span>
                </div>
                <div className="flex items-center gap-1.5 ml-auto">
                  <span className="text-[10px] text-muted-foreground">Pos</span>
                  <input
                    type="number"
                    min={1}
                    max={allClips.length}
                    value={selectedIndex + 1}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      if (val >= 1 && val <= allClips.length) {
                        handleMoveToPosition(selectedClip.hubspotId, val);
                      }
                    }}
                    className="w-10 rounded border bg-background px-1 py-0.5 text-[11px] text-center focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                  <span className="text-[10px] text-muted-foreground">/ {allClips.length}</span>
                </div>
              </div>

              <div className="border-t mx-3" />

              {/* Editing notes — fills remaining space */}
              <div className="flex flex-1 flex-col gap-1 px-3 pt-2 pb-3 min-h-0">
                <label className="flex items-center gap-1.5 text-[11px] font-semibold">
                  <StickyNote className="h-3.5 w-3.5" />
                  Editing Notes
                </label>
                <textarea
                  value={notesText}
                  onChange={(e) => handleNotesChange(e.target.value)}
                  onFocus={() => { notesActiveRef.current = true; }}
                  onBlur={handleNotesBlur}
                  placeholder="Trim, transitions, effects..."
                  className="flex-1 min-h-[4rem] resize-none rounded-md border bg-background px-2.5 py-2 text-sm leading-snug placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
                />
                {notesSaved && (
                  <span className="flex items-center gap-1 text-[11px] text-green-600">
                    <CheckCircle className="h-3 w-3" /> Saved
                  </span>
                )}
              </div>
            </div>
          );
        })()}
      </div>

      {/* ── Resizable divider ── */}
      <div
        onMouseDown={onDividerMouseDown}
        className="w-1 flex-shrink-0 cursor-col-resize bg-border hover:bg-primary/40 active:bg-primary/60 transition-colors"
        title="Drag to resize"
      />

      {/* ── Right column: Clip grid ── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Sortable clip grid */}
        <div className="flex-1 overflow-y-auto p-2">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={allClips.map((c) => c.hubspotId)}
              strategy={rectSortingStrategy}
            >
              <div
                className="grid gap-2"
                style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${thumbWidth}px, 1fr))` }}
              >
                {allClips.map((clip, index) => {
                  const minuteMarker = getMinuteMarker(index);
                  return (
                    <SortableCard
                      key={clip.hubspotId}
                      clip={clip}
                      index={index}
                      isSelected={clip.hubspotId === selectedClip?.hubspotId}
                      onSelect={() => setSelectedClipId(clip.hubspotId)}
                      thumbCache={thumbCache}
                      cookiesBrowser={settings.cookiesBrowser}
                      cookiesFile={settings.cookiesFile}
                      evil0ctalApiUrl={settings.evil0ctalApiUrl}
                      rootFolder={settings.rootFolder}
                      projectName={project?.name}
                      thumbRetryKey={thumbRetryKey}
                      hubspotToken={settings.hubspotToken}
                      minuteMarker={minuteMarker}
                    />
                  );
                })}
              </div>
            </SortableContext>
          </DndContext>
        </div>
      </div>

      {/* Cinema mode overlay */}
      {cinemaMode && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90"
          onClick={() => setCinemaMode(false)}
        >
          <div
            className="relative w-[90vw] max-w-[1280px] aspect-video rounded-lg bg-black overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {playerContent}
            <button
              onClick={() => setCinemaMode(false)}
              className="absolute top-3 right-3 z-10 rounded-full bg-black/60 p-1.5 text-white hover:bg-black/80 cursor-pointer transition-colors"
              title="Exit cinema mode"
            >
              <Minimize2 className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* Change thumbnail modal */}
      <Dialog open={thumbModalOpen} onOpenChange={setThumbModalOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Change thumbnail</DialogTitle>
            <DialogDescription>
              Paste an image (Ctrl+V / Cmd+V) or pick a file.
            </DialogDescription>
          </DialogHeader>
          <ThumbDropZone
            onImage={(dataUrl) => {
              if (selectedClip) applyThumbnail(selectedClip.hubspotId, dataUrl);
            }}
            onPickFile={async () => {
              const path = await openFileDialog({
                title: "Select thumbnail image",
                filters: [{ name: "Image", extensions: ["jpg", "jpeg", "png", "webp", "gif"] }],
              });
              if (!path || !selectedClip) return;
              const [b64, mime] = await invoke<[string, string]>("read_file_base64", { path });
              const dataUrl = `data:${mime};base64,${b64}`;
              applyThumbnail(selectedClip.hubspotId, dataUrl);
            }}
          />
        </DialogContent>
      </Dialog>

      {/* Remove clip confirmation dialog */}
      <Dialog open={removeTarget !== null} onOpenChange={(open) => { if (!open) setRemoveTarget(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove clip?</DialogTitle>
            <DialogDescription>
              This will remove the clip from the project and disassociate it from the HubSpot Video Project.
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              className="rounded"
              onChange={(e) => { skipConfirmRef.current = e.target.checked; }}
            />
            Don't ask me again this session
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveTarget(null)} className="cursor-pointer">
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="cursor-pointer"
              onClick={() => {
                if (removeTarget && removeClip) {
                  removeClip(removeTarget);
                  const next = allClips.find((c) => c.hubspotId !== removeTarget);
                  setSelectedClipId(next?.hubspotId ?? null);
                }
                setRemoveTarget(null);
              }}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// ── Sortable card wrapper ────────────────────────────────────────────────────

function SortableCard({
  clip,
  index,
  isSelected,
  onSelect,
  thumbCache,
  cookiesBrowser,
  cookiesFile,
  evil0ctalApiUrl,
  rootFolder,
  projectName,
  thumbRetryKey,
  hubspotToken,
  minuteMarker,
}: {
  clip: ProjectClip;
  index: number;
  isSelected: boolean;
  onSelect: () => void;
  thumbCache: React.RefObject<Map<string, string | null>>;
  cookiesBrowser: string;
  cookiesFile: string;
  evil0ctalApiUrl?: string;
  rootFolder?: string;
  projectName?: string;
  thumbRetryKey?: number;
  hubspotToken?: string;
  minuteMarker?: number | null;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: clip.hubspotId });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const hasMarker = minuteMarker != null;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`relative overflow-hidden rounded-lg cursor-grab touch-none [&_*]:!cursor-grab
        ${isSelected
          ? "border-2 border-green-500"
          : "border border-border"
        }`}
      onClick={onSelect}
      {...attributes}
      {...listeners}
    >
      {/* Top bar: order number + optional minute marker + drag icon */}
      <div className={`flex items-center border-b px-1.5 py-0.5 ${hasMarker ? "bg-sky-500" : "bg-muted/50"}`}>
        <span className={`text-[10px] font-bold flex-shrink-0 ${hasMarker ? "text-white/70" : "text-muted-foreground"}`}>#{index + 1}</span>
        {hasMarker && (
          <span className="flex-1 text-center text-[10px] font-black text-white">{minuteMarker}:00</span>
        )}
        {!hasMarker && <span className="flex-1" />}
        <GripVertical className={`h-3 w-3 flex-shrink-0 ${hasMarker ? "text-white/60" : "text-muted-foreground"}`} />
      </div>

      <ClipCard
        clip={toCardData(clip)}
        thumbCache={thumbCache}
        cookiesBrowser={cookiesBrowser}
        cookiesFile={cookiesFile}
        evil0ctalApiUrl={evil0ctalApiUrl}
        rootFolder={rootFolder}
        projectName={projectName}
        compact
        thumbRetryKey={thumbRetryKey}
        hubspotToken={hubspotToken}
      />
    </div>
  );
}

// ── Thumbnail paste/drop zone for the modal ──────────────────────────────

function ThumbDropZone({
  onImage,
  onPickFile,
}: {
  onImage: (dataUrl: string) => void;
  onPickFile: () => void;
}) {
  const zoneRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const processFile = useCallback((file: File) => {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      setPreview(dataUrl);
      onImage(dataUrl);
    };
    reader.readAsDataURL(file);
  }, [onImage]);

  useEffect(() => {
    const el = zoneRef.current;
    if (!el) return;

    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (!item.type.startsWith("image/")) continue;
        const file = item.getAsFile();
        if (file) { processFile(file); e.preventDefault(); break; }
      }
    };

    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [processFile]);

  return (
    <div
      ref={zoneRef}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files[0];
        if (file) processFile(file);
      }}
      className={`flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-6 transition-colors ${
        dragging ? "border-primary bg-primary/5" : "border-muted-foreground/25"
      }`}
    >
      {preview ? (
        <img src={preview} alt="" className="max-h-32 rounded object-contain" />
      ) : (
        <p className="text-sm text-muted-foreground text-center">
          Paste an image here or drag &amp; drop
        </p>
      )}
      <Button variant="outline" size="sm" onClick={onPickFile} className="cursor-pointer">
        <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
        Pick file
      </Button>
    </div>
  );
}
