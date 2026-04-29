import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Copy, Trash2, ChevronDown, ChevronRight, Pause, Play, Stethoscope } from "lucide-react";

export type DownloadLogLevel = "debug" | "info" | "warn" | "error";

export interface DownloadLogEntry {
  id: number;
  timestamp: string;
  level: DownloadLogLevel;
  source: string;
  clipId: string | null;
  message: string;
  detail: string | null;
}

interface DownloadsLogDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hubspotToken?: string;
}

const LEVEL_RANK: Record<DownloadLogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_BADGE: Record<DownloadLogLevel, string> = {
  debug: "text-muted-foreground/70",
  info: "text-sky-500",
  warn: "text-amber-500",
  error: "text-destructive",
};

const MAX_RENDERED = 1000;

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    const ms = String(d.getMilliseconds()).padStart(3, "0");
    return `${hh}:${mm}:${ss}.${ms}`;
  } catch {
    return iso;
  }
}

function formatEntryAsText(e: DownloadLogEntry): string {
  const head = `[${e.timestamp}] [${e.level.toUpperCase().padEnd(5)}] [${e.source}]${
    e.clipId ? ` [clip:${e.clipId}]` : ""
  } ${e.message}`;
  return e.detail ? `${head}\n${e.detail}` : head;
}

export function DownloadsLogDialog({ open, onOpenChange, hubspotToken }: DownloadsLogDialogProps) {
  const [entries, setEntries] = useState<DownloadLogEntry[]>([]);
  const [minLevel, setMinLevel] = useState<DownloadLogLevel>("debug");
  const [search, setSearch] = useState("");
  const [autoscroll, setAutoscroll] = useState(true);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [diagnosingIds, setDiagnosingIds] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Initial load + live subscription. Keep the listener active while the dialog
  // is open so users don't miss events; tear down on close to avoid leaks.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    invoke<DownloadLogEntry[]>("get_download_log")
      .then((all) => {
        if (cancelled) return;
        setEntries(all);
      })
      .catch(() => {});

    const unlistenPromise = listen<DownloadLogEntry>("download-log-entry", (event) => {
      setEntries((prev) => {
        const next = prev.length > MAX_RENDERED * 2 ? prev.slice(-MAX_RENDERED) : [...prev];
        next.push(event.payload);
        return next;
      });
    });

    return () => {
      cancelled = true;
      unlistenPromise.then((fn) => fn()).catch(() => {});
    };
  }, [open]);

  // Autoscroll to bottom whenever new entries arrive (unless paused).
  useEffect(() => {
    if (!autoscroll) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [entries, autoscroll]);

  const filtered = useMemo(() => {
    const minRank = LEVEL_RANK[minLevel];
    const q = search.trim().toLowerCase();
    const matches = entries.filter((e) => {
      if (LEVEL_RANK[e.level] < minRank) return false;
      if (!q) return true;
      return (
        e.source.toLowerCase().includes(q) ||
        e.message.toLowerCase().includes(q) ||
        (e.clipId?.toLowerCase().includes(q) ?? false) ||
        (e.detail?.toLowerCase().includes(q) ?? false)
      );
    });
    return matches.slice(-MAX_RENDERED);
  }, [entries, minLevel, search]);

  const handleCopyAll = useCallback(async () => {
    const text = filtered.map(formatEntryAsText).join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Ignore — clipboard write may be blocked in some contexts. The user
      // can still scroll/screenshot if needed.
    }
  }, [filtered]);

  const handleClear = useCallback(async () => {
    try {
      await invoke("clear_download_log");
      setEntries([]);
      setExpandedIds(new Set());
    } catch {
      // ignore
    }
  }, []);

  const toggleExpand = useCallback((id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleDiagnose = useCallback(async (clipId: string) => {
    if (!hubspotToken) return;
    setDiagnosingIds((prev) => {
      const next = new Set(prev);
      next.add(clipId);
      return next;
    });
    try {
      await invoke("diagnose_hubspot_clip", { token: hubspotToken, clipId });
    } catch {
      // command logs backend-side errors already
    } finally {
      setDiagnosingIds((prev) => {
        const next = new Set(prev);
        next.delete(clipId);
        return next;
      });
    }
  }, [hubspotToken]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[88vw] max-h-[85vh] flex flex-col gap-3">
        <DialogHeader>
          <DialogTitle>Downloads Log</DialogTitle>
          <DialogDescription>
            Live technical log of every download attempt, retry, and failure. Useful for debugging
            and sharing with support. Up to 5,000 entries are kept in memory; restarting CompiFlow
            clears the log.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <Select value={minLevel} onValueChange={(v) => setMinLevel(v as DownloadLogLevel)}>
            <SelectTrigger className="h-8 w-[140px]">
              <SelectValue placeholder="Min level" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="debug">Debug & up</SelectItem>
              <SelectItem value="info">Info & up</SelectItem>
              <SelectItem value="warn">Warnings & errors</SelectItem>
              <SelectItem value="error">Errors only</SelectItem>
            </SelectContent>
          </Select>

          <Input
            placeholder="Filter by source, clip ID, or message…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 flex-1 min-w-[200px]"
          />

          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5"
            onClick={() => setAutoscroll((v) => !v)}
            title={autoscroll ? "Pause auto-scroll" : "Resume auto-scroll"}
          >
            {autoscroll ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            {autoscroll ? "Pause" : "Resume"}
          </Button>

          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5"
            onClick={handleCopyAll}
            title="Copy all visible entries to clipboard"
          >
            <Copy className="h-3.5 w-3.5" />
            Copy
          </Button>

          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5"
            onClick={handleClear}
            title="Clear the log"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clear
          </Button>
        </div>

        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto rounded-md border bg-muted/30 p-2 font-mono text-[11px] leading-snug"
        >
          {filtered.length === 0 ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              No entries match the current filters.
            </div>
          ) : (
            filtered.map((e) => {
              const expanded = expandedIds.has(e.id);
              const hasDetail = !!e.detail;
              return (
                <div key={e.id} className="py-0.5">
                  <div
                    className={`flex items-start gap-1.5 ${
                      hasDetail ? "cursor-pointer hover:bg-muted/50 rounded px-1 -mx-1" : ""
                    }`}
                    onClick={hasDetail ? () => toggleExpand(e.id) : undefined}
                  >
                    {hasDetail ? (
                      <span className="mt-0.5 text-muted-foreground/50">
                        {expanded ? (
                          <ChevronDown className="h-3 w-3" />
                        ) : (
                          <ChevronRight className="h-3 w-3" />
                        )}
                      </span>
                    ) : (
                      <span className="w-3" />
                    )}
                    <span className="text-muted-foreground/60 tabular-nums">
                      {formatTimestamp(e.timestamp)}
                    </span>
                    <span className={`uppercase font-semibold w-12 ${LEVEL_BADGE[e.level]}`}>
                      {e.level}
                    </span>
                    <span className="text-purple-500 dark:text-purple-400 w-20 truncate" title={e.source}>
                      {e.source}
                    </span>
                    {e.clipId ? (
                      <span
                        className="text-emerald-500 dark:text-emerald-400 max-w-[140px] truncate"
                        title={`clip:${e.clipId}`}
                      >
                        clip:{e.clipId}
                      </span>
                    ) : null}
                    {e.source === "hubspot" && e.level === "error" && e.clipId && hubspotToken ? (
                      <button
                        className="rounded border px-1.5 py-0.5 text-[10px] font-medium text-foreground/80 hover:bg-muted"
                        onClick={(evt) => {
                          evt.stopPropagation();
                          void handleDiagnose(e.clipId!);
                        }}
                        title="Run HubSpot URL diagnosis for this clip"
                        disabled={diagnosingIds.has(e.clipId)}
                      >
                        <span className="inline-flex items-center gap-1">
                          <Stethoscope className="h-3 w-3" />
                          {diagnosingIds.has(e.clipId) ? "Diagnosing…" : "Diagnose"}
                        </span>
                      </button>
                    ) : null}
                    <span className="flex-1 break-words text-foreground/90">{e.message}</span>
                  </div>
                  {hasDetail && expanded && (
                    <pre className="mt-1 ml-5 max-h-64 overflow-auto rounded bg-background/70 p-2 text-[10.5px] text-muted-foreground whitespace-pre-wrap border">
                      {e.detail}
                    </pre>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="text-[11px] text-muted-foreground flex items-center justify-between">
          <span>
            Showing {filtered.length.toLocaleString()} of {entries.length.toLocaleString()} entries
            {entries.length >= 5000 && " (oldest are dropped after 5,000)"}
          </span>
          <span className="font-mono">
            {autoscroll ? "Auto-scroll on" : "Auto-scroll paused"}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
