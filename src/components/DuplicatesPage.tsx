/**
 * Duplicates page — list view.
 *
 * Reads the cached all-creators export, runs the in-process duplicate
 * detector, and renders one row per unresolved pair. Clicking a row opens
 * the side-by-side detail in the same surface (state-machine style — no
 * router, the parent only sees a single `"duplicates"` page).
 *
 * Concurrency: all viewers share a Supabase Realtime presence room so each
 * row shows a green dot when other teammates are looking at the same pair.
 * The local viewer is filtered out of the indicator (per spec: "others
 * only") so you never see your own name on a row you opened.
 *
 * v1 is read-only — no resolution actions in the UI yet. Resolved/dismissed
 * pairs in `duplicate_pair_resolutions` (populated via SQL or v2) drop out
 * of the list automatically.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  History,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  describeCreatorExportProgress,
  ensureCreatorsExport,
  isCreatorExportInProgress,
  useCreatorExportProgress,
  type CreatorExportResult,
} from "@/lib/creator-export";
import { parseCreatorsCsvFull } from "@/lib/data-integrity/creator-csv";
import { findDuplicatePairs, type DuplicatePair } from "@/lib/duplicates/find-pairs";
import {
  describeSupabaseError,
  fetchMergeHistory,
  fetchResolutions,
  joinDuplicatesRoom,
  resolvePresenceUser,
  type DuplicatePairResolution,
  type DuplicatesRoom,
  type MergeSnapshotSummary,
  type PresenceEntry,
} from "@/lib/duplicates/supabase";
import { hubspotCreatorUrl } from "@/lib/hubspot-urls";
import { DuplicatePairDetail } from "@/components/DuplicatePairDetail";
import { MergeHistoryDetail } from "@/components/MergeHistoryDetail";
import type { AppSettings } from "@/types";

interface Props {
  isActive: boolean;
  settings: AppSettings;
}

interface AnalysisResult {
  pairs: DuplicatePair[];
  generatedAt: Date;
  source: CreatorExportResult["source"];
}

// Module-scoped cache mirrors the pattern in
// src/lib/data-integrity/checks/creator-urls.tsx — the analysis is
// deterministic for a given (generatedAt, source) so we skip the parse +
// detect work when the user toggles between this page and another tab.
let cachedAnalysis: AnalysisResult | null = null;
let cachedSourceKey: string | null = null;

function analyze(result: CreatorExportResult): AnalysisResult {
  const key = `${result.generatedAt.toISOString()}::${result.source}`;
  if (cachedAnalysis && cachedSourceKey === key) return cachedAnalysis;
  const rows = parseCreatorsCsvFull(result.csv);
  const pairs = findDuplicatePairs(rows);
  cachedAnalysis = { pairs, generatedAt: result.generatedAt, source: result.source };
  cachedSourceKey = key;
  return cachedAnalysis;
}

export function DuplicatesPage({ isActive, settings }: Props) {
  const token = settings.hubspotToken;
  const exportProgress = useCreatorExportProgress();
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(cachedAnalysis);
  const [resolutions, setResolutions] = useState<Map<string, DuplicatePairResolution>>(new Map());
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPairKey, setSelectedPairKey] = useState<string | null>(null);
  const [presence, setPresence] = useState<Map<string, PresenceEntry[]>>(new Map());
  // Pair keys that the local user resolved during the current session. These
  // surface in a dedicated "Resolved this session" section at the top of the
  // list (instead of being silently dropped) so the user has a visible
  // reference to the merged record without forcing an export refetch.
  // Cleared on Refresh / page reload by virtue of being component state.
  const [sessionResolvedKeys, setSessionResolvedKeys] = useState<Set<string>>(new Set());
  // Pair keys we've confirmed have no `duplicate_merge_snapshots` row.
  // Set by `MergeHistoryDetail`'s `onSnapshotMissing` callback when the
  // user opens a session-merged pair we can't render through the history
  // view (e.g. the resolution came from "Mark resolved" which doesn't
  // write a snapshot, or the merge predates the snapshots table). Acts
  // as a sticky toggle so we don't ping-pong between the two detail
  // components on every render.
  const [pairKeysMissingSnapshot, setPairKeysMissingSnapshot] = useState<Set<string>>(
    new Set(),
  );
  // Top-level navigation: pending list (default) vs. merge history list.
  // Detail views are layered on top of these via `selectedPairKey` and
  // `selectedHistoryId`.
  const [view, setView] = useState<"list" | "history">("list");
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  const [history, setHistory] = useState<MergeSnapshotSummary[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const roomRef = useRef<DuplicatesRoom | null>(null);
  const hasLoadedRef = useRef(false);

  // ────────────────────────────────────────────────
  // Initial load — kick off when the page becomes active for the first time.
  // ────────────────────────────────────────────────
  const loadAnalysis = useCallback(
    async (force: boolean) => {
      if (!token) {
        setError("Set your HubSpot token in Settings to load creators.");
        return;
      }
      if (force) setRefreshing(true);
      else setLoading(true);
      setError(null);
      // A forced refresh re-fetches HubSpot and re-runs detection from
      // scratch, so the missing-snapshot cache is no longer trustworthy
      // (the user may have created a snapshot in HubSpot in the meantime,
      // or the snapshots table may have been migrated since the last
      // attempt). Cheaper to drop the cache than to remember which
      // entries are still valid.
      if (force) setPairKeysMissingSnapshot(new Set());
      try {
        const result = await ensureCreatorsExport({ token, force });
        const next = analyze(result);
        setAnalysis(next);
        try {
          const map = await fetchResolutions(next.pairs.map((p) => p.pairKey));
          setResolutions(map);
        } catch (err) {
          // Fetch failure shouldn't block the list — surface as a banner
          // and let the user keep working on detection results.
          console.error("[duplicates] failed to fetch resolutions:", err);
          setError(
            `Couldn't load resolution status from Supabase: ${describeSupabaseError(err)}`,
          );
        }
      } catch (err) {
        setError(describeSupabaseError(err));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [token],
  );

  useEffect(() => {
    if (!isActive || hasLoadedRef.current) return;
    hasLoadedRef.current = true;
    void loadAnalysis(false);
  }, [isActive, loadAnalysis]);

  // ────────────────────────────────────────────────
  // Merge history — fetched on demand the first time the user opens the
  // History view, then refreshed every time they re-enter it (so a merge
  // performed in this session shows up without a full page reload).
  // ────────────────────────────────────────────────
  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const rows = await fetchMergeHistory();
      setHistory(rows);
    } catch (err) {
      setHistoryError(describeSupabaseError(err));
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (view !== "history") return;
    void loadHistory();
  }, [view, loadHistory]);

  // ────────────────────────────────────────────────
  // Presence — one room shared across the whole page.
  // ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let teardown: (() => void) | null = null;

    void (async () => {
      const user = await resolvePresenceUser(settings.ownerEmail);
      if (cancelled) return;
      const room = joinDuplicatesRoom(user);
      roomRef.current = room;
      const unsub = room.subscribe((next) => {
        // Snapshot to a new Map so React notices the change.
        setPresence(new Map(next));
      });
      teardown = () => {
        unsub();
        room.leave();
        roomRef.current = null;
      };
    })();

    return () => {
      cancelled = true;
      teardown?.();
    };
  }, [settings.ownerEmail]);

  // Keep the room's broadcast in sync with whatever pair is currently selected.
  useEffect(() => {
    roomRef.current?.setActivePair(selectedPairKey);
  }, [selectedPairKey]);

  // ────────────────────────────────────────────────
  // Split pairs into "resolved this session" (shown at top with link to the
  // surviving record) and "pending" (still need a decision).
  //
  // Historical resolutions persisted in Supabase (status=resolved/dismissed)
  // stay hidden — the resolved section is intentionally session-scoped so it
  // doesn't grow into a giant log of every merge ever. Reopened pairs always
  // reappear in pending.
  // ────────────────────────────────────────────────
  const sessionResolvedPairs = useMemo(() => {
    const all = analysis?.pairs ?? [];
    return all.filter((p) => sessionResolvedKeys.has(p.pairKey));
  }, [analysis, sessionResolvedKeys]);

  const pendingPairs = useMemo(() => {
    const all = analysis?.pairs ?? [];
    return all.filter((p) => {
      if (sessionResolvedKeys.has(p.pairKey)) return false;
      const r = resolutions.get(p.pairKey);
      if (!r) return true;
      return r.status !== "resolved" && r.status !== "dismissed";
    });
  }, [analysis, resolutions, sessionResolvedKeys]);

  // Look in both lists so the user can reopen a session-resolved pair to
  // double-check the merged data without losing access to the side-by-side
  // view. The detail component switches into a read-only "already merged"
  // mode based on `resolvedSurvivingRid` below.
  const selectedPair = useMemo(() => {
    if (!selectedPairKey) return null;
    return (
      pendingPairs.find((p) => p.pairKey === selectedPairKey) ??
      sessionResolvedPairs.find((p) => p.pairKey === selectedPairKey) ??
      null
    );
  }, [selectedPairKey, pendingPairs, sessionResolvedPairs]);

  // ────────────────────────────────────────────────
  // Detail view takes over the page when a pair (or history snapshot) is
  // selected. History detail is checked first so a stale `selectedPairKey`
  // can't shadow it after navigation.
  // ────────────────────────────────────────────────
  if (selectedHistoryId) {
    return (
      <MergeHistoryDetail
        snapshotId={selectedHistoryId}
        token={token}
        onBack={() => setSelectedHistoryId(null)}
      />
    );
  }
  if (selectedPair) {
    const localUser = roomRef.current?.user ?? "";
    const pairKey = selectedPair.pairKey;
    const resolvedSurvivingRid = sessionResolvedKeys.has(pairKey)
      ? resolutions.get(pairKey)?.winnerRecordId ?? null
      : null;
    // Session-merged pairs (resolved AND a winner record id is set —
    // i.e. came from the in-app merge or "Mark resolved" with a winner)
    // route through `MergeHistoryDetail` so the user sees the snapshot
    // archaeology + live winner data instead of an empty live view (the
    // loser is archived in HubSpot post-merge). If the snapshot is
    // missing for any reason we sticky-fall-back to `DuplicatePairDetail`
    // via the `pairKeysMissingSnapshot` set so we don't loop.
    const hasWinner = !!resolvedSurvivingRid;
    const snapshotKnownMissing = pairKeysMissingSnapshot.has(pairKey);
    const useHistoryView =
      sessionResolvedKeys.has(pairKey) && hasWinner && !snapshotKnownMissing;
    if (useHistoryView) {
      return (
        <MergeHistoryDetail
          pairKey={pairKey}
          token={token}
          backLabel="Back to duplicates"
          onBack={() => setSelectedPairKey(null)}
          onSnapshotMissing={() => {
            setPairKeysMissingSnapshot((prev) => {
              if (prev.has(pairKey)) return prev;
              const next = new Set(prev);
              next.add(pairKey);
              return next;
            });
          }}
        />
      );
    }
    return (
      <DuplicatePairDetail
        pair={selectedPair}
        token={token}
        localUser={localUser}
        otherViewers={(presence.get(pairKey) ?? []).filter(
          (e) => e.user !== localUser,
        )}
        resolvedSurvivingRid={resolvedSurvivingRid}
        onBack={() => setSelectedPairKey(null)}
        onMergeSuccess={(winnerRid) => {
          // 1. Optimistically record the resolution so the row carries the
          //    surviving record id (used by the resolved-section link).
          //    The next list reload from Supabase will replace this stub
          //    with the real persisted row.
          setResolutions((prev) => {
            const next = new Map(prev);
            next.set(pairKey, {
              pairKey,
              status: "resolved",
              resolvedBy: localUser || null,
              resolvedAt: new Date(),
              resolutionNotes: "Merged via Duplicates page",
              winnerRecordId: winnerRid,
              updatedAt: new Date(),
            });
            return next;
          });
          // 2. Tag the pair as resolved-this-session so the list moves it to
          //    the "Resolved this session" section at the top instead of
          //    hiding it. Cleared on Refresh / page reload.
          setSessionResolvedKeys((prev) => new Set(prev).add(pairKey));
          // 2b. A successful merge always writes a fresh
          //     `duplicate_merge_snapshots` row (see
          //     `recordMergeResolution`), so clear any earlier
          //     "snapshot missing" sticky flag for this pair. Without
          //     this, a Reopen → re-merge cycle would keep falling
          //     back to the live `DuplicatePairDetail` view even
          //     though we now have an archaeology row to show.
          setPairKeysMissingSnapshot((prev) => {
            if (!prev.has(pairKey)) return prev;
            const next = new Set(prev);
            next.delete(pairKey);
            return next;
          });
          // 3. Navigate back to the list. We deliberately do NOT auto-refetch
          //    the creators export — that's a slow, network-heavy operation
          //    and the user can trigger it via the Refresh button when they
          //    want to re-run detection against fresh HubSpot data. Stale
          //    pairs that referenced the just-archived loser id remain
          //    visible in pending until then; clicking one would still load
          //    the detail view, where the live HubSpot fetch will surface
          //    the archived side as empty.
          setSelectedPairKey(null);
        }}
      />
    );
  }

  return (
    <div className="h-full overflow-auto">
      <div className="w-full space-y-4 px-4 py-4">
        {/* Header — title + subtitle on the left, action buttons on the
            right. Subtitle and the right-hand buttons swap based on which
            top-level view is active so the page only ever shows the
            controls relevant to that mode. */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {view === "history" ? (
              <>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 cursor-pointer px-2"
                    onClick={() => setView("list")}
                  >
                    <ArrowLeft className="mr-1.5 h-4 w-4" />
                    Back to duplicates
                  </Button>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <History className="h-4 w-4 text-muted-foreground" />
                  <h2 className="text-lg font-semibold leading-none">Merge history</h2>
                  {history && (
                    <Badge variant="secondary" className="h-5 px-1.5 text-[11px] tabular-nums">
                      {history.length}
                    </Badge>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Past merges with the full pre-merge snapshot of both
                  records. Click any row to see the side-by-side comparison.
                </p>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <Copy className="h-4 w-4 text-muted-foreground" />
                  <h2 className="text-lg font-semibold leading-none">Duplicates</h2>
                  {analysis && (
                    <Badge variant="secondary" className="h-5 px-1.5 text-[11px] tabular-nums">
                      {pendingPairs.length}
                    </Badge>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Potential duplicate creator pairs found in the cached HubSpot export.
                  Click Refresh to re-run detection against fresh data.
                </p>
              </>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {view === "list" ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="cursor-pointer"
                  onClick={() => setView("history")}
                >
                  <History className="mr-1.5 h-3.5 w-3.5" />
                  History
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="cursor-pointer"
                  disabled={!token || loading || refreshing}
                  onClick={() => {
                    void loadAnalysis(true);
                  }}
                >
                  <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", refreshing && "animate-spin")} />
                  Refresh
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="cursor-pointer"
                disabled={historyLoading}
                onClick={() => void loadHistory()}
              >
                <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", historyLoading && "animate-spin")} />
                Refresh
              </Button>
            )}
          </div>
        </div>

        {view === "list" ? (
          <>
            {/* Export-progress banner — same wording as the Data Integrity surface */}
            {isCreatorExportInProgress(exportProgress) && (
              <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin" />
                <span className="min-w-0 break-words">
                  {describeCreatorExportProgress(exportProgress)}
                </span>
              </div>
            )}

            {error && (
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="min-w-0 break-words">{error}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 cursor-pointer px-2 text-[11px]"
                  onClick={() => void loadAnalysis(false)}
                >
                  Retry
                </Button>
              </div>
            )}

            {/* Resolved-this-session section. Sits above the pending list so the
                user has a visible reference to the merged record without forcing
                an export refetch. Cleared on Refresh / page reload. */}
            {sessionResolvedPairs.length > 0 && (
              <div className="space-y-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
                  Resolved this session ({sessionResolvedPairs.length})
                </div>
                <ul className="divide-y rounded-md border bg-emerald-50/30">
                  {sessionResolvedPairs.map((pair) => {
                    const r = resolutions.get(pair.pairKey);
                    return (
                      <ResolvedPairRow
                        key={pair.pairKey}
                        pair={pair}
                        survivingRid={r?.winnerRecordId ?? null}
                        onOpen={() => setSelectedPairKey(pair.pairKey)}
                      />
                    );
                  })}
                </ul>
              </div>
            )}

            {/* Empty / loading / pending list */}
            {loading && !analysis ? (
              <div className="space-y-2">
                {[0, 1, 2, 3, 4].map((i) => (
                  <div key={i} className="h-16 animate-pulse rounded-md bg-muted/60" />
                ))}
              </div>
            ) : analysis && pendingPairs.length === 0 ? (
              <div className="rounded-md border bg-muted/20 px-4 py-10 text-center text-sm text-muted-foreground">
                No unresolved duplicate pairs in the current export.
              </div>
            ) : analysis ? (
              <ul className="divide-y rounded-md border">
                {pendingPairs.map((pair) => {
                  const otherViewers = (presence.get(pair.pairKey) ?? []).filter(
                    (e) => e.user !== (roomRef.current?.user ?? ""),
                  );
                  return (
                    <PairRow
                      key={pair.pairKey}
                      pair={pair}
                      otherViewers={otherViewers}
                      onOpen={() => setSelectedPairKey(pair.pairKey)}
                    />
                  );
                })}
              </ul>
            ) : null}

            {analysis && (
              <div className="text-[11px] text-muted-foreground">
                Detection ran on the {analysis.source} cache from{" "}
                {analysis.generatedAt.toLocaleString()}. Detected{" "}
                {analysis.pairs.length} pairs total
                {analysis.pairs.length - pendingPairs.length > 0 && (
                  <>
                    ;{" "}
                    {analysis.pairs.length - pendingPairs.length} hidden as
                    resolved or dismissed
                  </>
                )}
                .
              </div>
            )}
          </>
        ) : (
          <HistoryView
            history={history}
            loading={historyLoading}
            error={historyError}
            onRetry={() => void loadHistory()}
            onOpen={(id) => setSelectedHistoryId(id)}
          />
        )}
      </div>
    </div>
  );
}

function PairRow({
  pair,
  otherViewers,
  onOpen,
}: {
  pair: DuplicatePair;
  otherViewers: PresenceEntry[];
  onOpen: () => void;
}) {
  const summary = describePairReason(pair);
  const aName = pair.a.name || pair.a.rid;
  const bName = pair.b.name || pair.b.rid;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40 focus:bg-muted/60 focus:outline-none"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
            <span className="truncate">{aName}</span>
            <span className="text-muted-foreground">↔</span>
            <span className="truncate">{bName}</span>
            <Badge variant="outline" className="h-5 px-1.5 text-[10px] capitalize">
              {pair.network}
            </Badge>
            {pair.source.includes("multi_url_collision") && (
              <Badge variant="outline" className="h-5 px-1.5 text-[10px] text-amber-700">
                multi-URL cell
              </Badge>
            )}
            {pair.source.includes("bare_handle_promotion") && (
              <Badge variant="outline" className="h-5 px-1.5 text-[10px] text-amber-700">
                bare handle
              </Badge>
            )}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{summary}</div>
          {otherViewers.length > 0 && (
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-emerald-700">
              {otherViewers.map((v, i) => (
                <span key={`${v.user}-${i}`} className="inline-flex items-center gap-1">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  {v.user} is here
                </span>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void openUrl(hubspotCreatorUrl(pair.a.rid));
          }}
          className="hidden text-xs text-muted-foreground hover:text-foreground sm:inline-flex"
          title="Open creator A in HubSpot"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
        <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
      </button>
    </li>
  );
}

/**
 * Sibling of {@link PairRow} for pairs the local user just merged during
 * this session. Clicking the row reopens the side-by-side detail view in
 * read-only "already merged" mode so the user can sanity-check the merged
 * data without re-running the merge action. The right-aligned "View merged
 * record" button is a shortcut into HubSpot for the surviving creator.
 */
function ResolvedPairRow({
  pair,
  survivingRid,
  onOpen,
}: {
  pair: DuplicatePair;
  survivingRid: string | null;
  onOpen: () => void;
}) {
  const summary = describePairReason(pair);
  const aName = pair.a.name || pair.a.rid;
  const bName = pair.b.name || pair.b.rid;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 px-4 py-3 text-left opacity-80 transition-colors hover:bg-emerald-50/60 focus:bg-emerald-50/80 focus:outline-none"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
            <Badge
              variant="outline"
              className="h-5 border-emerald-300 bg-emerald-50 px-1.5 text-[10px] text-emerald-700"
            >
              <Check className="mr-0.5 h-3 w-3" />
              Merged
            </Badge>
            <span className="truncate">{aName}</span>
            <span className="text-muted-foreground">↔</span>
            <span className="truncate">{bName}</span>
            <Badge variant="outline" className="h-5 px-1.5 text-[10px] capitalize">
              {pair.network}
            </Badge>
          </div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{summary}</div>
        </div>
        <button
          type="button"
          disabled={!survivingRid}
          onClick={(e) => {
            e.stopPropagation();
            if (!survivingRid) return;
            void openUrl(hubspotCreatorUrl(survivingRid));
          }}
          className="inline-flex flex-shrink-0 items-center gap-1 text-xs text-emerald-700 hover:text-emerald-900 disabled:cursor-not-allowed disabled:opacity-50"
          title={survivingRid ? "Open merged record in HubSpot" : "Surviving record id unavailable"}
        >
          View merged record
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
        <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
      </button>
    </li>
  );
}

/**
 * Short human-readable reason that explains why this pair was flagged.
 * Kept compact for one-line list rows; the detail view shows the full
 * canonical URL + columns + sources.
 */
function describePairReason(pair: DuplicatePair): string {
  const aCols = pair.a.columns.join(" / ") || "—";
  const bCols = pair.b.columns.join(" / ") || "—";
  return `${aCols} ↔ ${bCols} · ${pair.canonicalUrl}`;
}

/**
 * Render the loading / error / list / empty branches of the merge-history
 * surface. Lives inline alongside `PairRow` because the list shape is
 * trivial and the only consumer is this page.
 */
function HistoryView({
  history,
  loading,
  error,
  onRetry,
  onOpen,
}: {
  history: MergeSnapshotSummary[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onOpen: (id: string) => void;
}) {
  if (error) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
        <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="min-w-0 break-words">{error}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 cursor-pointer px-2 text-[11px]"
          onClick={onRetry}
        >
          Retry
        </Button>
      </div>
    );
  }

  if (loading && !history) {
    return (
      <div className="space-y-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-16 animate-pulse rounded-md bg-muted/60" />
        ))}
      </div>
    );
  }

  if (history && history.length === 0) {
    return (
      <div className="rounded-md border bg-muted/20 px-4 py-10 text-center text-sm text-muted-foreground">
        No merges recorded yet. Merges performed via the Duplicates page from now on
        will appear here.
      </div>
    );
  }

  return (
    <ul className="divide-y rounded-md border">
      {(history ?? []).map((row) => (
        <MergeHistoryRow
          key={row.id}
          row={row}
          onOpen={() => onOpen(row.id)}
        />
      ))}
    </ul>
  );
}

