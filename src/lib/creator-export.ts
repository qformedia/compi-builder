/**
 * Orchestrator for the all-creators HubSpot CSV that backs the
 * "Creator profile URLs" Data Integrity check.
 *
 * On every request we walk three caches in order:
 *   1. local disk (`<app_data>/hs-exports/all-creators.csv` + `.meta.json`)
 *   2. Supabase Storage (`hs-exports/all-creators/...`, latest row from
 *      `public.hs_exports`)
 *   3. HubSpot async Export API → upload to Supabase → write local
 *
 * Anything older than 24h is treated as stale. A `force` request always
 * runs the HubSpot path, regardless of cache age.
 *
 * The orchestrator de-duplicates concurrent callers via a single in-flight
 * promise and broadcasts progress strings to subscribers so the UI can show
 * a meaningful message while we wait on HubSpot's job queue.
 */

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  downloadCreatorsExport,
  getLatestCreatorsExport,
  isSupabaseConfigured,
  recordCreatorsExport,
  uploadCreatorsExport,
} from "@/lib/supabase";
import { looksLikeCreatorsCsv } from "@/lib/data-integrity/creator-csv";

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const HUBSPOT_POLL_INTERVAL_MS = 5_000;
const HUBSPOT_POLL_TIMEOUT_MS = 10 * 60 * 1000;

export type CreatorExportSource = "local" | "supabase" | "hubspot";

export interface CreatorExportResult {
  csv: string;
  generatedAt: Date;
  source: CreatorExportSource;
  storagePath?: string;
}

export interface CreatorExportProgress {
  phase:
    | "idle"
    | "checking-local"
    | "checking-supabase"
    | "downloading-supabase"
    | "exporting-hubspot"
    | "polling-hubspot"
    | "downloading-hubspot"
    | "uploading-supabase"
    | "saving-local"
    | "done"
    | "error";
  message?: string;
  /** HubSpot reported job status, when relevant (PROCESSING / PENDING / ...). */
  hubspotStatus?: string;
  /** When the current/last export was generated. */
  generatedAt?: Date;
}

type Subscriber = (progress: CreatorExportProgress) => void;

interface CachedExportFromTauri {
  csv?: string;
  generatedAt?: string;
  storagePath?: string;
}

interface HubspotExportStatusResponse {
  status: string;
  downloadUrl?: string;
  message?: string;
}

let lastProgress: CreatorExportProgress = { phase: "idle" };
const subscribers = new Set<Subscriber>();
let inflight: Promise<CreatorExportResult> | null = null;
let inflightForce = false;

function notify(progress: CreatorExportProgress): void {
  lastProgress = progress;
  for (const sub of subscribers) {
    try {
      sub(progress);
    } catch (err) {
      console.error("[creator-export] subscriber threw:", err);
    }
  }
}

export function subscribeCreatorExportProgress(sub: Subscriber): () => void {
  subscribers.add(sub);
  sub(lastProgress);
  return () => {
    subscribers.delete(sub);
  };
}

export function getLastCreatorExportProgress(): CreatorExportProgress {
  return lastProgress;
}

/** React hook wrapping `subscribeCreatorExportProgress`. */
export function useCreatorExportProgress(): CreatorExportProgress {
  const [progress, setProgress] = useState<CreatorExportProgress>(lastProgress);
  useEffect(() => subscribeCreatorExportProgress(setProgress), []);
  return progress;
}

export function isCreatorExportStale(generatedAt: Date): boolean {
  return Date.now() - generatedAt.getTime() > STALE_AFTER_MS;
}

export function creatorExportAgeMs(generatedAt: Date): number {
  return Date.now() - generatedAt.getTime();
}

/**
 * Delete the local cache so the next `ensureCreatorsExport` call has to
 * fetch from Supabase/HubSpot again. Used when downstream parsing detects
 * the cached CSV is malformed and we don't want subsequent app starts to
 * keep hitting the same bad file.
 */
export async function clearLocalCreatorsExport(): Promise<void> {
  try {
    await invoke("clear_local_creators_export");
  } catch (err) {
    console.warn("[creator-export] failed to clear local cache:", err);
  }
}

export interface EnsureExportOptions {
  token: string;
  force?: boolean;
}

/**
 * Returns the freshest all-creators CSV available, refreshing from HubSpot
 * if necessary. Concurrent callers share the same promise; a `force` call
 * waiting on a non-force run will trigger a follow-up refresh once the
 * in-flight call settles.
 */
