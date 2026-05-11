import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AlertTriangle, ExternalLink, Loader2, RefreshCw } from "lucide-react";
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
  CREATOR_URL_FIELDS,
  CREATOR_URL_RULES,
  type CreatorUrlField,
} from "../creator-url-rules";
import {
  groupIssuesByField,
  parseCreatorsCsv,
  validateCreatorUrls,
  type CreatorUrlIssue,
} from "../creator-csv";
import type {
  IntegrityCheck,
  IntegritySection,
  IntegritySectionCount,
  IntegritySectionPage,
  Severity,
} from "../types";

interface CachedAnalysis {
  generatedAt: Date;
  /** Keyed by field; preserves CREATOR_URL_FIELDS order. */
  groups: Record<CreatorUrlField, CreatorUrlIssue[]>;
  totals: Record<CreatorUrlField, number>;
}

let cachedAnalysis: CachedAnalysis | null = null;
let cachedSourceKey: string | null = null;

function analyze(result: CreatorExportResult): CachedAnalysis {
  const key = `${result.generatedAt.toISOString()}::${result.source}`;
  if (cachedAnalysis && cachedSourceKey === key) {
    return cachedAnalysis;
  }
  const rows = parseCreatorsCsv(result.csv);
  const issues = validateCreatorUrls(rows);
  const groups = groupIssuesByField(issues);
  const totals: Record<CreatorUrlField, number> = {
    instagram: groups.instagram.length,
    secondary_instagram: groups.secondary_instagram.length,
    tiktok: groups.tiktok.length,
    secondary_tiktok: groups.secondary_tiktok.length,
    youtube: groups.youtube.length,
  };
  cachedAnalysis = { generatedAt: result.generatedAt, groups, totals };
  cachedSourceKey = key;
  return cachedAnalysis;
}

/**
 * If the CSV we got back can't be parsed, the local cache contains garbage
 * that would keep failing on every app start. Drop the cache so the next
 * call goes back to Supabase / HubSpot for a fresh copy.
 */
async function tryAnalyze(result: CreatorExportResult): Promise<CachedAnalysis> {
  try {
    return analyze(result);
  } catch (err) {
    if (result.source === "local") {
      await clearLocalCreatorsExport();
    }
    throw err;
  }
}

function sectionsFromAnalysis(
  analysis: CachedAnalysis,
): IntegritySection<CreatorUrlIssue>[] {
  return CREATOR_URL_FIELDS.map((field) => ({
    id: field,
    title: CREATOR_URL_RULES[field].label,
    severity: "warning" as Severity,
    defaultOpen: analysis.totals[field] > 0,
    items: analysis.groups[field],
  }));
}

function countsFromAnalysis(
  analysis: CachedAnalysis,
): IntegritySectionCount[] {
  return CREATOR_URL_FIELDS.map((field) => ({
    id: field,
    title: CREATOR_URL_RULES[field].label,
    severity: "warning" as Severity,
    defaultOpen: analysis.totals[field] > 0,
    total: analysis.totals[field],
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
): Promise<IntegritySectionPage<CreatorUrlIssue>> {
  const result = await ensureCreatorsExport({ token });
  const analysis = await tryAnalyze(result);
  return {
    sections: sectionsFromAnalysis(analysis),
  };
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

function CreatorUrlRow({
  item,
}: {
  item: CreatorUrlIssue;
  token: string;
  onFixed: (id: string, summary?: string) => void;
}) {
  const rule = CREATOR_URL_RULES[item.field];
  return (
    <li className="group flex min-h-[56px] flex-col gap-1 px-4 py-2.5 transition-colors hover:bg-muted/30 sm:flex-row sm:items-center sm:gap-3">
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
        </div>
        <div className="min-w-0 truncate text-xs text-muted-foreground" title={item.value}>
          {item.value}
        </div>
        <div className="text-[11px] text-amber-700">{rule.invalidMessage}</div>
      </div>
      <div className="flex flex-shrink-0 items-center gap-2">
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
      </div>
    </li>
  );
}

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

function CreatorUrlsBulkActions({ token }: { token: string }) {
  const [progress, setProgress] = useState<CreatorExportProgress>({ phase: "idle" });
  const [refreshing, setRefreshing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    return subscribeCreatorExportProgress(setProgress);
  }, []);

  const generatedAt = progress.generatedAt ?? cachedAnalysis?.generatedAt;
  const isStale = generatedAt ? isCreatorExportStale(generatedAt) : true;

  const runForceRefresh = async () => {
    if (!token) return;
    setRefreshing(true);
    try {
      invalidateCreatorUrlsAnalysis();
      await ensureCreatorsExport({ token, force: true });
      // The parent card driven by `useIntegrity` listens for this event and
      // re-runs `loadCheck` so the analysis from the new CSV is shown.
      window.dispatchEvent(new CustomEvent("creator-urls:refresh-requested"));
    } finally {
      setRefreshing(false);
    }
  };

  const onClick = () => {
    if (refreshing || !token) return;
    if (!isStale && generatedAt) {
      setConfirmOpen(true);
      return;
    }
    void runForceRefresh();
  };

  const ageLabel = generatedAt ? `Last export: ${formatAge(generatedAt)}` : "No cached export";
  const isBusy =
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
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 cursor-pointer px-2 text-xs"
          disabled={isBusy || !token}
          onClick={onClick}
          title="Re-run HubSpot CSV export and re-validate"
        >
          <RefreshCw className={cn("mr-1.5 h-3 w-3", isBusy && "animate-spin")} />
          Force re-export
        </Button>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
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
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setConfirmOpen(false);
                void runForceRefresh();
              }}
            >
              Re-export anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export const creatorUrlsCheck: IntegrityCheck<CreatorUrlIssue> = {
  id: "creator-urls",
  title: "Creator profile URLs",
  description:
    "Creators whose Instagram / TikTok / YouTube URLs don't match the canonical profile-URL format. Open the creator in HubSpot to fix the value manually.",
  fetchCount: fetchCreatorUrlsCounts,
  fetch: fetchCreatorUrlsSections,
  Row: CreatorUrlRow,
  BulkActions: CreatorUrlsBulkActions,
  StatusLine: CreatorUrlsStatusLine,
};
