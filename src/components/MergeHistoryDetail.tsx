/**
 * Read-only A/B/Live-merged comparison for a past merge.
 *
 * This view exists because HubSpot's native merge is destructive: once two
 * records are merged you cannot reconstruct what the loser looked like
 * beforehand from HubSpot itself. We capture a full pre-merge snapshot at
 * merge time (see `recordMergeResolution` in
 * `src/lib/duplicates/supabase.ts`) and replay it here.
 *
 * Two entry points:
 *
 *   - From the History list: the parent passes `snapshotId`. Used to
 *     review any past merge from `duplicate_merge_snapshots`.
 *   - From the "Resolved this session" list on the Duplicates page: the
 *     parent passes `pairKey`. We look up the most recent snapshot for
 *     that pair so the just-merged pair renders with the same archaeology
 *     instead of the empty live view (the loser is now archived in
 *     HubSpot, so a naive live fetch returns blanks).
 *
 * Layout intentionally mirrors {@link DuplicatePairDetail} — same Why /
 * License / Associations / Side-by-side cards — but:
 *   - Always 3 columns (Winner snapshot / Loser snapshot / Merged record (live)).
 *   - First two columns are sourced from Supabase, third column is sourced
 *     from a live HubSpot fetch of the surviving record. Cells where the
 *     live value diverges from the captured winner snapshot are
 *     highlighted to surface post-merge edits or HubSpot merge surprises.
 *   - When the live fetch fails or the snapshot is missing, we fall back
 *     to the predicted merged value (`predictMergedProperties`) and surface
 *     a warning banner so the reviewer knows what they're looking at.
 *   - Top banner records who/when, plus a "View merged record" shortcut
 *     into the surviving HubSpot record.
 *
 * If `pairKey` is provided but no snapshot exists (older merges, manual
 * resolutions, missing migration), we surface that to the parent via
 * `onSnapshotMissing` so it can swap us out for the live `DuplicatePairDetail`
 * fallback view.
 */

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ExternalLink,
  Loader2,
  Pencil,
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
  fetchMergeSnapshotByPairKey,
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

type Props = (
  | { snapshotId: string; pairKey?: undefined }
  | { snapshotId?: undefined; pairKey: string }
) & {
  /** Optional HubSpot token used to (a) resolve license-file ids → human
   *  filenames and (b) fetch the live state of the surviving record so the
   *  third column can show real post-merge data instead of a prediction.
   *  Without a token the chips fall back to showing raw ids and the third
   *  column falls back to the predicted-merged values. */
  token?: string;
  onBack: () => void;
  /** Custom label for the back button. Defaults to "Back to history".
   *  The Duplicates page passes "Back to duplicates" when surfacing this
   *  view from the session-resolved list. */
  backLabel?: string;
  /** Fired when no snapshot row exists for the given `pairKey`. The parent
   *  uses this to swap in a live fallback (`DuplicatePairDetail`) so the
   *  user always sees something rather than a hard error. Only meaningful
   *  in the `pairKey` entry-point; ignored in the `snapshotId` path. */
  onSnapshotMissing?: () => void;
};

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

// Three-column layout is constant in this view (winner / loser / live
// surviving record). Pulled out so the header and every row stay aligned.
const GRID_COLS = "grid-cols-[minmax(160px,200px)_1fr_1fr_1fr]";

// Header label for the third column. Was "Predicted merged" when the
// column showed `predictMergedProperties(...)`; now it always shows the
// live state of the surviving record (or the predicted value as a
// fallback when the live fetch fails — banner surfaces the fallback).
const MERGED_COLUMN_LABEL = "Merged record (live)";

interface CreatorRecord {
  id: string;
  properties: Record<string, string | null>;
}

interface FetchCreatorsResponse {
  results: CreatorRecord[];
}

interface CreatorAssociations {
  id: string;
  videoProjects: AssociatedRecord[];
  externalClips: AssociatedRecord[];
}

