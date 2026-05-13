import { createClient } from "@supabase/supabase-js";
import type { FeedbackPayload } from "@/types";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const screenshotsBucket = import.meta.env.VITE_SUPABASE_FEEDBACK_BUCKET || "feedback-screenshots";
const hsExportsBucket = import.meta.env.VITE_SUPABASE_HS_EXPORTS_BUCKET || "hs-exports";

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

function requireSupabaseConfig() {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.");
  }
}

function createSupabaseClient() {
  requireSupabaseConfig();
  return createClient(supabaseUrl!, supabaseAnonKey!);
}

function getFileExtension(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  return ext && ext.length <= 10 ? ext : "png";
}

export async function uploadFeedbackScreenshot(file: Blob, filename: string) {
  const client = createSupabaseClient();
  const extension = getFileExtension(filename);
  const objectPath = `${Date.now()}-${crypto.randomUUID()}.${extension}`;

  const { error } = await client.storage
    .from(screenshotsBucket)
    .upload(objectPath, file, {
      cacheControl: "3600",
      upsert: false,
      contentType: file.type || undefined,
    });

  if (error) throw error;

  const { data } = client.storage.from(screenshotsBucket).getPublicUrl(objectPath);
  return data.publicUrl;
}

export async function submitFeedback(payload: FeedbackPayload) {
  const client = createSupabaseClient();
  const { error } = await client.from("feedback").insert(payload);
  if (error) throw error;
}

export interface DownloadIssueInfo {
  clipId: string;
  clipUrl: string;
  platform: string;
  downloadStatus: string;
  localFile?: string;
  downloadError?: string;
  retryCount: number;
  reporterName?: string;
}

export async function reportDownloadIssue(info: DownloadIssueInfo) {
  const description = [
    `URL: ${info.clipUrl}`,
    `Platform: ${info.platform}`,
    `Status: ${info.downloadStatus}`,
    `File: ${info.localFile ?? "(none)"}`,
    `Error: ${info.downloadError ?? "(none)"}`,
    `Retry count: ${info.retryCount}`,
    `OS: ${navigator.userAgent}`,
    `App: v${__APP_VERSION__}`,
  ].join("\n");

  const payload: FeedbackPayload = {
    type: "bug",
    title: `Download issue: ${info.clipId}`,
    description,
    importance: "important",
    reporter_name: info.reporterName || undefined,
    screenshots: [],
    app_version: __APP_VERSION__,
    os_info: navigator.userAgent,
  };

  await submitFeedback(payload);
}

/* ------------------------------------------------------------------ */
/* HubSpot export cache (all-creators CSV for Data Integrity)         */
/* ------------------------------------------------------------------ */

const HS_EXPORT_KIND_ALL_CREATORS = "all_creators";

export interface CreatorsExportPointer {
  storagePath: string;
  generatedAt: Date;
  rowCount: number | null;
}

/** Returns the most recent `all_creators` export pointer, or null if there is none. */
export async function getLatestCreatorsExport(): Promise<CreatorsExportPointer | null> {
  const client = createSupabaseClient();
  const { data, error } = await client
    .from("hs_exports")
    .select("storage_path, generated_at, row_count")
    .eq("kind", HS_EXPORT_KIND_ALL_CREATORS)
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    storagePath: data.storage_path as string,
    generatedAt: new Date(data.generated_at as string),
    rowCount: (data.row_count as number | null) ?? null,
  };
}

/** Downloads the CSV stored at `storagePath` in the hs-exports bucket as text. */
export async function downloadCreatorsExport(storagePath: string): Promise<string> {
  const client = createSupabaseClient();
  const { data, error } = await client.storage.from(hsExportsBucket).download(storagePath);
  if (error) throw error;
  if (!data) throw new Error("Empty response downloading creators export");
  return await data.text();
}

/**
 * Uploads a fresh all-creators CSV under a timestamped object path and
 * returns where it landed. We never overwrite existing exports so the
 * `hs_exports` table doubles as an audit log.
 */
export async function uploadCreatorsExport(csv: string): Promise<{ storagePath: string }> {
  const client = createSupabaseClient();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const storagePath = `all-creators/all-creators-${stamp}.csv`;

  const blob = new Blob([csv], { type: "text/csv" });
  const { error } = await client.storage.from(hsExportsBucket).upload(storagePath, blob, {
    cacheControl: "3600",
    upsert: false,
    contentType: "text/csv",
  });
  if (error) throw error;
  return { storagePath };
}

/** Insert a pointer row in `hs_exports` for an export we just uploaded. */
export async function recordCreatorsExport(
  storagePath: string,
  rowCount: number,
  appVersion?: string,
): Promise<void> {
  const client = createSupabaseClient();
  const { error } = await client.from("hs_exports").insert({
    kind: HS_EXPORT_KIND_ALL_CREATORS,
    storage_path: storagePath,
    row_count: rowCount,
    app_version: appVersion ?? null,
  });
  if (error) throw error;
}

/* ------------------------------------------------------------------ */
/* Excluded HubSpot owners (Create > Owner dropdown filter)           */
/* ------------------------------------------------------------------ */

export interface ExcludedOwner {
  ownerId: string;
  email: string | null;
  displayName: string | null;
  note: string | null;
  excludedBy: string | null;
}

/** Returns the current exclude list, or `[]` if Supabase is not configured. */
export async function listExcludedOwners(): Promise<ExcludedOwner[]> {
  if (!isSupabaseConfigured) return [];
  const client = createSupabaseClient();
  const { data, error } = await client
    .from("hs_excluded_owners")
    .select("owner_id, email, display_name, note, excluded_by")
    .order("display_name", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    ownerId: r.owner_id as string,
    email: (r.email as string) ?? null,
    displayName: (r.display_name as string) ?? null,
    note: (r.note as string) ?? null,
    excludedBy: (r.excluded_by as string) ?? null,
  }));
}

export async function excludeOwner(o: {
  ownerId: string;
  email?: string;
  displayName?: string;
  excludedBy?: string;
}): Promise<void> {
  const client = createSupabaseClient();
  const { error } = await client.from("hs_excluded_owners").upsert(
    {
      owner_id: o.ownerId,
      email: o.email ?? null,
      display_name: o.displayName ?? null,
      excluded_by: o.excludedBy ?? null,
    },
    { onConflict: "owner_id" },
  );
  if (error) throw error;
}

export async function unexcludeOwner(ownerId: string): Promise<void> {
  const client = createSupabaseClient();
  const { error } = await client
    .from("hs_excluded_owners")
    .delete()
    .eq("owner_id", ownerId);
  if (error) throw error;
}

