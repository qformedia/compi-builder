/**
 * Creator profile URL integrity check.
 *
 * v2 structure (this file): the same five strict regex rules from
 * `creator-url-rules.ts` are still the gate, but rows are now triaged by
 * the classifier (`creator-url-classifier.ts`) into three action-shaped
 * buckets so the user knows exactly what to do with each issue:
 *
 *   1. Auto-fixable          — Bulk-fix runner writes the canonical URL.
 *   2. Duplicate after fix   — Send the user to the Duplicates page to
 *                              merge before any write touches HubSpot.
 *   3. Manual review         — Open the creator in HubSpot, edit by hand.
 *
 * Pull plan:
 *
 *   - `ensureCreatorsExport` provides the cached CSV (and re-fetches from
 *     HubSpot if it's older than 24h). We parse it with
 *     `parseCreatorsCsvFull` so the classifier has access to all columns.
 *   - `fetchResolutions` provides the current Supabase resolution rows.
 *     The classifier uses them to drop already-merged pairs from the
 *     duplicate-after-fix bucket and to promote the merge winner's row
 *     back to auto-fixable. Failure is non-fatal — we degrade to "treat
 *     everything as pending" so a transient Supabase outage doesn't take
 *     the integrity card down with it.
 *   - The whole pipeline is memoised by (export source, generatedAt,
 *     resolution-version) so opening the integrity card a second time
 *     doesn't re-parse the CSV.
 */

import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  ArrowRight,
  Bookmark,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Pencil,
  RefreshCw,
  ShieldAlert,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  clearLocalCreatorsExport,
  describeCreatorExportProgress,
  ensureCreatorsExport,
  isCreatorExportStale,
  subscribeCreatorExportProgress,
  useCreatorExportProgress,
  type CreatorExportProgress,
  type CreatorExportResult,
} from "@/lib/creator-export";
import { hubspotCreatorUrl } from "@/lib/hubspot-urls";
import {
  describeSupabaseError,
  fetchResolutions,
  flagPotentialDuplicate,
  flagPotentialDuplicatesBulk,
  type FlagPotentialDuplicateResult,
} from "@/lib/duplicates/supabase";
import type { DuplicatePairResolution } from "@/lib/duplicates/supabase";
import {
  CREATOR_URL_RULES,
  type CreatorUrlField,
} from "../creator-url-rules";
import {
  parseCreatorsCsvFull,
} from "../creator-csv";
import {
  classifyCreatorUrls,
  groupIssuesByBucket,
  type ClassifiedBucket,
  type ClassifiedIssue,
} from "../creator-url-classifier";
import {
  runBulkAutoFix,
  hasCompletedAutofixRun,
  AUTOFIX_FIRST_RUN_CAP,
  type BulkAutoFixOutcome,
} from "../creator-url-bulk-fix";
import type {
  IntegrityCheck,
  IntegritySection,
  IntegritySectionCount,
  IntegritySectionPage,
  Severity,
} from "../types";
import type { AppSettings } from "@/types";

interface CachedAnalysis {
  generatedAt: Date;
  issues: ClassifiedIssue[];
  counts: Record<ClassifiedBucket, number>;
  groups: Record<ClassifiedBucket, ClassifiedIssue[]>;
}

let cachedAnalysis: CachedAnalysis | null = null;
let cachedSourceKey: string | null = null;

let sessionFixedIds = new Set<string>();
let sessionFixedVersion = 0;

export function markIssuesFixed(ids: string[]) {
  for (const id of ids) sessionFixedIds.add(id);
  sessionFixedVersion++;
  invalidateCreatorUrlsAnalysis();
}

export function clearSessionFixed() {
  sessionFixedIds.clear();
  sessionFixedVersion++;
}

function analyze(
  result: CreatorExportResult,
  resolutions: Map<string, DuplicatePairResolution>,
  resolutionsVersion: string,
): CachedAnalysis {
  const key = `${result.generatedAt.toISOString()}::${result.source}::${resolutionsVersion}::sf=${sessionFixedVersion}`;
  if (cachedAnalysis && cachedSourceKey === key) {
    return cachedAnalysis;
  }
  const rows = parseCreatorsCsvFull(result.csv);
  const { issues, counts } = classifyCreatorUrls({ creators: rows, resolutions });
  
  // Promote fixed-this-session items
  for (const issue of issues) {
    if (issue.bucket === "auto-fixable" && sessionFixedIds.has(issue.id)) {
      issue.bucket = "fixed-this-session";
      counts["auto-fixable"]--;
      counts["fixed-this-session"]++;
    }
  }

  const groups = groupIssuesByBucket(issues);
  cachedAnalysis = { generatedAt: result.generatedAt, issues, counts, groups };
  cachedSourceKey = key;
  return cachedAnalysis;
}

