import { useState, useCallback } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CreatorSuggestionPanel } from "@/components/CreatorSuggestionPanel";
import { SCORE_COLORS, HubSpotIcon, getPlatform, PlatformIcon } from "@/components/ClipCard";
import { countClipsMissingCreator, fetchClipsMissingCreator } from "@/lib/hubspot";
import type { AppSettings, Clip } from "@/types";
import { cn } from "@/lib/utils";
import type { IntegrityCheck, IntegritySection, IntegritySectionCount, Severity } from "../types";

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
  settings,
  onFixed,
}: {
  item: Clip;
  token: string;
  settings: AppSettings;
  onFixed: (id: string, summary?: string) => void;
}) {
  // Tracks success purely for the row's green tint — `CreatorSuggestionPanel`
  // owns its own "Fixed → name" badge once linked.
  const [linked, setLinked] = useState(false);
  const platform = getPlatform(clip.link);
  const { host, shortPath } = clipUrlParts(clip.link);
  const tags = clip.tags?.slice(0, 3) ?? [];
  const moreTags = (clip.tags?.length ?? 0) - tags.length;
  const np = clip.numPublishedVideoProjects ?? 0;
  const showThumb = !!clip.fetchedThumbnail;

  const onLinked = useCallback(
    (name: string) => {
      setLinked(true);
      onFixed(clip.id, name);
    },
    [clip.id, onFixed],
  );

  return (
    <li
      className={cn(
        "group flex flex-wrap items-center gap-3 px-4 py-2 transition-colors hover:bg-muted/30 sm:flex-nowrap",
        linked && "bg-emerald-50/40",
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
        <button
          type="button"
          className="block max-w-full cursor-pointer truncate text-left text-xs hover:underline"
          title={clip.link}
          onClick={() => openUrl(clip.link)}
        >
          <span className="font-medium text-foreground">{host}</span>
          <span className="text-muted-foreground">{shortPath}</span>
        </button>
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
          <CreatorSuggestionPanel
            clip={clip}
            token={token}
            settings={settings}
            onLinked={onLinked}
          />
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

async function fetchClipsMissingCreatorCounts(token: string): Promise<IntegritySectionCount[]> {
  const counts = await countClipsMissingCreator(token);
  return [
    {
      id: "in-published",
      title: "In published videos",
      severity: "critical" as Severity,
      defaultOpen: true,
      total: counts.inPublished,
    },
    {
      id: "other",
      title: "Not yet published",
      severity: "warning" as Severity,
      defaultOpen: false,
      total: counts.other,
    },
  ];
}

export const clipsMissingCreatorCheck: IntegrityCheck<Clip> = {
  id: "clips-missing-creator",
  title: "Clips without creator",
  description:
    "Clips with no creator linked. Critical when already in a published video — the credit is publicly missing.",
  fetchCount: fetchClipsMissingCreatorCounts,
  fetch: fetchClipsMissingCreatorSections,
  Row: ClipsMissingCreatorRow,
};
