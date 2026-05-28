import { useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCheck,
  Loader2,
  RotateCcw,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ClipCard } from "@/components/ClipCard";
import type { BucketResult } from "@/lib/autofill";
import type { AppSettings, AutofillBucket, Project } from "@/types";

interface Props {
  results: BucketResult[];
  bucketById: Map<string, AutofillBucket>;
  settings: AppSettings;
  project: Project;
  onClose: () => void;
  onDiscardClip: (bucketId: string, clipId: string) => void;
  onReRollBucket: (bucketId: string) => Promise<void> | void;
  onAddBucket: (bucketId: string) => void;
  onAddEverything: () => void;
}

/** Full-screen overlay showing the autofill picks grouped by bucket. Per-clip
 *  discard, per-bucket re-roll/add-all, footer add-everything. */
export function AutofillPreview({
  results,
  bucketById,
  settings,
  project,
  onClose,
  onDiscardClip,
  onReRollBucket,
  onAddBucket,
  onAddEverything,
}: Props) {
  const thumbCache = useRef<Map<string, string | null>>(new Map());
  const [reRolling, setReRolling] = useState<Set<string>>(new Set());

  const totalRemaining = results.reduce((sum, r) => sum + r.clips.length, 0);

  const reRoll = async (bucketId: string) => {
    setReRolling((prev) => new Set(prev).add(bucketId));
    try {
      await onReRollBucket(bucketId);
    } finally {
      setReRolling((prev) => {
        const next = new Set(prev);
        next.delete(bucketId);
        return next;
      });
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm">
      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between border-b border-border bg-background px-4 py-3 shadow-sm">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold">Autofill preview</h2>
          <span className="text-xs text-muted-foreground">
            {totalRemaining} clip{totalRemaining !== 1 ? "s" : ""} ready · {results.length} bucket{results.length !== 1 ? "s" : ""}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} className="cursor-pointer">
            Cancel
          </Button>
          <Button
            onClick={onAddEverything}
            disabled={totalRemaining === 0}
            className="cursor-pointer gap-1.5"
          >
            <CheckCheck className="h-4 w-4" />
            Add everything to project
          </Button>
        </div>
      </div>

      {/* ── Body ────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {results.length === 0 && (
          <p className="text-sm text-muted-foreground">No buckets to preview.</p>
        )}

        <div className="flex flex-col gap-6">
          {results.map((result) => {
            const bucket = bucketById.get(result.bucketId);
            if (!bucket) return null;
            const label = bucket.label?.trim() || "Bucket";
            const isReRolling = reRolling.has(result.bucketId);
            const filled = result.clips.length;
            return (
              <section key={result.bucketId}>
                {/* Bucket header */}
                <div className="mb-2 flex items-center gap-2">
                  <h3 className="text-sm font-semibold">{label}</h3>
                  <span
                    className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${
                      result.partial
                        ? "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {result.partial && <AlertTriangle className="h-3 w-3" />}
                    {filled} / {bucket.count}
                  </span>
                  <div className="ml-auto flex items-center gap-1.5">
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => reRoll(result.bucketId)}
                      disabled={isReRolling}
                      className="cursor-pointer"
                    >
                      {isReRolling ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RotateCcw className="h-3.5 w-3.5" />
                      )}
                      Re-roll
                    </Button>
                    <Button
                      size="xs"
                      onClick={() => onAddBucket(result.bucketId)}
                      disabled={filled === 0}
                      className="cursor-pointer"
                    >
                      <CheckCheck className="h-3.5 w-3.5" />
                      Add all ({filled})
                    </Button>
                  </div>
                </div>

                {/* Clip grid (reuses ClipCard) */}
                {filled === 0 ? (
                  <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                    {result.partial
                      ? "HubSpot didn't return enough matches for this bucket. Loosen its filters or re-roll."
                      : "All picks committed or discarded."}
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-3">
                    {result.clips.map((clip) => (
                      <div key={clip.id} className="relative">
                        <ClipCard
                          clip={clip}
                          thumbCache={thumbCache}
                          cookiesBrowser={settings.cookiesBrowser}
                          cookiesFile={settings.cookiesFile}
                          evil0ctalApiUrl={settings.evil0ctalApiUrl}
                          hubspotToken={settings.hubspotToken}
                          searchTags={[]}
                          inProject={project.clips.some((c) => c.hubspotId === clip.id)}
                          hasProject
                          preferHubSpotPreview={settings.preferHubSpotPreview}
                        />
                        <button
                          type="button"
                          onClick={() => onDiscardClip(result.bucketId, clip.id)}
                          className="absolute -right-2 -top-2 z-10 flex h-6 w-6 cursor-pointer items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm hover:bg-destructive hover:text-destructive-foreground"
                          title="Discard this clip from the preview"
                          aria-label="Discard clip"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
