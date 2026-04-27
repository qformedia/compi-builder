import changelogMarkdown from "../../CHANGELOG.md?raw";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";

declare const __APP_VERSION__: string;

interface ChangelogSection {
  heading: string;
  bullets: string[];
}

interface ChangelogEntry {
  version: string;
  date: string;
  sections: ChangelogSection[];
}

const ENTRY_HEADING = /^##\s+v(\S+)\s+-\s+(.+?)\s*$/;
const SECTION_HEADING = /^###\s+(.+?)\s*$/;
const BULLET = /^-\s+(.+?)\s*$/;
const ENTRIES_MARKER = "<!-- changelog-entries -->";

function parseChangelog(markdown: string): ChangelogEntry[] {
  const markerIndex = markdown.indexOf(ENTRIES_MARKER);
  const body = markerIndex >= 0
    ? markdown.slice(markerIndex + ENTRIES_MARKER.length)
    : markdown;

  const entries: ChangelogEntry[] = [];
  let currentEntry: ChangelogEntry | null = null;
  let currentSection: ChangelogSection | null = null;

  for (const rawLine of body.split("\n")) {
    const line = rawLine.trimEnd();

    const entryMatch = line.match(ENTRY_HEADING);
    if (entryMatch) {
      currentEntry = { version: entryMatch[1], date: entryMatch[2], sections: [] };
      currentSection = null;
      entries.push(currentEntry);
      continue;
    }

    if (!currentEntry) continue;

    const sectionMatch = line.match(SECTION_HEADING);
    if (sectionMatch) {
      currentSection = { heading: sectionMatch[1], bullets: [] };
      currentEntry.sections.push(currentSection);
      continue;
    }

    const bulletMatch = line.match(BULLET);
    if (bulletMatch && currentSection) {
      currentSection.bullets.push(bulletMatch[1]);
    }
  }

  return entries;
}

const ENTRIES = parseChangelog(changelogMarkdown);

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ChangelogDialog({ open, onOpenChange }: Props) {
  const currentVersion = `v${__APP_VERSION__}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>What's new in CompiFlow</DialogTitle>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto pr-1">
          {ENTRIES.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No changelog entries available yet.
            </p>
          ) : (
            <ol className="flex flex-col gap-6">
              {ENTRIES.map((entry) => (
                <ChangelogEntryItem
                  key={entry.version}
                  entry={entry}
                  isCurrent={`v${entry.version}` === currentVersion}
                />
              ))}
            </ol>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ChangelogEntryItem({
  entry,
  isCurrent,
}: {
  entry: ChangelogEntry;
  isCurrent: boolean;
}) {
  return (
    <li className="border-b last:border-b-0 pb-4 last:pb-0">
      <header className="mb-2 flex flex-wrap items-baseline gap-2">
        <h3 className="text-base font-semibold">v{entry.version}</h3>
        <span className="text-xs text-muted-foreground">{entry.date}</span>
        {isCurrent && (
          <Badge variant="secondary" className="text-[10px]">
            Current
          </Badge>
        )}
      </header>

      {entry.sections.length === 0 ? (
        <p className="text-sm text-muted-foreground">No notes for this release.</p>
      ) : (
        entry.sections.map((section) => (
          <section key={section.heading} className="mb-3 last:mb-0">
            <h4 className="mb-1 text-sm font-medium text-foreground">
              {section.heading}
            </h4>
            <ul className="ml-5 list-disc space-y-1 text-sm text-muted-foreground">
              {section.bullets.map((bullet, i) => (
                <li key={i}>{bullet}</li>
              ))}
            </ul>
          </section>
        ))
      )}
    </li>
  );
}
