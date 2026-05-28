import { useEffect, useMemo, useState } from "react";
import { GripVertical, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TagPicker } from "@/components/TagPicker";
import { CreatorPicker } from "@/components/CreatorPicker";
import {
  LICENSE_TYPE_OPTIONS,
  LicenseTypePicker,
  type LicenseTypeOption,
} from "@/components/LicenseTypePicker";
import { SUPPORTED_PLATFORMS, type SupportedPlatform } from "@/lib/getPlatform";
import { fetchTagOptions, type TagOption } from "@/lib/tags";
import {
  FIELD_LABELS,
  OPERATOR_LABELS,
  OPERATORS_BY_FIELD,
  createFilter,
} from "@/lib/autofill";
import type {
  BucketFilter,
  BucketFilterField,
  BucketFilterOperator,
} from "@/types";
import type { CreatorOption } from "@/lib/hubspot";

const SCORE_OPTIONS = ["XL", "L", "M", "S", "XS"] as const;

/** Field groups for the field selector — keeps related fields together. */
const FIELD_GROUPS: { label: string; fields: BucketFilterField[] }[] = [
  {
    label: "Content",
    fields: ["tag", "score", "caption", "duration"],
  },
  {
    label: "Source",
    fields: ["creator", "provider", "dateFound"],
  },
  {
    label: "Performance",
    fields: ["likes", "plays", "comments"],
  },
  {
    label: "Status",
    fields: ["licenseType", "availableAskFirst", "usedCount"],
  },
];

interface Props {
  filter: BucketFilter;
  onChange: (next: BucketFilter) => void;
  onRemove: () => void;
  /** Optional drag handle props from @dnd-kit; renders the grip icon as a
   *  drag listener target when provided. */
  dragHandle?: React.HTMLAttributes<HTMLButtonElement>;
  /** HubSpot token for pickers that fetch live data (tags, creators). */
  token: string;
  /** Pre-loaded tag options shared with the parent (avoids re-fetching per row). */
  tagOptions: TagOption[];
}

/** One filter condition row inside a bucket. Delegates value editing to the
 *  same pickers used on the search page (TagPicker, CreatorPicker,
 *  LicenseTypePicker) so we don't reimplement filter UI. */
export function AutofillFilterRow({
  filter,
  onChange,
  onRemove,
  dragHandle,
  token,
  tagOptions,
}: Props) {
  const operators = OPERATORS_BY_FIELD[filter.field];

  const updateField = (field: BucketFilterField) => {
    // Field swap: reset to a sensible default value for the new field.
    onChange(createFilter(field));
  };

  const updateOperator = (operator: BucketFilterOperator) => {
    // Operator swap: reset value to avoid stale shapes (string ↔ array ↔ tuple).
    onChange({ ...createFilter(filter.field), operator, id: filter.id });
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-muted/30 px-1.5 py-1">
      <button
        type="button"
        {...dragHandle}
        className="flex h-7 w-5 cursor-grab items-center justify-center text-muted-foreground hover:text-foreground active:cursor-grabbing"
        title="Drag to reorder filter"
        aria-label="Drag to reorder filter"
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>

      <FieldSelect value={filter.field} onChange={updateField} />

      {operators.length > 1 ? (
        <OperatorSelect value={filter.operator} options={operators} onChange={updateOperator} />
      ) : (
        <span className="text-[11px] text-muted-foreground px-1">
          {OPERATOR_LABELS[filter.operator]}
        </span>
      )}

      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <FilterValueEditor
          filter={filter}
          onChange={(value) => onChange({ ...filter, value })}
          token={token}
          tagOptions={tagOptions}
        />
      </div>

      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={onRemove}
        className="cursor-pointer text-muted-foreground hover:text-destructive"
        title="Remove filter"
        aria-label="Remove filter"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

// ── Field / operator selects ───────────────────────────────────────────────

function FieldSelect({
  value,
  onChange,
}: {
  value: BucketFilterField;
  onChange: (next: BucketFilterField) => void;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as BucketFilterField)}>
      <SelectTrigger className="h-7 w-[10.5rem] gap-1 px-2 text-[11px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {FIELD_GROUPS.map((group) => (
          <div key={group.label}>
            <div className="px-2 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              {group.label}
            </div>
            {group.fields.map((field) => (
              <SelectItem key={field} value={field} className="text-xs">
                {FIELD_LABELS[field]}
              </SelectItem>
            ))}
          </div>
        ))}
      </SelectContent>
    </Select>
  );
}

