/**
 * Bulk auto-fix runner for the Creator profile URL integrity check.
 *
 * Takes a list of `ClassifiedIssue`s in the `auto-fixable` bucket and
 * applies the canonical URL to HubSpot. The classifier has already
 * triple-checked that:
 *
 *   - `cleanCreatorUrl` returned `status: "fixed"` with the same network
 *     as the field.
 *   - The proposed URL passes the strict regex from `creator-url-rules.ts`.
 *   - No other creator (or another invalid row in this CSV) cleans to the
 *     same canonical, AND no within-record collision exists.
 *
 * This module's job is the network plumbing: read live → guard against
 * drift → PATCH → append to the audit log → return a per-row outcome.
 *
 * Safety details:
 *
 *   1. Concurrency capped at 4 in-flight to keep us well under the
 *      default 100/10s HubSpot rate limit even on bursty runs.
 *   2. Every row is GET-validated against HubSpot RIGHT BEFORE the PATCH.
 *      The CSV is up to 24h old; if a teammate already fixed the value
 *      we soft-skip rather than overwrite their work.
 *   3. The audit-log insert is best-effort — if the
 *      `creator_url_autofix_events` table is missing or returns an error
 *      we log and continue. The HubSpot write has already succeeded by
 *      that point, so losing the audit row is the least-bad failure.
 *   4. First-run cap (10 rows) lives in the calling UI, not this module.
 *      The module honours whatever it's handed; the UI is responsible
 *      for slicing.
 */

import { invoke } from "@tauri-apps/api/core";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { describeSupabaseError } from "@/lib/duplicates/supabase";
import { CREATOR_URL_RULES, type CreatorUrlField } from "./creator-url-rules";
import type { ClassifiedIssue } from "./creator-url-classifier";

/**
 * First-run safety cap. The UI applies this when no successful auto-fix
 * has been recorded locally yet — keeps the blast radius of any latent
 * bug small until the user has hand-verified a batch.
 */
export const AUTOFIX_FIRST_RUN_CAP = 10;

const FIRST_RUN_LS_KEY = "creator-url-autofix:first-run-completed";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

let cachedClient: SupabaseClient | null = null;
function getSupabase(): SupabaseClient | null {
  if (!supabaseUrl || !supabaseAnonKey) return null;
  if (!cachedClient) cachedClient = createClient(supabaseUrl, supabaseAnonKey);
  return cachedClient;
}

/** True when at least one successful auto-fix run has been completed. */
export function hasCompletedAutofixRun(): boolean {
  try {
    return localStorage.getItem(FIRST_RUN_LS_KEY) === "1";
  } catch {
    return false;
  }
}

function markRunCompleted(): void {
  try {
    localStorage.setItem(FIRST_RUN_LS_KEY, "1");
  } catch {
    // Private browsing / disabled storage — keep the cap on, no harm done.
  }
}

/** HubSpot internal property name for a given URL field. The CSV header
 *  is the display label; HubSpot's `/objects/...` API uses internal names. */
function internalPropertyOf(field: CreatorUrlField): string {
  return field;
}

export type BulkAutoFixOutcome =
  | {
      kind: "applied";
      issueId: string;
      creatorId: string;
      creatorName: string;
      field: CreatorUrlField;
      before: string;
      after: string;
    }
  | {
      kind: "skipped";
      issueId: string;
      creatorId: string;
      creatorName: string;
      field: CreatorUrlField;
      reason: string;
    }
  | {
      kind: "error";
      issueId: string;
      creatorId: string;
      creatorName: string;
      field: CreatorUrlField;
      message: string;
    };

export interface BulkAutoFixArgs {
  token: string;
  issues: ClassifiedIssue[];
  /** Called after each row finishes with the cumulative completion count. */
  onProgress?: (done: number, total: number) => void;
  /** Who's running the fix. Used in the audit log. Defaults to the OS user. */
  actor?: string;
  /** Override concurrency cap. Defaults to 4. */
  concurrency?: number;
}

interface CreatorRecord {
  id: string;
  properties: Record<string, string | null>;
}

interface FetchCreatorsBatchResponse {
  results: CreatorRecord[];
}

/**
 * Re-read live HubSpot properties for the supplied creator IDs in one
 * batch. We use `fetch_creators_batch` (already wired in the Rust
 * backend) so we don't have to add a single-record GET command. The
 * batch endpoint returns every property in `full_creator_properties`,
 * which is overkill for our needs but cheaper than five extra Tauri
 * commands.
 */
async function fetchLiveValues(
  token: string,
  creatorIds: string[],
): Promise<Map<string, Record<string, string | null>>> {
  const out = new Map<string, Record<string, string | null>>();
  if (creatorIds.length === 0) return out;
  const response = await invoke<FetchCreatorsBatchResponse>(
    "fetch_creators_batch",
    { token, creatorIds },
  );
  for (const r of response.results ?? []) {
    if (r?.id) out.set(r.id, r.properties ?? {});
  }
  return out;
}

function normalizeForComparison(v: string | null | undefined): string {
  return (v ?? "").trim();
}

async function patchOne(
  token: string,
  creatorId: string,
  field: CreatorUrlField,
  newValue: string,
): Promise<void> {
  await invoke("update_creator_properties", {
    token,
    creatorId,
    properties: { [internalPropertyOf(field)]: newValue },
  });
}