export async function ensureCreatorsExport(
  opts: EnsureExportOptions,
): Promise<CreatorExportResult> {
  if (inflight) {
    // If we're not forcing, just piggyback on whatever is already running.
    if (!opts.force) return inflight;
    // We are forcing but a non-force is already in-flight; chain a forced
    // run after it so the user always gets a fresh export.
    if (!inflightForce) {
      return inflight.then(() => ensureCreatorsExport(opts));
    }
    return inflight;
  }

  inflightForce = opts.force ?? false;
  inflight = runEnsure(opts).finally(() => {
    inflight = null;
    inflightForce = false;
  });
  return inflight;
}

async function runEnsure(opts: EnsureExportOptions): Promise<CreatorExportResult> {
  try {
    if (!opts.force) {
      const local = await tryLocal();
      if (local) {
        notify({ phase: "done", generatedAt: local.generatedAt, message: "Using local cache" });
        return local;
      }

      if (isSupabaseConfigured) {
        const supa = await trySupabase();
        if (supa) {
          notify({ phase: "done", generatedAt: supa.generatedAt, message: "Using Supabase cache" });
          return supa;
        }
      }
    }

    const fresh = await refreshFromHubspot(opts.token);
    notify({ phase: "done", generatedAt: fresh.generatedAt, message: "Export refreshed" });
    return fresh;
  } catch (err) {
    notify({
      phase: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function tryLocal(): Promise<CreatorExportResult | null> {
  notify({ phase: "checking-local" });
  const cached = await invoke<CachedExportFromTauri>("read_local_creators_export");
  if (!cached.csv || !cached.generatedAt) return null;
  const generatedAt = new Date(cached.generatedAt);
  if (Number.isNaN(generatedAt.getTime())) return null;
  if (isCreatorExportStale(generatedAt)) return null;

  // Defend against a previous bad upload: if the cached file is not a real
  // CSV (e.g. a ZIP body persisted by an earlier broken build), drop it and
  // let the orchestrator fall through to Supabase / HubSpot.
  if (!looksLikeCreatorsCsv(cached.csv)) {
    console.warn("[creator-export] local cache is not a valid CSV, clearing");
    await clearLocalCreatorsExport();
    return null;
  }

  return {
    csv: cached.csv,
    generatedAt,
    source: "local",
    storagePath: cached.storagePath,
  };
}

async function trySupabase(): Promise<CreatorExportResult | null> {
  notify({ phase: "checking-supabase" });
  let pointer;
  try {
    pointer = await getLatestCreatorsExport();
  } catch (err) {
    console.warn("[creator-export] Supabase pointer lookup failed:", err);
    return null;
  }
  if (!pointer) return null;
  if (isCreatorExportStale(pointer.generatedAt)) return null;

  notify({
    phase: "downloading-supabase",
    generatedAt: pointer.generatedAt,
    message: "Downloading creators export from Supabase…",
  });

  let csv: string;
  try {
    csv = await downloadCreatorsExport(pointer.storagePath);
  } catch (err) {
    console.warn("[creator-export] Supabase download failed:", err);
    return null;
  }

  // If Supabase still has the corrupted file from a previous broken upload
  // (e.g. ZIP bytes written under the .csv name), don't trust it — fall
  // through and force a fresh HubSpot pull.
  if (!looksLikeCreatorsCsv(csv)) {
    console.warn(
      "[creator-export] Supabase export is not a valid CSV, falling through to HubSpot",
    );
    return null;
  }

  notify({ phase: "saving-local", generatedAt: pointer.generatedAt });
  await writeLocal(csv, pointer.generatedAt, pointer.storagePath);

  return {
    csv,
    generatedAt: pointer.generatedAt,
    source: "supabase",
    storagePath: pointer.storagePath,
  };
}

async function refreshFromHubspot(token: string): Promise<CreatorExportResult> {
  if (!token) {
    throw new Error("HubSpot token is required to refresh the creators export");
  }

  notify({ phase: "exporting-hubspot", message: "Starting HubSpot export…" });
  const taskId = await invoke<string>("hubspot_export_all_creators_start", { token });

  const startedAt = Date.now();
  let downloadUrl: string | undefined;
  while (true) {
    const status = await invoke<HubspotExportStatusResponse>(
      "hubspot_export_all_creators_status",
      { token, taskId },
    );
    notify({
      phase: "polling-hubspot",
      hubspotStatus: status.status,
      message: friendlyHubspotStatusMessage(status),
    });

    if (status.status === "COMPLETE" && status.downloadUrl) {
      downloadUrl = status.downloadUrl;
      break;
    }
    if (status.status === "FAILED" || status.status === "CANCELED") {
      throw new Error(
        `HubSpot export ${status.status.toLowerCase()}${
          status.message ? `: ${status.message}` : ""
        }`,
      );
    }
    if (Date.now() - startedAt > HUBSPOT_POLL_TIMEOUT_MS) {
      throw new Error("HubSpot export did not finish within 10 minutes");
    }
    await delay(HUBSPOT_POLL_INTERVAL_MS);
  }

  notify({ phase: "downloading-hubspot", message: "Downloading CSV from HubSpot…" });
  const csv = await invoke<string>("hubspot_export_download", { url: downloadUrl });

  // Guard rail — refuse to upload garbage to Supabase. If HubSpot ever
  // returns a non-CSV body (e.g. they change the export packaging again),
  // surface a clear error here instead of poisoning the shared cache.
  if (!looksLikeCreatorsCsv(csv)) {
    throw new Error(
      "HubSpot returned something that isn't a creators CSV. The export packaging may have changed; check the desktop logs.",
    );
  }

  const generatedAt = new Date();
  let storagePath: string | undefined;

  if (isSupabaseConfigured) {
    notify({ phase: "uploading-supabase", message: "Uploading to Supabase…" });
    try {
      const upload = await uploadCreatorsExport(csv);
      storagePath = upload.storagePath;
      const rowCount = countCsvRows(csv);
      await recordCreatorsExport(storagePath, rowCount, getAppVersion());
    } catch (err) {
      console.warn("[creator-export] Supabase upload failed:", err);
    }
  }

  notify({ phase: "saving-local", generatedAt });
  await writeLocal(csv, generatedAt, storagePath);

  return { csv, generatedAt, source: "hubspot", storagePath };
}

async function writeLocal(
  csv: string,
  generatedAt: Date,
  storagePath: string | undefined,
): Promise<void> {
  await invoke("write_local_creators_export", {
    csv,
    generatedAt: generatedAt.toISOString(),
    storagePath: storagePath ?? null,
  });
}

function friendlyHubspotStatusMessage(status: HubspotExportStatusResponse): string {
  switch (status.status) {
    case "PENDING":
      return "Asking HubSpot for an up-to-date creators list…";
    case "PROCESSING":
      return "HubSpot is preparing the creators list (this can take a few minutes)…";
    case "COMPLETE":
      return "Almost ready — downloading the creators list…";
    case "FAILED":
      return status.message ? `HubSpot couldn't finish: ${status.message}` : "HubSpot couldn't finish the export";
    case "CANCELED":
      return "HubSpot canceled the export";
    default:
      return `Waiting for HubSpot (${status.status.toLowerCase()})…`;
  }
}

/**
 * Plain-language one-liner derived from a progress event. Safe to show in
 * UI surfaces that don't know the orchestrator internals (e.g. the global
 * "data integrity" warning bar). Returns null when there is nothing the
 * user needs to see.
 */
export function describeCreatorExportProgress(
  progress: CreatorExportProgress,
): string | null {
  switch (progress.phase) {
    case "checking-local":
    case "checking-supabase":
      return "Checking creators list…";
    case "downloading-supabase":
      return "Loading creators list from the cloud…";
    case "exporting-hubspot":
      return "Asking HubSpot for an up-to-date creators list…";
    case "polling-hubspot":
      return progress.message || "HubSpot is preparing the creators list…";
    case "downloading-hubspot":
      return "Almost ready — downloading the creators list from HubSpot…";
    case "uploading-supabase":
      return "Saving creators list to the cloud…";
    case "saving-local":
      return "Saving creators list locally…";
    case "error":
      return progress.message ? `Creators list error: ${progress.message}` : "Couldn't refresh creators list";
    case "done":
    case "idle":
    default:
      return null;
  }
}

/**
 * `true` while the orchestrator is actively talking to HubSpot/Supabase
 * (i.e. the user should see a progress indicator).
 */
export function isCreatorExportInProgress(progress: CreatorExportProgress): boolean {
  return (
    progress.phase !== "idle" &&
    progress.phase !== "done" &&
    progress.phase !== "error"
  );
}

function countCsvRows(csv: string): number {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (c === '"') {
      if (inQuotes && csv[i + 1] === '"') {
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && c === "\n") count++;
  }
  // Subtract header row, clamp to zero.
  return Math.max(0, count - 1);
}

function getAppVersion(): string | undefined {
  try {
    return typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : undefined;
  } catch {
    return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
