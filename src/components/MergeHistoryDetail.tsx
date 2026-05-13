/**
 * Read-only A/B/Predicted-merged comparison for a past merge.
 *
 * This view exists because HubSpot's native merge is destructive: once two
 * records are merged you cannot reconstruct what the loser looked like
 * beforehand from HubSpot itself. We capture a full pre-merge snapshot at
 * merge time (see `recordMergeResolution` in
 * `src/lib/duplicates/supabase.ts`) and replay it here.
 *
 * Layout intentionally mirrors {@link DuplicatePairDetail} — same Why /
 * Statuses / Associations / Side-by-side cards — but:
 *   - Always 3 columns (Winner / Loser / Predicted merged), no winner
 *     picker, no merge action.
 *   - Data sourced from Supabase, not live HubSpot.
 *   - Top banner records who/when, plus a "View merged record" shortcut
 *     into the surviving HubSpot record.
 */

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  ASSOCIATION_ROLLUP_KEYS,
  ASSOCIATION_ROLLUP_LABELS,
  predictMergedAssociationRollup,
  predictMergedProperties,
  sortPropertiesForDiff,
  type PropDiff,
  type PropDiffBucket,
} from "@/lib/duplicates/diff";
import {
  describeSupabaseError,
  fetchMergeSnapshot,
  type MergeSnapshot,
} from "@/lib/duplicates/supabase";
import { hubspotClipUrl, hubspotCreatorUrl, hubspotVideoProjectUrl } from "@/lib/hubspot-urls";
import {
  AssociatedRecordsSection,
  LicenseInfoCard,
  PropValueCell,
  formatDisplayValue,
  type AssociatedRecord,
  type HubspotFileInfo,
} from "@/components/duplicate-pair-view-primitives";

interface Props {
  snapshotId: string;
  /** Optional HubSpot token used to resolve license-file ids → human
   *  filenames. Snapshots store only the ids (HubSpot's data model), so
   *  the file metadata fetch happens at view time against live HubSpot.
   *  Without a token the chips fall back to showing the raw id. */
  token?: string;
  onBack: () => void;
}

const BUCKET_LABEL: Record<PropDiffBucket, string> = {
  mismatch: "Differs",
  only_a: "Only on Winner",
  only_b: "Only on Loser",
  equal: "Identical",
};

const BUCKET_HEADER_CLASS: Record<PropDiffBucket, string> = {
  mismatch: "text-amber-700",
  only_a: "text-sky-700",
  only_b: "text-sky-700",
  equal: "text-muted-foreground",
};

const BUCKET_ROW_CLASS: Record<PropDiffBucket, string> = {
  mismatch: "bg-amber-50/40",
  only_a: "",
  only_b: "",
  equal: "",
};

// Three-column layout is constant in this view (winner / loser / predicted
// merged). Pulled out so the header and every row stay aligned.
const GRID_COLS = "grid-cols-[minmax(160px,200px)_1fr_1fr_1fr]";

