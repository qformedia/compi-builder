import { createClient } from "@supabase/supabase-js";
import type { FeedbackPayload } from "@/types";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const screenshotsBucket = import.meta.env.VITE_SUPABASE_FEEDBACK_BUCKET || "feedback-screenshots";

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
