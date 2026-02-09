import { useState, useRef } from "react";
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
import { GripVertical } from "lucide-react";
import { ClipCard } from "@/components/ClipCard";
import type { AppSettings, Project, ProjectClip } from "@/types";
import type { ClipCardData } from "@/components/ClipCard";

interface Props {
  settings: AppSettings;
  project: Project | null;
  setProject: (p: Project | null) => void;
}

function toCardData(clip: ProjectClip): ClipCardData {
  return {
    id: clip.hubspotId,
    link: clip.link,
    tags: clip.tags,
    creatorName: clip.creatorName,
    downloadStatus: clip.downloadStatus,
    downloadError: clip.downloadError,
  };
}

export function ArrangeTab({ settings, project, setProject }: Props) {
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const thumbCache = useRef(new Map<string, string | null>());

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

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
    <div className="flex h-full flex-col gap-4 py-4">
      {/* Video player */}
      <div className="flex max-h-[60%] flex-1 items-center justify-center rounded-lg bg-black">
        {selectedClip?.localFile ? (
          <video
            ref={videoRef}
            key={selectedClip.localFile}
            controls
            autoPlay
            className="max-h-full max-w-full rounded-lg"
            src={`localfile://localhost/${encodeURIComponent(selectedClip.localFile)}`}
          />
        ) : (
          <p className="text-sm text-white/40">Select a clip to preview</p>
        )}
      </div>

      {/* Sortable cards row */}
      <div className="flex-shrink-0">
        <p className="mb-2 text-xs font-medium text-muted-foreground">
          {completedClips.length} clip{completedClips.length !== 1 ? "s" : ""} — drag to reorder
        </p>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={completedClips.map((c) => c.hubspotId)}
            strategy={horizontalListSortingStrategy}
          >
            <div className="flex gap-3 overflow-x-auto pb-2 scroll-smooth">
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
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>
    </div>
  );
}

// ── Sortable card wrapper ────────────────────────────────────────────────────

function SortableCard({
  clip,
  index,
  isSelected,
  onSelect,
  thumbCache,
  cookiesBrowser,
  cookiesFile,
}: {
  clip: ProjectClip;
  index: number;
  isSelected: boolean;
  onSelect: () => void;
  thumbCache: React.RefObject<Map<string, string | null>>;
  cookiesBrowser: string;
  cookiesFile: string;
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
      className="relative flex-shrink-0"
      onClick={onSelect}
    >
      {/* Order badge + drag handle */}
      <div
        className="absolute -left-1 -top-1 z-10 flex cursor-grab touch-none items-center gap-0.5 rounded-br-md rounded-tl-lg bg-black/70 px-1 py-0.5 text-white"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-3 w-3" />
        <span className="text-[10px] font-bold">{index + 1}</span>
      </div>

      {/* Selection ring */}
      <div className={`rounded-lg ${isSelected ? "ring-2 ring-primary ring-offset-1" : ""}`}>
        <ClipCard
          clip={toCardData(clip)}
          thumbCache={thumbCache}
          cookiesBrowser={cookiesBrowser}
          cookiesFile={cookiesFile}
        />
      </div>
    </div>
  );
}