/**
 * Fetch resolutions for the pair keys mentioned in `duplicate-after-fix`
 * collision targets. Failure is non-fatal — we proceed with an empty map
 * so the classifier still works.
 */
async function loadResolutionsSafely(
  pairKeys: string[],
): Promise<{ map: Map<string, DuplicatePairResolution>; version: string }> {
  if (pairKeys.length === 0) {
    return { map: new Map(), version: "empty" };
  }
  try {
    const map = await fetchResolutions(pairKeys);
    // Version string is stable for identical resolution data so the cache
    // key changes only when something actually moved in Supabase.
    const parts: string[] = [];
    for (const [k, v] of map) parts.push(`${k}=${v.status}=${v.winnerRecordId ?? ""}`);
    parts.sort();
    return { map, version: parts.join("|") || "none" };
  } catch (err) {
    console.warn("[creator-urls] failed to fetch resolutions:", describeSupabaseError(err));
    return { map: new Map(), version: "error" };
  }
}

/**
 * Two-pass analyser: classify once without resolutions to learn which pair
 * keys we'd hit, then re-run with the actual resolution rows. Saves a
 * blanket "fetch every pair key in the resolutions table" call — the
 * classifier only cares about pairs it's about to flag.
 */
async function analyzeWithResolutions(
  result: CreatorExportResult,
): Promise<CachedAnalysis> {
  const firstPass = (() => {
    const rows = parseCreatorsCsvFull(result.csv);
    return classifyCreatorUrls({ creators: rows });
  })();
  const pairKeys = new Set<string>();
  for (const issue of firstPass.issues) {
    if (issue.bucket !== "duplicate-after-fix" || !issue.collidesWith) continue;
    for (const c of issue.collidesWith) pairKeys.add(c.pairKey);
  }
  const { map, version } = await loadResolutionsSafely([...pairKeys]);
  return analyze(result, map, version);
}

async function tryAnalyze(result: CreatorExportResult): Promise<CachedAnalysis> {
  try {
    return await analyzeWithResolutions(result);
  } catch (err) {
    if (result.source === "local") {
      await clearLocalCreatorsExport();
    }
    throw err;
  }
}

const BUCKET_SECTIONS: { id: ClassifiedBucket; title: string; severity: Severity }[] = [
  { id: "fixed-this-session", title: "Fixed this session", severity: "info" },
  { id: "auto-fixable", title: "Auto-fixable", severity: "warning" },
  { id: "duplicate-after-fix", title: "Becomes a duplicate after fix", severity: "warning" },
  { id: "manual", title: "Manual review", severity: "info" },
];

function sectionsFromAnalysis(
  analysis: CachedAnalysis,
): IntegritySection<ClassifiedIssue>[] {
  return BUCKET_SECTIONS.map((spec) => ({
    id: spec.id,
    title: spec.title,
    severity: spec.severity,
    defaultOpen: analysis.counts[spec.id] > 0,
    items: analysis.groups[spec.id],
  }));
}

function countsFromAnalysis(analysis: CachedAnalysis): IntegritySectionCount[] {
  return BUCKET_SECTIONS.map((spec) => ({
    id: spec.id,
    title: spec.title,
    severity: spec.severity,
    defaultOpen: analysis.counts[spec.id] > 0,
    total: analysis.counts[spec.id],
  }));
}

async function fetchCreatorUrlsCounts(
  token: string,
  opts?: { force?: boolean },
): Promise<IntegritySectionCount[]> {
  if (opts?.force) {
    invalidateCreatorUrlsAnalysis();
    await clearLocalCreatorsExport();
  }
  const result = await ensureCreatorsExport({ token, force: opts?.force });
  const analysis = await tryAnalyze(result);
  return countsFromAnalysis(analysis);
}

async function fetchCreatorUrlsSections(
  token: string,
  _after?: string,
): Promise<IntegritySectionPage<ClassifiedIssue>> {
  const result = await ensureCreatorsExport({ token });
  const analysis = await tryAnalyze(result);
  return { sections: sectionsFromAnalysis(analysis) };
}

/** Reset the in-memory analysis so the next fetchCount/fetch re-parses. */
export function invalidateCreatorUrlsAnalysis(): void {
  cachedAnalysis = null;
  cachedSourceKey = null;
}

