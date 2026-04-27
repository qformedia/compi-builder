import { useEffect, useLayoutEffect, useMemo, useState, type UIEvent } from "react";
import { ChevronDown, CheckCircle2, AlertTriangle, RefreshCw, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { INTEGRITY_CHECKS, type IntegrityCheck, type IntegritySection, type Severity, maxSeverity } from "@/lib/data-integrity";
import { useIntegrity, type IntegrityCheckData } from "@/lib/data-integrity/use-data-integrity";
import type { AppSettings } from "@/types";

const SEV_RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

/** Small severity dot — single source of truth for the colour palette. */
function severityDotClass(sev: Severity): string {
  switch (sev) {
    case "critical":
      return "bg-red-500";
    case "warning":
      return "bg-amber-500";
    default:
      return "bg-sky-500";
  }
}

/** Severity label colour used inline in section/card headers. */
function severityTextClass(sev: Severity): string {
  switch (sev) {
    case "critical":
      return "text-red-600";
    case "warning":
      return "text-amber-600";
    default:
      return "text-sky-600";
  }
}

interface Props {
  isActive: boolean;
  settings: AppSettings;
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function DataIntegrityPage({ isActive, settings }: Props) {
  const token = settings.hubspotToken;
  const {
    checkData,
    checkLoading,
    checkPageLoading,
    lastRun,
    refreshAllLoading,
    summary,
    loadCheck,
    loadMoreCheck,
    ensureFullLoaded,
    loadAll,
    syncVersion,
    consumeCheckFetchSyncBatch,
  } = useIntegrity();
  const [cardOpen, setCardOpen] = useState<Record<string, boolean>>({});
  const [sectionOpen, setSectionOpen] = useState<Record<string, boolean>>({});
  const [fixedThisSession, setFixedThisSession] = useState<Record<string, number>>({});

  // Apply section/collapse defaults after each check fetch (mirrors previous inline loadCheck logic).
  useLayoutEffect(() => {
    const batch = consumeCheckFetchSyncBatch();
    for (const { checkId, reset, sections, total } of batch) {
      if (reset) {
        setSectionOpen((s) => {
          const next: Record<string, boolean> = { ...s };
          for (const k of Object.keys(next)) {
            if (k.startsWith(`${checkId}::`)) {
              delete next[k];
            }
          }
          for (const sec of sections) {
            next[`${checkId}::${sec.id}`] = sec.defaultOpen ?? true;
          }
          return next;
        });
      } else {
        setSectionOpen((s) => {
          const next: Record<string, boolean> = { ...s };
          for (const sec of sections) {
            const key = `${checkId}::${sec.id}`;
            if (!(key in next)) {
              next[key] = sec.defaultOpen ?? true;
            }
          }
          return next;
        });
      }
      setCardOpen((c) => {
        if (c[checkId] === undefined) {
          return { ...c, [checkId]: total > 0 };
        }
        return c;
      });
    }
  }, [syncVersion, consumeCheckFetchSyncBatch]);

  useEffect(() => {
    if (!isActive) return;
    for (const check of INTEGRITY_CHECKS) {
      const data = checkData[check.id];
      const countTotal =
        data?.counts?.reduce((sum, section) => sum + section.total, 0) ??
        data?.sections?.reduce((sum, section) => sum + section.items.length, 0) ??
        0;
      if (countTotal > 0) {
        void ensureFullLoaded(check, true);
      }
    }
  }, [checkData, ensureFullLoaded, isActive]);

  const sortedChecks = useMemo(() => {
    return [...INTEGRITY_CHECKS].sort((a, b) => {
      const da = checkData[a.id];
      const db = checkData[b.id];
      const sevA =
        !da
          ? ("info" as Severity)
          : maxSeverity((da.counts ?? da.sections ?? []).map((s) => s.severity));
      const sevB =
        !db
          ? ("info" as Severity)
          : maxSeverity((db.counts ?? db.sections ?? []).map((s) => s.severity));
      return SEV_RANK[sevB] - SEV_RANK[sevA];
    });
  }, [checkData]);

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <div className="w-full space-y-4 px-4 py-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-lg font-semibold leading-none">Data integrity</h2>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Things in HubSpot that need fixing.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 cursor-pointer"
            disabled={!token || refreshAllLoading}
            onClick={() => {
              setFixedThisSession({});
              void loadAll({ resetSectionKeys: true });
            }}
          >
            <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", refreshAllLoading && "animate-spin")} />
            Refresh all
          </Button>
        </div>

        {/* Summary line */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <div className="flex flex-wrap items-center gap-3">
            <SummaryStat sev="critical" count={summary.critical} label="critical" />
            <span className="text-border">·</span>
            <SummaryStat sev="warning" count={summary.warning} label="warnings" />
            <span className="text-border">·</span>
            <SummaryStat sev="info" count={summary.info} label="info" />
          </div>
          {lastRun && <span>Last run {formatTime(lastRun)}</span>}
        </div>

        {/* Checks */}
        <div className="space-y-3">
          {sortedChecks.map((check) => (
            <CheckCard
              key={check.id}
              check={check}
              token={token}
              settings={settings}
              data={checkData[check.id]}
              loading={checkLoading[check.id] === true}
              loadingMore={checkPageLoading[check.id] === true}
              open={cardOpen[check.id] !== false}
              onToggleCard={() =>
                setCardOpen((c) => ({ ...c, [check.id]: c[check.id] === false ? true : false }))
              }
              sectionOpen={sectionOpen}
              onToggleSection={(k, o) => setSectionOpen((s) => ({ ...s, [k]: o }))}
              onRefresh={() => {
                void loadCheck(check, true);
              }}
              onLoadMore={() => {
                void loadMoreCheck(check);
              }}
              fixedCount={fixedThisSession[check.id] ?? 0}
              onFixedOne={() =>
                setFixedThisSession((f) => ({ ...f, [check.id]: (f[check.id] ?? 0) + 1 }))
              }
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function SummaryStat({ sev, count, label }: { sev: Severity; count: number; label: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", count === 0 && "opacity-50")}>
      <span className={cn("h-1.5 w-1.5 rounded-full", severityDotClass(sev))} />
      <span className="tabular-nums">
        <span className="font-medium text-foreground">{count}</span>{" "}
        <span>{label}</span>
      </span>
    </span>
  );
}

function CheckCard<T extends { id: string }>({
  check,
  token,
  settings,
  data,
  loading,
  loadingMore,
  open,
  onToggleCard,
  sectionOpen,
  onToggleSection,
  onRefresh,
  onLoadMore,
  fixedCount,
  onFixedOne,
}: {
  check: IntegrityCheck<T>;
  token: string;
  settings: AppSettings;
  data: IntegrityCheckData | undefined;
  loading: boolean;
  loadingMore: boolean;
  open: boolean;
  onToggleCard: () => void;
  sectionOpen: Record<string, boolean>;
  onToggleSection: (key: string, o: boolean) => void;
  onRefresh: () => void;
  onLoadMore: () => void;
  fixedCount: number;
  onFixedOne: () => void;
}) {
  const hasErr = Boolean(data?.error);
  const errMsg = data?.error?.message;
  const sections: IntegritySection<Record<string, unknown> & { id: string }>[] = data?.sections ?? [];
  const counts = data?.counts ?? sections.map((section) => ({
    id: section.id,
    title: section.title,
    severity: section.severity,
    defaultOpen: section.defaultOpen,
    total: section.items.length,
  }));

  const countTotal = useMemo(
    () => counts.reduce((a, s) => a + s.total, 0),
    [counts],
  );
  const cardSev: Severity = counts.length ? maxSeverity(counts.map((s) => s.severity)) : "info";
  const sectionTotals = useMemo(() => new Map(counts.map((section) => [section.id, section.total])), [counts]);
  const loadedTotal = useMemo(
    () => sections.reduce((a, s) => a + s.items.length, 0),
    [sections],
  );
  const canLoadMore = Boolean(data?.nextAfter);
  const Row = check.Row;

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    if (!canLoadMore || loadingMore) return;
    const el = event.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 240) {
      onLoadMore();
    }
  };

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className={cn("gap-1.5 px-4 py-3", open && "border-b")}>
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "h-2 w-2 flex-shrink-0 rounded-full",
              countTotal === 0 && !hasErr ? "bg-muted-foreground/40" : severityDotClass(cardSev),
            )}
          />
          <CardTitle className="min-w-0 truncate text-sm">{check.title}</CardTitle>
          <Badge variant="secondary" className="h-5 px-1.5 text-[11px] tabular-nums">
            {countTotal}
          </Badge>
          {fixedCount > 0 && (
            <span className="ml-1 inline-flex items-center gap-1 text-[11px] text-emerald-700">
              <CheckCircle2 className="h-3 w-3" />
              {fixedCount} fixed
            </span>
          )}
        </div>
        {check.description && (
          <CardDescription className="text-xs leading-relaxed">
            {check.description}
          </CardDescription>
        )}
        <CardAction>
          <div className="flex items-center gap-0.5">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 cursor-pointer"
              title="Refresh this check"
              disabled={loading}
              onClick={onRefresh}
            >
              <RefreshCw className={cn("h-3.5 w-3.5 text-muted-foreground", loading && "animate-spin")} />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 cursor-pointer"
              onClick={onToggleCard}
              title={open ? "Collapse" : "Expand"}
            >
              <ChevronDown
                className={cn(
                  "h-3.5 w-3.5 transition-transform text-muted-foreground",
                  !open && "-rotate-90",
                )}
              />
            </Button>
          </div>
        </CardAction>
      </CardHeader>

      {open && (
        <CardContent className="space-y-0 p-0">
          {loading && (
            <div className="space-y-1.5 px-4 py-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-12 animate-pulse rounded-md bg-muted/60" />
              ))}
            </div>
          )}

          {!loading && hasErr && (
            <div className="m-3 flex flex-wrap items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="min-w-0 break-words">{errMsg}</span>
              <Button variant="ghost" size="sm" className="h-6 cursor-pointer px-2 text-[11px]" onClick={onRefresh}>
                Retry
              </Button>
            </div>
          )}

          {!loading && !hasErr && countTotal === 0 && (
            <div className="flex items-center gap-2 px-4 py-4 text-sm text-emerald-700">
              <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
              All clear — no issues found.
            </div>
          )}

          {!loading && !hasErr && countTotal > 0 && sections.length === 0 && (
            <div className="space-y-1.5 px-4 py-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-12 animate-pulse rounded-md bg-muted/60" />
              ))}
            </div>
          )}

          {!loading && !hasErr && countTotal > 0 && sections.length > 0 && (
            <div className="max-h-[60vh] overflow-y-auto" onScroll={handleScroll}>
              {sections
                .slice()
                .sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity])
                .map((section) => {
                  const sKey = `${check.id}::${section.id}`;
                  const singleSectionNoTitle = sections.length === 1 && !section.title;
                  const secOpen: boolean = singleSectionNoTitle
                    ? true
                    : sectionOpen[sKey] === undefined
                      ? (section.defaultOpen ?? true)
                      : Boolean(sectionOpen[sKey]);
                  const sectionTotal = sectionTotals.get(section.id) ?? section.items.length;
                  if (section.items.length === 0 && sectionTotal === 0) return null;

                  return (
                    <section key={section.id} className="border-b last:border-0">
                      {!singleSectionNoTitle && (
                        <button
                          type="button"
                          className="sticky top-0 z-10 flex w-full items-center justify-between border-b border-border/60 bg-muted px-4 py-2 text-left transition-colors hover:bg-muted/80"
                          onClick={() => onToggleSection(sKey, !secOpen)}
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <span
                              className={cn(
                                "h-1.5 w-1.5 flex-shrink-0 rounded-full",
                                severityDotClass(section.severity),
                              )}
                            />
                            <span
                              className={cn(
                                "truncate text-[11px] font-semibold uppercase tracking-wide",
                                severityTextClass(section.severity),
                              )}
                            >
                              {section.title || "Issues"}
                            </span>
                            <Badge
                              variant="secondary"
                              className="h-4 px-1.5 text-[10px] tabular-nums"
                            >
                              {section.items.length < sectionTotal
                                ? `${section.items.length}/${sectionTotal}`
                                : sectionTotal}
                            </Badge>
                          </span>
                          <ChevronDown
                            className={cn(
                              "h-3.5 w-3.5 text-muted-foreground transition-transform",
                              !secOpen && "-rotate-90",
                            )}
                          />
                        </button>
                      )}
                      {secOpen && (
                        <ul className="divide-y divide-border/60">
                          {section.items.map((item) => (
                            <Row
                              key={item.id}
                              item={item as T}
                              token={token}
                              settings={settings}
                              onFixed={(_id, _summary) => onFixedOne()}
                            />
                          ))}
                        </ul>
                      )}
                    </section>
                  );
                })}
              <div className="flex items-center justify-center gap-2 border-t px-4 py-3 text-xs text-muted-foreground">
                {loadingMore ? (
                  <>
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    Loading more clips...
                  </>
                ) : canLoadMore ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 cursor-pointer px-2 text-xs"
                    onClick={onLoadMore}
                  >
                    Load more ({loadedTotal}/{countTotal})
                  </Button>
                ) : loadedTotal < countTotal ? (
                  <span>
                    Loaded {loadedTotal} of {countTotal} clips
                  </span>
                ) : (
                  <span>All {countTotal} clips loaded</span>
                )}
              </div>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
