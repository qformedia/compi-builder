import { useState } from "react";
import { ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

export const LICENSE_TYPE_OPTIONS = [
  "Recurrent",
  "Ask First",
  "Limited Recurrency",
  "Singular",
  "Money Involved",
] as const;

export type LicenseTypeOption = (typeof LICENSE_TYPE_OPTIONS)[number];

/** Lower-cased + trimmed canonical form. Used for case-insensitive comparisons
 *  against HubSpot's `creator_license_type` which is free-form text. */
export const normaliseLicenseType = (s?: string) => (s ?? "").trim().toLowerCase();

/** Pre-computed canonical Ask First value; the only license type that has a
 *  follow-on `available_ask_first` flag in HubSpot. */
export const ASK_FIRST_LICENSE_NORMAL = normaliseLicenseType("Ask First");

interface LicenseTypePickerProps {
  selected: LicenseTypeOption[];
  onChange: (values: LicenseTypeOption[]) => void;
}

/** Multi-select popover for the License Type filter. Used on the External
 *  Clips search page and the Autofill page. */
export function LicenseTypePicker({ selected, onChange }: LicenseTypePickerProps) {
  const [open, setOpen] = useState(false);
  const toggle = (value: LicenseTypeOption) => {
    onChange(
      selected.includes(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value],
    );
  };
  const label =
    selected.length === 0
      ? "License: any"
      : selected.length === LICENSE_TYPE_OPTIONS.length
        ? "License: all"
        : `License: ${selected.length}/${LICENSE_TYPE_OPTIONS.length}`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-6 gap-0.5 px-2 text-[11px]">
          {label}
          <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <Command>
          <CommandList>
            <CommandGroup>
              {LICENSE_TYPE_OPTIONS.map((opt) => {
                const active = selected.includes(opt);
                return (
                  <CommandItem key={opt} value={opt} onSelect={() => toggle(opt)}>
                    <span className={active ? "font-semibold" : ""}>
                      {active ? "✓ " : "  "}
                      {opt}
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
            {selected.length > 0 && (
              <CommandGroup>
                <CommandItem onSelect={() => onChange([])}>Clear filter</CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
