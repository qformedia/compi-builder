import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, Pencil, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TagPicker } from "@/components/TagPicker";
import { useTagOptions, type TagOption } from "@/lib/tags";
import { IntegrityFixedPill } from "@/lib/data-integrity/components/IntegrityFixedPill";

type PanelState =
  | { kind: "idle" }
  | { kind: "editing"; draft: string[] }
  | { kind: "applying"; values: string[] }
  | { kind: "applied"; values: string[] }
  | { kind: "error"; message: string; previous: PanelState };

interface Props {
  clipId: string;
  token: string;
  /**
   * EC tag values that the VPs suggest, already filtered/expanded through the
   * EC taxonomy. May be empty when no published VP tag mapped to the EC tags.
   */
  suggestedTags: string[];
  onApplied: (values: string[], summary: string) => void;
}

function tagLabelsFromValues(values: string[], options: TagOption[]): string {
  const map = new Map(options.map((o) => [o.value, o.label] as const));
  return values.map((v) => map.get(v) ?? v).join(", ");
}

/**
 * Per-row tag fix panel for the Data Integrity "Clips with unknown tags in
 * published videos" check. Visually and behaviourally mirrors
 * `CreatorSuggestionPanel` so the two integrity flows feel identical.
 */
export function TagSuggestionPanel({
  clipId,
  token,
  suggestedTags,
  onApplied,
}: Props) {
  const tagOptions = useTagOptions(token);
  const [st, setSt] = useState<PanelState>({ kind: "idle" });

  const apply = useCallback(
    async (values: string[]) => {
      if (values.length === 0) {
        setSt({
          kind: "error",
          message: "Select at least one tag.",
          previous: { kind: "editing", draft: values },
        });
        return;
      }
      const previous: PanelState = st;
      setSt({ kind: "applying", values });
      try {
        await invoke("update_clip_properties", {
          token,
          clipId,
          properties: { tags: values.join(";") },
        });
        setSt({ kind: "applied", values });
        onApplied(values, `Tagged → ${tagLabelsFromValues(values, tagOptions)}`);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setSt({ kind: "error", message, previous });
      }
    },
    [clipId, onApplied, st, tagOptions, token],
  );

  if (st.kind === "applied") {
    return (
      <IntegrityFixedPill
        label={`Tagged → ${tagLabelsFromValues(st.values, tagOptions)}`}
        className="self-end"
      />
    );
  }

  if (st.kind === "applying") {
    return (
      <span className="inline-flex items-center gap-1.5 self-end px-1 text-[11px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Applying tags…
      </span>
    );
  }

  if (st.kind === "error") {
    return (
      <div className="flex w-full max-w-sm flex-col items-end gap-1.5">
        <p className="text-right text-[10px] leading-tight text-destructive">{st.message}</p>
        <div className="flex flex-wrap justify-end gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 cursor-pointer text-[11px]"
            onClick={() => setSt(st.previous)}
          >
            Dismiss
          </Button>
        </div>
      </div>
    );
  }

  if (st.kind === "editing") {
    const draft = st.draft;
    const setDraft = (next: string[]) => setSt({ kind: "editing", draft: next });
    return (
      <div className="flex w-full min-w-0 max-w-md flex-col gap-2 rounded-md border border-border/80 bg-card/30 p-2.5 text-left">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Edit tags
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-5 w-5 cursor-pointer"
            onClick={() => setSt({ kind: "idle" })}
            title="Cancel"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>

        <TagPicker
          options={tagOptions}
          selected={draft}
          onChange={setDraft}
          hideBadges
        />

        {draft.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {draft.map((value) => (
              <Badge
                key={value}
                variant="secondary"
                className="h-5 gap-0.5 rounded px-1.5 text-[10px] font-normal"
              >
                {tagLabelsFromValues([value], tagOptions)}
                <button
                  type="button"
                  className="cursor-pointer rounded-full hover:bg-muted"
                  onClick={() => setDraft(draft.filter((v) => v !== value))}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </Badge>
            ))}
          </div>
        )}

        <div className="flex items-center justify-end gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 cursor-pointer px-2 text-[11px]"
            onClick={() => setSt({ kind: "idle" })}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-7 cursor-pointer gap-1 px-2 text-[11px]"
            disabled={draft.length === 0}
            onClick={() => {
              void apply(draft);
            }}
          >
            Save{draft.length > 0 ? ` (${draft.length})` : ""}
          </Button>
        </div>
      </div>
    );
  }

  // st.kind === "idle"
  const hasSuggestion = suggestedTags.length > 0;

  if (!hasSuggestion) {
    return (
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 cursor-pointer gap-1 px-2 text-[11px]"
          onClick={() => setSt({ kind: "editing", draft: [] })}
        >
          <Pencil className="h-3 w-3" />
          Pick tags…
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      <Button
        type="button"
        size="sm"
        className="h-7 cursor-pointer px-2 text-[11px]"
        onClick={() => {
          void apply(suggestedTags);
        }}
      >
        Apply VP tag{suggestedTags.length > 1 ? "s" : ""}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 cursor-pointer gap-1 px-2 text-[11px] text-muted-foreground"
        title="Edit tags before applying"
        onClick={() => setSt({ kind: "editing", draft: suggestedTags })}
      >
        <Pencil className="h-3 w-3" />
        Edit
      </Button>
    </div>
  );
}
