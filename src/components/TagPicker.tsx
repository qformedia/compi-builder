import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { X, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TagOption } from "@/lib/tags";

interface Props {
  options: TagOption[];
  /** Selected internal values */
  selected: string[];
  onChange: (values: string[]) => void;
  /** Hide the selected badges below the trigger */
  hideBadges?: boolean;
  /** Inline chips inside the trigger instead of a separate chip row */
  variant?: "default" | "inline";
}

export function TagPicker({
  options,
  selected,
  onChange,
  hideBadges,
  variant = "default",
}: Props) {
  const [open, setOpen] = useState(false);
  const isInline = variant === "inline";

  const toggle = (value: string) => {
    onChange(
      selected.includes(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value],
    );
  };

  const labelFor = (value: string) =>
    options.find((o) => o.value === value)?.label ?? value;

  const showBelowBadges = !hideBadges && !isInline && selected.length > 0;

  return (
    <div className="flex flex-col gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              "justify-between",
              isInline && "w-full",
              isInline && selected.length > 0 && "h-auto min-h-9 py-1.5",
            )}
          >
            {isInline && selected.length > 0 ? (
              <span className="flex flex-1 flex-wrap items-center gap-1 min-w-0 mr-2">
                {selected.map((value) => (
                  <Badge
                    key={value}
                    variant="secondary"
                    className="gap-1 font-normal"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {labelFor(value)}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(value);
                      }}
                      className="ml-0.5 rounded-full hover:bg-muted"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </span>
            ) : (
              <span
                className={cn(
                  isInline && selected.length === 0 && "text-muted-foreground font-normal",
                )}
              >
                {selected.length === 0
                  ? "Select tags..."
                  : `${selected.length} tag${selected.length > 1 ? "s" : ""} selected`}
              </span>
            )}
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-0" align="start">
          <Command>
            <CommandInput placeholder="Search tags..." />
            <CommandList>
              <CommandEmpty>No tags found.</CommandEmpty>
              <CommandGroup>
                {options.map((opt) => (
                  <CommandItem
                    key={opt.value}
                    value={opt.label}
                    onSelect={() => toggle(opt.value)}
                  >
                    <span
                      className={
                        selected.includes(opt.value) ? "font-semibold" : ""
                      }
                    >
                      {selected.includes(opt.value) ? "✓ " : ""}
                      {opt.label}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {showBelowBadges && (
        <div className="flex flex-wrap gap-1">
          {selected.map((value) => (
            <Badge key={value} variant="secondary" className="gap-1">
              {labelFor(value)}
              <button
                type="button"
                onClick={() => toggle(value)}
                className="ml-0.5 rounded-full hover:bg-muted"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
