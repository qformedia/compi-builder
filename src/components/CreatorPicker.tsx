import { useState, useEffect, useRef } from "react";
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
import { ChevronsUpDown, Loader2, X } from "lucide-react";
import { searchCreators } from "@/lib/hubspot";
import type { CreatorOption } from "@/lib/hubspot";

interface Props {
  token: string;
  value: CreatorOption | null;
  onChange: (creator: CreatorOption | null) => void;
}

export function CreatorPicker({ token, value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CreatorOption[]>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!query.trim()) {
      setResults([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const creators = await searchCreators(token, query.trim());
        setResults(creators);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, open, token]);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };

  const handleSelect = (creator: CreatorOption) => {
    onChange(creator);
    setOpen(false);
    setQuery("");
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(null);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant={value ? "secondary" : "outline"}
          className="h-7 gap-1.5 px-2 text-[11px] font-medium"
        >
          {value ? (
            <>
              <span className="max-w-[120px] truncate">{value.name}</span>
              <span
                role="button"
                onClick={handleClear}
                className="ml-0.5 rounded-full p-0.5 hover:bg-muted-foreground/20 cursor-pointer"
                title="Clear creator filter"
              >
                <X className="h-3 w-3" />
              </span>
            </>
          ) : (
            <>
              <span>Creator</span>
              <ChevronsUpDown className="h-3 w-3 opacity-50" />
            </>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search by name or link..."
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {loading && (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            )}
            {!loading && query.trim() && results.length === 0 && (
              <CommandEmpty>No creators found.</CommandEmpty>
            )}
            {!loading && !query.trim() && (
              <CommandEmpty className="py-4 text-center text-xs text-muted-foreground">
                Type a name or link to search
              </CommandEmpty>
            )}
            {results.length > 0 && (
              <CommandGroup>
                {results.map((creator) => (
                  <CommandItem
                    key={creator.id}
                    value={`${creator.name} ${creator.mainLink}`}
                    onSelect={() => handleSelect(creator)}
                    className="flex flex-col items-start gap-0.5 py-2"
                  >
                    <span className="font-medium leading-tight">
                      {creator.name}
                    </span>
                    {creator.mainLink && (
                      <span className="max-w-full truncate text-[11px] text-muted-foreground leading-tight">
                        {creator.mainLink}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
