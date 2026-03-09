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
import { GripVertical, CheckCircle, StickyNote, Download, FolderOpen, Loader2, Trash2, Maximize2, Minimize2, ImageIcon, RefreshCw, AlertTriangle, CheckCircle2, Copy, ClipboardCheck } from "lucide-react";
import { MediaPlayer, MediaProvider, type MediaPlayerInstance } from "@vidstack/react";
import { defaultLayoutIcons, DefaultVideoLayout } from "@vidstack/react/player/layouts/default";
import "@vidstack/react/player/styles/default/theme.css";
import "@vidstack/react/player/styles/default/layouts/video.css";
import { ClipCard, SCORE_COLORS, getPlatform } from "@/components/ClipCard";
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
import { resolveClipPath } from "@/types";
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
  };
}

const THUMB_DEFAULT = 110;

function getClipDuration(clip: ProjectClip): number {
  return clip.editedDuration ?? clip.localDuration ?? 0;
}

const LEFT_MIN = 180;
const LEFT_MAX = 560;
const LEFT_DEFAULT = 288;

export function ArrangeTab({ settings, project, setProject, isActive, removeClip, thumbWidth = THUMB_DEFAULT, suppressAutoPlay = false }: Props) {
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const playerRef = useRef<MediaPlayerInstance>(null);
  const thumbCache = useRef(new Map<string, string | null>());
  const [cinemaMode, setCinemaMode] = useState(false);
  const [reportedClipId, setReportedClipId] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
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
    setNotesSaved(true);
  }, [project, setProject, settings.rootFolder]);

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
          <button
            onClick={() => setCinemaMode(!cinemaMode)}
            className="absolute top-1.5 right-1.5 z-10 rounded-full bg-black/60 p-1 text-white hover:bg-black/80 cursor-pointer transition-colors"
            title={cinemaMode ? "Exit cinema mode" : "Cinema mode (16:9)"}
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Clip action bar — single source of truth for all download actions */}
        {selectedClip && (() => {
          const ds = selectedClip.downloadStatus;
          const platform = getPlatform(selectedClip.link);
          const isChinese = ["Douyin", "Bilibili", "Xiaohongshu"].includes(platform);
          const isXiaohongshu = platform === "Xiaohongshu";
          const retried = (selectedClip.retryCount ?? 0) >= 1;
          const btnClass = "flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted cursor-pointer transition-colors";

          return (
            <div className="flex flex-col gap-0.5 border-b py-1">
              {/* Error message (failed clips only) */}
              {ds === "failed" && (
                <p className="px-2 text-[10px] text-destructive leading-snug">
                  {isXiaohongshu
                    ? "Xiaohongshu videos can't be auto-downloaded — import manually"
                    : (selectedClip.downloadError ?? "Download failed")}
                </p>
              )}

              {/* Action buttons row */}
              <div className="flex items-center gap-1 flex-wrap">
                {ds === "downloading" ? (
                  <span className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" /> Downloading...
                  </span>
                ) : ds === "failed" ? (
                  !isXiaohongshu && (
                    <button onClick={() => downloadClip(selectedClip)} className={btnClass} title="Retry download">
                      <RefreshCw className="h-3 w-3" /> Retry
                    </button>
                  )
                ) : isPlayable(selectedClip) ? (
                  <button onClick={() => downloadClip(selectedClip, true)} className={btnClass} title="Re-download clip">
                    <RefreshCw className="h-3 w-3" /> Re-download
                  </button>
                ) : (
                  <button onClick={() => downloadClip(selectedClip)} className={btnClass} title="Download clip">
                    <Download className="h-3 w-3" /> Download
                  </button>
                )}

                <button onClick={() => importClipFile(selectedClip)} className={btnClass} title="Import a local video file">
                  <FolderOpen className="h-3 w-3" /> Browse
                </button>

                {isChinese && (
                  <button onClick={() => openUrl("https://dy.kukutool.com/en")} className={`${btnClass} text-blue-600 hover:bg-blue-50`} title="Open KuKuTool for Chinese platform downloads">
                    KuKuTool ↗
                  </button>
                )}

                <button
                  onClick={() => {
                    navigator.clipboard.writeText(selectedClip.link).then(() => {
                      setCopiedLink(true);
                      setTimeout(() => setCopiedLink(false), 2000);
                    });
                  }}
                  className={btnClass}
                  title="Copy clip link"
                >
                  {copiedLink ? <ClipboardCheck className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3" />}
                </button>

                {retried && isSupabaseConfigured && (
                  reportedClipId === selectedClip.hubspotId ? (
                    <span className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] text-green-600">
                      <CheckCircle2 className="h-3 w-3" /> Reported
                    </span>
                  ) : (
                    <button onClick={() => handleReportIssue(selectedClip)} disabled={reporting} className={`${btnClass} disabled:opacity-50`} title="Report this download issue">
                      <AlertTriangle className="h-3 w-3" /> Report
                    </button>
                  )
                )}
              </div>
            </div>
          );
        })()}

        {/* Metadata panel below player */}
        {selectedClip && (
          <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3">
            {/* Clip header */}
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-muted-foreground">#{selectedIndex + 1}</span>
              <span className="truncate text-sm font-semibold">{selectedClip.creatorName}</span>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
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

            {selectedClip.notes && (
              <p className="text-[11px] text-muted-foreground italic leading-snug">
                {selectedClip.notes}
              </p>
            )}

            {/* Score — label + buttons on same row */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-semibold text-muted-foreground flex-shrink-0">Score</span>
              {(["XL", "L", "M", "S", "XS"] as const).map((s) => {
                const active = selectedClip.score === s;
                return (
                  <button
                    key={s}
                    onClick={() => {
                      updateHubSpotField(selectedClip.hubspotId, "score", s, { score: s });
                    }}
                    className={`rounded px-2 py-0.5 text-[11px] font-bold uppercase leading-none cursor-pointer transition-all ${
                      active
                        ? SCORE_COLORS[s]
                        : "bg-muted text-muted-foreground hover:bg-muted/80"
                    }`}
                  >
                    {s}
                  </button>
                );
              })}
            </div>

            {/* Duration + Position — same row */}
            <div className="flex items-end gap-3">
              <div className="flex flex-col gap-0.5">
                <label className="text-[11px] font-semibold text-muted-foreground whitespace-nowrap">
                  Duration (s)
                </label>
                <div className="flex items-center gap-1">
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
                    className="w-16 rounded-md border bg-background px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                  <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                    /{formatDuration(selectedClip.localDuration)}
                  </span>
                </div>
              </div>
              <div className="flex flex-col gap-0.5">
                <label className="text-[11px] font-semibold text-muted-foreground">Pos.</label>
                <div className="flex items-center gap-1">
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
                    className="w-14 rounded-md border bg-background px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                  <span className="text-[10px] text-muted-foreground">/{allClips.length}</span>
                </div>
              </div>
            </div>

            <div className="border-t" />

            {/* Editing notes */}
            <div className="flex flex-1 flex-col gap-1">
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

            {/* Clip management actions */}
            <div className="border-t" />
            <div className="flex items-center gap-0.5 flex-wrap">
              <button
                onClick={() => setThumbModalOpen(true)}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted cursor-pointer transition-colors"
                title="Change thumbnail"
              >
                <ImageIcon className="h-3 w-3" />
                Thumb
              </button>
              {removeClip && (
                <button
                  onClick={() => {
                    if (skipConfirmRef.current) {
                      removeClip(selectedClip.hubspotId);
                      const next = allClips.find((c) => c.hubspotId !== selectedClip.hubspotId);
                      setSelectedClipId(next?.hubspotId ?? null);
                    } else {
                      setRemoveTarget(selectedClip.hubspotId);
                    }
                  }}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-destructive hover:bg-destructive/10 cursor-pointer transition-colors"
                >
                  <Trash2 className="h-3 w-3" />
                  Remove
                </button>
              )}
            </div>
          </div>
        )}
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
      className={`overflow-hidden cursor-grab touch-none [&_*]:!cursor-grab
        ${hasMarker ? "rounded-r-lg" : "rounded-lg"}
        ${isSelected
          ? "border-2 border-green-500"
          : hasMarker
            ? "border border-border border-l-[3px] border-l-[#00a8ff]"
            : "border border-border"
        }`}
      onClick={onSelect}
      {...attributes}
      {...listeners}
    >
      {/* Top bar: order number + optional minute badge + drag icon */}
      <div className="flex items-center justify-between border-b bg-muted/50 px-1.5 py-0.5">
        <div className="flex items-center gap-1 min-w-0">
          <span className="text-[10px] font-bold text-muted-foreground flex-shrink-0">#{index + 1}</span>
          {hasMarker && (
            <span className="rounded px-1 py-px text-[9px] font-bold leading-tight text-white flex-shrink-0" style={{ backgroundColor: "#00a8ff" }}>
              {minuteMarker}:00
            </span>
          )}
        </div>
        <GripVertical className="h-3 w-3 text-muted-foreground flex-shrink-0" />
      </div>

      <ClipCard
        clip={toCardData(clip)}
        thumbCache={thumbCache}
        cookiesBrowser={cookiesBrowser}
        cookiesFile={cookiesFile}
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