export function MergeHistoryDetail({ snapshotId, token, onBack }: Props) {
  const [snapshot, setSnapshot] = useState<MergeSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const s = await fetchMergeSnapshot(snapshotId);
        if (cancelled) return;
        if (!s) {
          setError(
            "Snapshot not found. It may have been deleted, or the migration that creates the merge_snapshots table hasn't been applied yet.",
          );
          setSnapshot(null);
        } else {
          setSnapshot(s);
        }
      } catch (err) {
        if (cancelled) return;
        setError(describeSupabaseError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [snapshotId]);

  // Ownership map captured at merge time. Wrapped in a Map so it has the
  // same call shape as the live view's `ownersById`, which lets us reuse
  // `formatDisplayValue` from the shared primitives without forking.
  const ownersById = useMemo<Map<string, string>>(() => {
    if (!snapshot) return new Map();
    return new Map(Object.entries(snapshot.ownersById));
  }, [snapshot]);

  // Diff treats winner as A, loser as B (constant in this view; the
  // snapshot already preserves which side won).
  const diff = useMemo<PropDiff[]>(() => {
    if (!snapshot) return [];
    return sortPropertiesForDiff(snapshot.winnerProps, snapshot.loserProps);
  }, [snapshot]);

  const groupedDiff = useMemo(() => {
    const groups: Record<PropDiffBucket, PropDiff[]> = {
      mismatch: [],
      only_a: [],
      only_b: [],
      equal: [],
    };
    for (const row of diff) groups[row.bucket].push(row);
    return groups;
  }, [diff]);

  const mergedProps = useMemo<Record<string, string>>(() => {
    if (!snapshot) return {};
    return predictMergedProperties(snapshot.winnerProps, snapshot.loserProps);
  }, [snapshot]);

  // ── License file id → name resolver (best-effort, mirrors live view).
  // The snapshot only stores ids (that's all HubSpot gives us), so we
  // hit live HubSpot at view time to swap them for friendly filenames.
  // Failure is silent; chips fall back to ids. ────────────────────────
  const [fileNamesById, setFileNamesById] = useState<Map<string, HubspotFileInfo>>(
    new Map(),
  );
  const fileIds = useMemo<string[]>(() => {
    if (!snapshot) return [];
    const out = new Set<string>();
    for (const side of [snapshot.winnerProps, snapshot.loserProps]) {
      for (const key of ["license_file", "traceability_file"] as const) {
        const raw = (side[key] ?? "").trim();
        if (!raw) continue;
        for (const tok of raw.split(/[;,\s]+/)) {
          const t = tok.trim();
          if (t) out.add(t);
        }
      }
    }
    return Array.from(out).sort();
  }, [snapshot]);
  const fileIdsKey = fileIds.join(",");
  useEffect(() => {
    if (!token || fileIds.length === 0) {
      setFileNamesById(new Map());
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await invoke<Record<string, HubspotFileInfo>>(
          "fetch_hubspot_files_batch",
          { token, fileIds },
        );
        if (cancelled) return;
        setFileNamesById(new Map(Object.entries(res)));
      } catch {
        // Silent: chip falls back to the raw id.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, fileIdsKey]);

  if (loading) {
    return (
      <div className="h-full overflow-auto">
        <div className="w-full space-y-4 px-4 py-4">
          <BackButton onBack={onBack} />
          <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin" />
            Loading merge snapshot…
          </div>
        </div>
      </div>
    );
  }

  if (error || !snapshot) {
    return (
      <div className="h-full overflow-auto">
        <div className="w-full space-y-4 px-4 py-4">
          <BackButton onBack={onBack} />
          <div className="flex flex-wrap items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            <span className="min-w-0 break-words">
              {error ?? "Snapshot not found."}
            </span>
          </div>
        </div>
      </div>
    );
  }

  const winnerName = snapshot.winnerName || snapshot.winnerRecordId;
  const loserName = snapshot.loserName || snapshot.loserRecordId;

  return (
    <div className="h-full overflow-auto">
      <div className="w-full space-y-4 px-4 py-4">
        <BackButton onBack={onBack} />

        {/* Top banner: who/when + the link out to HubSpot. Sits above the
            comparison cards so it's the first thing the reviewer sees when
            opening a historical merge. */}
        <Card className="border-emerald-300 bg-emerald-50/40">
          <CardHeader className="gap-1.5">
            <CardTitle className="flex flex-wrap items-center gap-2 text-base text-emerald-900">
              <Check className="h-4 w-4 text-emerald-600" />
              Merged on {snapshot.mergedAt.toLocaleString()}
              {snapshot.actor && (
                <span className="text-emerald-900/70">by {snapshot.actor}</span>
              )}
            </CardTitle>
            <CardDescription className="text-xs text-emerald-900/80">
              The data below is the snapshot captured at merge time, not the
              current state of HubSpot.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex items-center justify-end">
            <Button
              variant="outline"
              size="sm"
              className="cursor-pointer border-emerald-400 text-emerald-800 hover:bg-emerald-100/60"
              onClick={() => void openUrl(hubspotCreatorUrl(snapshot.winnerRecordId))}
            >
              <ExternalLink className="mr-1.5 h-4 w-4" />
              View merged record in HubSpot
            </Button>
          </CardContent>
        </Card>

        {/* Why card (mirrors DuplicatePairDetail's layout but built from
            the snapshot's denormalized fields). */}
        <Card>
          <CardHeader className="gap-1.5">
            <CardTitle className="text-base">Why this was a potential duplicate</CardTitle>
            <CardDescription className="text-xs">
              The same canonical {snapshot.network ?? "URL"} was found across both records.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              {snapshot.network && (
                <Badge variant="outline" className="capitalize">{snapshot.network}</Badge>
              )}
              {snapshot.canonicalUrl && (
                <button
                  type="button"
                  onClick={() => void openUrl(snapshot.canonicalUrl!)}
                  className="inline-flex items-center gap-1 truncate text-primary hover:underline"
                  title="Open canonical URL"
                >
                  <span className="truncate">{snapshot.canonicalUrl}</span>
                  <ExternalLink className="h-3 w-3 flex-shrink-0" />
                </button>
              )}
            </div>
            <div className="rounded-md bg-muted/40 px-3 py-2 text-xs">
              <span className="font-medium">{winnerName}</span>
              <span className="ml-1 text-emerald-700">(winner)</span>
              <span className="mx-2 text-muted-foreground">==</span>
              <span className="font-medium">{loserName}</span>
              <span className="ml-1 text-rose-700">(archived)</span>
            </div>
          </CardContent>
        </Card>

        {/* License Information card — same layout as the live view but
            always 3 columns (Winner / Loser / Predicted merged). The
            mergedProps argument is non-null so LicenseInfoCard renders
            the third column unconditionally. */}
        <Card>
          <CardHeader className="gap-1.5">
            <CardTitle className="text-base">License Information</CardTitle>
            <CardDescription className="text-xs">
              Snapshot of each side's HubSpot license fields at merge time.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LicenseInfoCard
              propsA={snapshot.winnerProps}
              propsB={snapshot.loserProps}
              mergedProps={mergedProps}
              nameA={winnerName}
              nameB={loserName}
              mergedColumnLabel="Predicted merged"
              fileNamesById={fileNamesById}
            />
          </CardContent>
        </Card>

        {/* Associations card — counts table + records sections from the
            snapshot. Both `winner_associations` and `loser_associations`
            can be null if the associations fetch failed at merge time;
            we render empty sections in that case so the layout stays
            consistent. */}
        <Card>
          <CardHeader className="gap-1.5">
            <CardTitle className="text-base">Associations</CardTitle>
            <CardDescription className="text-xs">
              Rollup counts and associated records as captured at merge time.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md border">
              <div
                className={cn(
                  "grid items-center gap-3 border-b bg-muted/40 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground",
                  GRID_COLS,
                )}
              >
                <span>Count</span>
                <span>{winnerName}</span>
                <span>{loserName}</span>
                <span className="text-emerald-700">Predicted merged</span>
              </div>
              <ul className="divide-y">
                {ASSOCIATION_ROLLUP_KEYS.map((key) => {
                  const valWinner = snapshot.winnerProps[key] ?? "0";
                  const valLoser = snapshot.loserProps[key] ?? "0";
                  const differs = valWinner !== valLoser;
                  const mergedVal = predictMergedAssociationRollup(valWinner, valLoser);
                  return (
                    <li
                      key={key}
                      className={cn(
                        "grid items-center gap-3 px-4 py-1.5 text-xs",
                        GRID_COLS,
                        differs && "bg-amber-50/40",
                      )}
                    >
                      <span className="font-medium">
                        {ASSOCIATION_ROLLUP_LABELS[key] ?? key}
                      </span>
                      <span className={cn(differs && "font-semibold text-amber-700")}>
                        {valWinner || "0"}
                      </span>
                      <span className={cn(differs && "font-semibold text-amber-700")}>
                        {valLoser || "0"}
                      </span>
                      <span className="font-semibold text-emerald-700">{mergedVal}</span>
                    </li>
                  );
                })}
              </ul>
            </div>

            <div className="space-y-3">
              <AssociatedRecordsSection
                title="Video Projects"
                recordsA={
                  (snapshot.winnerAssociations?.videoProjects as AssociatedRecord[] | undefined) ?? []
                }
                recordsB={
                  (snapshot.loserAssociations?.videoProjects as AssociatedRecord[] | undefined) ?? []
                }
                winnerSide="a"
                mergedColumnLabel="Predicted merged"
                renderChips={(r) => {
                  const tag = r.tag as string | undefined;
                  const status = r.status as string | undefined;
                  return (
                    <>
                      {tag && (
                        <Badge variant="outline" className="h-4 px-1 text-[9px]">{tag}</Badge>
                      )}
                      {status && (
                        <Badge variant="secondary" className="h-4 px-1 text-[9px]">{status}</Badge>
                      )}
                    </>
                  );
                }}
                buildUrl={(r) => hubspotVideoProjectUrl(r.id)}
              />
              <AssociatedRecordsSection
                title="External Clips"
                recordsA={
                  (snapshot.winnerAssociations?.externalClips as AssociatedRecord[] | undefined) ?? []
                }
                recordsB={
                  (snapshot.loserAssociations?.externalClips as AssociatedRecord[] | undefined) ?? []
                }
                winnerSide="a"
                mergedColumnLabel="Predicted merged"
                renderChips={(r) => {
                  const score = r.score as string | undefined;
                  return (
                    <>
                      {score && (
                        <Badge variant="outline" className="h-4 px-1 text-[9px]">{score}</Badge>
                      )}
                    </>
                  );
                }}
                buildUrl={(r) => hubspotClipUrl(r.id)}
              />
            </div>
          </CardContent>
        </Card>

        {/* Side-by-side property diff (3 columns: Winner / Loser / Predicted). */}
        <Card className="overflow-hidden p-0">
          <CardHeader className="gap-1.5 px-4 py-3">
            <div className={cn("grid items-center gap-3 text-sm", GRID_COLS)}>
              <CardTitle className="text-sm">Property</CardTitle>
              <SideHeader
                badgeText="Winner"
                badgeClass="border-emerald-300 bg-emerald-50 text-emerald-700"
                name={winnerName}
                rid={snapshot.winnerRecordId}
              />
              <SideHeader
                badgeText="Archived"
                badgeClass="border-rose-300 bg-rose-50 text-rose-700"
                name={loserName}
                rid={snapshot.loserRecordId}
              />
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <Badge
                    variant="outline"
                    className="h-5 border-emerald-300 bg-emerald-50 px-1.5 text-[10px] text-emerald-700"
                  >
                    <Check className="mr-0.5 h-3 w-3" />
                    Predicted merged
                  </Badge>
                </div>
                <div className="text-[11px] text-muted-foreground">
                  Winner wins on conflict; empty winner fields filled from loser
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {(["mismatch", "only_a", "only_b", "equal"] as PropDiffBucket[]).map((bucket) => {
              const rows = groupedDiff[bucket];
              if (rows.length === 0) return null;
              return (
                <section key={bucket} className="border-t first:border-t-0">
                  <div className="sticky top-0 z-10 border-b border-border/60 bg-muted px-4 py-1.5">
                    <span
                      className={cn(
                        "text-[11px] font-semibold uppercase tracking-wide",
                        BUCKET_HEADER_CLASS[bucket],
                      )}
                    >
                      {BUCKET_LABEL[bucket]}
                    </span>
                    <span className="ml-2 text-[11px] text-muted-foreground">
                      {rows.length}
                    </span>
                  </div>
                  <ul className="divide-y divide-border/60">
                    {rows.map((row) => {
                      // valueA/valueB in this view map to winner/loser
                      // because we passed (winnerProps, loserProps) into
                      // sortPropertiesForDiff in that order above.
                      const displayWinner = formatDisplayValue(row.key, row.valueA, ownersById);
                      const displayLoser = formatDisplayValue(row.key, row.valueB, ownersById);
                      const mergedRaw = mergedProps[row.key] ?? "";
                      const displayMerged = formatDisplayValue(row.key, mergedRaw, ownersById);
                      // Highlight the merged cell when the predicted value
                      // came from the loser (i.e. the winner's field was
                      // empty) — same affordance as the live view.
                      const filledFromLoser = !row.valueA.trim() && !!mergedRaw.trim();
                      return (
                        <li
                          key={row.key}
                          className={cn(
                            "grid items-start gap-3 px-4 py-2 text-xs",
                            GRID_COLS,
                            BUCKET_ROW_CLASS[row.bucket],
                          )}
                        >
                          <div className="font-medium text-foreground">{row.label}</div>
                          <PropValueCell value={displayWinner} rawValue={row.valueA} propKey={row.key} />
                          <PropValueCell value={displayLoser} rawValue={row.valueB} propKey={row.key} />
                          <div className={cn(filledFromLoser && "rounded-sm bg-emerald-50/70 px-1.5 py-0.5")}>
                            <PropValueCell value={displayMerged} rawValue={mergedRaw} propKey={row.key} />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
            {diff.length === 0 && (
              <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                Both records were entirely empty at merge time.
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex items-center gap-3">
      <Button
        variant="ghost"
        size="sm"
        className="h-8 cursor-pointer px-2"
        onClick={onBack}
      >
        <ArrowLeft className="mr-1.5 h-4 w-4" />
        Back to history
      </Button>
    </div>
  );
}

/** Compact column header for one of the three sides in the diff card.
 *  Mirrors the look of `CreatorHeader` in DuplicatePairDetail but takes a
 *  custom badge instead of a fixed "A" / "B" label. */
function SideHeader({
  badgeText,
  badgeClass,
  name,
  rid,
}: {
  badgeText: string;
  badgeClass: string;
  name: string;
  rid: string;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        <Badge variant="outline" className={cn("h-5 px-1.5 text-[10px]", badgeClass)}>
          {badgeText}
        </Badge>
        <span className="truncate text-sm font-medium">{name}</span>
        <button
          type="button"
          onClick={() => void openUrl(hubspotCreatorUrl(rid))}
          className="text-muted-foreground hover:text-foreground"
          title="Open in HubSpot"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="text-[11px] text-muted-foreground">id {rid}</div>
    </div>
  );
}