function formatAge(generatedAt: Date): string {
  const ms = Date.now() - generatedAt.getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ──────────────────────────────────────────────────────────────────────
// Row
// ──────────────────────────────────────────────────────────────────────

/**
 * Shared visual scaffold for every bucket row: creator name + field
 * badge + value diff. Per-bucket actions are rendered in the right-hand
 * slot via `actions`.
 */
function ClassifiedRowShell({
  item,
  actions,
  bucketLabel,
}: {
  item: ClassifiedIssue;
  actions: React.ReactNode;
  bucketLabel?: React.ReactNode;
}) {
  const rule = CREATOR_URL_RULES[item.field];
  return (
    <li className="group flex min-h-[64px] flex-col gap-1 px-4 py-2.5 transition-colors hover:bg-muted/30 sm:flex-row sm:items-center sm:gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            className="min-w-0 truncate text-left text-sm font-medium hover:underline"
            title="Open creator in HubSpot"
            onClick={() => openUrl(hubspotCreatorUrl(item.creatorId))}
          >
            {item.creatorName}
          </button>
          <Badge
            variant="outline"
            className="h-4 flex-shrink-0 rounded px-1.5 text-[10px] font-normal text-muted-foreground"
          >
            {rule.label}
          </Badge>
          {bucketLabel}
        </div>
        <ValueDiff item={item} />
        <ReasonLine item={item} />
      </div>
      <div className="flex flex-shrink-0 items-center gap-2">{actions}</div>
    </li>
  );
}

function ValueDiff({ item }: { item: ClassifiedIssue }) {
  if (item.proposedUrl && item.proposedUrl !== item.rawValue) {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span className="min-w-0 truncate font-mono text-[11px] text-rose-700" title={item.rawValue}>
          {item.rawValue}
        </span>
        <ArrowRight className="h-3 w-3 flex-shrink-0 opacity-60" />
        <span
          className="min-w-0 truncate font-mono text-[11px] text-emerald-700"
          title={item.proposedUrl}
        >
          {item.proposedUrl}
        </span>
      </div>
    );
  }
  return (
    <div className="min-w-0 truncate text-xs text-muted-foreground" title={item.rawValue}>
      {item.rawValue}
    </div>
  );
}

function ReasonLine({ item }: { item: ClassifiedIssue }) {
  if (item.bucket === "manual") {
    const rule = CREATOR_URL_RULES[item.field];
    return (
      <div className="text-[11px] text-amber-700">
        {item.manualReason || rule.invalidMessage}
      </div>
    );
  }
  if (item.bucket === "duplicate-after-fix") {
    const other = item.collidesWith?.[0];
    const more = item.collidesWith && item.collidesWith.length > 1
      ? ` and ${item.collidesWith.length - 1} other${item.collidesWith.length - 1 === 1 ? "" : "s"}`
      : "";
    return (
      <div className="text-[11px] text-amber-700">
        Same canonical URL as{" "}
        <span className="font-medium">{other?.creatorName ?? "another creator"}</span>
        {more} — resolve in Duplicates first.
      </div>
    );
  }
  if (item.proposedIssues && item.proposedIssues.length > 0) {
    return (
      <div className="text-[11px] text-emerald-700">
        Will: {item.proposedIssues.join(", ")}.
      </div>
    );
  }
  return null;
}

function CreatorUrlRow({
  item,
  token,
  onFixed,
  settings,
}: {
  item: ClassifiedIssue;
  token: string;
  onFixed: (id: string, summary?: string) => void;
  settings: AppSettings;
}) {
  if (item.bucket === "fixed-this-session") {
    return <FixedThisSessionRow item={item} />;
  }
  if (item.bucket === "auto-fixable") {
    return (
      <AutoFixableRow item={item} token={token} onFixed={onFixed} />
    );
  }
  if (item.bucket === "duplicate-after-fix") {
    return <DuplicateAfterFixRow item={item} settings={settings} />;
  }
  return <ManualRow item={item} />;
}

function FixedThisSessionRow({ item }: { item: ClassifiedIssue }) {
  return (
    <ClassifiedRowShell
      item={item}
      bucketLabel={
        <Badge
          variant="outline"
          className="h-4 flex-shrink-0 rounded border-emerald-300 bg-emerald-50 px-1.5 text-[10px] font-normal text-emerald-700"
        >
          <CheckCircle2 className="mr-0.5 h-3 w-3 inline-block" />
          Fixed
        </Badge>
      }
      actions={
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 cursor-pointer px-2 text-xs"
          onClick={() => openUrl(hubspotCreatorUrl(item.creatorId))}
        >
          <ExternalLink className="mr-1 h-3 w-3" />
          HubSpot
        </Button>
      }
    />
  );
}

