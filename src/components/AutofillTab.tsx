import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  ArrowLeft,
  Loader2,
  Play,
  Plus,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  LicenseTypePicker,
  LICENSE_TYPE_OPTIONS,
  type LicenseTypeOption,
} from "@/components/LicenseTypePicker";
import { AutofillBucketCard } from "@/components/AutofillBucketCard";
import { AutofillPreview } from "@/components/AutofillPreview";
import { useTagOptionsCache } from "@/components/AutofillFilterRow";
import {
  createBucket,
  defaultAutofillConfig,
  duplicateBucket,
  runAutofill,
  type BucketResult,
} from "@/lib/autofill";
import type {
  AutofillBucket,
  AutofillConfig,
  AppSettings,
  Clip,
  Project,
} from "@/types";

interface Props {
  settings: AppSettings;
  project: Project;
  setProject: (p: Project | null) => void;
  addClip: (clip: Clip) => void;
  onBackToSearch: () => void;
}

/** Autofill page: configure ordered buckets of clips, preview the picks,
 *  then commit them to the open Video Project. */
export function AutofillTab({ settings, project, setProject, addClip, onBackToSearch }: Props) {
  const [config, setConfig] = useState<AutofillConfig>(
    () => project.autofillConfig ?? defaultAutofillConfig(),
  );
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  /** Preview results from the most recent Run. Null = no preview open. */
  const [previewResults, setPreviewResults] = useState<BucketResult[] | null>(null);

  const tagOptions = useTagOptionsCache(settings.hubspotToken);

  // Reset error when buckets change so old failures don't linger.
  useEffect(() => {
    setRunError(null);
  }, [config]);

  // Persist config to the project's project.json whenever it changes.
  // Debounced lightly to avoid hammering disk on every keystroke.
  const saveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (saveRef.current) clearTimeout(saveRef.current);
    saveRef.current = setTimeout(() => {
      const updated: Project = { ...project, autofillConfig: config };
      setProject(updated);
      invoke("save_project_data", {
        rootFolder: settings.rootFolder,
        project: updated,
      }).catch(() => {});
    }, 400);
    return () => {
      if (saveRef.current) clearTimeout(saveRef.current);
    };
    // We deliberately omit `project` / `setProject` from deps — we only want
    // to write back when the user-edited config changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, settings.rootFolder]);

  // ── Bucket list edits ────────────────────────────────────────────────
  const updateBucket = useCallback((id: string, next: AutofillBucket) => {
    setConfig((prev) => ({
      ...prev,
      buckets: prev.buckets.map((b) => (b.id === id ? next : b)),
    }));
  }, []);

  const removeBucket = useCallback((id: string) => {
    setConfig((prev) => ({ ...prev, buckets: prev.buckets.filter((b) => b.id !== id) }));
  }, []);

  const duplicate = useCallback((id: string) => {
    setConfig((prev) => {
      const idx = prev.buckets.findIndex((b) => b.id === id);
      if (idx < 0) return prev;
      const copy = duplicateBucket(prev.buckets[idx]);
      const next = [...prev.buckets];
      next.splice(idx + 1, 0, copy);
      return { ...prev, buckets: next };
    });
  }, []);

  const addNewBucket = useCallback(() => {
    setConfig((prev) => ({ ...prev, buckets: [...prev.buckets, createBucket()] }));
  }, []);

  // ── Drag-and-drop reordering (same pattern as ArrangeTab) ────────────
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setConfig((prev) => {
      const oldIndex = prev.buckets.findIndex((b) => b.id === active.id);
      const newIndex = prev.buckets.findIndex((b) => b.id === over.id);
      if (oldIndex < 0 || newIndex < 0) return prev;
      return { ...prev, buckets: arrayMove(prev.buckets, oldIndex, newIndex) };
    });
  };

  // ── Run ──────────────────────────────────────────────────────────────
  const runConfig = useCallback(async () => {
    if (!settings.hubspotToken) {
      setRunError("HubSpot token is not configured.");
      return;
    }
    if (config.buckets.length === 0) {
      setRunError("Add at least one bucket before running.");
      return;
    }
    setRunning(true);
    setRunError(null);
    try {
      const { results } = await runAutofill(config, project, settings.hubspotToken);
      setPreviewResults(results);
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }, [config, project, settings.hubspotToken]);

  // Re-roll a single bucket inside the preview. Excludes everything currently
  // shown in any preview bucket and everything already in the project.
  const reRollBucket = useCallback(
    async (bucketId: string) => {
      if (!previewResults || !settings.hubspotToken) return;
      const bucket = config.buckets.find((b) => b.id === bucketId);
      if (!bucket) return;
      const excludeIds = new Set<string>(project.clips.map((c) => c.hubspotId));
      for (const r of previewResults) {
        for (const clip of r.clips) excludeIds.add(clip.id);
      }
      const { runBucket: runOne } = await import("@/lib/autofill");
      const res = await runOne(bucket, {
        token: settings.hubspotToken,
        globals: config,
        excludeIds,
      });
      setPreviewResults((prev) =>
        prev?.map((r) => (r.bucketId === bucketId ? res : r)) ?? null,
      );
    },
    [config, previewResults, project.clips, settings.hubspotToken],
  );

  // Bucket-local "Add all" — commits one bucket's remaining picks and clears
  // it from the preview. Whatever the user didn't discard goes in.
  const addBucketToProject = useCallback(
    (bucketId: string) => {
      if (!previewResults) return;
      const target = previewResults.find((r) => r.bucketId === bucketId);
      if (!target) return;
      for (const clip of target.clips) addClip(clip);
      setPreviewResults((prev) =>
        prev?.map((r) => (r.bucketId === bucketId ? { ...r, clips: [] } : r)) ?? null,
      );
    },
    [addClip, previewResults],
  );

  // Global "Add everything to project" — commit remaining picks in every
  // bucket and close the preview.
  const addEverything = useCallback(() => {
    if (!previewResults) return;
    for (const result of previewResults) {
      for (const clip of result.clips) addClip(clip);
    }
    setPreviewResults(null);
  }, [addClip, previewResults]);

  // Drop one clip from a bucket's preview without committing.
  const discardClip = useCallback((bucketId: string, clipId: string) => {
    setPreviewResults((prev) =>
      prev?.map((r) =>
        r.bucketId === bucketId ? { ...r, clips: r.clips.filter((c) => c.id !== clipId) } : r,
      ) ?? null,
    );
  }, []);

  // ── Render ───────────────────────────────────────────────────────────
  const bucketById = useMemo(
    () => new Map(config.buckets.map((b) => [b.id, b])),
    [config.buckets],
  );

  const totalPlanned = config.buckets.reduce((sum, b) => sum + b.count, 0);

  return (
    <div className="flex h-full flex-col gap-3 py-4">
      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBackToSearch}
          className="cursor-pointer gap-1.5"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Search
        </Button>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5" />
          Autofill — {config.buckets.length} bucket{config.buckets.length !== 1 ? "s" : ""} ·{" "}
          {totalPlanned} planned clip{totalPlanned !== 1 ? "s" : ""}
        </div>
        <Button
          onClick={runConfig}
          disabled={running || config.buckets.length === 0}
          className="cursor-pointer gap-1.5"
        >
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          Run
        </Button>
      </div>

      {runError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {runError}
        </div>
      )}

      {/* ── Global filters ──────────────────────────────────────────── */}
      <GlobalFiltersRow
        config={config}
        onChange={(patch) => setConfig((prev) => ({ ...prev, ...patch }))}
      />

      {/* ── Buckets list ────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
        >
          <SortableContext
            items={config.buckets.map((b) => b.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="flex flex-col gap-2">
              {config.buckets.map((bucket, i) => {
                const result = previewResults?.find((r) => r.bucketId === bucket.id);
                return (
                  <AutofillBucketCard
                    key={bucket.id}
                    bucket={bucket}
                    index={i + 1}
                    onChange={(next) => updateBucket(bucket.id, next)}
                    onDuplicate={() => duplicate(bucket.id)}
                    onRemove={() => removeBucket(bucket.id)}
                    lastFilled={result?.clips.length}
                    partial={result?.partial}
                    token={settings.hubspotToken}
                    tagOptions={tagOptions}
                  />
                );
              })}
            </div>
          </SortableContext>
        </DndContext>

        <div className="mt-3 flex items-center justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={addNewBucket}
            className="cursor-pointer gap-1.5"
          >
            <Plus className="h-4 w-4" />
            Add bucket
          </Button>
        </div>
      </div>

      {/* ── Preview overlay ─────────────────────────────────────────── */}
      {previewResults && (
        <AutofillPreview
          results={previewResults}
          bucketById={bucketById}
          settings={settings}
          project={project}
          onClose={() => setPreviewResults(null)}
          onDiscardClip={discardClip}
          onReRollBucket={reRollBucket}
          onAddBucket={addBucketToProject}
          onAddEverything={addEverything}
        />
      )}
    </div>
  );
}

