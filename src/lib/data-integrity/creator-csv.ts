/**
 * Minimal RFC 4180 CSV parser + helpers for the all-creators HubSpot export.
 *
 * Only used to surface invalid URL values in the Data Integrity page, so we
 * keep this intentionally tiny — no external dependency, no streaming, no
 * type coercion. Headers come straight from the CSV's first row and rows are
 * accessed by header name so we are not coupled to column order.
 */

import {
  CREATOR_URL_FIELDS,
  CREATOR_URL_RULES,
  type CreatorUrlField,
} from "./creator-url-rules";

export interface CreatorRow {
  id: string;
  name: string;
  values: Partial<Record<CreatorUrlField, string>>;
}

/**
 * Same source CSV as `CreatorRow`, but exposes ALL columns by trimmed header
 * name. Used by the Duplicates page so the detector + side-by-side preview
 * have access to every creator column without each consumer needing its own
 * parser.
 */
export interface CreatorRowFull {
  id: string;
  name: string;
  raw: Record<string, string>;
}

export interface CreatorUrlIssue {
  /** Stable id across pages — `creatorId:field`. */
  id: string;
  creatorId: string;
  creatorName: string;
  field: CreatorUrlField;
  /** Raw value from the CSV (already trimmed). */
  value: string;
}

/**
 * Parse a CSV string into rows of fields. Supports quoted values, embedded
 * commas, embedded quotes (`""`), CR/LF line endings. Skips a single trailing
 * empty row (CSVs from HubSpot end in a newline). Strips the UTF-8 BOM that
 * HubSpot's async export sometimes prepends — it would otherwise cause the
 * first column header (`\uFEFFRecord ID`) to silently not match anything.
 */
