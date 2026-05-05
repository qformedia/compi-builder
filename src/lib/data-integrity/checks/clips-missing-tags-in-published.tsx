import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle2, Loader2, Tags } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  countClipsMissingTagsInPublished,
  fetchClipsMissingTagsInPublished,
  fetchClipVpTagsBatch,
} from "@/lib/hubspot";
import { fetchTagOptions, resolveTagLabel } from "@/lib/tags";
import type { AppSettings, Clip } from "@/types";
import { ClipIntegrityRow } from "../components/ClipIntegrityRow";
import type { IntegrityCheck, IntegritySectionCount, IntegritySectionPage, Severity } from "../types";

interface ClipMissingTagsItem extends Clip {
  vpTags: string[];
  suggestedVpTags: string[];
}

async function applyTagsToClip(token: string, clipId: string, tags: string[]): Promise<void> {
  await invoke("update_clip_properties", {
    token,
    clipId,
    properties: {
      tags: tags.join(";"),
    },
  });
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
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onApply = async () => {
    if (clip.suggestedVpTags.length === 0) return;
    setBusy(true);
    setErr(null);
    try {
      await applyTagsToClip(token, clip.id, clip.suggestedVpTags);
      setApplied(true);
      onFixed(clip.id, `Tagged: ${clip.suggestedVpTags.map((t) => resolveTagLabel(t)).join(", ")}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const suggestionBadges = (
    <div className="flex flex-wrap items-center justify-end gap-1">
      {clip.suggestedVpTags.map((tag) => (
        <Badge key={tag} variant="secondary" className="h-5 rounded px-1.5 text-[10px]">
          {resolveTagLabel(tag)}
        </Badge>
      ))}
    </div>
  );

  return (
    <ClipIntegrityRow
      clip={clip}
      settings={settings}
      linked={applied}
      rightActions={(
        <div className="flex min-w-0 max-w-[420px] flex-col items-end gap-1">
          {clip.suggestedVpTags.length > 0 ? (
            <>
              {suggestionBadges}
              <div className="flex flex-wrap items-center justify-end gap-1">
                {applied ? (
                  <span className="inline-flex items-center gap-1 rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800">
                    <CheckCircle2 className="h-3 w-3" />
                    Tagged
                  </span>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    className="h-6 cursor-pointer px-2 text-[10px]"
                    disabled={busy}
                    onClick={() => {
                      void onApply();
                    }}
                  >
                    {busy ? (
                      <>
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                        Applying...
                      </>
                    ) : (
                      "Apply VP tag(s)"
                    )}
                  </Button>
                )}
              </div>
            </>
          ) : (
            <div className="text-right text-[10px] text-muted-foreground">
              {clip.vpTags.length > 0 ? (
                <span>VP tags don't match EC taxonomy: {clip.vpTags.join(", ")}</span>
              ) : (
                <span>No published VP tag found</span>
              )}
            </div>
          )}
          {err && <p className="text-right text-[10px] text-destructive">{err}</p>}
        </div>
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
        if (clip.suggestedVpTags.length === 0) continue;
        await applyTagsToClip(token, clip.id, clip.suggestedVpTags);
        setDone((n) => n + 1);
        onFixed(clip.id, `Tagged: ${clip.suggestedVpTags.join(", ")}`);
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
  const clipIds = page.clips.map((clip) => clip.id);
  const [vpTagsByClip, tagOptions] = await Promise.all([
    fetchClipVpTagsBatch(token, clipIds),
    fetchTagOptions(token),
  ]);
  const validTagValues = new Set(tagOptions.map((option) => option.value));

  const enriched = page.clips.map<ClipMissingTagsItem>((clip) => {
    const vpTags = vpTagsByClip.get(clip.id) ?? [];
    const suggestedVpTags = vpTags.filter((tag) => validTagValues.has(tag));
    return {
      ...clip,
      vpTags,
      suggestedVpTags,
    };
  });

  return {
    sections: [
      {
        id: "auto-fixable",
        title: "Auto-fixable (VP tag matches EC taxonomy)",
        severity: "warning" as Severity,
        defaultOpen: true,
        items: enriched.filter((clip) => clip.suggestedVpTags.length > 0),
      },
      {
        id: "needs-review",
        title: "Needs review (no matching VP tag)",
        severity: "info" as Severity,
        defaultOpen: false,
        items: enriched.filter((clip) => clip.suggestedVpTags.length === 0),
      },
    ],
    nextAfter: page.nextAfter,
  };
}

async function fetchClipsMissingTagsInPublishedCounts(token: string): Promise<IntegritySectionCount[]> {
  const counts = await countClipsMissingTagsInPublished(token);
  return [
    {
      id: "all",
      title: "",
      severity: "warning" as Severity,
      defaultOpen: true,
      total: counts.total,
    },
  ];
}

export const clipsMissingTagsInPublishedCheck: IntegrityCheck<ClipMissingTagsItem> = {
  id: "clips-missing-tags-in-published",
  title: "Clips with unknown tags in published videos",
  description:
    "External Clips with unknown tags that are already in published videos and have Granted creators. Apply matching VP tags where possible.",
  fetchCount: fetchClipsMissingTagsInPublishedCounts,
  fetch: fetchClipsMissingTagsInPublishedSections,
  Row: ClipsMissingTagsRow,
  BulkActions: ClipsMissingTagsBulkActions,
};
