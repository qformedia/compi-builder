/**
 * Reusable rendering primitives shared between the live Duplicates detail
 * view ({@link DuplicatePairDetail}) and the read-only Merge History detail
 * view ({@link MergeHistoryDetail}).
 *
 * These pieces are intentionally framework-light: small components and pure
 * formatters with no domain coupling beyond "render a HubSpot creator
 * status / property value / associated record". When something starts to
 * pull in new data sources (live HubSpot fetches, Supabase, etc.) it
 * doesn't belong here — keep this file as the boring presentational layer.
 */

import React, { useMemo } from "react";
import { ExternalLink } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cn } from "@/lib/utils";
import { CREATOR_PROPERTY_LABELS, LICENSE_INFO_KEYS } from "@/lib/duplicates/diff";
import { hubspotFileUrl } from "@/lib/hubspot-urls";

// ────────────────────────────────────────────────────────────────────────
// Status pill — colored badge for the HubSpot creator `status` enum.
//
// Color legend matches HubSpot's own dropdown swatches:
//   - muted neutral for cold-start states ("To Contact")
//   - warm amber/orange once outreach begins ("Contacted")
//   - teal/emerald for the win states ("Connected" / "Granted")
//   - rose for negative outcomes ("Declined" / "Uncontactable")
//   - dark slate for the terminal "do not retry" buckets
// Values must match the canonical labels in the HubSpot property
// definition (`docs/hs-properties/hubspot-properties-export-creators-2026-04-01.csv`).
// ────────────────────────────────────────────────────────────────────────

const STATUS_BADGE_CLASS: Record<string, string> = {
  "To Contact": "bg-slate-100 text-slate-700 ring-slate-300",
  "Contacted": "bg-orange-100 text-orange-800 ring-orange-300",
  "Connected": "bg-teal-100 text-teal-800 ring-teal-300",
  "Granted": "bg-emerald-100 text-emerald-800 ring-emerald-300",
  "Declined": "bg-rose-100 text-rose-800 ring-rose-300",
  "Uncontactable": "bg-rose-100 text-rose-800 ring-rose-300",
  "Not Existing Anymore": "bg-slate-700 text-slate-50 ring-slate-700",
  "Discarded to Acquire": "bg-slate-700 text-slate-50 ring-slate-700",
};

const STATUS_DOT_CLASS: Record<string, string> = {
  "To Contact": "bg-slate-400",
  "Contacted": "bg-orange-500",
  "Connected": "bg-teal-500",
  "Granted": "bg-emerald-500",
  "Declined": "bg-rose-500",
  "Uncontactable": "bg-rose-500",
  "Not Existing Anymore": "bg-slate-300",
  "Discarded to Acquire": "bg-slate-300",
};

export function StatusPill({ value }: { value: string }) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground ring-1 ring-inset ring-border">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
        —
      </span>
    );
  }
  const badgeClass =
    STATUS_BADGE_CLASS[trimmed] ?? "bg-muted text-muted-foreground ring-border";
  const dotClass = STATUS_DOT_CLASS[trimmed] ?? "bg-muted-foreground/40";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        badgeClass,
      )}
    >
      <span className={cn("inline-block h-1.5 w-1.5 rounded-full", dotClass)} />
      {trimmed}
    </span>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Property cell — the body of one cell in the Property diff table.
// ────────────────────────────────────────────────────────────────────────

export function PropValueCell({
  value,
  rawValue,
  propKey,
}: {
  value: string;
  /** The unformatted value as returned by HubSpot. Used for URL detection and
   *  the `openUrl` target so that an owner-name override (where `value` is a
   *  human label and `rawValue` is the numeric id) doesn't break the click. */
  rawValue?: string;
  propKey: string;
}) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  const linkTarget = rawValue ?? value;
  const isUrl = /^https?:\/\//i.test(linkTarget);
  if (isUrl) {
    return (
      <button
        type="button"
        onClick={() => void openUrl(linkTarget)}
        className="inline-flex items-start gap-1 break-all text-left text-primary hover:underline"
      >
        <span className="break-all">{value}</span>
        <ExternalLink className="mt-0.5 h-3 w-3 flex-shrink-0" />
      </button>
    );
  }
  const isDateProp = DATE_PROP_KEYS.has(propKey);
  const display = isDateProp ? formatWithDaysAgo(value) : value;
  return <span className="break-words text-foreground">{display}</span>;
}

/** Property keys that should be rendered with the `(N days ago) <date>`
 *  helper. Centralised so the live diff, the snapshot diff, and the
 *  License Information card all stay in agreement on what counts as a
 *  date column. (`date_initial_contact` is intentionally left out: it
 *  was never formatted that way in the original diff and the team
 *  reads that field as a literal calendar date.) */