function AutoFixableRow({
  item,
  token,
  onFixed,
}: {
  item: ClassifiedIssue;
  token: string;
  onFixed: (id: string, summary?: string) => void;
}) {
  const [state, setState] = useState<
    { kind: "idle" } | { kind: "running" } | { kind: "applied" } | { kind: "skipped"; reason: string } | { kind: "error"; message: string }
  >({ kind: "idle" });

  const applyOne = async () => {
    if (state.kind === "running" || !token) return;
    setState({ kind: "running" });
    try {
      const [outcome] = await runBulkAutoFix({
        token,
        issues: [item],
        onProgress: () => {},
      });
      if (outcome.kind === "applied") {
        setState({ kind: "applied" });
        onFixed(item.id, `Fixed ${CREATOR_URL_RULES[item.field].label}`);
        markIssuesFixed([item.id]);
        window.dispatchEvent(new CustomEvent("creator-urls:reclassify", { detail: "creator-urls" }));
      } else if (outcome.kind === "skipped") {
        setState({ kind: "skipped", reason: outcome.reason });
      } else {
        setState({ kind: "error", message: outcome.message });
      }
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <ClassifiedRowShell
      item={item}
      actions={
        <>
          {state.kind === "skipped" && (
            <span className="max-w-[180px] truncate text-[10px] text-muted-foreground" title={state.reason}>
              Skipped: {state.reason}
            </span>
          )}
          {state.kind === "error" && (
            <span className="max-w-[180px] truncate text-[10px] text-destructive" title={state.message}>
              {state.message}
            </span>
          )}
          {state.kind !== "applied" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 cursor-pointer px-2 text-xs"
              disabled={state.kind === "running" || !token}
              onClick={() => void applyOne()}
              title="Apply just this fix"
            >
              {state.kind === "running" ? (
                <>
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  Fixing…
                </>
              ) : (
                <>
                  <Pencil className="mr-1 h-3 w-3" />
                  Fix
                </>
              )}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 cursor-pointer px-2 text-xs"
            onClick={() => openUrl(hubspotCreatorUrl(item.creatorId))}
          >
            <ExternalLink className="mr-1 h-3 w-3" />
            HubSpot
          </Button>
        </>
      }
    />
  );
}

function DuplicateAfterFixRow({
  item,
  settings,
}: {
  item: ClassifiedIssue;
  settings: AppSettings;
}) {
  const other = item.collidesWith?.[0];
  // Optimistic flag state. Starts mirroring the classifier-derived value
  // so a teammate's flag (loaded with the resolutions fetch) is visible
  // immediately; flips after the local click so the user sees the
  // "Marked" indicator without waiting for the next reclassify cycle.
  const [optimisticFlag, setOptimisticFlag] = useState<{
    source: string;
    flaggedAt: Date;
  } | null>(null);
  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState<string | null>(null);

  const flagged = optimisticFlag ?? (other?.flaggedSource
    ? { source: other.flaggedSource, flaggedAt: other.flaggedAt ?? new Date() }
    : null);

  const onOpenDuplicates = () => {
    if (!other) return;
    window.dispatchEvent(
      new CustomEvent("duplicates:open-pair", { detail: { pairKey: other.pairKey } }),
    );
  };

  const onMark = async () => {
    if (!other || marking) return;
    setMarking(true);
    setMarkError(null);
    try {
      const result = await flagPotentialDuplicate({
        recordIdA: item.creatorId,
        recordIdB: other.creatorId,
        source: "integrity-mark",
        actor: settings.ownerEmail || "",
      });
      if (result.kind === "error") {
        setMarkError(result.message);
        return;
      }
      // Treat "skipped: already-flagged" the same as "flagged" — the
      // row should still show the Marked state.
      setOptimisticFlag({ source: "integrity-mark", flaggedAt: new Date() });
      // Nudge the integrity provider to re-fetch resolutions so other
      // rows (and the bulk-action counts) catch up.
      window.dispatchEvent(
        new CustomEvent("creator-urls:reclassify", { detail: "creator-urls" }),
      );
    } catch (err) {
      setMarkError(err instanceof Error ? err.message : String(err));
    } finally {
      setMarking(false);
    }
  };

  return (
    <ClassifiedRowShell
      item={item}
      bucketLabel={
        flagged ? (
          <Badge
            variant="outline"
            className="h-4 flex-shrink-0 rounded border-violet-300 bg-violet-50 px-1.5 text-[10px] font-normal text-violet-700"
            title={`Flagged ${flagged.flaggedAt.toLocaleString()}`}
          >
            <Bookmark className="mr-0.5 h-3 w-3 inline-block" />
            Marked
          </Badge>
        ) : (
          <Badge
            variant="outline"
            className="h-4 flex-shrink-0 rounded px-1.5 text-[10px] font-normal text-amber-700"
          >
            Resolve first
          </Badge>
        )
      }
      actions={
        <>
          {markError && (
            <span
              className="max-w-[180px] truncate text-[10px] text-destructive"
              title={markError}
            >
              {markError}
            </span>
          )}
          {flagged ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 cursor-pointer px-2 text-xs"
              disabled={!other}
              onClick={onOpenDuplicates}
              title="Open this pair in the Duplicates page"
            >
              <Users className="mr-1 h-3 w-3" />
              Resolve in Duplicates
              <ArrowRight className="ml-1 h-3 w-3" />
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 cursor-pointer px-2 text-xs"
                disabled={!other || marking}
                onClick={() => void onMark()}
                title="Add this pair to the Duplicates page queue"
              >
                {marking ? (
                  <>
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    Marking…
                  </>
                ) : (
                  <>
                    <Bookmark className="mr-1 h-3 w-3" />
                    Mark as potential duplicate
                  </>
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 cursor-pointer px-2 text-xs"
                disabled={!other}
                onClick={onOpenDuplicates}
                title="Jump to this pair in the Duplicates page"
              >
                <Users className="mr-1 h-3 w-3" />
                Open in Duplicates
              </Button>
            </>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 cursor-pointer px-2 text-xs"
            onClick={() => openUrl(hubspotCreatorUrl(item.creatorId))}
          >
            <ExternalLink className="mr-1 h-3 w-3" />
            HubSpot
          </Button>
        </>
      }
    />
  );
}

function ManualRow({ item }: { item: ClassifiedIssue }) {
  return (
    <ClassifiedRowShell
      item={item}
      actions={
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 cursor-pointer px-2 text-xs"
          onClick={() => openUrl(hubspotCreatorUrl(item.creatorId))}
        >
          <ExternalLink className="mr-1 h-3 w-3" />
          Open in HubSpot
        </Button>
      }
    />
  );
}

// ──────────────────────────────────────────────────────────────────────
// StatusLine + BulkActions
// ──────────────────────────────────────────────────────────────────────

function CreatorUrlsStatusLine() {
  const progress = useCreatorExportProgress();
  const message = describeCreatorExportProgress(progress);
  if (!message) return null;
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin" />
      <span className="min-w-0 truncate">{message}</span>
    </div>
  );
}

function CreatorUrlsBulkActions({
  sections,
  token,
  settings,
  onFixed,
}: {
  sections: IntegritySection<ClassifiedIssue>[];
  token: string;
  settings: AppSettings;
  onFixed: (id: string, summary?: string) => void;
}) {
  const [progress, setProgress] = useState<CreatorExportProgress>({ phase: "idle" });
  const [refreshing, setRefreshing] = useState(false);
  const [confirmRefreshOpen, setConfirmRefreshOpen] = useState(false);
  const [fixDialogOpen, setFixDialogOpen] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [fixProgress, setFixProgress] = useState({ done: 0, total: 0 });
  const [fixOutcomes, setFixOutcomes] = useState<BulkAutoFixOutcome[] | null>(null);
  const [previouslyRan, setPreviouslyRan] = useState<boolean>(hasCompletedAutofixRun());
  // Bulk-mark state — separate from the bulk auto-fix dialog because
  // marking is a much lighter operation (Supabase-only, no HubSpot
  // writes) and doesn't need a confirmation modal.
  const [marking, setMarking] = useState(false);
  const [markProgress, setMarkProgress] = useState({ done: 0, total: 0 });
  const [markOutcome, setMarkOutcome] = useState<{
    flagged: number;
    skipped: number;
    errors: number;
    /** First per-row error message captured from the bulk run. Surfaced
     *  inline so a fully-failed run (e.g. missing migration) doesn't
     *  read as "nothing happened". */
    firstErrorMessage?: string;
  } | null>(null);

  useEffect(() => {
    return subscribeCreatorExportProgress(setProgress);
  }, []);

  const autoFixable = useMemo(
    () => sections.find((s) => s.id === "auto-fixable")?.items ?? [],
    [sections],
  );

  const appliedSlice = useMemo(() => {
    const cap = previouslyRan ? autoFixable.length : Math.min(autoFixable.length, AUTOFIX_FIRST_RUN_CAP);
    return autoFixable.slice(0, cap);
  }, [autoFixable, previouslyRan]);

  // Duplicate-after-fix rows that haven't been flagged yet. The classifier
  // already populates `collidesWith[0].flaggedSource`, so anything still
  // null here is fresh work for the bulk-mark button.
  const markable = useMemo(() => {
    const items = sections.find((s) => s.id === "duplicate-after-fix")?.items ?? [];
    return items.filter((item) => {
      const other = item.collidesWith?.[0];
      return !!other && !other.flaggedSource;
    });
  }, [sections]);

  const generatedAt = progress.generatedAt ?? cachedAnalysis?.generatedAt;
  const isStale = generatedAt ? isCreatorExportStale(generatedAt) : true;

  const runForceRefresh = async () => {
    if (!token) return;
    setRefreshing(true);
    try {
      clearSessionFixed();
      invalidateCreatorUrlsAnalysis();
      await ensureCreatorsExport({ token, force: true });
      window.dispatchEvent(new CustomEvent("creator-urls:refresh-requested"));
    } finally {
      setRefreshing(false);
    }
  };

  const onClickRefresh = () => {
    if (refreshing || !token) return;
    if (!isStale && generatedAt) {
      setConfirmRefreshOpen(true);
      return;
    }
    void runForceRefresh();
  };

  const onClickFixAll = () => {
    if (autoFixable.length === 0 || fixing || !token) return;
    setFixOutcomes(null);
    setFixDialogOpen(true);
  };

  const runFixAll = async () => {
    setFixing(true);
    setFixProgress({ done: 0, total: 0 });
    try {
      const slice = appliedSlice;
      setFixProgress({ done: 0, total: slice.length });
      const outcomes = await runBulkAutoFix({
        token,
        issues: slice,
        onProgress: (done) => setFixProgress({ done, total: slice.length }),
      });
      setFixOutcomes(outcomes);
      const appliedIds: string[] = [];
      for (const o of outcomes) {
        if (o.kind === "applied") {
          onFixed(o.issueId, "Auto-fixed URL");
          appliedIds.push(o.issueId);
        }
      }
      if (appliedIds.length > 0) {
        setPreviouslyRan(true);
        markIssuesFixed(appliedIds);
        window.dispatchEvent(new CustomEvent("creator-urls:reclassify", { detail: "creator-urls" }));
      }
    } finally {
      setFixing(false);
    }
  };

  const onClickMarkAll = () => {
    if (markable.length === 0 || marking) return;
    setMarkOutcome(null);
    void runMarkAll();
  };

  const runMarkAll = async () => {
    setMarking(true);
    setMarkProgress({ done: 0, total: markable.length });
    try {
      // Deduplicate by pair_key in case the same collision appears
      // multiple times (e.g. a creator's primary + secondary both
      // collide with the same other record). Without this, the bulk
      // helper would issue redundant upserts.
      const seen = new Set<string>();
      const items = markable
        .map((item) => {
          const other = item.collidesWith?.[0];
          if (!other) return null;
          if (seen.has(other.pairKey)) return null;
          seen.add(other.pairKey);
          return {
            recordIdA: item.creatorId,
            recordIdB: other.creatorId,
            source: "integrity-mark-bulk",
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      const results: FlagPotentialDuplicateResult[] = await flagPotentialDuplicatesBulk({
        items,
        actor: settings.ownerEmail || "",
        onProgress: (done) => setMarkProgress({ done, total: items.length }),
      });
      let flagged = 0;
      let skipped = 0;
      let errors = 0;
      let firstErrorMessage: string | undefined;
      for (const r of results) {
        if (r.kind === "flagged") flagged++;
        else if (r.kind === "skipped") skipped++;
        else {
          errors++;
          if (!firstErrorMessage) firstErrorMessage = r.message;
        }
      }
      setMarkOutcome({ flagged, skipped, errors, firstErrorMessage });
      if (flagged > 0) {
        window.dispatchEvent(
          new CustomEvent("creator-urls:reclassify", { detail: "creator-urls" }),
        );
      }
    } finally {
      setMarking(false);
    }
  };

  const ageLabel = generatedAt ? `Last export: ${formatAge(generatedAt)}` : "No cached export";
  const isExportBusy =
    refreshing ||
    [
      "exporting-hubspot",
      "polling-hubspot",
      "downloading-hubspot",
      "uploading-supabase",
      "downloading-supabase",
      "saving-local",
    ].includes(progress.phase);

  return (
    <>
      <div className="flex flex-col items-end gap-1">
        <span className="text-[11px] text-muted-foreground">{ageLabel}</span>
        <div className="flex items-center gap-1">
          {autoFixable.length > 0 && (
            <Button
              type="button"
              variant="default"
              size="sm"
              className="h-7 cursor-pointer px-2 text-xs"
              disabled={fixing || !token}
              onClick={onClickFixAll}
              title="Apply every auto-fixable URL"
            >
              {fixing ? (
                <>
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  Fixing {fixProgress.done}/{fixProgress.total}
                </>
              ) : (
                <>
                  <Pencil className="mr-1 h-3 w-3" />
                  Fix all auto-fixable ({autoFixable.length})
                </>
              )}
            </Button>
          )}
          {markable.length > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 cursor-pointer border-violet-300 px-2 text-xs text-violet-700 hover:bg-violet-50 hover:text-violet-700"
              disabled={marking}
              onClick={onClickMarkAll}
              title="Add every unmarked duplicate-after-fix pair to the Duplicates queue"
            >
              {marking ? (
                <>
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  Marking {markProgress.done}/{markProgress.total}
                </>
              ) : (
                <>
                  <Bookmark className="mr-1 h-3 w-3" />
                  Mark all as potential duplicate ({markable.length})
                </>
              )}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 cursor-pointer px-2 text-xs"
            disabled={isExportBusy || !token}
            onClick={onClickRefresh}
            title="Re-run HubSpot CSV export and re-validate"
          >
            <RefreshCw className={cn("mr-1.5 h-3 w-3", isExportBusy && "animate-spin")} />
            Force re-export
          </Button>
        </div>
        {markOutcome && (
          <div className="flex max-w-[420px] flex-col items-end gap-0.5">
            <span
              className={cn(
                "text-[11px]",
                markOutcome.errors > 0 ? "text-destructive" : "text-muted-foreground",
              )}
              title="Last bulk-mark run"
            >
              Marked {markOutcome.flagged}
              {markOutcome.skipped > 0 && ` · ${markOutcome.skipped} already marked`}
              {markOutcome.errors > 0 && ` · ${markOutcome.errors} failed`}
            </span>
            {markOutcome.errors > 0 && markOutcome.firstErrorMessage && (
              <span
                className="max-w-full truncate text-[11px] text-destructive"
                title={markOutcome.firstErrorMessage}
              >
                {markOutcome.firstErrorMessage}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Re-export confirmation (warns if cache is fresh). */}
      <Dialog open={confirmRefreshOpen} onOpenChange={setConfirmRefreshOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              Re-export creators?
            </DialogTitle>
            <DialogDescription>
              The cached export is only{" "}
              <span className="font-medium">
                {generatedAt ? formatAge(generatedAt) : "recent"}
              </span>{" "}
              old. Re-running can take a few minutes and counts towards your HubSpot API
              limits. Continue?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setConfirmRefreshOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setConfirmRefreshOpen(false);
                void runForceRefresh();
              }}
            >
              Re-export anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Fix-All confirmation dialog with sample preview. */}
      <Dialog open={fixDialogOpen} onOpenChange={(open) => !fixing && setFixDialogOpen(open)}>
        <DialogContent className="sm:max-w-4xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-amber-600" />
              {fixOutcomes
                ? "Auto-fix complete"
                : previouslyRan
                  ? `Fix ${autoFixable.length} URL${autoFixable.length === 1 ? "" : "s"}?`
                  : `Fix first ${Math.min(autoFixable.length, AUTOFIX_FIRST_RUN_CAP)} of ${autoFixable.length} URL${autoFixable.length === 1 ? "" : "s"}?`}
            </DialogTitle>
            <DialogDescription>
              {fixOutcomes
                ? renderOutcomeSummary(fixOutcomes)
                : previouslyRan
                  ? "Each row is re-checked against HubSpot right before the write. If the value already changed, that row is skipped."
                  : `First run is capped at ${AUTOFIX_FIRST_RUN_CAP} rows so you can spot-check the result. The cap lifts automatically after the first successful run.`}
            </DialogDescription>
          </DialogHeader>

          {!fixOutcomes && !fixing && (
            <ChangesTable items={appliedSlice} totalCount={autoFixable.length} />
          )}

          {fixing && (
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Applying {fixProgress.done} of {fixProgress.total}…
            </div>
          )}

          {fixOutcomes && <OutcomeList outcomes={fixOutcomes} />}

          <DialogFooter className="gap-2">
            {fixOutcomes ? (
              <Button onClick={() => setFixDialogOpen(false)}>Close</Button>
            ) : (
              <>
                <Button variant="ghost" disabled={fixing} onClick={() => setFixDialogOpen(false)}>
                  Cancel
                </Button>
                <Button
                  disabled={fixing}
                  onClick={() => void runFixAll()}
                >
                  {fixing ? (
                    <>
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      Fixing…
                    </>
                  ) : (
                    "Apply fixes"
                  )}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function renderOutcomeSummary(outcomes: BulkAutoFixOutcome[]): string {
  let applied = 0;
  let skipped = 0;
  let errors = 0;
  for (const o of outcomes) {
    if (o.kind === "applied") applied++;
    else if (o.kind === "skipped") skipped++;
    else errors++;
  }
  const parts: string[] = [`${applied} applied`];
  if (skipped > 0) parts.push(`${skipped} skipped`);
  if (errors > 0) parts.push(`${errors} failed`);
  return parts.join(" · ");
}

function ChangesTable({ items, totalCount }: { items: ClassifiedIssue[]; totalCount: number }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 min-h-0">
      <div className="overflow-y-auto max-h-[55vh] rounded-md border">
        <table className="w-full text-left text-[11px]">
          <thead className="sticky top-0 z-10 bg-muted/80 backdrop-blur-sm">
            <tr className="border-b">
              <th className="px-3 py-2 font-medium">Creator</th>
              <th className="px-3 py-2 font-medium">Field</th>
              <th className="px-3 py-2 font-medium">Before → After</th>
              <th className="px-3 py-2 font-medium">Changes</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {items.map((item) => (
              <tr key={item.id} className="hover:bg-muted/30">
                <td className="px-3 py-2 align-top">
                  <button
                    type="button"
                    className="font-medium hover:underline text-left text-foreground"
                    title="Open creator in HubSpot"
                    onClick={() => openUrl(hubspotCreatorUrl(item.creatorId))}
                  >
                    {item.creatorName}
                  </button>
                </td>
                <td className="px-3 py-2 align-top">
                  <Badge
                    variant="outline"
                    className="h-4 rounded px-1.5 text-[10px] font-normal text-muted-foreground whitespace-nowrap"
                  >
                    {CREATOR_URL_RULES[item.field].label}
                  </Badge>
                </td>
                <td className="px-3 py-2 align-top">
                  <div className="flex flex-col gap-0.5">
                    <span className="truncate font-mono text-[10px] text-rose-700 max-w-[400px]" title={item.rawValue}>
                      {item.rawValue}
                    </span>
                    <span className="truncate font-mono text-[10px] text-emerald-700 max-w-[400px]" title={item.proposedUrl}>
                      {item.proposedUrl}
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2 align-top text-muted-foreground">
                  {item.proposedIssues?.join(", ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {items.length < totalCount && (
        <div className="text-[11px] text-muted-foreground">
          Showing {items.length} of {totalCount} auto-fixable
        </div>
      )}
    </div>
  );
}

function OutcomeList({ outcomes }: { outcomes: BulkAutoFixOutcome[] }) {
  const skipped = outcomes.filter((o) => o.kind === "skipped");
  const errors = outcomes.filter((o) => o.kind === "error");
  if (skipped.length === 0 && errors.length === 0) {
    return (
      <div className="rounded-md border border-emerald-200 bg-emerald-50/40 px-3 py-2 text-xs text-emerald-700">
        Every selected row was written successfully.
      </div>
    );
  }
  return (
    <div className="space-y-2 text-[11px]">
      {errors.length > 0 && (
        <div className="space-y-1 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
          <div className="font-medium text-destructive">{errors.length} failed</div>
          <ul className="space-y-0.5 text-destructive">
            {errors.slice(0, 6).map((o) => (
              <li key={o.issueId} className="truncate">
                {o.creatorName}: {o.message}
              </li>
            ))}
            {errors.length > 6 && <li className="text-destructive/60">+ {errors.length - 6} more</li>}
          </ul>
        </div>
      )}
      {skipped.length > 0 && (
        <div className="space-y-1 rounded-md border bg-muted/40 px-3 py-2">
          <div className="font-medium text-muted-foreground">{skipped.length} skipped</div>
          <ul className="space-y-0.5 text-muted-foreground">
            {skipped.slice(0, 6).map((o) => (
              <li key={o.issueId} className="truncate">
                {o.creatorName}: {o.reason}
              </li>
            ))}
            {skipped.length > 6 && <li>+ {skipped.length - 6} more</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

export const creatorUrlsCheck: IntegrityCheck<ClassifiedIssue> = {
  id: "creator-urls",
  title: "Creator profile URLs",
  description:
    "Creators whose Instagram / TikTok / YouTube URLs don't match the canonical profile-URL format. Auto-fixable rows can be corrected in bulk; collisions are routed to the Duplicates page.",
  fetchCount: fetchCreatorUrlsCounts,
  fetch: fetchCreatorUrlsSections,
  Row: CreatorUrlRow,
  BulkActions: CreatorUrlsBulkActions,
  StatusLine: CreatorUrlsStatusLine,
};

// Re-export internal types so the bulk-fix module and tests can reuse them.
export type { CreatorUrlField };
