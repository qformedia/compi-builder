import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
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
  horizontalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripHorizontal, CheckCircle, StickyNote, Download, FolderOpen, Loader2 } from "lucide-react";
import { MediaPlayer, MediaProvider, type MediaPlayerInstance } from "@vidstack/react";
import { defaultLayoutIcons, DefaultVideoLayout } from "@vidstack/react/player/layouts/default";
import "@vidstack/react/player/styles/default/theme.css";
import "@vidstack/react/player/styles/default/layouts/video.css";
import { ClipCard, SCORE_COLORS } from "@/components/ClipCard";
import { resolveClipPath } from "@/types";
import type { AppSettings, Project, ProjectClip } from "@/types";
import type { ClipCardData } from "@/components/ClipCard";

interface Props {
  settings: AppSettings;
  project: Project | null;
  setProject: (p: Project | null) => void;
  isActive: boolean;
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

export function ArrangeTab({ settings, project, setProject, isActive }: Props) {
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const playerRef = useRef<MediaPlayerInstance>(null);
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

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  // Pause video when leaving the tab
  useEffect(() => {
    if (!isActive && playerRef.current) {
      playerRef.current.pause();
    }
  }, [isActive]);

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

  const downloadClip = useCallback(async (clip: ProjectClip) => {
    if (!project) return;
    try {
      await invoke("download_clip", {
        rootFolder: settings.rootFolder,
        projectName: project.name,
        clipId: clip.hubspotId,
        url: clip.link,
        cookiesBrowser: settings.cookiesBrowser || null,
        cookiesFile: settings.cookiesFile || null,
      });
    } catch { /* handled via event listener */ }
  }, [project, settings]);

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

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <p>Open a project in the Project tab first.</p>
      </div>
    );
  }

  if (allClips.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <p>No downloaded clips yet. Download clips in the Project tab.</p>
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

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Player + side panel row */}
      <div className="flex min-h-0 flex-1 gap-2">
        {/* Video player */}
        <div className="relative min-h-0 flex-1 rounded-lg bg-black overflow-hidden">
          {selectedClip && isPlayable(selectedClip) ? (
            <MediaPlayer
              ref={playerRef}
              key={selectedClip.localFile}
              src={`localfile://localhost/${encodeURIComponent(resolveClipPath(settings.rootFolder, project.name, selectedClip.localFile!))}`}
              autoPlay={isActive}
              onEnded={handleNextClip}
              keyTarget="document"
              className="absolute inset-0 !w-full !h-full [&_video]:!absolute [&_video]:!inset-0 [&_video]:!w-full [&_video]:!h-full [&_video]:!object-contain"
            >
              <MediaProvider />
              <DefaultVideoLayout icons={defaultLayoutIcons} seekStep={5} slots={{ pipButton: null, fullscreenButton: null }} />
            </MediaPlayer>
          ) : selectedClip ? (
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <p className="text-sm text-white/40">
                {selectedClip.downloadStatus === "downloading" ? "Downloading..." : "Clip not downloaded yet"}
              </p>
              {selectedClip.downloadStatus === "downloading" && (
                <Loader2 className="h-6 w-6 animate-spin text-white/40" />
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => downloadClip(selectedClip)}
                  className="flex items-center gap-1.5 rounded-md bg-white/10 px-3 py-1.5 text-xs text-white hover:bg-white/20 cursor-pointer"
                >
                  <Download className="h-3.5 w-3.5" />
                  {selectedClip.downloadStatus === "downloading" ? "Retry" : "Download"}
                </button>
                <button
                  onClick={() => importClipFile(selectedClip)}
                  className="flex items-center gap-1.5 rounded-md bg-white/10 px-3 py-1.5 text-xs text-white hover:bg-white/20 cursor-pointer"
                >
                  <FolderOpen className="h-3.5 w-3.5" /> Browse
                </button>
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-white/40">Select a clip to preview</p>
            </div>
          )}
        </div>

        {/* Side panel: clip info + editable fields + editing notes */}
        {selectedClip && (
          <div className="flex w-64 flex-shrink-0 flex-col gap-2.5 overflow-y-auto rounded-lg border bg-card p-3">
            {/* Clip header */}
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-muted-foreground">#{selectedIndex + 1}</span>
              <span className="truncate text-sm font-semibold">{selectedClip.creatorName}</span>
            </div>

            {selectedClip.licenseType && selectedClip.licenseType.toLowerCase() !== "recurrent" && (
              <span className="self-start rounded bg-amber-500/90 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                {selectedClip.licenseType}
              </span>
            )}

            {selectedClip.notes && (
              <p className="text-[11px] text-muted-foreground italic leading-snug">
                {selectedClip.notes}
              </p>
            )}

            <div className="border-t" />

            {/* Editable: Score */}
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold text-muted-foreground">Score</label>
              <div className="flex flex-wrap gap-1">
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
            </div>

            {/* Editable: Edited Duration */}
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold text-muted-foreground">
                Edited Duration (s)
              </label>
              <div className="flex items-center gap-2">
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
                  className="w-20 rounded-md border bg-background px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <span className="text-[11px] text-muted-foreground">
                  total: {formatDuration(selectedClip.localDuration)}
                </span>
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
          </div>
        )}
      </div>

      {/* Sortable cards row — fixed at bottom */}
      <div className="flex-shrink-0 border-t bg-background pt-1 pb-1 px-1">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={allClips.map((c) => c.hubspotId)}
            strategy={horizontalListSortingStrategy}
          >
            <div className="flex gap-2 overflow-x-auto pb-1 scroll-smooth">
              {allClips.map((clip, index) => (
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
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>
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

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex-shrink-0 rounded-lg overflow-hidden cursor-grab touch-none [&_*]:!cursor-grab ${isSelected ? "border-2 border-green-500" : "border border-border"}`}
      onClick={onSelect}
      {...attributes}
      {...listeners}
    >
      {/* Top bar: order number + drag icon */}
      <div className="flex items-center justify-between border-b bg-muted/50 px-2 py-1">
        <span className="text-[11px] font-bold text-muted-foreground">#{index + 1}</span>
        <GripHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
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
