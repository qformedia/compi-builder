import { useState } from "react";
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
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { KeyboardSensor } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { GripVertical, Play } from "lucide-react";
import type { AppSettings, Project, ProjectClip } from "@/types";

interface Props {
  settings: AppSettings;
  project: Project | null;
  setProject: (p: Project | null) => void;
}

export function ArrangeTab({ settings, project, setProject }: Props) {
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
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
  );

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

    // Rebuild full clips list: keep non-completed as-is, replace completed with reordered
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
    <div className="flex h-full gap-4 py-4">
      {/* Left: sortable list */}
      <div className="flex w-80 flex-shrink-0 flex-col gap-2">
        <p className="text-sm font-medium">
          {completedClips.length} clip{completedClips.length !== 1 ? "s" : ""} — drag to reorder
        </p>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={completedClips.map((c) => c.hubspotId)}
            strategy={verticalListSortingStrategy}
          >
            <div className="flex flex-col gap-1">
              {completedClips.map((clip, index) => (
                <SortableClipItem
                  key={clip.hubspotId}
                  clip={clip}
                  index={index}
                  isSelected={clip.hubspotId === selectedClipId}
                  onSelect={() => setSelectedClipId(clip.hubspotId)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>

      {/* Right: video player */}
      <div className="flex flex-1 flex-col gap-2">
        {selectedClip?.localFile ? (
          <>
            <video
              key={selectedClip.localFile}
              controls
              autoPlay
              className="max-h-[70vh] w-full rounded-lg bg-black"
              src={`localfile://localhost/${encodeURIComponent(selectedClip.localFile)}`}
            />
            <p className="text-sm text-muted-foreground">
              {selectedClip.creatorName} — {selectedClip.tags.join(", ")}
            </p>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed">
            <p className="text-sm text-muted-foreground">
              Select a clip to preview
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function SortableClipItem({
  clip,
  index,
  isSelected,
  onSelect,
}: {
  clip: ProjectClip;
  index: number;
  isSelected: boolean;
  onSelect: () => void;
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
    <Card
      ref={setNodeRef}
      style={style}
      className={`flex cursor-pointer items-center gap-2 p-2 ${
        isSelected ? "border-primary" : ""
      }`}
      onClick={onSelect}
    >
      <div
        className="cursor-grab touch-none text-muted-foreground"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </div>
      <span className="text-xs font-medium text-muted-foreground w-5">
        {index + 1}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{clip.creatorName}</p>
        <div className="flex gap-1">
          {clip.tags.slice(0, 2).map((tag) => (
            <Badge key={tag} variant="outline" className="text-xs">
              {tag}
            </Badge>
          ))}
        </div>
      </div>
      <Play className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
    </Card>
  );
}