interface AssociationsResponse {
  results: CreatorAssociations[];
}

interface LiveWinnerData {
  props: Record<string, string>;
  associations: CreatorAssociations | null;
}

export function MergeHistoryDetail({
  snapshotId,
  pairKey,
  token,
  onBack,
  backLabel = "Back to history",
  onSnapshotMissing,
}: Props) {
  const [snapshot, setSnapshot] = useState<MergeSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // True after we've signalled `onSnapshotMissing` so the parent has a
  // tick to swap us out for the fallback view. While this is true we
  // keep rendering a neutral loader instead of the "Snapshot not found"
  // error — otherwise the user sees a flash of the error in the gap
  // between "we know snapshot is missing" and "parent re-renders us
  // with a different component".
  const [handingOff, setHandingOff] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSnapshot(null);
    setHandingOff(false);
    void (async () => {
      try {
        const s = pairKey
          ? await fetchMergeSnapshotByPairKey(pairKey)
          : snapshotId
            ? await fetchMergeSnapshot(snapshotId)
            : null;
        if (cancelled) return;
        if (!s) {
          if (pairKey && onSnapshotMissing) {
            // Tell the parent there's no snapshot for this pair so it
            // can render the live fallback view. Stay in a soft "handing
            // off" state until the parent's next render replaces us.
            setHandingOff(true);
            onSnapshotMissing();
            return;
          }
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
    // `onSnapshotMissing` intentionally omitted: callers passing a fresh
    // closure each render would otherwise force a re-fetch of the
    // snapshot every time. The latest closure is captured via the ref
    // pattern via React's stale-closure rules — fine here because the
    // missing-snapshot signal only matters once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshotId, pairKey]);

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

  const predictedMergedProps = useMemo<Record<string, string>>(() => {
    if (!snapshot) return {};
    return predictMergedProperties(snapshot.winnerProps, snapshot.loserProps);
  }, [snapshot]);

  // ── Live winner fetch (props + associations) ────────────────────────
  // Kicks off after the snapshot resolves so we know `winner_record_id`.
  // Loading and error are tracked separately so we can keep showing the
  // predicted merged data while live is in flight, and so we can surface
  // a clear "showing predicted as fallback" banner when the live fetch
  // fails (e.g. winner archived for unrelated reasons, network error,
  // expired token). The snapshot is the source of truth for the first
  // two columns regardless of live state.
  const [liveWinner, setLiveWinner] = useState<LiveWinnerData | null>(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);

  useEffect(() => {
    if (!snapshot) return;
    const winnerId = snapshot.winnerRecordId;
    if (!winnerId || !token) {
      setLiveWinner(null);
      setLiveError(null);
      setLiveLoading(false);
      return;
    }
    let cancelled = false;
    setLiveLoading(true);
    setLiveError(null);
    void (async () => {
      try {
        const [propsRes, assocRes] = await Promise.all([
          invoke<FetchCreatorsResponse>("fetch_creators_batch", {
            token,
            creatorIds: [winnerId],
          }),
          invoke<AssociationsResponse>("fetch_creator_associations_batch", {
            token,
            creatorIds: [winnerId],
          }),
        ]);
        if (cancelled) return;
        const propsRow = propsRes.results.find((r) => r.id === winnerId);
        const assocRow = assocRes.results.find((r) => r.id === winnerId);
        // HubSpot's batch read filters out archived records by default
        // (we don't pass `archived=true`), so a record that was archived
        // after the merge — or any record we can't read with the current
        // token — comes back as an empty `results` array. Treating that
        // as a successful fetch with `props={}` would paint every cell
        // in the third column as "—" with an "Edited" pill, which is a
        // lie. Surface it as an error instead so the column falls back
        // to predicted merged values and the amber banner explains why.
        if (!propsRow) {
          throw new Error(
            `Surviving record ${winnerId} returned no data from HubSpot. ` +
              `It may have been archived after the merge, or your token may ` +
              `lack access. Showing predicted merged values instead.`,
          );
        }
        const normalizedProps: Record<string, string> = {};
        for (const [k, v] of Object.entries(propsRow.properties)) {
          normalizedProps[k] = v == null ? "" : String(v);
        }
        setLiveWinner({
          props: normalizedProps,
          associations: assocRow ?? null,
        });
      } catch (err) {
        if (cancelled) return;
        setLiveError(err instanceof Error ? err.message : String(err));
        setLiveWinner(null);
      } finally {
        if (!cancelled) setLiveLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [snapshot, token]);

  // The third-column data source. Falls back to predicted merged when
  // live data isn't available (loading or failed). Once live data lands
  // we switch over and unlock the "edited since merge" highlight so the
  // user can see exactly which fields drift from the snapshot.
  const displayMergedProps = useMemo<Record<string, string>>(() => {
    return liveWinner?.props ?? predictedMergedProps;
  }, [liveWinner, predictedMergedProps]);

  // Live winner associations override the predicted union shown in the
  // third column. When live isn't available we let the primitive compute
  // the predicted union from snapshot winner+loser (the existing default
  // behavior of `AssociatedRecordsSection`).
  const liveVideoProjects = liveWinner?.associations?.videoProjects;
  const liveExternalClips = liveWinner?.associations?.externalClips;

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
    // Also include any file ids that appear only on the live winner so
    // the third column's chips resolve to filenames too.
    if (liveWinner) {
      for (const key of ["license_file", "traceability_file"] as const) {
        const raw = (liveWinner.props[key] ?? "").trim();
        if (!raw) continue;
        for (const tok of raw.split(/[;,\s]+/)) {
          const t = tok.trim();
          if (t) out.add(t);
        }
      }
    }
    return Array.from(out).sort();
  }, [snapshot, liveWinner]);
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

  if (loading || handingOff) {
    return (
      <div className="h-full overflow-auto">
        <div className="w-full space-y-4 px-4 py-4">
          <BackButton onBack={onBack} label={backLabel} />
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
          <BackButton onBack={onBack} label={backLabel} />
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
        <BackButton onBack={onBack} label={backLabel} />

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
              The first two columns show the snapshot captured at merge
              time. The third column shows the live HubSpot state of the
              surviving record. Cells highlighted in green changed since
              the merge.
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

        {/* Live-fetch status banners. Loading is a soft info banner so
            the user knows the third column will refresh shortly; error
            is amber and explains the fallback to predicted merged. */}
        {liveLoading && !liveWinner && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin" />
            <span className="min-w-0 break-words">
              Loading the current state of the surviving record from HubSpot…
              The third column shows the predicted merge until then.
            </span>
          </div>
        )}
        {liveError && !liveWinner && (
          <div className="flex flex-wrap items-start gap-2 rounded-md border border-amber-300 bg-amber-50/70 px-3 py-2 text-xs text-amber-900">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            <span className="min-w-0 break-words">
              Couldn&apos;t load the live state of the surviving record:
              {" "}{liveError}. The third column is showing the predicted
              merged values as a fallback.
            </span>
          </div>
        )}

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
            always 3 columns (Winner / Loser / Merged record (live)). The
            third column is sourced from `displayMergedProps` which is the
            live winner data when available, predicted merged when not. */}
        <Card>
          <CardHeader className="gap-1.5">
            <CardTitle className="text-base">License Information</CardTitle>
            <CardDescription className="text-xs">
              Side-by-side license fields. The first two columns are from
              the snapshot; the third is the current state of the surviving
              record.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LicenseInfoCard
              propsA={snapshot.winnerProps}
              propsB={snapshot.loserProps}
              mergedProps={displayMergedProps}
              nameA={winnerName}
              nameB={loserName}
              mergedColumnLabel={MERGED_COLUMN_LABEL}
              fileNamesById={fileNamesById}
            />
          </CardContent>
        </Card>

        {/* Associations card — counts table + records sections. The third
            column counts come from live winner properties when available;
            the records lists come from the live winner associations. */}
        <Card>
          <CardHeader className="gap-1.5">
            <CardTitle className="text-base">Associations</CardTitle>
            <CardDescription className="text-xs">
              First two columns: snapshot. Third column: live HubSpot
              associations of the surviving record.
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
                <span className="text-emerald-700">{MERGED_COLUMN_LABEL}</span>
              </div>
              <ul className="divide-y">
                {ASSOCIATION_ROLLUP_KEYS.map((key) => {
                  const valWinner = snapshot.winnerProps[key] ?? "0";
                  const valLoser = snapshot.loserProps[key] ?? "0";
                  const differs = valWinner !== valLoser;
                  // Live count when we have it; otherwise predicted sum.
                  const liveVal = liveWinner?.props[key];
                  const mergedVal = liveVal != null
                    ? liveVal || "0"
                    : predictMergedAssociationRollup(valWinner, valLoser);
                  // Edited-since-merge highlight: live count differs from
                  // the snapshot winner count. Empty (no live yet) → no
                  // highlight.
                  const editedSinceMerge =
                    !!liveWinner &&
                    (liveVal ?? "0").trim() !== (valWinner ?? "0").trim();
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
                      <span
                        className={cn(
                          "font-semibold text-emerald-700",
                          editedSinceMerge &&
                            "rounded-sm bg-emerald-100/80 px-1.5 py-0.5",
                        )}
                        title={
                          editedSinceMerge
                            ? "Changed since the merge"
                            : undefined
                        }
                      >
                        {mergedVal}
                      </span>
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
                mergedColumnLabel={MERGED_COLUMN_LABEL}
                mergedRecordsOverride={liveVideoProjects}
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
                mergedColumnLabel={MERGED_COLUMN_LABEL}
                mergedRecordsOverride={liveExternalClips}
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

        {/* Side-by-side property diff (3 columns: Winner snapshot / Loser
            snapshot / Merged record (live)). Cells where the live winner
            value diverges from the captured winner snapshot are tagged
            with an "Edited" pill so the reviewer can spot post-merge
            edits at a glance. */}
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
                    {MERGED_COLUMN_LABEL}
                  </Badge>
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {liveWinner
                    ? "Current data from HubSpot for the surviving record"
                    : liveLoading
                      ? "Loading current data… showing predicted merged"
                      : "Predicted merged (live data unavailable)"}
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
                      const mergedRaw = displayMergedProps[row.key] ?? "";
                      const displayMerged = formatDisplayValue(row.key, mergedRaw, ownersById);
                      // Edited-since-merge highlight: live data is loaded
                      // and the value diverges from the captured winner
                      // snapshot. The trim is important because HubSpot
                      // sometimes returns whitespace-only diffs for
                      // unchanged fields.
                      const editedSinceMerge =
                        !!liveWinner &&
                        mergedRaw.trim() !== row.valueA.trim();
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
                          <div
                            className={cn(
                              editedSinceMerge && "rounded-sm bg-emerald-50/70 px-1.5 py-0.5",
                            )}
                            title={editedSinceMerge ? "Changed since the merge" : undefined}
                          >
                            {editedSinceMerge && (
                              <div className="mb-0.5 inline-flex items-center gap-1 rounded-sm bg-emerald-100 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-700">
                                <Pencil className="h-2.5 w-2.5" />
                                Edited
                              </div>
                            )}
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

function BackButton({ onBack, label }: { onBack: () => void; label: string }) {
  return (
    <div className="flex items-center gap-3">
      <Button
        variant="ghost"
        size="sm"
        className="h-8 cursor-pointer px-2"
        onClick={onBack}
      >
        <ArrowLeft className="mr-1.5 h-4 w-4" />
        {label}
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