/**
 * One row in the merge-history list. Shape mirrors {@link ResolvedPairRow}:
 * the whole row is clickable to open the side-by-side detail, and the
 * right-aligned button is a shortcut into HubSpot for the surviving
 * creator.
 */
function MergeHistoryRow({
  row,
  onOpen,
}: {
  row: MergeSnapshotSummary;
  onOpen: () => void;
}) {
  const winner = row.winnerName || row.winnerRecordId;
  const loser = row.loserName || row.loserRecordId;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40 focus:bg-muted/60 focus:outline-none"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
            <Badge
              variant="outline"
              className="h-5 border-emerald-300 bg-emerald-50 px-1.5 text-[10px] text-emerald-700"
            >
              <Check className="mr-0.5 h-3 w-3" />
              Merged
            </Badge>
            <span className="truncate">{winner}</span>
            <span className="text-muted-foreground">←</span>
            <span className="truncate text-muted-foreground">{loser}</span>
            {row.network && (
              <Badge variant="outline" className="h-5 px-1.5 text-[10px] capitalize">
                {row.network}
              </Badge>
            )}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {row.mergedAt.toLocaleString()}
            {row.actor && <> · by {row.actor}</>}
            {row.canonicalUrl && <> · {row.canonicalUrl}</>}
          </div>
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void openUrl(hubspotCreatorUrl(row.winnerRecordId));
          }}
          className="inline-flex flex-shrink-0 items-center gap-1 text-xs text-emerald-700 hover:text-emerald-900"
          title="Open merged record in HubSpot"
        >
          View merged record
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
        <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
      </button>
    </li>
  );
}
