import { CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  /** Full label, e.g. "Fixed → John Doe" or "Tagged → Cute, Art" */
  label: string;
  /** Optional max width clamp; defaults to a reasonable column width. */
  className?: string;
}

/**
 * Compact green success pill used by Data Integrity row panels after a fix is
 * applied. Shared between `CreatorSuggestionPanel` and `TagSuggestionPanel` so
 * the success state is visually identical across checks.
 */
export function IntegrityFixedPill({ label, className }: Props) {
  return (
    <span
      className={cn(
        "inline-flex max-w-[260px] items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-800",
        className,
      )}
    >
      <CheckCircle2 className="h-3 w-3 flex-shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  );
}
