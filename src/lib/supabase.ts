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