function OperatorSelect({
  value,
  options,
  onChange,
}: {
  value: BucketFilterOperator;
  options: BucketFilterOperator[];
  onChange: (next: BucketFilterOperator) => void;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as BucketFilterOperator)}>
      <SelectTrigger className="h-7 w-[6rem] gap-1 px-2 text-[11px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((op) => (
          <SelectItem key={op} value={op} className="text-xs">
            {OPERATOR_LABELS[op]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ── Value editor (one component per field/operator combo) ──────────────────

interface ValueEditorProps {
  filter: BucketFilter;
  onChange: (value: unknown) => void;
}

interface FilterValueEditorProps extends ValueEditorProps {
  token: string;
  tagOptions: TagOption[];
}

function FilterValueEditor({ filter, onChange, token, tagOptions }: FilterValueEditorProps) {
  switch (filter.field) {
    case "tag":
      return <TagValueEditor filter={filter} onChange={onChange} tagOptions={tagOptions} />;
    case "score":
      return <ScoreValueEditor filter={filter} onChange={onChange} />;
    case "creator":
      return <CreatorValueEditor filter={filter} onChange={onChange} token={token} />;
    case "dateFound":
      return <DateValueEditor filter={filter} onChange={onChange} />;
    case "licenseType":
      return <LicenseValueEditor filter={filter} onChange={onChange} />;
    case "provider":
      return <ProviderValueEditor filter={filter} onChange={onChange} />;
    case "availableAskFirst":
      return <AvailableAskFirstEditor filter={filter} onChange={onChange} />;
    case "duration":
    case "likes":
    case "plays":
    case "comments":
    case "usedCount":
      return <NumericValueEditor filter={filter} onChange={onChange} />;
    case "caption":
      return <TextValueEditor filter={filter} onChange={onChange} placeholder="Substring…" />;
    default:
      return null;
  }
}

function TagValueEditor({
  filter,
  onChange,
  tagOptions,
}: ValueEditorProps & { tagOptions: TagOption[] }) {
  const selected = Array.isArray(filter.value) ? (filter.value as string[]) : [];
  return (
    <div className="min-w-[10rem] flex-1">
      <TagPicker
        variant="inline"
        options={tagOptions}
        selected={selected}
        onChange={onChange}
        hideBadges
      />
    </div>
  );
}

function ScoreValueEditor({ filter, onChange }: ValueEditorProps) {
  if (filter.operator === "in") {
    const selected = Array.isArray(filter.value) ? (filter.value as string[]) : [];
    return (
      <div className="flex items-center gap-1">
        {SCORE_OPTIONS.map((score) => {
          const active = selected.includes(score);
          return (
            <button
              key={score}
              type="button"
              onClick={() =>
                onChange(active ? selected.filter((s) => s !== score) : [...selected, score])
              }
              className={`rounded px-1.5 py-0.5 text-[11px] font-bold uppercase leading-none cursor-pointer transition-all ${
                active
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/70"
              }`}
            >
              {score}
            </button>
          );
        })}
      </div>
    );
  }
  const value = typeof filter.value === "string" ? filter.value : "XL";
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-7 w-20 px-2 text-[11px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {SCORE_OPTIONS.map((score) => (
          <SelectItem key={score} value={score} className="text-xs">
            {score}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function CreatorValueEditor({
  filter,
  onChange,
  token,
}: ValueEditorProps & { token: string }) {
  // The CreatorPicker is keyed by the full CreatorOption; we only store the
  // main_link in the filter. Cache the last picked option locally so the
  // picker can show a friendly label.
  const initial: CreatorOption | null = useMemo(() => {
    if (typeof filter.value !== "string" || !filter.value) return null;
    return { id: "", name: filter.value, mainLink: filter.value };
  }, [filter.value]);
  const [selected, setSelected] = useState<CreatorOption | null>(initial);

  useEffect(() => {
    setSelected(initial);
  }, [initial]);

  return (
    <CreatorPicker
      token={token}
      value={selected}
      onChange={(creator) => {
        setSelected(creator);
        onChange(creator?.mainLink ?? "");
      }}
      emptyButtonLabel="Pick creator"
    />
  );
}

function DateValueEditor({ filter, onChange }: ValueEditorProps) {
  if (filter.operator === "between") {
    const v = Array.isArray(filter.value) ? (filter.value as [string?, string?]) : [];
    const from = v[0] ?? "";
    const to = v[1] ?? "";
    return (
      <div className="flex items-center gap-1">
        <Input
          type="date"
          value={from}
          onChange={(e) => onChange([e.target.value || null, to || null])}
          className="h-7 w-32 px-2 text-[11px]"
        />
        <span className="text-[10px] text-muted-foreground">–</span>
        <Input
          type="date"
          value={to}
          onChange={(e) => onChange([from || null, e.target.value || null])}
          className="h-7 w-32 px-2 text-[11px]"
        />
      </div>
    );
  }
  return (
    <Input
      type="date"
      value={typeof filter.value === "string" ? filter.value : ""}
      onChange={(e) => onChange(e.target.value)}
      className="h-7 w-32 px-2 text-[11px]"
    />
  );
}

function LicenseValueEditor({ filter, onChange }: ValueEditorProps) {
  const selected = Array.isArray(filter.value) ? (filter.value as LicenseTypeOption[]) : [];
  const valid = selected.filter((s): s is LicenseTypeOption =>
    (LICENSE_TYPE_OPTIONS as readonly string[]).includes(s),
  );
  return <LicenseTypePicker selected={valid} onChange={onChange as (v: LicenseTypeOption[]) => void} />;
}

function ProviderValueEditor({ filter, onChange }: ValueEditorProps) {
  const selected = Array.isArray(filter.value) ? (filter.value as SupportedPlatform[]) : [];
  return (
    <div className="flex flex-wrap items-center gap-1">
      {SUPPORTED_PLATFORMS.map((platform) => {
        const active = selected.includes(platform);
        return (
          <button
            key={platform}
            type="button"
            onClick={() =>
              onChange(active ? selected.filter((p) => p !== platform) : [...selected, platform])
            }
            className={`rounded px-1.5 py-0.5 text-[11px] font-medium cursor-pointer transition-all ${
              active
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/70"
            }`}
          >
            {platform}
          </button>
        );
      })}
    </div>
  );
}

function AvailableAskFirstEditor({ filter, onChange }: ValueEditorProps) {
  const value = filter.value === true || filter.value === "true";
  return (
    <Select value={value ? "true" : "false"} onValueChange={(v) => onChange(v === "true")}>
      <SelectTrigger className="h-7 w-24 px-2 text-[11px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="true" className="text-xs">
          Yes
        </SelectItem>
        <SelectItem value="false" className="text-xs">
          No
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

function NumericValueEditor({ filter, onChange }: ValueEditorProps) {
  if (filter.operator === "between") {
    const v = Array.isArray(filter.value) ? (filter.value as [number?, number?]) : [];
    const min = v[0] ?? "";
    const max = v[1] ?? "";
    return (
      <div className="flex items-center gap-1">
        <Input
          type="number"
          value={min}
          onChange={(e) =>
            onChange([toNumberOrUndefined(e.target.value), toNumberOrUndefined(String(max))])
          }
          placeholder="min"
          className="h-7 w-20 px-2 text-[11px]"
        />
        <span className="text-[10px] text-muted-foreground">–</span>
        <Input
          type="number"
          value={max}
          onChange={(e) =>
            onChange([toNumberOrUndefined(String(min)), toNumberOrUndefined(e.target.value)])
          }
          placeholder="max"
          className="h-7 w-20 px-2 text-[11px]"
        />
      </div>
    );
  }
  return (
    <Input
      type="number"
      value={typeof filter.value === "number" || typeof filter.value === "string" ? String(filter.value) : ""}
      onChange={(e) => onChange(toNumberOrUndefined(e.target.value) ?? "")}
      className="h-7 w-24 px-2 text-[11px]"
    />
  );
}

function TextValueEditor({
  filter,
  onChange,
  placeholder,
}: ValueEditorProps & { placeholder?: string }) {
  return (
    <Input
      type="text"
      value={typeof filter.value === "string" ? filter.value : ""}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="h-7 px-2 text-[11px]"
    />
  );
}

function toNumberOrUndefined(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

/** Hook the parent uses to lazily fetch tag options once and reuse them
 *  across all filter rows. Kept here so callers don't have to hand-roll the
 *  fetch + cache pattern. */
export function useTagOptionsCache(token: string): TagOption[] {
  const [tagOptions, setTagOptions] = useState<TagOption[]>([]);
  useEffect(() => {
    if (!token) return;
    fetchTagOptions(token).then(setTagOptions).catch(() => {});
  }, [token]);
  return tagOptions;
}