export function parseCsv(input: string): string[][] {
  if (input.charCodeAt(0) === 0xfeff) {
    input = input.slice(1);
  }
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const c = input[i];

    if (inQuotes) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (c === "\r") {
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += c;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/**
 * Cheap sanity check: does this look like a creators CSV, or did we
 * accidentally download a ZIP / HTML error page / empty body?
 *
 * Used by the orchestrator to fall through to the next cache layer when a
 * source returns garbage, so a single corrupt upload doesn't lock the
 * Data Integrity check in a permanent error state.
 */
export function looksLikeCreatorsCsv(csv: string): boolean {
  if (!csv || csv.length < 32) return false;

  // Strip BOM for the check.
  const body = csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv;

  // ZIP magic — happens when an upstream caller forgot to extract the CSV
  // from the export ZIP.
  if (body.startsWith("PK\x03\x04")) return false;
  // HTML error page from S3 or Cloudflare.
  if (/^\s*<(\!doctype|html|\?xml)/i.test(body)) return false;
  // JSON error envelope (HubSpot occasionally returns one in place of the CSV).
  if (body.trimStart().startsWith("{") || body.trimStart().startsWith("[")) {
    return false;
  }

  // First line should be a CSV header containing the ID column we rely on.
  const firstLineEnd = body.indexOf("\n");
  const firstLine = (firstLineEnd === -1 ? body : body.slice(0, firstLineEnd)).trim();
  if (!firstLine || firstLine.split(",").length < 3) return false;

  const lowered = firstLine.toLowerCase();
  return (
    lowered.includes("record id") ||
    lowered.includes("record_id") ||
    lowered.includes("hs_object_id") ||
    lowered.includes("object id")
  );
}

/**
 * Find the first column header that matches any of the supplied aliases.
 * HubSpot's async Export API sometimes labels the same property differently
 * (display label vs internal name vs casing), so we accept several spellings
 * for each column we care about and return the first hit.
 */
function findColumn(header: string[], aliases: string[]): number {
  for (const alias of aliases) {
    const exact = header.findIndex((h) => h === alias);
    if (exact >= 0) return exact;
  }
  // Case-insensitive fallback handles "Record Id", "RECORD ID", etc.
  const normalized = header.map((h) => h.trim().toLowerCase());
  for (const alias of aliases) {
    const i = normalized.indexOf(alias.trim().toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * Convert the parsed CSV into one row per creator with only the fields the
 * Data Integrity check cares about. Unknown columns are ignored. Header
 * matching is flexible so the same parser works against the reference CSV
 * (display labels: "Record ID", "Instagram", ...) and against direct
 * exports that label columns by internal name ("hs_object_id", ...).
 */
export function parseCreatorsCsv(csv: string): CreatorRow[] {
  const rows = parseCsv(csv);
  if (rows.length === 0) return [];

  // Trim headers so whitespace differences between exports don't break lookup.
  const header = rows[0].map((h) => h.trim());

  const idIdx = findColumn(header, ["Record ID", "Record Id", "hs_object_id", "Object ID"]);
  const nameIdx = findColumn(header, ["Name", "name"]);
  const fieldIdx: Record<CreatorUrlField, number> = {
    instagram: findColumn(header, [CREATOR_URL_RULES.instagram.csvHeader, "instagram"]),
    secondary_instagram: findColumn(header, [
      CREATOR_URL_RULES.secondary_instagram.csvHeader,
      "secondary_instagram",
    ]),
    tiktok: findColumn(header, [CREATOR_URL_RULES.tiktok.csvHeader, "tiktok", "Tiktok"]),
    secondary_tiktok: findColumn(header, [
      CREATOR_URL_RULES.secondary_tiktok.csvHeader,
      "secondary_tiktok",
    ]),
    youtube: findColumn(header, [
      CREATOR_URL_RULES.youtube.csvHeader,
      "YouTube",
      "youtube",
    ]),
  };

  if (idIdx < 0) {
    const preview = header.slice(0, 12).join(", ");
    throw new Error(
      `Creators CSV is missing the record-ID column. First headers seen: ${preview}${header.length > 12 ? "…" : ""}`,
    );
  }

  const out: CreatorRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length === 1 && r[0] === "") continue;
    const id = (r[idIdx] ?? "").trim();
    if (!id) continue;
    const name = nameIdx >= 0 ? (r[nameIdx] ?? "").trim() : "";
    const values: Partial<Record<CreatorUrlField, string>> = {};
    for (const field of CREATOR_URL_FIELDS) {
      const col = fieldIdx[field];
      if (col < 0) continue;
      const raw = (r[col] ?? "").trim();
      if (raw) values[field] = raw;
    }
    out.push({ id, name, values });
  }
  return out;
}

/**
 * Return every non-empty value that fails its field's strict regex. Rows are
 * emitted per (creator × bad field) so the UI can paginate them cleanly.
 */
export function validateCreatorUrls(rows: CreatorRow[]): CreatorUrlIssue[] {
  const out: CreatorUrlIssue[] = [];
  for (const row of rows) {
    for (const field of CREATOR_URL_FIELDS) {
      const value = row.values[field];
      if (!value) continue;
      const rule = CREATOR_URL_RULES[field];
      if (rule.regex.test(value)) continue;
      out.push({
        id: `${row.id}:${field}`,
        creatorId: row.id,
        creatorName: row.name || `Creator ${row.id}`,
        field,
        value,
      });
    }
  }
  return out;
}

/**
 * Convert the parsed CSV into one row per creator with every column kept
 * verbatim under its trimmed header name. Use this when downstream code needs
 * access to columns beyond the 5 URL fields (e.g. the Duplicates page side-by-
 * side preview, which surfaces Owner / Status / Category / etc.).
 *
 * Header lookup is case-sensitive on the trimmed header — match what HubSpot
 * exports, e.g. `"Record ID"`, `"Name"`, `"Instagram"`. Aliases are not
 * resolved here; consumers should fall back to alternate names via
 * `findColumn`-style helpers if needed.
 */
export function parseCreatorsCsvFull(csv: string): CreatorRowFull[] {
  const rows = parseCsv(csv);
  if (rows.length === 0) return [];

  const header = rows[0].map((h) => h.trim());
  const idIdx = findColumn(header, ["Record ID", "Record Id", "hs_object_id", "Object ID"]);
  const nameIdx = findColumn(header, ["Name", "name"]);

  if (idIdx < 0) {
    const preview = header.slice(0, 12).join(", ");
    throw new Error(
      `Creators CSV is missing the record-ID column. First headers seen: ${preview}${header.length > 12 ? "…" : ""}`,
    );
  }

  const out: CreatorRowFull[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length === 1 && r[0] === "") continue;
    const id = (r[idIdx] ?? "").trim();
    if (!id) continue;
    const name = nameIdx >= 0 ? (r[nameIdx] ?? "").trim() : "";
    const raw: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) {
      const key = header[c];
      if (!key) continue;
      raw[key] = (r[c] ?? "").trim();
    }
    out.push({ id, name, raw });
  }
  return out;
}

/** Group issues into one bucket per URL field, preserving rule order. */
export function groupIssuesByField(
  issues: CreatorUrlIssue[],
): Record<CreatorUrlField, CreatorUrlIssue[]> {
  const groups: Record<CreatorUrlField, CreatorUrlIssue[]> = {
    instagram: [],
    secondary_instagram: [],
    tiktok: [],
    secondary_tiktok: [],
    youtube: [],
  };
  for (const issue of issues) {
    groups[issue.field].push(issue);
  }
  return groups;
}