// ── Global filters row ─────────────────────────────────────────────────────

function GlobalFiltersRow({
  config,
  onChange,
}: {
  config: AutofillConfig;
  onChange: (patch: Partial<AutofillConfig>) => void;
}) {
  const license = config.globalLicenseTypes.filter((s): s is LicenseTypeOption =>
    (LICENSE_TYPE_OPTIONS as readonly string[]).includes(s),
  );
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2 py-1.5">
      <span className="text-[11px] font-medium text-muted-foreground mr-1">Global filters:</span>
      <button
        type="button"
        onClick={() => onChange({ globalNeverUsed: !config.globalNeverUsed })}
        className={`rounded px-2 py-0.5 text-[11px] font-medium cursor-pointer transition-all ${
          config.globalNeverUsed
            ? "bg-green-500 text-white"
            : "bg-muted text-muted-foreground hover:bg-muted/80"
        }`}
        title="Only pick clips that have never been used in a published Video Project."
      >
        Never used
      </button>
      <span className="mx-1 text-muted-foreground/30">|</span>
      <LicenseTypePicker
        selected={license}
        onChange={(values) => onChange({ globalLicenseTypes: values })}
      />
      <span className="ml-auto text-[10px] text-muted-foreground">
        Always AND-combined · applied to every bucket
      </span>
    </div>
  );
}
