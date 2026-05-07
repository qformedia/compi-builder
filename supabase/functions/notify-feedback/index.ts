import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

interface FeedbackRecord {
  id: string;
  type: "bug" | "feature";
  title: string;
  description: string;
  frequency?: "once" | "sometimes" | "always" | null;
  importance?: "nice_to_have" | "important" | "critical" | null;
  reporter_name?: string | null;
  screenshots?: string[] | null;
  app_version?: string | null;
  os_info?: string | null;
  status?: string | null;
  ai_response?: { summary?: string } | null;
  chat_session_id?: string | null;
  created_at: string;
}

interface SupabaseWebhookPayload {
  type: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  schema: string;
  record?: FeedbackRecord;
  old_record?: FeedbackRecord;
}

interface ChatMessageRow {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_name: string | null;
  created_at: string;
}

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
const TELEGRAM_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID");
const ADMIN_TELEGRAM_CHAT_ID =
  Deno.env.get("ADMIN_TELEGRAM_CHAT_ID") ?? TELEGRAM_CHAT_ID;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const TRANSCRIPT_LIMIT = 10;
const TRANSCRIPT_LINE_MAX = 240;

function formatTypeLabel(type: FeedbackRecord["type"]) {
  return type === "bug" ? "Report a Problem" : "Suggest an Improvement";
}

function formatExtraDetails(record: FeedbackRecord): string[] {
  const lines: string[] = [];

  if (record.type === "bug" && record.frequency) {
    const frequencyMap: Record<string, string> = {
      once: "Once",
      sometimes: "Sometimes",
      always: "Every time",
    };
    lines.push(`Frequency: ${frequencyMap[record.frequency] ?? record.frequency}`);
  }

  if (record.importance) {
    const importanceMap: Record<string, string> = {
      nice_to_have: "Nice to have",
      important: "Important",
      critical: "Critical for my work",
    };
    lines.push(`Importance: ${importanceMap[record.importance] ?? record.importance}`);
  }

  if (record.reporter_name) lines.push(`Name: ${record.reporter_name}`);
  if (record.app_version) lines.push(`App version: ${record.app_version}`);
  if (record.os_info) lines.push(`OS: ${record.os_info}`);

  const screenshotsCount = record.screenshots?.length ?? 0;
  lines.push(`Screenshots: ${screenshotsCount}`);
  return lines;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

async function fetchTranscript(sessionId: string): Promise<ChatMessageRow[]> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return [];
  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
    const { data, error } = await sb
      .from("chat_messages")
      .select("role, content, tool_name, created_at")
      .eq("session_id", sessionId)
      .in("role", ["user", "assistant"])
      .not("content", "is", null)
      .order("created_at", { ascending: false })
      .limit(TRANSCRIPT_LIMIT);
    if (error) {
      console.error("[notify-feedback] transcript fetch failed:", error.message);
      return [];
    }
    return ((data ?? []) as ChatMessageRow[]).reverse();
  } catch (err) {
    console.error("[notify-feedback] transcript exception:", err);
    return [];
  }
}

function buildTranscriptBlock(messages: ChatMessageRow[]): string[] {
  if (messages.length === 0) return [];
  const lines = ["", "Conversation (last 10 turns):"];
  for (const msg of messages) {
    const speaker = msg.role === "user" ? "User" : "MiniMiki";
    const content = truncate((msg.content ?? "").replace(/\s+/g, " ").trim(), TRANSCRIPT_LINE_MAX);
    if (content) lines.push(`• ${speaker}: ${content}`);
  }
  return lines;
}

function buildTelegramMessage(record: FeedbackRecord, transcript: ChatMessageRow[]) {
  const sourceLabel = record.chat_session_id ? "MiniMiki chat" : "Feedback form";
  const lines: string[] = [
    "New CompiFlow feedback",
    "",
    `Source: ${sourceLabel}`,
    `Type: ${formatTypeLabel(record.type)}`,
    `Title: ${record.title}`,
  ];

  if (record.ai_response?.summary) {
    lines.push("", `Summary: ${record.ai_response.summary}`);
  }

  lines.push("", "Description:", record.description, "", ...formatExtraDetails(record));

  if (record.screenshots && record.screenshots.length > 0) {
    lines.push("", "Screenshot URLs:", ...record.screenshots);
  }

  lines.push(...buildTranscriptBlock(transcript));

  return lines.join("\n");
}

function buildApprovalKeyboard(feedbackId: string) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Approve", callback_data: `approve:${feedbackId}` },
        { text: "❌ Reject", callback_data: `reject:${feedbackId}` },
      ],
    ],
  };
}

serve(async (req) => {
  if (!TELEGRAM_BOT_TOKEN || !ADMIN_TELEGRAM_CHAT_ID) {
    return new Response(
      JSON.stringify({
        error:
          "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID/ADMIN_TELEGRAM_CHAT_ID",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  let body: SupabaseWebhookPayload;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON payload" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (body.type !== "INSERT" || !body.record) {
    return new Response(JSON.stringify({ ok: true, ignored: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const transcript = body.record.chat_session_id
    ? await fetchTranscript(body.record.chat_session_id)
    : [];
  const message = buildTelegramMessage(body.record, transcript);
  const replyMarkup = buildApprovalKeyboard(body.record.id);

  const telegramRes = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: ADMIN_TELEGRAM_CHAT_ID,
        text: message,
        reply_markup: replyMarkup,
      }),
    },
  );

  if (!telegramRes.ok) {
    const errorText = await telegramRes.text();
    return new Response(
      JSON.stringify({ error: "Telegram API failed", details: errorText }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
