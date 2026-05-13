import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, Tags } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TagSuggestionPanel } from "@/components/TagSuggestionPanel";
import {
  countClipsMissingTagsInPublished,
  fetchClipsMissingTagsInPublished,
  fetchClipVpTagsBatch,
} from "@/lib/hubspot";
import { fetchTagOptions, suggestEcTagsForForeignTag, useTagOptions } from "@/lib/tags";
import type { AppSettings, Clip } from "@/types";
import { ClipIntegrityRow } from "../components/ClipIntegrityRow";
import { VpTagCell, EcTagCell } from "../components/VpTagContext";
import type {
  IntegrityCheck,
  IntegritySectionCount,
  IntegritySectionPage,
  Severity,
} from "../types";

interface ClipMissingTagsItem extends Clip {
  /** Raw VP tag values (internal value of HubSpot single-select on the VP) for every published VP this clip is in. */
  vpTags: string[];
  /**
   * EC tag values suggested for this clip. May come from an exact VP→EC match
   * or from splitting a compound VP tag like "Cute Art" into ["Cute", "Art"]
   * when both parts exist in the EC taxonomy.
   */
  suggestedTags: string[];
}

/**
 * HubSpot's search API is eventually consistent — it can take tens of seconds
 * before a PATCH that sets `tags` is reflected in the NOT_HAS_PROPERTY filter.
 * We remember locally-fixed clip IDs so the next refresh filters them out
 * immediately instead of resurrecting them from the stale index.
 */
const RECENTLY_FIXED_TTL_MS = 90_000;
const recentlyFixedClipIds = new Map<string, number>();

function rememberFixedClip(id: string) {
  recentlyFixedClipIds.set(id, Date.now());
}

function pruneFixedClips() {
  const now = Date.now();
  for (const [id, at] of recentlyFixedClipIds) {
    if (now - at > RECENTLY_FIXED_TTL_MS) recentlyFixedClipIds.delete(id);
  }
}

async function applyTagsToClip(token: string, clipId: string, tags: string[]): Promise<void> {
  await invoke("update_clip_properties", {
    token,
    clipId,
    properties: { tags: tags.join(";") },
  });
  rememberFixedClip(clipId);
}

function ClipsMissingTagsRow({
  item: clip,
  token,
  settings,
  onFixed,
}: {
  item: ClipMissingTagsItem;
  token: string;
  settings: AppSettings;
  onFixed: (id: string, summary?: string) => void;
}) {
  const [appliedSummary, setAppliedSummary] = useState<string | null>(null);
  const tagOptions = useTagOptions(token);

  return (
    <ClipIntegrityRow
      clip={clip}
      settings={settings}
      linked={appliedSummary !== null}
      contexts={[
        <VpTagCell key="vp" vpTags={clip.vpTags} />,
        <EcTagCell key="ec" suggestedTags={clip.suggestedTags} tagOptions={tagOptions} />,
      ]}
      rightActions={(
        <TagSuggestionPanel
          clipId={clip.id}
          token={token}
          suggestedTags={clip.suggestedTags}
          onApplied={(_values, summary) => {
            rememberFixedClip(clip.id);
            setAppliedSummary(summary);
            onFixed(clip.id, summary);
          }}
        />
      )}
    />
  );
}

function ClipsMissingTagsBulkActions({
  sections,
  token,
  settings: _settings,
  onFixed,
}: {
  sections: IntegritySectionPage<ClipMissingTagsItem>["sections"];
  token: string;
  settings: AppSettings;
  onFixed: (id: string, summary?: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  const autoItems = useMemo(
    () => sections.find((section) => section.id === "auto-fixable")?.items ?? [],
    [sections],
  );

  const applyAll = async () => {
    if (autoItems.length === 0) return;
    setBusy(true);
    setDone(0);
    setErr(null);
    try {
      for (const clip of autoItems) {
        if (clip.suggestedTags.length === 0) continue;
        await applyTagsToClip(token, clip.id, clip.suggestedTags);
        setDone((n) => n + 1);
        onFixed(clip.id, `Tagged: ${clip.suggestedTags.join(", ")}`);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (autoItems.length === 0) return null;

  return (
    <div className="flex min-w-0 flex-col items-end gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7 cursor-pointer px-2 text-[11px]"
        disabled={busy}
        onClick={() => {
          void applyAll();
        }}
      >
        {busy ? (
          <>
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            Applying {done}/{autoItems.length}
          </>
        ) : (
          <>
            <Tags className="mr-1 h-3.5 w-3.5" />
            Apply VP tags to {autoItems.length}
          </>
        )}
      </Button>
      {err && <p className="max-w-[260px] text-right text-[10px] text-destructive">{err}</p>}
    </div>
  );
}

async function fetchClipsMissingTagsInPublishedSections(
  token: string,
  after?: string,
): Promise<IntegritySectionPage<ClipMissingTagsItem>> {
  const page = await fetchClipsMissingTagsInPublished(token, after);

  pruneFixedClips();
  const filteredClips = page.clips.filter(
    (clip) => !recentlyFixedClipIds.has(clip.id) && clip.tags.length === 0,
  );

  const clipIds = filteredClips.map((clip) => clip.id);
  const [vpTagsByClip, tagOptions] = await Promise.all([
    fetchClipVpTagsBatch(token, clipIds),
    fetchTagOptions(token),
  ]);

  const enriched = filteredClips.map<ClipMissingTagsItem>((clip) => {
    const vpTags = vpTagsByClip.get(clip.id) ?? [];
    const suggestedSet = new Set<string>();
    for (const vp of vpTags) {
      for (const matched of suggestEcTagsForForeignTag(vp, tagOptions)) {
        suggestedSet.add(matched);
      }
    }
    const suggestedTags = Array.from(suggestedSet);
    return { ...clip, vpTags, suggestedTags };
  });

  return {
    sections: [
      {
        id: "auto-fixable",
        title: "Auto-fixable",
        severity: "warning" as Severity,
        defaultOpen: true,
        items: enriched.filter((clip) => clip.suggestedTags.length > 0),
      },
      {
        id: "needs-review",
        title: "Needs review",
        severity: "info" as Severity,
        defaultOpen: false,
        items: enriched.filter((clip) => clip.suggestedTags.length === 0),
      },
    ],
    nextAfter: page.nextAfter,
  };
}

async function fetchClipsMissingTagsInPublishedCounts(token: string): Promise<IntegritySectionCount[]> {
  pruneFixedClips();
  const counts = await countClipsMissingTagsInPublished(token);
  const total = Math.max(0, counts.total - recentlyFixedClipIds.size);
  return [
    {
      id: "all",
      title: "",
      severity: "warning" as Severity,
      defaultOpen: true,
      total,
    },
  ];
}

export const clipsMissingTagsInPublishedCheck: IntegrityCheck<ClipMissingTagsItem> = {
  id: "clips-missing-tags-in-published",
  title: "Clips with unknown tags in published videos",
  description:
    "Clips already in published videos with a Granted creator but no tags. Apply matching VP tags or pick tags manually.",
  fetchCount: fetchClipsMissingTagsInPublishedCounts,
  fetch: fetchClipsMissingTagsInPublishedSections,
  Row: ClipsMissingTagsRow,
  BulkActions: ClipsMissingTagsBulkActions,
};
