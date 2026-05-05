import { ClipIntegrityRow } from "@/lib/data-integrity/components/ClipIntegrityRow";
import { countClipsToDelete, fetchClipsToDelete } from "@/lib/hubspot";
import type { AppSettings, Clip } from "@/types";
import type { IntegrityCheck, IntegritySectionCount, IntegritySectionPage, Severity } from "../types";

function ClipsToDeleteRow({
  item: clip,
  settings,
}: {
  item: Clip;
  token: string;
  settings: AppSettings;
  onFixed: (id: string, summary?: string) => void;
}) {
  return <ClipIntegrityRow clip={clip} settings={settings} />;
}

async function fetchClipsToDeleteSections(
  token: string,
  after?: string,
): Promise<IntegritySectionPage<Clip>> {
  const page = await fetchClipsToDelete(token, after);
  return {
    sections: [
      {
        id: "to-delete",
        title: "",
        severity: "warning" as Severity,
        defaultOpen: true,
        items: page.clips,
      },
    ],
    nextAfter: page.nextAfter,
  };
}

async function fetchClipsToDeleteCounts(token: string): Promise<IntegritySectionCount[]> {
  const counts = await countClipsToDelete(token);
  return [
    {
      id: "to-delete",
      title: "",
      severity: "warning" as Severity,
      defaultOpen: true,
      total: counts.total,
    },
  ];
}

export const clipsToDeleteCheck: IntegrityCheck<Clip> = {
  id: "clips-to-delete",
  title: "Clips marked to delete",
  description:
    "External Clips flagged in HubSpot with To Delete = true. Review and remove them when ready.",
  fetchCount: fetchClipsToDeleteCounts,
  fetch: fetchClipsToDeleteSections,
  Row: ClipsToDeleteRow,
};