const DATE_PROP_KEYS = new Set<string>([
  "date_found",
  "date_granted",
  "hs_createdate",
  "hs_lastmodifieddate",
]);

/**
 * Map a HubSpot property value to the string we actually want to show in
 * the diff table. Currently only resolves `hubspot_owner_id` → owner name,
 * but this is the natural extension point if other id-typed properties
 * surface later (e.g. associated record ids). Falls through to the raw
 * value when no override applies or the lookup misses.
 *
 * `ownersById` is a `Map` rather than a plain object so callers can use
 * either an in-memory map (live view) or a `new Map(Object.entries(...))`
 * built from a Supabase JSON column (history view) without having to think
 * about prototype pollution edge cases.
 */
export function formatDisplayValue(
  propKey: string,
  value: string,
  ownersById: Map<string, string>,
): string {
  if (!value) return value;
  if (propKey === "hubspot_owner_id") {
    return ownersById.get(value) ?? value;
  }
  return value;
}

/** Render an ISO-ish date string with a relative `(N days ago)` prefix.
 *  Tolerates non-date input by returning the raw value unchanged. */
export function formatWithDaysAgo(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const days = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
  const ago = days === 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
  return `(${ago}) ${value}`;
}

// ────────────────────────────────────────────────────────────────────────
// License Information card.
//
// Replaces the older single-row "Creator statuses" card. Renders one row
// per LICENSE_INFO_KEY with `status` first, side A / side B, and an
// optional 3rd column for the predicted-merged value. Used by both the
// live Duplicates detail view and the read-only Merge History detail
// view, so all the per-row formatting (status pill, Yes/No toggle, date
// helper, file ids) lives here once.
// ────────────────────────────────────────────────────────────────────────

/**
 * Render one cell of the License Information card. Decides between the
 * status pill, a Yes/No mapper for the License Checked boolean enum, the
 * days-ago date helper for `date_granted`, file-id chips that deep-link
 * into HubSpot for `license_file` / `traceability_file`, or plain
 * `break-words` text for everything else.
 */
function LicenseValueCell({
  propKey,
  value,
  fileNamesById,
}: {
  propKey: string;
  value: string;
  /** Optional file id → metadata map. When supplied (DuplicatePairDetail
   *  fetches it lazily), `license_file` / `traceability_file` chips show
   *  the resolved filename instead of the raw id. */
  fileNamesById?: Map<string, HubspotFileInfo>;
}) {
  const trimmed = (value ?? "").trim();
  if (propKey === "status") {
    return <StatusPill value={trimmed} />;
  }
  if (!trimmed) return <span className="text-muted-foreground">—</span>;
  if (propKey === "license_checked") {
    // HubSpot booleans serialize as the literal strings "true" / "false".
    // Anything else (e.g. an admin-edited free-text override) falls
    // through to the raw value so we don't silently hide it.
    if (trimmed === "true") return <span className="text-foreground">Yes</span>;
    if (trimmed === "false") return <span className="text-muted-foreground">No</span>;
    return <span className="break-words text-foreground">{trimmed}</span>;
  }
  if (propKey === "date_granted") {
    return <span className="break-words text-foreground">{formatWithDaysAgo(trimmed)}</span>;
  }
  if (propKey === "license_file" || propKey === "traceability_file") {
    return <FileIdChips raw={trimmed} fileNamesById={fileNamesById} />;
  }
  return <span className="break-words text-foreground">{trimmed}</span>;
}

/**
 * Resolved metadata for a single HubSpot file. Comes from the
 * `fetch_hubspot_files_batch` Tauri command; keys are file ids.
 *
 * `name` and `extension` are stored separately on the HubSpot side
 * (e.g. `"signed_license_alex"` + `"pdf"`) — the chip joins them with a
 * dot for display so the user sees a familiar `name.ext` filename.
 */
export interface HubspotFileInfo {
  name: string;
  extension: string;
  url: string;
}

/**
 * Render a HubSpot file-picker property value (one or more file ids) as
 * clickable chips that open the file preview in HubSpot.
 *
 * HubSpot's file picker stores multi-file selections as a delimited
 * string; we've seen `;` (the multi-enum convention) and `,` in the wild
 * depending on which integration wrote the property, so we accept both
 * plus runs of whitespace. Any token that survives trimming becomes one
 * chip — empty tokens are dropped so a trailing separator doesn't
 * produce a phantom link.
 *
 * When a parent passes a `fileNamesById` map, each chip swaps the raw
 * numeric id for the resolved `name.extension` display, with the id
 * tucked into the `title` attribute so the underlying value is still
 * inspectable on hover. Falls back to the id whenever the resolver
 * doesn't have an entry (e.g. the fetch is still in flight, the file
 * was archived, or the resolver wasn't wired up at this call site).
 */
