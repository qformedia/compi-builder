/**
 * Side-by-side detail view for a single duplicate pair.
 *
 * Both creators are fetched LIVE from HubSpot via `fetch_creators_batch`
 * (which now returns the full property set defined in
 * `helpers::full_creator_properties`). We do not rely on the cached CSV for
 * the comparison values — the cache can be hours old and this page exists
 * specifically to support a resolution decision, so always show the freshest
 * truth.
 *
 * Presence is broadcast via the parent's `roomRef.setActivePair(pairKey)`
 * call. We just consume the resulting `otherViewers` prop here. The local
 * viewer is excluded by the parent so the footer never shows your own name.
 *
 * v1: read-only. No "Mark resolved" / "Mark not-a-duplicate" buttons yet.
 */

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ExternalLink,
  GitMerge,
  Loader2,
  Users,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { HubSpotIcon } from "@/components/ClipCard";
import {
  CREATOR_PROPERTY_LABELS,
  sortPropertiesForDiff,
  predictMergedProperties,
  predictMergedAssociationRollup,
  ASSOCIATION_ROLLUP_KEYS,
  ASSOCIATION_ROLLUP_LABELS,
  type PropDiff,
  type PropDiffBucket,
} from "@/lib/duplicates/diff";
import type { DuplicatePair } from "@/lib/duplicates/find-pairs";
import {
  describeSupabaseError,
  recordMergeResolution,
  type PresenceEntry,
} from "@/lib/duplicates/supabase";
import { hubspotClipUrl, hubspotCreatorUrl, hubspotVideoProjectUrl } from "@/lib/hubspot-urls";
import {
  AssociatedRecordsSection,
  LicenseInfoCard,
  PropValueCell,
  StatusPill,
  formatDisplayValue,
  type AssociatedRecord,
  type HubspotFileInfo,
} from "@/components/duplicate-pair-view-primitives";

interface CreatorRecord {
  id: string;
  properties: Record<string, string | null>;
}

interface FetchResponse {
  results: CreatorRecord[];
}

interface Props {
  pair: DuplicatePair;
  token: string;
  /** Local viewer's presence name; passed in only so we can sanity-check the
   *  list of other viewers (the parent already filters self out). Also used
   *  as the actor name when persisting a merge to the audit log. */
  localUser: string;
  otherViewers: PresenceEntry[];
  /** When set, the pair has already been merged in HubSpot during this
   *  session and the value is the surviving record's id. The detail view
   *  switches into a read-only mode: the "Pick winner & merge" card is
   *  replaced by an "Already merged" status card pointing at this record so
   *  the user can sanity-check the merged data. */
  resolvedSurvivingRid?: string | null;
  onBack: () => void;
  /** Called after a successful HubSpot merge. The parent is responsible for
   *  refreshing the creators export (the loser is now archived) and
   *  navigating back to the list. */
  onMergeSuccess?: (winnerRecordId: string, loserRecordId: string) => void;
}

interface CreatorAssociations {
  id: string;
  videoProjects: AssociatedRecord[];
  externalClips: AssociatedRecord[];
}

interface AssociationsResponse {
  results: CreatorAssociations[];
}

interface OwnerRecord {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
}

/** Build the "Firstname Lastname" / email fallback that we use across the app
 *  whenever a HubSpot owner needs to be shown to a human. */
function ownerDisplayName(o: OwnerRecord): string {
  const full = `${o.firstName ?? ""} ${o.lastName ?? ""}`.trim();
  return full || o.email || o.id;
}

const BUCKET_LABEL: Record<PropDiffBucket, string> = {
  mismatch: "Differs",
  only_a: "Only on A",
  only_b: "Only on B",
  equal: "Identical",
};

const BUCKET_ROW_CLASS: Record<PropDiffBucket, string> = {
  mismatch: "bg-amber-50/40",
  only_a: "",
  only_b: "",
  equal: "",
};

const BUCKET_HEADER_CLASS: Record<PropDiffBucket, string> = {
  mismatch: "text-amber-700",
  only_a: "text-sky-700",
  only_b: "text-sky-700",
  equal: "text-muted-foreground",
};

