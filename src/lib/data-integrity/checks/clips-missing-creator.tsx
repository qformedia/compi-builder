import { useCallback, useState } from "react";
import { useCreatorSuggestion } from "@/components/CreatorSuggestionPanel";
import { setActivePreview } from "@/lib/data-integrity/clip-preview-store";
import { countClipsMissingCreator, fetchClipsMissingCreator } from "@/lib/hubspot";
import type { AppSettings, Clip } from "@/types";
import { ClipIntegrityRow } from "../components/ClipIntegrityRow";
import type { IntegrityCheck, IntegritySectionCount, IntegritySectionPage, Severity } from "../types";

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
  const [linked, setLinked] = useState(false);
  const onLinked = useCallback(
    (name: string) => {
      setLinked(true);
      onFixed(clip.id, name);
    },
    [clip.id, onFixed],
  );

  const { trigger, panel } = useCreatorSuggestion({
    clip,
    token,
    settings,
    onLinked,
    onSuggestStart: () => setActivePreview(clip),
  });

  return (
    <ClipIntegrityRow
      clip={clip}
      settings={settings}
      linked={linked}
      rightActions={trigger}
      expandedPanel={panel}
    />
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
