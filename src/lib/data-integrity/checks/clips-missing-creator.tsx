import { useCallback, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ClipPreview } from "@/components/ClipPreview";
import { CreatorSuggestionPanel } from "@/components/CreatorSuggestionPanel";
import { SCORE_COLORS, HubSpotIcon, getPlatform, PlatformIcon } from "@/components/ClipCard";
import {
  setActivePreview,
  useActivePreview,
} from "@/lib/data-integrity/clip-preview-store";
import { countClipsMissingCreator, fetchClipsMissingCreator } from "@/lib/hubspot";
import { hubspotClipUrl } from "@/lib/hubspot-urls";
import type { AppSettings, Clip } from "@/types";
import { cn } from "@/lib/utils";
import type { IntegrityCheck, IntegritySectionCount, IntegritySectionPage, Severity } from "../types";

const PREVIEW_WIDTH_PX = 280;

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

function ClipUrlButton({ link, host, shortPath, className }: { link: string; host: string; shortPath: string; className?: string }) {
  return (
    <button
      type="button"
      className={cn("block max-w-full cursor-pointer truncate text-left text-xs hover:underline", className)}
      title={link}
      onClick={() => openUrl(link)}
    >
      <span className="font-medium text-foreground">{host}</span>
      <span className="text-muted-foreground">{shortPath}</span>
    </button>
  );
}

function OpenClipInHubSpotButton({ clipId }: { clipId: string }) {
  return (
    <button
      type="button"
      className="flex h-5 w-5 flex-shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      title="Open clip in HubSpot"
      onClick={() => openUrl(hubspotClipUrl(clipId))}
    >
      <HubSpotIcon className="h-3 w-3" />
    </button>
  );
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
  const activeClip = useActivePreview();
  const isPreviewing = activeClip?.id === clip.id;

  const onLinked = useCallback(
    (name: string) => {
      setLinked(true);
      onFixed(clip.id, name);
    },
    [clip.id, onFixed],
  );

  const closePreview = useCallback(() => setActivePreview(null), []);

  return (
    <li
      className={cn(
        "group flex flex-wrap gap-3 px-4 py-2 transition-colors hover:bg-muted/30 sm:flex-nowrap",
        isPreviewing ? "items-start" : "items-center",
        linked && "bg-emerald-50/40",
        isPreviewing && "bg-muted/30",
      )}
    >
      {isPreviewing ? (
        <div
          className="flex flex-shrink-0 flex-col gap-1.5"
          style={{ width: PREVIEW_WIDTH_PX }}
        >
          <div className="flex items-center gap-1">
            <ClipUrlButton
              link={clip.link}
              host={host}
              shortPath={shortPath}
              className="flex-1"
            />
            <OpenClipInHubSpotButton clipId={clip.id} />
            <button
              type="button"
              className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              title="Close preview"
              onClick={closePreview}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          <div className="relative aspect-[9/16] w-full overflow-hidden rounded-md border bg-black">
            <ClipPreview
              clip={clip}
              preferHubSpotPreview={settings.preferHubSpotPreview}
              onClose={closePreview}
            />
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="relative h-12 w-12 flex-shrink-0 overflow-hidden rounded-md border bg-muted transition-colors hover:border-primary"
          onClick={() => setActivePreview(clip)}
          title="Preview clip"
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
      )}

      <div className="min-w-0 flex-1">
        {!isPreviewing && (
          <div className="flex min-w-0 items-center gap-1.5">
            <ClipUrlButton
              link={clip.link}
              host={host}
              shortPath={shortPath}
              className="min-w-0"
            />
            <OpenClipInHubSpotButton clipId={clip.id} />
          </div>
        )}
        <div
          className={cn(
            "flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground",
            !isPreviewing && "mt-1",
          )}
        >
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
            onSuggestStart={() => setActivePreview(clip)}
          />
        </div>
      </div>
    </li>
  );
}

async function fetchClipsMissingCreatorSections(
  token: string,
  after?: string,
): Promise<IntegritySectionPage<Clip>> {
  const page = await fetchClipsMissingCreator(token, after);
  const inPublished = page.clips.filter((c) => (c.numPublishedVideoProjects ?? 0) > 0);
  const other = page.clips.filter((c) => (c.numPublishedVideoProjects ?? 0) === 0);
  return {
    sections: [
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
    ],
    nextAfter: page.nextAfter,
  };
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