export function DuplicatePairDetail({
  pair,
  token,
  localUser,
  otherViewers,
  resolvedSurvivingRid = null,
  onBack,
  onMergeSuccess,
}: Props) {
  const isAlreadyMerged = !!resolvedSurvivingRid;
  const [props, setProps] = useState<{ a: Record<string, string>; b: Record<string, string> } | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ── Merge state ─────────────────────────────────────────────────────────
  // `winnerSide` drives the optional 3rd "Merged" preview column across the
  // Status / Associations / Property cards and unlocks the Merge button. The
  // confirmation dialog is the gate before any HubSpot write happens.
  const [winnerSide, setWinnerSide] = useState<"a" | "b" | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  // Non-fatal: HubSpot succeeded but Supabase audit didn't. Surface as a
  // warning banner instead of treating the merge as failed.
  const [mergeWarning, setMergeWarning] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        if (!token) throw new Error("HubSpot token is not configured");
        const res = await invoke<FetchResponse>("fetch_creators_batch", {
          token,
          creatorIds: [pair.a.rid, pair.b.rid],
        });
        if (cancelled) return;
        const map = new Map(res.results.map((r) => [r.id, normalizeProps(r.properties)]));
        setProps({
          a: map.get(pair.a.rid) ?? {},
          b: map.get(pair.b.rid) ?? {},
        });
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pair.a.rid, pair.b.rid, token]);

  // ── Owners fetch — used to resolve `hubspot_owner_id` (a numeric string)
  // into a friendly "First Last" / email label in the diff table. Failure is
  // non-fatal: we just fall back to the raw id, same as before this fetch
  // existed. ────────────────────────────────────────────────────────────────
  const [ownersById, setOwnersById] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void (async () => {
      try {
        const owners = await invoke<OwnerRecord[]>("list_owners", { token });
        if (cancelled) return;
        const map = new Map<string, string>();
        for (const o of owners) map.set(String(o.id), ownerDisplayName(o));
        setOwnersById(map);
      } catch {
        // Silent: the column will keep showing the id, which is still
        // unambiguous when paired with the HubSpot record link in the header.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // ── Associations fetch (parallel, independent) ──────────────────────────
  const [assocData, setAssocData] = useState<{
    a: CreatorAssociations | null;
    b: CreatorAssociations | null;
  } | null>(null);
  const [assocLoading, setAssocLoading] = useState(true);
  const [assocError, setAssocError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setAssocLoading(true);
    setAssocError(null);
    (async () => {
      try {
        if (!token) throw new Error("HubSpot token is not configured");
        const res = await invoke<AssociationsResponse>(
          "fetch_creator_associations_batch",
          { token, creatorIds: [pair.a.rid, pair.b.rid] },
        );
        if (cancelled) return;
        const map = new Map(res.results.map((r) => [r.id, r]));
        setAssocData({
          a: map.get(pair.a.rid) ?? null,
          b: map.get(pair.b.rid) ?? null,
        });
      } catch (err) {
        if (cancelled) return;
        setAssocError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setAssocLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pair.a.rid, pair.b.rid, token]);

  // ── Resolve HubSpot file ids → filenames for the License Information
  // chips. Lazy / best-effort: fires only when the underlying license_file
  // or traceability_file values change, and a failure leaves
  // `fileNamesById` empty so the chips fall back to showing the id. ────
  const [fileNamesById, setFileNamesById] = useState<Map<string, HubspotFileInfo>>(
    new Map(),
  );
  const fileIds = useMemo<string[]>(() => {
    if (!props) return [];
    const out = new Set<string>();
    for (const side of [props.a, props.b]) {
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
  }, [props]);
  // Stable cache key so the effect re-runs only when the *set* of ids
  // changes, not on every render that produces a new array reference.
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
        // Silent: chip falls back to the raw id, which is still a
        // working link into HubSpot via the file-preview URL.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, fileIdsKey]);

  const diff = useMemo<PropDiff[]>(() => {
    if (!props) return [];
    return sortPropertiesForDiff(props.a, props.b);
  }, [props]);

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

  // The parent already filters self out, but defence-in-depth: also drop any
  // accidental self-entry here in case the parent didn't have `localUser`
  // resolved by the time it rendered.
  const displayedViewers = useMemo(
    () => otherViewers.filter((v) => v.user !== localUser),
    [otherViewers, localUser],
  );

  const aName = pair.a.name || pair.a.rid;
  const bName = pair.b.name || pair.b.rid;

  // ── Merge derived state ────────────────────────────────────────────────
  // Resolve which sides correspond to winner/loser once `winnerSide` is set,
  // so every consumer of "the predicted merge" reads from the same source
  // of truth (no place where one section computes winner=A and another
  // computes winner=B).
  const winnerRid = winnerSide === "a" ? pair.a.rid : winnerSide === "b" ? pair.b.rid : null;
  const loserRid = winnerSide === "a" ? pair.b.rid : winnerSide === "b" ? pair.a.rid : null;
  const winnerName = winnerSide === "a" ? aName : winnerSide === "b" ? bName : "";
  const loserName = winnerSide === "a" ? bName : winnerSide === "b" ? aName : "";

  const mergedProps = useMemo<Record<string, string> | null>(() => {
    if (!props || !winnerSide) return null;
    const winner = winnerSide === "a" ? props.a : props.b;
    const loser = winnerSide === "a" ? props.b : props.a;
    return predictMergedProperties(winner, loser);
  }, [props, winnerSide]);

  /** Header label for the predicted-merge column ("A Merged" / "B Merged"). */
  const mergedColumnLabel = winnerSide
    ? `${winnerSide.toUpperCase()} Merged`
    : null;

  // ── Merge action handler ───────────────────────────────────────────────
  // Strict ordering: HubSpot merge first, then Supabase audit. If HubSpot
  // fails we surface the error and never write to Supabase. If HubSpot
  // succeeds but Supabase fails we still treat the operation as a success
  // for the user (the irreversible write already happened) but warn so they
  // can manually re-run the audit if needed.
  async function handleMergeConfirm() {
    if (!winnerRid || !loserRid) return;
    setMerging(true);
    setMergeError(null);
    setMergeWarning(null);
    // HubSpot's merge endpoint may return a different primary id than the
    // one we sent (it picks the canonical surviving record id, which can
    // differ from `primaryObjectId` when there have been prior merges
    // touching either side). We persist *that* id into the snapshot and
    // resolution row so the History view's live-winner fetch hits a
    // record that actually exists in HubSpot. Falling back to `winnerRid`
    // keeps the prior behaviour for the common case where the API
    // response shape doesn't expose an id.
    let actualWinnerRid = winnerRid;
    try {
      const directRes = await invoke<unknown>("merge_creators", {
        token,
        winnerId: winnerRid,
        loserId: loserRid,
      });
      actualWinnerRid = extractMergedRecordId(directRes) ?? winnerRid;
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : String(err));
      setMerging(false);
      return;
    }
    if (actualWinnerRid !== winnerRid) {
      console.info(
        `[duplicates] HubSpot resolved primary id ${winnerRid} → ${actualWinnerRid} during merge. ` +
          "Using HubSpot's canonical id for the snapshot.",
      );
    }

    try {
      // Capture the full pre-merge state so the History view can render an
      // A/B/Predicted-merged comparison later. Both `props` and `assocData`
      // are guaranteed non-null here because the Merge button is disabled
      // until both fetches complete (the loading branch above the merge
      // card is mutually exclusive). Associations are still wrapped in a
      // null fallback because the associations fetch can fail
      // independently and we'd rather record the property snapshot on a
      // best-effort basis than skip the snapshot entirely.
      const winnerProps = winnerSide === "a" ? props!.a : props!.b;
      const loserProps = winnerSide === "a" ? props!.b : props!.a;
      const winnerAssoc = winnerSide === "a" ? assocData?.a ?? null : assocData?.b ?? null;
      const loserAssoc = winnerSide === "a" ? assocData?.b ?? null : assocData?.a ?? null;
      await recordMergeResolution({
        pairKey: pair.pairKey,
        winnerRecordId: actualWinnerRid,
        loserRecordId: loserRid,
        actor: localUser,
        snapshot: {
          network: pair.network,
          canonicalUrl: pair.canonicalUrl,
          winnerName: winnerSide === "a" ? aName : bName,
          loserName: winnerSide === "a" ? bName : aName,
          winnerProps,
          loserProps,
          winnerAssociations: winnerAssoc
            ? {
                videoProjects: winnerAssoc.videoProjects ?? [],
                externalClips: winnerAssoc.externalClips ?? [],
              }
            : null,
          loserAssociations: loserAssoc
            ? {
                videoProjects: loserAssoc.videoProjects ?? [],
                externalClips: loserAssoc.externalClips ?? [],
              }
            : null,
          ownersById: Object.fromEntries(ownersById),
        },
      });
    } catch (err) {
      setMergeWarning(
        `Merge succeeded in HubSpot, but couldn't record the audit row: ${describeSupabaseError(err)}. ` +
          "The pair may briefly reappear until the next refresh, and the merge may not show up in History.",
      );
    }

    setConfirmOpen(false);
    setMerging(false);
    onMergeSuccess?.(actualWinnerRid, loserRid);
  }

  return (
    <div className="h-full overflow-auto">
      <div className="w-full space-y-4 px-4 py-4">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 cursor-pointer px-2"
            onClick={onBack}
          >
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            Back to duplicates
          </Button>
        </div>

        {/* "Why" card */}
        <Card>
          <CardHeader className="gap-1.5">
            <CardTitle className="text-base">Why this is a potential duplicate</CardTitle>
            <CardDescription className="text-xs">
              The same canonical {pair.network} URL was found across both records.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="capitalize">{pair.network}</Badge>
              <button
                type="button"
                onClick={() => void openUrl(pair.canonicalUrl)}
                className="inline-flex items-center gap-1 truncate text-primary hover:underline"
                title="Open canonical URL"
              >
                <span className="truncate">{pair.canonicalUrl}</span>
                <ExternalLink className="h-3 w-3 flex-shrink-0" />
              </button>
              {pair.source.map((s) => (
                <Badge key={s} variant="secondary" className="text-[10px]">
                  {humanizeSource(s)}
                </Badge>
              ))}
            </div>
            <div className="rounded-md bg-muted/40 px-3 py-2 text-xs">
              <span className="font-medium">{aName}</span>
              <button
                type="button"
                onClick={() => void openUrl(hubspotCreatorUrl(pair.a.rid))}
                className="ml-1 inline-flex text-muted-foreground hover:text-orange-500"
                title="Open in HubSpot"
              >
                <HubSpotIcon className="h-3 w-3" />
              </button>
              {pair.a.columns.length > 0 && (
                <> · <span className="text-muted-foreground">{pair.a.columns.join(", ")}</span></>
              )}
              <span className="mx-2 text-muted-foreground">==</span>
              <span className="font-medium">{bName}</span>
              <button
                type="button"
                onClick={() => void openUrl(hubspotCreatorUrl(pair.b.rid))}
                className="ml-1 inline-flex text-muted-foreground hover:text-orange-500"
                title="Open in HubSpot"
              >
                <HubSpotIcon className="h-3 w-3" />
              </button>
              {pair.b.columns.length > 0 && (
                <> · <span className="text-muted-foreground">{pair.b.columns.join(", ")}</span></>
              )}
            </div>
          </CardContent>
        </Card>

        {/* License Information card — surfaced above Associations because
            the licensing state (status, license file, traceability file,
            granted date, etc.) is the single most decision-driving signal
            when triaging a duplicate. Mirrors HubSpot's own License
            Information property card so the reviewer sees the same
            grouping they're already used to. */}
        <Card>
          <CardHeader className="gap-1.5">
            <CardTitle className="text-base">License Information</CardTitle>
            <CardDescription className="text-xs">
              Current HubSpot license fields for each creator. Differing
              non-empty values are highlighted.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LicenseInfoCard
              propsA={props?.a ?? {}}
              propsB={props?.b ?? {}}
              mergedProps={mergedProps}
              nameA={aName}
              nameB={bName}
              mergedColumnLabel={mergedColumnLabel}
              loading={!props}
              fileNamesById={fileNamesById}
            />
          </CardContent>
        </Card>

        {/* Associations card */}
        <Card>
          <CardHeader className="gap-1.5">
            <CardTitle className="text-base">Associations</CardTitle>
            <CardDescription className="text-xs">
              Rollup counts and associated records for each side.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Counts table */}
            {props ? (
              (() => {
                const headerGrid = winnerSide
                  ? "grid-cols-[minmax(160px,200px)_1fr_1fr_1fr]"
                  : "grid-cols-[minmax(160px,200px)_1fr_1fr]";
                return (
                  <div className="rounded-md border">
                    <div
                      className={cn(
                        "grid items-center gap-3 border-b bg-muted/40 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground",
                        headerGrid,
                      )}
                    >
                      <span>Count</span>
                      <span>{aName}</span>
                      <span>{bName}</span>
                      {winnerSide && (
                        <span className="text-emerald-700">{mergedColumnLabel}</span>
                      )}
                    </div>
                    <ul className="divide-y">
                      {ASSOCIATION_ROLLUP_KEYS.map((key) => {
                        const valA = props.a[key] ?? "0";
                        const valB = props.b[key] ?? "0";
                        const differs = valA !== valB;
                        const mergedVal = winnerSide
                          ? predictMergedAssociationRollup(
                              winnerSide === "a" ? valA : valB,
                              winnerSide === "a" ? valB : valA,
                            )
                          : null;
                        return (
                          <li
                            key={key}
                            className={cn(
                              "grid items-center gap-3 px-4 py-1.5 text-xs",
                              headerGrid,
                              differs && "bg-amber-50/40",
                            )}
                          >
                            <span className="font-medium">
                              {ASSOCIATION_ROLLUP_LABELS[key] ?? key}
                            </span>
                            <span className={cn(differs && "font-semibold text-amber-700")}>
                              {valA || "0"}
                            </span>
                            <span className={cn(differs && "font-semibold text-amber-700")}>
                              {valB || "0"}
                            </span>
                            {winnerSide && mergedVal !== null && (
                              <span className="font-semibold text-emerald-700">
                                {mergedVal}
                              </span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })()
            ) : (
              <div className="h-24 animate-pulse rounded-md bg-muted/60" />
            )}

            {/* Associated records */}
            {assocLoading ? (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-10 animate-pulse rounded-md bg-muted/60" />
                ))}
              </div>
            ) : assocError ? (
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="min-w-0 break-words">{assocError}</span>
              </div>
            ) : assocData ? (
              <div className="space-y-3">
                <AssociatedRecordsSection
                  title="Video Projects"
                  recordsA={assocData.a?.videoProjects ?? []}
                  recordsB={assocData.b?.videoProjects ?? []}
                  winnerSide={winnerSide}
                  mergedColumnLabel={mergedColumnLabel}
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
                  recordsA={assocData.a?.externalClips ?? []}
                  recordsB={assocData.b?.externalClips ?? []}
                  winnerSide={winnerSide}
                  mergedColumnLabel={mergedColumnLabel}
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
            ) : null}
          </CardContent>
        </Card>

        {/* Side-by-side */}
        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-10 animate-pulse rounded-md bg-muted/60" />
            ))}
          </div>
        ) : error ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        ) : (
          <Card className="overflow-hidden p-0">
            <CardHeader className="gap-1.5 px-4 py-3">
              <div
                className={cn(
                  "grid items-center gap-3 text-sm",
                  winnerSide
                    ? "grid-cols-[minmax(160px,200px)_1fr_1fr_1fr]"
                    : "grid-cols-[minmax(160px,200px)_1fr_1fr]",
                )}
              >
                <CardTitle className="text-sm">Property</CardTitle>
                <CreatorHeader name={aName} rid={pair.a.rid} sideLabel="A" />
                <CreatorHeader name={bName} rid={pair.b.rid} sideLabel="B" />
                {winnerSide && (
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <Badge
                        variant="outline"
                        className="h-5 border-emerald-300 bg-emerald-50 px-1.5 text-[10px] text-emerald-700"
                      >
                        <Check className="mr-0.5 h-3 w-3" />
                        {mergedColumnLabel}
                      </Badge>
                      <span className="truncate text-sm font-medium text-emerald-700">
                        Predicted merged record
                      </span>
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      Winner wins on conflict; empty winner fields filled from loser
                    </div>
                  </div>
                )}
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
                        const displayA = formatDisplayValue(row.key, row.valueA, ownersById);
                        const displayB = formatDisplayValue(row.key, row.valueB, ownersById);
                        const mergedRaw = mergedProps?.[row.key] ?? "";
                        const displayMerged = formatDisplayValue(row.key, mergedRaw, ownersById);
                        // Highlight the merged cell when the predicted value
                        // came from the loser (i.e. winner's field was empty).
                        // That's the only case where the merged record gains
                        // information the winner alone wouldn't have, and it's
                        // the most useful thing to draw the reviewer's eye to.
                        const winnerRaw = winnerSide
                          ? winnerSide === "a"
                            ? row.valueA
                            : row.valueB
                          : "";
                        const filledFromLoser =
                          !!winnerSide && !winnerRaw.trim() && !!mergedRaw.trim();
                        return (
                          <li
                            key={row.key}
                            className={cn(
                              "grid items-start gap-3 px-4 py-2 text-xs",
                              winnerSide
                                ? "grid-cols-[minmax(160px,200px)_1fr_1fr_1fr]"
                                : "grid-cols-[minmax(160px,200px)_1fr_1fr]",
                              BUCKET_ROW_CLASS[row.bucket],
                            )}
                          >
                            <div className="font-medium text-foreground">{row.label}</div>
                            <PropValueCell value={displayA} rawValue={row.valueA} propKey={row.key} />
                            <PropValueCell value={displayB} rawValue={row.valueB} propKey={row.key} />
                            {winnerSide && (
                              <div className={cn(filledFromLoser && "rounded-sm bg-emerald-50/70 px-1.5 py-0.5")}>
                                <PropValueCell
                                  value={displayMerged}
                                  rawValue={mergedRaw}
                                  propKey={row.key}
                                />
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                );
              })}
              {diff.length === 0 && (
                <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                  Both creators are entirely empty. Open the records in HubSpot for the full picture.
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Pick winner + merge action / Already-merged status.
            This is the only write surface on the page. We deliberately put
            it BELOW the comparison cards so the reviewer scrolls through
            all the differences before deciding. When the pair was already
            merged in this session, this slot becomes a read-only status
            card pointing at the surviving record instead. */}
        {props && isAlreadyMerged ? (
          <Card className="border-emerald-300 bg-emerald-50/40">
            <CardHeader className="gap-1.5">
              <CardTitle className="flex items-center gap-2 text-base text-emerald-900">
                <Check className="h-4 w-4 text-emerald-600" />
                This pair has already been merged
              </CardTitle>
              <CardDescription className="text-xs text-emerald-900/80">
                Merge actions are disabled. The data above reflects what's currently
                in HubSpot — the archived side may show as empty since archived
                records aren't returned by the API.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex items-center justify-end">
              <Button
                variant="outline"
                size="sm"
                className="cursor-pointer border-emerald-400 text-emerald-800 hover:bg-emerald-100/60"
                onClick={() =>
                  resolvedSurvivingRid &&
                  void openUrl(hubspotCreatorUrl(resolvedSurvivingRid))
                }
              >
                <ExternalLink className="mr-1.5 h-4 w-4" />
                View merged record in HubSpot
              </Button>
            </CardContent>
          </Card>
        ) : props ? (
          <Card>
            <CardHeader className="gap-1.5">
              <CardTitle className="text-base">Pick winner & merge</CardTitle>
              <CardDescription className="text-xs">
                Select which record survives. The other record will be archived in HubSpot
                and its associations transferred to the winner. This cannot be undone.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <WinnerCard
                  side="a"
                  name={aName}
                  rid={pair.a.rid}
                  status={(props.a.status ?? "").trim()}
                  selected={winnerSide === "a"}
                  otherSelected={winnerSide === "b"}
                  onSelect={() => setWinnerSide("a")}
                />
                <WinnerCard
                  side="b"
                  name={bName}
                  rid={pair.b.rid}
                  status={(props.b.status ?? "").trim()}
                  selected={winnerSide === "b"}
                  otherSelected={winnerSide === "a"}
                  onSelect={() => setWinnerSide("b")}
                />
              </div>

              {mergeError && (
                <div className="flex flex-wrap items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                  <span className="min-w-0 break-words">{mergeError}</span>
                </div>
              )}

              {mergeWarning && (
                <div className="flex flex-wrap items-start gap-2 rounded-md border border-amber-300 bg-amber-50/70 px-3 py-2 text-xs text-amber-800">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                  <span className="min-w-0 break-words">{mergeWarning}</span>
                </div>
              )}

              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="default"
                  size="sm"
                  className="cursor-pointer"
                  disabled={!winnerSide || merging}
                  onClick={() => setConfirmOpen(true)}
                >
                  <GitMerge className="mr-1.5 h-4 w-4" />
                  {winnerSide ? `Merge into ${winnerSide.toUpperCase()}` : "Merge"}
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : null}

        {/* Other viewers footer */}
        {displayedViewers.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border bg-emerald-50/40 px-3 py-2 text-xs text-emerald-800">
            <Users className="h-3.5 w-3.5 flex-shrink-0" />
            <span>Other viewers right now:</span>
            {displayedViewers.map((v, i) => (
              <span key={`${v.user}-${i}`} className="inline-flex items-center gap-1">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
                {v.user}
              </span>
            ))}
          </div>
        )}

        {/* Confirmation modal — last chance to bail before the irreversible
            HubSpot call. We disable the close button while merging is in
            flight so the user can't end up with a "did it succeed?" race. */}
        <Dialog
          open={confirmOpen}
          onOpenChange={(open) => {
            if (!open && merging) return;
            setConfirmOpen(open);
            if (!open) setMergeError(null);
          }}
        >
          <DialogContent showCloseButton={!merging}>
            <DialogHeader>
              <DialogTitle>Merge duplicate creators?</DialogTitle>
              <DialogDescription>
                {winnerSide ? (
                  <>
                    All data from <span className="font-medium text-foreground">{loserName}</span>{" "}
                    will be merged into{" "}
                    <span className="font-medium text-foreground">{winnerName}</span>.
                  </>
                ) : (
                  "Pick a winner first."
                )}
              </DialogDescription>
            </DialogHeader>
            <ul className="space-y-1.5 text-xs text-muted-foreground">
              <li>
                <span className="font-medium text-foreground">Conflicting field values:</span>{" "}
                kept from {winnerName || "the winner"}.
              </li>
              <li>
                <span className="font-medium text-foreground">Empty winner fields:</span>{" "}
                filled from {loserName || "the loser"}.
              </li>
              <li>
                <span className="font-medium text-foreground">Create date:</span>{" "}
                the older create date is kept, regardless of which record wins.
              </li>
              <li>
                <span className="font-medium text-foreground">All associations</span> (Contacts,
                External Clips, Video Projects, Send Link Actions, Social Interactions, Public
                Video Projects) move to {winnerName || "the winner"}.
              </li>
              <li>
                <span className="font-medium text-foreground">{loserName || "The loser"}</span>{" "}
                will be archived in HubSpot. <span className="font-medium">This cannot be undone.</span>
              </li>
            </ul>
            {mergeError && (
              <div className="flex flex-wrap items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                <span className="min-w-0 break-words">{mergeError}</span>
              </div>
            )}
            <DialogFooter>
              <Button
                variant="outline"
                size="sm"
                className="cursor-pointer"
                disabled={merging}
                onClick={() => setConfirmOpen(false)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                className="cursor-pointer"
                disabled={!winnerSide || merging}
                onClick={() => void handleMergeConfirm()}
              >
                {merging ? (
                  <>
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                    Merging…
                  </>
                ) : (
                  <>
                    <GitMerge className="mr-1.5 h-4 w-4" />
                    Merge now
                  </>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

/** Single radio-style card in the winner picker. Selected card gets a
 *  visually strong border + Winner badge; the unselected sibling fades to
 *  muted with a "Will be archived" badge so the reviewer always sees the
 *  consequence of their choice. */
function WinnerCard({
  side,
  name,
  rid,
  status,
  selected,
  otherSelected,
  onSelect,
}: {
  side: "a" | "b";
  name: string;
  rid: string;
  status: string;
  selected: boolean;
  otherSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex w-full flex-col items-start gap-2 rounded-md border p-3 text-left transition-colors",
        "hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected && "border-emerald-400 bg-emerald-50/40 ring-1 ring-emerald-200",
        otherSelected && "opacity-60",
      )}
    >
      <div className="flex w-full items-center gap-2">
        <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
          {side.toUpperCase()}
        </Badge>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
        {selected && (
          <Badge className="h-5 bg-emerald-500 px-1.5 text-[10px] text-white hover:bg-emerald-500">
            <Check className="mr-0.5 h-3 w-3" />
            Winner
          </Badge>
        )}
        {otherSelected && (
          <Badge variant="outline" className="h-5 border-rose-300 px-1.5 text-[10px] text-rose-700">
            Will be archived
          </Badge>
        )}
      </div>
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>id {rid}</span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void openUrl(hubspotCreatorUrl(rid));
          }}
          className="inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground"
          title="Open in HubSpot"
        >
          <ExternalLink className="h-3 w-3" />
        </button>
      </div>
      {status && <StatusPill value={status} />}
    </button>
  );
}

function CreatorHeader({
  name,
  rid,
  sideLabel,
}: {
  name: string;
  rid: string;
  sideLabel: "A" | "B";
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
          {sideLabel}
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

function normalizeProps(props: Record<string, string | null>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(props)) {
    out[k] = v == null ? "" : String(v);
  }
  return out;
}

/** Map detector source codes to short user-facing chips on the why-card. */
function humanizeSource(s: string): string {
  switch (s) {
    case "canonical_collision":
      return "Same canonical URL";
    case "multi_url_collision":
      return "Inside a multi-URL cell";
    case "bare_handle_promotion":
      return "Bare handle promoted";
    default:
      return s;
  }
}

// Re-export the labels constant so consumers wanting to map property keys
// can avoid an extra import. (No-op cost; tree-shaken if unused.)
export { CREATOR_PROPERTY_LABELS };

/**
 * Extract the canonical surviving-record id from a HubSpot merge response.
 *
 * HubSpot's merge endpoint always echoes the surviving object under
 * different keys depending on which API version / object type the request
 * hit. We accept the most common shapes seen in production:
 *
 *   - `{ id: "..." }`            — modern CRM objects API.
 *   - `{ vid: 123 }`             — legacy contact merge.
 *   - `{ objectId: "..." }`      — some object-type merges.
 *   - `{ properties: { hs_object_id: "..." } }` — when the response
 *     includes the merged object's properties.
 *
 * Returns `null` when nothing recognisable is present so callers can fall
 * back to the id they originally sent.
 */
function extractMergedRecordId(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const obj = response as Record<string, unknown>;
  const direct = obj.id ?? obj.objectId ?? obj.vid;
  if (direct != null) {
    const s = String(direct).trim();
    if (s) return s;
  }
  const props = obj.properties;
  if (props && typeof props === "object") {
    const hsId = (props as Record<string, unknown>).hs_object_id;
    if (hsId != null) {
      const s = String(hsId).trim();
      if (s) return s;
    }
  }
  return null;
}
