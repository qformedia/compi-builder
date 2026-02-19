import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
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
import { GripHorizontal } from "lucide-react";
import { MediaPlayer, MediaProvider, type MediaPlayerInstance } from "@vidstack/react";
import { defaultLayoutIcons, DefaultVideoLayout } from "@vidstack/react/player/layouts/default";
import "@vidstack/react/player/styles/default/theme.css";
import "@vidstack/react/player/styles/default/layouts/video.css";
import { ClipCard } from "@/components/ClipCard";
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

  const completedClips = project?.clips.filter(
    (c) => c.downloadStatus === "complete" && c.localFile,
  ) ?? [];

  const selectedClip = completedClips.find(
    (c) => c.hubspotId === selectedClipId,
  ) ?? completedClips[0] ?? null;

  const handleNextClip = useCallback(() => {
    if (!selectedClip) return;
    const currentIndex = completedClips.findIndex(
      (c) => c.hubspotId === selectedClip.hubspotId,
    );
    if (currentIndex < completedClips.length - 1) {
      setSelectedClipId(completedClips[currentIndex + 1].hubspotId);
    }
  }, [completedClips, selectedClip]);

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <p>Open a project in the Project tab first.</p>
      </div>
    );
  }

  if (completedClips.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <p>No downloaded clips yet. Download clips in the Project tab.</p>
      </div>
    );
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = completedClips.findIndex(
      (c) => c.hubspotId === active.id,
    );
    const newIndex = completedClips.findIndex(
      (c) => c.hubspotId === over.id,
    );
    const reordered = arrayMove(completedClips, oldIndex, newIndex);

    const nonCompleted = project.clips.filter(
      (c) => c.downloadStatus !== "complete" || !c.localFile,
    );
    const allClips = [
      ...reordered.map((c, i) => ({ ...c, order: i })),
      ...nonCompleted,
    ];

    const updated = { ...project, clips: allClips };
    setProject(updated);
    invoke("save_project_data", {
      rootFolder: settings.rootFolder,
      project: updated,
    }).catch(() => {});
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Video player — fills remaining space above cards */}
      <div className="relative min-h-0 flex-1 rounded-lg bg-black overflow-hidden">
        {selectedClip?.localFile ? (
          <MediaPlayer
            ref={playerRef}
            key={selectedClip.localFile}
            src={`localfile://localhost/${encodeURIComponent(resolveClipPath(settings.rootFolder, project.name, selectedClip.localFile))}`}
            autoPlay={isActive}
            onEnded={handleNextClip}
            keyTarget="document"
            className="absolute inset-0 !w-full !h-full [&_video]:!absolute [&_video]:!inset-0 [&_video]:!w-full [&_video]:!h-full [&_video]:!object-contain"
          >
            <MediaProvider />
            <DefaultVideoLayout icons={defaultLayoutIcons} seekStep={5} slots={{ pipButton: null, fullscreenButton: null }} />
          </MediaPlayer>
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-white/40">Select a clip to preview</p>
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
            items={completedClips.map((c) => c.hubspotId)}
            strategy={horizontalListSortingStrategy}
          >
            <div className="flex gap-2 overflow-x-auto pb-1 scroll-smooth">
              {completedClips.map((clip, index) => (
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
