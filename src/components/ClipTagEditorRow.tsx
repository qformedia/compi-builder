import { Loader2, ExternalLink, Image as ImageIcon, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Badge } from "@/components/ui/badge";
import { TagPicker } from "@/components/TagPicker";
import { PlatformIcon, getPlatform } from "@/components/ClipCard";
import type { TagOption } from "@/lib/tags";

/**
 * Compact row for inline tag editing — visually mirrors the Tag Clips tab row
 * (TagClipsTab) so users get a consistent tagging UX across the app.
 *
 * Pure draft editor: it never persists by itself. The owning screen decides
 * when to commit the staged values (e.g. via a single Save action). The row
 * only shows progress feedback while the parent flips `isSaving`.
 */
export interface ClipTagEditorRowProps {
  /** Identifying info shown on the left side of the row */
  clip: {
    hubspotId: string;
    link: string;
    creatorName: string;
    /** Zero-based position; we render `#{order + 1}` to match the rest of the app */
    order: number;
    fetchedThumbnail?: string;
  };
  tagOptions: TagOption[];
  selected: string[];
  onChange: (values: string[]) => void;
  /** Optional spinner state while the parent commits this row */
  isSaving?: boolean;
  /** Optional HubSpot record URL — when set, shows the small open-in-HubSpot icon */
  hubspotRecordUrl?: string;
}

export function ClipTagEditorRow({
  clip,
  tagOptions,
  selected,
  onChange,
  isSaving = false,
  hubspotRecordUrl,
}: ClipTagEditorRowProps) {
  const platform = getPlatform(clip.link);
  const labelFor = (value: string) =>
    tagOptions.find((o) => o.value === value)?.label ?? value;

  return (
    <div className="rounded-lg border overflow-hidden flex">
      {/* Identity */}
      <div className="flex-1 min-w-0 p-3 flex gap-3">
        <div className="w-11 aspect-[9/16] rounded-md overflow-hidden bg-muted flex items-center justify-center flex-shrink-0">
          {clip.fetchedThumbnail ? (
            <img src={clip.fetchedThumbnail} alt="" className="h-full w-full object-cover" />
          ) : (
            <ImageIcon className="h-3 w-3 text-muted-foreground/40" />
          )}
        </div>

        <div className="flex-1 min-w-0 flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <PlatformIcon platform={platform} className="h-3.5 w-3.5 flex-shrink-0" />
            <button
              onClick={() => void openUrl(clip.link)}
              className="text-xs text-foreground hover:underline cursor-pointer text-left truncate min-w-0"
              title={clip.link}
            >
              {clip.link}
            </button>
            {hubspotRecordUrl && (
              <button
                onClick={() => void openUrl(hubspotRecordUrl)}
                className="text-muted-foreground hover:text-foreground cursor-pointer flex-shrink-0"
                title="Open in HubSpot"
              >
                <ExternalLink className="h-3 w-3" />
              </button>
            )}
          </div>

          <div className="text-[11px] text-muted-foreground truncate">
            #{clip.order + 1} · {clip.creatorName}
          </div>
        </div>
      </div>

      {/* Tag picker (mirrors TagClipsTab right column, minus per-row Save). */}
      <div className="w-72 flex-shrink-0 border-l p-3 flex flex-col justify-center gap-2 bg-muted/5">
        {isSaving ? (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Saving...
          </div>
        ) : (
          <div className="flex items-center gap-1.5 flex-wrap">
            <div className="w-36 flex-shrink-0">
              <TagPicker
                options={tagOptions}
                selected={selected}
                onChange={onChange}
                hideBadges
              />
            </div>
            {selected.map((v) => (
              <Badge key={v} variant="secondary" className="text-[10px] h-5 px-1.5 gap-0.5">
                {labelFor(v)}
                <button
                  onClick={() => onChange(selected.filter((t) => t !== v))}
                  className="hover:bg-muted rounded-full cursor-pointer"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