async function recordAuditEvent(args: {
  runId: string;
  outcome: Extract<BulkAutoFixOutcome, { kind: "applied" }>;
  actor: string;
  appVersion: string;
}): Promise<void> {
  const client = getSupabase();
  if (!client) return; // No Supabase configured — write is a no-op.
  const { outcome } = args;
  const { error } = await client.from("creator_url_autofix_events").insert({
    run_id: args.runId,
    creator_id: outcome.creatorId,
    creator_name: outcome.creatorName || null,
    field: outcome.field,
    property: internalPropertyOf(outcome.field),
    before_value: outcome.before || null,
    after_value: outcome.after,
    applied_by: args.actor || null,
    app_version: args.appVersion || null,
  });
  if (error) {
    // The migration may not be deployed on the user's Supabase project
    // yet. The HubSpot write has already succeeded, so we don't want to
    // surface this as a fix failure — just leave a console breadcrumb.
    console.warn(
      "[autofix] audit event insert failed (non-blocking):",
      describeSupabaseError(error),
    );
  }
}

async function resolveActor(passed: string | undefined): Promise<string> {
  if (passed && passed.trim()) return passed.trim();
  try {
    const fromOs = await invoke<string>("current_os_username");
    if (fromOs && fromOs.trim()) return fromOs.trim();
  } catch {
    // Tauri unavailable (tests).
  }
  return "compiflow";
}

/**
 * Apply every supplied issue's canonical URL to HubSpot.
 *
 * Returns one outcome per input issue in the same order so the UI can
 * line up results 1:1 with the rows the user clicked on. Failures
 * don't abort the run — each row is independent.
 */
export async function runBulkAutoFix(args: BulkAutoFixArgs): Promise<BulkAutoFixOutcome[]> {
  const { token, issues } = args;
  if (issues.length === 0) return [];
  const concurrency = Math.max(1, args.concurrency ?? 4);
  const runId =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `run-${Date.now()}`;
  const actor = await resolveActor(args.actor);
  const appVersion =
    typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "";

  // Step 1: batch-fetch live values for every unique creator id in one
  // shot so we don't fire N tiny GETs.
  const uniqueIds = [...new Set(issues.map((i) => i.creatorId))];
  let liveById = new Map<string, Record<string, string | null>>();
  try {
    liveById = await fetchLiveValues(token, uniqueIds);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return issues.map<BulkAutoFixOutcome>((issue) => ({
      kind: "error",
      issueId: issue.id,
      creatorId: issue.creatorId,
      creatorName: issue.creatorName,
      field: issue.field,
      message: `Pre-flight read failed: ${message}`,
    }));
  }

  const outcomes: BulkAutoFixOutcome[] = new Array(issues.length);
  let done = 0;

  // Step 2: pool of workers patching with a small concurrency cap.
  let cursor = 0;
  const total = issues.length;
  args.onProgress?.(0, total);

  async function applyOne(idx: number): Promise<void> {
    const issue = issues[idx];
    const proposed = issue.proposedUrl;
    if (!proposed) {
      outcomes[idx] = {
        kind: "error",
        issueId: issue.id,
        creatorId: issue.creatorId,
        creatorName: issue.creatorName,
        field: issue.field,
        message: "No proposed URL — classifier mismatch (skipping)",
      };
      return;
    }

    // Belt-and-braces: re-run the strict regex on the proposed value.
    const rule = CREATOR_URL_RULES[issue.field];
    if (!rule.regex.test(proposed)) {
      outcomes[idx] = {
        kind: "error",
        issueId: issue.id,
        creatorId: issue.creatorId,
        creatorName: issue.creatorName,
        field: issue.field,
        message: "Proposed URL no longer passes the strict regex (skipping)",
      };
      return;
    }

    const props = liveById.get(issue.creatorId);
    if (!props) {
      outcomes[idx] = {
        kind: "skipped",
        issueId: issue.id,
        creatorId: issue.creatorId,
        creatorName: issue.creatorName,
        field: issue.field,
        reason: "Creator no longer exists in HubSpot",
      };
      return;
    }

    const live = normalizeForComparison(props[internalPropertyOf(issue.field)]);
    const csvValue = normalizeForComparison(issue.rawValue);
    if (live === normalizeForComparison(proposed)) {
      outcomes[idx] = {
        kind: "skipped",
        issueId: issue.id,
        creatorId: issue.creatorId,
        creatorName: issue.creatorName,
        field: issue.field,
        reason: "Already canonical in HubSpot",
      };
      return;
    }
    if (live !== csvValue) {
      outcomes[idx] = {
        kind: "skipped",
        issueId: issue.id,
        creatorId: issue.creatorId,
        creatorName: issue.creatorName,
        field: issue.field,
        reason: "Value changed in HubSpot since the export",
      };
      return;
    }

    try {
      await patchOne(token, issue.creatorId, issue.field, proposed);
      const applied: Extract<BulkAutoFixOutcome, { kind: "applied" }> = {
        kind: "applied",
        issueId: issue.id,
        creatorId: issue.creatorId,
        creatorName: issue.creatorName,
        field: issue.field,
        before: csvValue,
        after: proposed,
      };
      outcomes[idx] = applied;
      // Audit log is best-effort.
      await recordAuditEvent({ runId, outcome: applied, actor, appVersion });
    } catch (err) {
      outcomes[idx] = {
        kind: "error",
        issueId: issue.id,
        creatorId: issue.creatorId,
        creatorName: issue.creatorName,
        field: issue.field,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(concurrency, total); w++) {
    workers.push(
      (async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= total) return;
          await applyOne(idx);
          done++;
          args.onProgress?.(done, total);
        }
      })(),
    );
  }
  await Promise.all(workers);

  // If anything actually wrote, lift the first-run cap.
  if (outcomes.some((o) => o.kind === "applied")) {
    markRunCompleted();
  }

  return outcomes;
}
