import { Badge } from "@/components/ui/badge";
import type { TagOption } from "@/lib/tags";

function tagLabel(value: string, options: TagOption[]): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

/**
 * Single-column cell that renders the raw VP tag values for a clip.
 * Designed to be used as one of `ClipIntegrityRow`'s `contexts` entries so it
 * sits next to the EC suggestion cell with a visual divider between them.
 */
export function VpTagCell({ vpTags }: { vpTags: string[] }) {
  if (vpTags.length === 0) {
    return (
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        No VP tag
      </div>
    );
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-1">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        VP {vpTags.length > 1 ? "tags" : "tag"}
      </div>
      <div className="flex min-w-0 flex-wrap gap-1">
        {vpTags.map((tag) => (
          <span
            key={tag}
            className="max-w-full truncate rounded bg-background/70 px-1.5 py-0.5 text-[11px] leading-tight text-foreground"
            title={tag}
          >
            {tag}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Single-column cell that renders the EC tag suggestions derived from the VP
 * tags. Renders an arrow-prefixed header so the visual flow `VP → EC` reads
 * naturally across two adjacent columns.
 */
export function EcTagCell({
  suggestedTags,
  tagOptions,
}: {
  suggestedTags: string[];
  tagOptions: TagOption[];
}) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-1">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        → EC {suggestedTags.length > 1 ? "tags" : "tag"}
      </div>
      {suggestedTags.length > 0 ? (
        <div className="flex min-w-0 flex-wrap gap-1">
          {suggestedTags.map((value) => (
            <Badge
              key={value}
              variant="secondary"
              className="h-5 max-w-full truncate rounded-full px-2 text-[10px] font-normal"
              title={tagLabel(value, tagOptions)}
            >
              {tagLabel(value, tagOptions)}
            </Badge>
          ))}
        </div>
      ) : (
        <div className="text-[10px] italic text-muted-foreground">no match</div>
      )}
    </div>
  );
}
