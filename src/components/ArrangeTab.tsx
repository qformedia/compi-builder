import { useState, useRef, useEffect } from "react";
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
  const videoRef = useRef<HTMLVideoElement>(null);
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
    if (!isActive && videoRef.current) {
      videoRef.current.pause();
    }
  }, [isActive]);

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <p>Open a project in the Project tab first.</p>
      </div>
    );
  }

  const completedClips = project.clips.filter(
    (c) => c.downloadStatus === "complete" && c.localFile,
  );

  if (completedClips.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <p>No downloaded clips yet. Download clips in the Project tab.</p>
      </div>
    );
  }

  const selectedClip = completedClips.find(
    (c) => c.hubspotId === selectedClipId,
  ) ?? completedClips[0];

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
    <div className="flex h-full flex-col">
      {/* Video player — fills remaining space above cards */}
      <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg bg-black">
        {selectedClip?.localFile ? (
          <video
            ref={videoRef}
            key={selectedClip.localFile}
            controls
            autoPlay={isActive}
            className="max-h-full max-w-full rounded-lg"
            src={`localfile://localhost/${encodeURIComponent(resolveClipPath(settings.rootFolder, project.name, selectedClip.localFile))}`}
          />
        ) : (
          <p className="text-sm text-white/40">Select a clip to preview</p>
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
