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
  ChevronRight,
  Copy,
  ExternalLink,
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
  fetchResolutions,
  joinDuplicatesRoom,
  resolvePresenceUser,
  type DuplicatePairResolution,
  type DuplicatesRoom,
  type PresenceEntry,
} from "@/lib/duplicates/supabase";
import { hubspotCreatorUrl } from "@/lib/hubspot-urls";
import { DuplicatePairDetail } from "@/components/DuplicatePairDetail";
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
  // Filter out resolved/dismissed pairs (reopened reappear).
  // ────────────────────────────────────────────────
  const visiblePairs = useMemo(() => {
    const all = analysis?.pairs ?? [];
    return all.filter((p) => {
      const r = resolutions.get(p.pairKey);
      if (!r) return true;
      return r.status !== "resolved" && r.status !== "dismissed";
    });
  }, [analysis, resolutions]);

  const selectedPair = useMemo(() => {
    if (!selectedPairKey) return null;
    return visiblePairs.find((p) => p.pairKey === selectedPairKey) ?? null;
  }, [selectedPairKey, visiblePairs]);

  // ────────────────────────────────────────────────
  // Detail view takes over the page when a pair is selected.
  // ────────────────────────────────────────────────
  if (selectedPair) {
    const localUser = roomRef.current?.user ?? "";
    return (
      <DuplicatePairDetail
        pair={selectedPair}
        token={token}
        localUser={localUser}
        otherViewers={(presence.get(selectedPair.pairKey) ?? []).filter(
          (e) => e.user !== localUser,
        )}
        onBack={() => setSelectedPairKey(null)}
      />
    );
  }

  return (
    <div className="h-full overflow-auto">
      <div className="w-full space-y-4 px-4 py-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Copy className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-lg font-semibold leading-none">Duplicates</h2>
              {analysis && (
                <Badge variant="secondary" className="h-5 px-1.5 text-[11px] tabular-nums">
                  {visiblePairs.length}
                </Badge>
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Potential duplicate creator pairs found in the cached HubSpot export.
              Resolved or dismissed pairs disappear automatically.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 cursor-pointer"
            disabled={!token || loading || refreshing}
            onClick={() => {
              void loadAnalysis(true);
            }}
          >
            <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", refreshing && "animate-spin")} />
            Refresh
          </Button>
        </div>

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

        {/* Empty / loading / list */}
        {loading && !analysis ? (
          <div className="space-y-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-md bg-muted/60" />
            ))}
          </div>
        ) : analysis && visiblePairs.length === 0 ? (
          <div className="rounded-md border bg-muted/20 px-4 py-10 text-center text-sm text-muted-foreground">
            No unresolved duplicate pairs in the current export.
          </div>
        ) : analysis ? (
          <ul className="divide-y rounded-md border">
            {visiblePairs.map((pair) => {
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
            {analysis.pairs.length - visiblePairs.length > 0 && (
              <>; {analysis.pairs.length - visiblePairs.length} hidden as resolved or dismissed</>
            )}
            .
          </div>
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
 * Short human-readable reason that explains why this pair was flagged.
 * Kept compact for one-line list rows; the detail view shows the full
 * canonical URL + columns + sources.
 */
function describePairReason(pair: DuplicatePair): string {
  const aCols = pair.a.columns.join(" / ") || "—";
  const bCols = pair.b.columns.join(" / ") || "—";
  return `${aCols} ↔ ${bCols} · ${pair.canonicalUrl}`;
}
