import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CreatorPicker } from "@/components/CreatorPicker";
import { SCORE_COLORS, HubSpotIcon, getPlatform, PlatformIcon } from "@/components/ClipCard";
import { fetchClipsMissingCreator } from "@/lib/hubspot";
import type { Clip } from "@/types";
import type { CreatorOption } from "@/lib/hubspot";
import { cn } from "@/lib/utils";
import type { IntegrityCheck, IntegritySection, Severity } from "../types";

const HUBSPOT_CLIP_RECORD = "https://app-eu1.hubspot.com/contacts/146859718/record/2-192287471";

function clipUrlParts(link: string): { host: string; shortPath: string } {
  try {
    const u = new URL(link);
    const host = u.hostname.replace(/^www\./, "");
    const path = u.pathname + (u.search ? "…" : "");
    const shortPath = path.length > 48 ? path.slice(0, 45) + "…" : path;
    return { host, shortPath: shortPath || "/" };
  } catch {
    return { host: "URL", shortPath: link.length > 48 ? `${link.slice(0, 45)}…` : link };
  }
}

function ClipsMissingCreatorRow({
  item: clip,
  token,
  onFixed,
}: {
  item: Clip;
  token: string;
  onFixed: (id: string, summary?: string) => void;
}) {
  const [associating, setAssociating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fixedName, setFixedName] = useState<string | null>(null);
  const platform = getPlatform(clip.link);
  const { host, shortPath } = clipUrlParts(clip.link);
  const tags = clip.tags?.slice(0, 3) ?? [];
  const moreTags = (clip.tags?.length ?? 0) - tags.length;
  const np = clip.numPublishedVideoProjects ?? 0;
  const showThumb = !!clip.fetchedThumbnail;

  const onPick = useCallback(
    async (creator: CreatorOption | null) => {
      if (!creator) return;
      setError(null);
      setAssociating(true);
      try {
        await invoke("associate_clip_to_creator", {
          token,
          clipId: clip.id,
          creatorId: creator.id,
        });
        setFixedName(creator.name);
        onFixed(clip.id, creator.name);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setAssociating(false);
      }
    },
    [clip.id, token, onFixed],
  );

  return (
    <li
      className={cn(
        "group flex flex-wrap items-center gap-3 px-4 py-2 transition-colors hover:bg-muted/30 sm:flex-nowrap",
        fixedName && "bg-emerald-50/40",
      )}
    >
      <button
        type="button"
        className="relative h-12 w-12 flex-shrink-0 overflow-hidden rounded-md border bg-muted"
        onClick={() => openUrl(clip.link)}
        title={clip.link}
      >
        {showThumb && clip.fetchedThumbnail ? (
          <img
            src={clip.fetchedThumbnail}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-muted-foreground">
            <PlatformIcon platform={platform} className="h-5 w-5 opacity-50" />
          </span>
        )}
      </button>

      <div className="min-w-0 flex-1">
        <div className="truncate text-xs" title={clip.link}>
          <span className="font-medium text-foreground">{host}</span>
          <span className="text-muted-foreground">{shortPath}</span>
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          {clip.score && (
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${SCORE_COLORS[clip.score] ?? "bg-slate-600 text-white"}`}
            >
              {clip.score}
            </span>
          )}
          {tags.map((t) => (
            <Badge
              key={t}
              variant="secondary"
              className="h-4 max-w-[100px] truncate rounded px-1.5 text-[10px] font-normal"
            >
              {t}
            </Badge>
          ))}
          {moreTags > 0 && <span className="text-[10px]">+{moreTags}</span>}
        </div>
      </div>

      <div className="ml-auto flex w-full min-w-0 flex-col items-stretch gap-1 sm:ml-0 sm:w-auto sm:items-end">
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {np > 0 && (
            <Badge
              variant="outline"
              className="h-5 shrink-0 rounded-full border-red-200 bg-red-50 px-1.5 text-[10px] font-medium text-red-700"
            >
              Used {np}×
            </Badge>
          )}
          {fixedName ? (
            <span className="inline-flex max-w-[220px] items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-800">
              <CheckCircle2 className="h-3 w-3 flex-shrink-0" />
              <span className="truncate">Fixed → {fixedName}</span>
            </span>
          ) : associating ? (
            <span className="inline-flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Linking…
            </span>
          ) : (
            <CreatorPicker
              token={token}
              value={null}
              onChange={onPick}
              emptyButtonLabel="Pick creator…"
            />
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 flex-shrink-0 cursor-pointer"
            title="Open in HubSpot"
            onClick={() => openUrl(`${HUBSPOT_CLIP_RECORD}/${clip.id}`)}
          >
            <HubSpotIcon className="h-3.5 w-3.5" />
          </Button>
        </div>
        {error && (
          <div className="flex max-w-full items-start justify-end gap-1 text-right text-[10px] text-destructive">
            <AlertTriangle className="h-3 w-3 flex-shrink-0" />
            <span className="min-w-0 break-words leading-tight">{error}</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-5 shrink-0 cursor-pointer px-1 text-[10px]"
              onClick={() => setError(null)}
            >
              Dismiss
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}

async function fetchClipsMissingCreatorSections(token: string): Promise<IntegritySection<Clip>[]> {
  const all = await fetchClipsMissingCreator(token);
  const inPublished = all.filter((c) => (c.numPublishedVideoProjects ?? 0) > 0);
  const other = all.filter((c) => (c.numPublishedVideoProjects ?? 0) === 0);
  return [
    {
      id: "in-published",
      title: "In published videos",
      severity: "critical" as Severity,
      defaultOpen: true,
      items: inPublished,
    },
    {
      id: "other",
      title: "Not yet published",
      severity: "warning" as Severity,
      defaultOpen: false,
      items: other,
    },
  ];
}

export const clipsMissingCreatorCheck: IntegrityCheck<Clip> = {
  id: "clips-missing-creator",
  title: "Clips without creator",
  description:
    "Clips with no creator linked. Critical when already in a published video — the credit is publicly missing.",
  fetch: fetchClipsMissingCreatorSections,
  Row: ClipsMissingCreatorRow,
};