function FileIdChips({
  raw,
  fileNamesById,
}: {
  raw: string;
  fileNamesById?: Map<string, HubspotFileInfo>;
}) {
  const ids = raw
    .split(/[;,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {ids.map((id) => {
        const info = fileNamesById?.get(id);
        const label = info?.name
          ? info.extension
            ? `${info.name}.${info.extension}`
            : info.name
          : id;
        const tooltip = info?.name ? `${label} (id ${id})` : `Open file ${id} in HubSpot`;
        return (
          <button
            key={id}
            type="button"
            onClick={() => void openUrl(hubspotFileUrl(id))}
            className="inline-flex max-w-full items-center gap-1 rounded-sm bg-primary/5 px-1.5 py-0.5 text-primary hover:bg-primary/10 hover:underline"
            title={tooltip}
          >
            <span className="break-all">{label}</span>
            <ExternalLink className="h-3 w-3 flex-shrink-0" />
          </button>
        );
      })}
    </div>
  );
}

export function LicenseInfoCard({
  propsA,
  propsB,
  mergedProps,
  nameA,
  nameB,
  mergedColumnLabel,
  loading = false,
  fileNamesById,
}: {
  propsA: Record<string, string>;
  propsB: Record<string, string>;
  /** Predicted merged property bag, or null when no winner has been
   *  picked yet. When null, the third column is hidden entirely (3-col
   *  grid instead of 4-col). */
  mergedProps: Record<string, string> | null;
  nameA: string;
  nameB: string;
  /** Header label for the predicted-merged column. Required iff
   *  `mergedProps` is non-null. Examples: "A Merged" (live view, when
   *  side A is the winner) or "Predicted merged" (history view). */
  mergedColumnLabel: string | null;
  /** Show a skeleton placeholder instead of the table. Used by the live
   *  view while the property fetch is in flight. */
  loading?: boolean;
  /** Optional resolved file metadata. When passed,
   *  `license_file` / `traceability_file` cells render filenames
   *  instead of raw ids. */
  fileNamesById?: Map<string, HubspotFileInfo>;
}) {
  if (loading) {
    return <div className="h-40 animate-pulse rounded-md bg-muted/60" />;
  }
  const showMerged = mergedProps !== null;
  const headerGrid = showMerged
    ? "grid-cols-[minmax(160px,200px)_1fr_1fr_1fr]"
    : "grid-cols-[minmax(160px,200px)_1fr_1fr]";
  return (
    <div className="rounded-md border">
      <div
        className={cn(
          "grid items-center gap-3 border-b bg-muted/40 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground",
          headerGrid,
        )}
      >
        <span>Field</span>
        <span className="truncate" title={nameA}>{nameA}</span>
        <span className="truncate" title={nameB}>{nameB}</span>
        {showMerged && (
          <span className="text-emerald-700">{mergedColumnLabel}</span>
        )}
      </div>
      <ul className="divide-y">
        {LICENSE_INFO_KEYS.map((key) => {
          const valA = (propsA[key] ?? "").trim();
          const valB = (propsB[key] ?? "").trim();
          const valMerged = mergedProps?.[key]?.trim() ?? "";
          // Mismatch only counts when both sides are non-empty AND
          // different. "One side empty" cases are common (e.g. only the
          // Granted side has a license file) and shouldn't be flagged in
          // amber — they're expected, not conflicts to resolve.
          const differs = !!valA && !!valB && valA !== valB;
          return (
            <li
              key={key}
              className={cn(
                "grid items-start gap-3 px-4 py-2 text-xs",
                headerGrid,
                differs && "bg-amber-50/40",
              )}
            >
              <div className="flex items-center gap-2">
                <span className="font-medium">
                  {CREATOR_PROPERTY_LABELS[key] ?? key}
                </span>
                {differs && (
                  <span className="rounded-sm bg-amber-100 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-700">
                    Differs
                  </span>
                )}
              </div>
              <LicenseValueCell propKey={key} value={valA} fileNamesById={fileNamesById} />
              <LicenseValueCell propKey={key} value={valB} fileNamesById={fileNamesById} />
              {showMerged && (
                <LicenseValueCell
                  propKey={key}
                  value={valMerged}
                  fileNamesById={fileNamesById}
                />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Associated records section + row.
//
// Reused by the Associations card in both the live and history views.
// Both views need:
//   - A two-side comparison (records on A vs. records on B).
//   - An optional third column showing the predicted post-merge union
//     (winner-first, deduped by id), driven by `winnerSide`.
// ────────────────────────────────────────────────────────────────────────

export interface AssociatedRecord {
  id: string;
  name: string;
  [key: string]: string;
}

export function AssociatedRecordsSection({
  title,
  recordsA,
  recordsB,
  winnerSide,
  mergedColumnLabel,
  renderChips,
  buildUrl,
}: {
  title: string;
  recordsA: AssociatedRecord[];
  recordsB: AssociatedRecord[];
  winnerSide: "a" | "b" | null;
  mergedColumnLabel: string | null;
  renderChips: (r: AssociatedRecord) => React.ReactNode;
  buildUrl: (r: AssociatedRecord) => string;
}) {
  const bothEmpty = recordsA.length === 0 && recordsB.length === 0;
  // Predicted post-merge list = winner-first union, deduped by id.
  // HubSpot's merge transfers every loser association onto the winner; if
  // a record was already associated to both sides it stays a single
  // association (HubSpot dedupes). Mirroring that here keeps the count in
  // the rollup table honest with the list shown right above it.
  const mergedRecords = useMemo<AssociatedRecord[]>(() => {
    if (!winnerSide) return [];
    const winner = winnerSide === "a" ? recordsA : recordsB;
    const loser = winnerSide === "a" ? recordsB : recordsA;
    const seen = new Set<string>();
    const out: AssociatedRecord[] = [];
    for (const r of [...winner, ...loser]) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
    return out;
  }, [winnerSide, recordsA, recordsB]);

  const gridClass = winnerSide
    ? "grid grid-cols-[minmax(160px,200px)_1fr_1fr_1fr] gap-3"
    : "grid grid-cols-[minmax(160px,200px)_1fr_1fr] gap-3";

  return (
    <div className="rounded-md border">
      <div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </span>
        <span className="text-[11px] text-muted-foreground">
          ({recordsA.length} / {recordsB.length}
          {winnerSide && ` / ${mergedRecords.length}`})
        </span>
        {winnerSide && mergedColumnLabel && (
          <span className="ml-auto text-[10px] font-medium text-emerald-700">
            {mergedColumnLabel}
          </span>
        )}
      </div>
      {bothEmpty ? (
        <div className="px-4 py-3 text-xs text-muted-foreground">No associated records.</div>
      ) : (
        // `min-w-0` on every column wrapper is critical: by default a grid
        // item's min-width is `auto`, so a long URL inside the cell forces
        // the column wider than its `1fr` share and the row spills past
        // the visible card edge. Setting min-w-0 lets the inner `truncate`
        // actually clip with "…".
        <div className={gridClass}>
          {/* Empty spacer column */}
          <div />
          <div className="min-w-0 divide-y border-l">
            {recordsA.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">—</div>
            ) : (
              recordsA.map((r) => (
                <AssociatedRecordRow
                  key={r.id}
                  record={r}
                  renderChips={renderChips}
                  buildUrl={buildUrl}
                />
              ))
            )}
          </div>
          <div className="min-w-0 divide-y border-l">
            {recordsB.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">—</div>
            ) : (
              recordsB.map((r) => (
                <AssociatedRecordRow
                  key={r.id}
                  record={r}
                  renderChips={renderChips}
                  buildUrl={buildUrl}
                />
              ))
            )}
          </div>
          {winnerSide && (
            <div className="min-w-0 divide-y border-l">
              {mergedRecords.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted-foreground">—</div>
              ) : (
                mergedRecords.map((r) => (
                  <AssociatedRecordRow
                    key={r.id}
                    record={r}
                    renderChips={renderChips}
                    buildUrl={buildUrl}
                  />
                ))
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function AssociatedRecordRow({
  record,
  renderChips,
  buildUrl,
}: {
  record: AssociatedRecord;
  renderChips: (r: AssociatedRecord) => React.ReactNode;
  buildUrl: (r: AssociatedRecord) => string;
}) {
  const label = record.name || record.link || "Unnamed";
  return (
    // `min-w-0` here too: the row is a flex item inside a column that's
    // already min-width-constrained by the grid wrapper, but the inner
    // truncate only kicks in when every ancestor up to the truncating
    // span can shrink below its content's intrinsic width.
    <div className="flex min-w-0 items-center gap-1.5 px-3 py-1.5 text-xs">
      <span className="min-w-0 flex-1 truncate font-medium" title={label}>
        {label}
      </span>
      {renderChips(record)}
      <button
        type="button"
        onClick={() => void openUrl(buildUrl(record))}
        className="ml-auto flex-shrink-0 text-muted-foreground hover:text-foreground"
        title="Open in HubSpot"
      >
        <ExternalLink className="h-3 w-3" />
      </button>
    </div>
  );
}
