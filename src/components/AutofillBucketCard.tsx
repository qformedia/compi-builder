import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Copy,
  GripVertical,
  Plus,
  Trash2,
  AlertTriangle,
  Hash,
  Shuffle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AutofillFilterRow } from "@/components/AutofillFilterRow";
import { createFilter, MAX_BUCKET_COUNT, MAX_FILTERS_PER_BUCKET } from "@/lib/autofill";
import type {
  AutofillBucket,
  BucketFilter,
  BucketSort,
} from "@/types";
import type { TagOption } from "@/lib/tags";

const SORT_LABELS: Record<BucketSort, string> = {
  newest: "Newest first",
  oldest: "Oldest first",
  random: "Random",
  mostLiked: "Most liked",
};

interface Props {
  bucket: AutofillBucket;
  /** 1-based position used in the auto label "Bucket N". */
  index: number;
  onChange: (next: AutofillBucket) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  /** Number of clips fetched into this bucket on the last run, or undefined
   *  if the bucket hasn't been run yet. Used to render the fill ratio. */
  lastFilled?: number;
  /** True when the last run returned fewer clips than `count`. */
  partial?: boolean;
  token: string;
  tagOptions: TagOption[];
}

/** A single bucket card on the Autofill page. Filters are AND'd; sort +
 *  count cap apply after dedup/filter. Sortable via @dnd-kit (same pattern
 *  as ArrangeTab). */
export function AutofillBucketCard({
  bucket,
  index,
  onChange,
  onDuplicate,
  onRemove,
  lastFilled,
  partial,
  token,
  tagOptions,
}: Props) {
  const sortable = useSortable({ id: bucket.id });
  const style = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };

  const updateFilter = (filterId: string, next: BucketFilter) => {
    onChange({
      ...bucket,
      filters: bucket.filters.map((f) => (f.id === filterId ? next : f)),
    });
  };

  const removeFilter = (filterId: string) => {
    onChange({ ...bucket, filters: bucket.filters.filter((f) => f.id !== filterId) });
  };

  const addFilter = () => {
    if (bucket.filters.length >= MAX_FILTERS_PER_BUCKET) return;
    onChange({ ...bucket, filters: [...bucket.filters, createFilter()] });
  };

  const updateCount = (raw: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    const clamped = Math.min(MAX_BUCKET_COUNT, Math.max(1, Math.round(n)));
    onChange({ ...bucket, count: clamped });
  };

  const label = bucket.label?.trim() || `Bucket ${index}`;

  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      className={`rounded-md border border-border bg-card shadow-sm ${
        sortable.isDragging ? "opacity-60" : ""
      }`}
    >
      {/* ── Header ───────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
        <button
          type="button"
          {...sortable.attributes}
          {...sortable.listeners}
          className="flex h-7 w-5 cursor-grab items-center justify-center text-muted-foreground hover:text-foreground active:cursor-grabbing"
          title="Drag to reorder bucket"
          aria-label="Drag to reorder bucket"
        >
          <GripVertical className="h-4 w-4" />
        </button>

        <Input
          value={bucket.label ?? ""}
          onChange={(e) => onChange({ ...bucket, label: e.target.value })}
          placeholder={label}
          className="h-7 flex-1 px-2 text-xs font-medium"
          aria-label="Bucket label"
        />

        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Hash className="h-3.5 w-3.5" />
          <Input
            type="number"
            value={bucket.count}
            onChange={(e) => updateCount(e.target.value)}
            min={1}
            max={MAX_BUCKET_COUNT}
            className="h-7 w-16 px-2 text-xs"
            aria-label="Clip count"
          />
        </div>

        <Select
          value={bucket.sort}
          onValueChange={(v) => onChange({ ...bucket, sort: v as BucketSort })}
        >
          <SelectTrigger className="h-7 w-32 gap-1 px-2 text-[11px]">
            <Shuffle className="h-3 w-3 opacity-60" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(SORT_LABELS) as BucketSort[]).map((sort) => (
              <SelectItem key={sort} value={sort} className="text-xs">
                {SORT_LABELS[sort]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {lastFilled !== undefined && (
          <span
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${
              partial
                ? "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                : "bg-muted text-muted-foreground"
            }`}
            title={
              partial
                ? `Only ${lastFilled} of ${bucket.count} matched this filter set.`
                : `Filled ${lastFilled} / ${bucket.count}`
            }
          >
            {partial && <AlertTriangle className="h-3 w-3" />}
            {lastFilled} / {bucket.count}
          </span>
        )}

        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onDuplicate}
          className="cursor-pointer text-muted-foreground hover:text-foreground"
          title="Duplicate bucket"
          aria-label="Duplicate bucket"
        >
          <Copy className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onRemove}
          className="cursor-pointer text-muted-foreground hover:text-destructive"
          title="Remove bucket"
          aria-label="Remove bucket"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* ── Filter rows ─────────────────────────────────────────────── */}
      <div className="flex flex-col gap-1.5 px-2 py-2">
        {bucket.filters.length === 0 && (
          <p className="px-2 py-1 text-[11px] italic text-muted-foreground">
            No filters yet — this bucket would match every eligible clip. Add a filter to narrow it down.
          </p>
        )}
        {bucket.filters.map((filter) => (
          <AutofillFilterRow
            key={filter.id}
            filter={filter}
            onChange={(next) => updateFilter(filter.id, next)}
            onRemove={() => removeFilter(filter.id)}
            token={token}
            tagOptions={tagOptions}
          />
        ))}

        <div className="flex items-center justify-between pt-1">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={addFilter}
            disabled={bucket.filters.length >= MAX_FILTERS_PER_BUCKET}
            className="cursor-pointer text-xs"
          >
            <Plus className="h-3.5 w-3.5" />
            Add filter
          </Button>
          <span className="text-[10px] text-muted-foreground">
            {bucket.filters.length} / {MAX_FILTERS_PER_BUCKET} filters · AND
          </span>
        </div>
      </div>
    </div>
  );
}
