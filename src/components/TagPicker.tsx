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
import { ALL_TAGS } from "@/lib/tags";

interface Props {
  selected: string[];
  onChange: (tags: string[]) => void;
}

export function TagPicker({ selected, onChange }: Props) {
  const [open, setOpen] = useState(false);

  const toggle = (tag: string) => {
    onChange(
      selected.includes(tag)
        ? selected.filter((t) => t !== tag)
        : [...selected, tag],
    );
  };

  return (
    <div className="flex flex-col gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className="justify-between"
          >
            {selected.length === 0
              ? "Select tags..."
              : `${selected.length} tag${selected.length > 1 ? "s" : ""} selected`}
            <ChevronsUpDown className="ml-2 h-4 w-4 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-0" align="start">
          <Command>
            <CommandInput placeholder="Search tags..." />
            <CommandList>
              <CommandEmpty>No tags found.</CommandEmpty>
              <CommandGroup>
                {ALL_TAGS.map((tag) => (
                  <CommandItem
                    key={tag}
                    value={tag}
                    onSelect={() => toggle(tag)}
                  >
                    <span
                      className={
                        selected.includes(tag) ? "font-semibold" : ""
                      }
                    >
                      {selected.includes(tag) ? "✓ " : ""}
                      {tag}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selected.map((tag) => (
            <Badge key={tag} variant="secondary" className="gap-1">
              {tag}
              <button
                onClick={() => toggle(tag)}
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
