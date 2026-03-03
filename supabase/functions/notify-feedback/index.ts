import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

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
  created_at: string;
}

interface SupabaseWebhookPayload {
  type: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  schema: string;
  record?: FeedbackRecord;
  old_record?: FeedbackRecord;
}

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
const TELEGRAM_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID");

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

  if (record.type === "feature" && record.importance) {
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

function buildTelegramMessage(record: FeedbackRecord) {
  const lines = [
    "New CompiFlow feedback",
    "",
    `Type: ${formatTypeLabel(record.type)}`,
    `Title: ${record.title}`,
    "",
    "Description:",
    record.description,
    "",
    ...formatExtraDetails(record),
  ];

  if (record.screenshots && record.screenshots.length > 0) {
    lines.push("", "Screenshot URLs:", ...record.screenshots);
  }

  return lines.join("\n");
}

serve(async (req) => {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return new Response(
      JSON.stringify({ error: "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID" }),
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

  const message = buildTelegramMessage(body.record);

  const telegramRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
    }),
  });

  if (!telegramRes.ok) {
    const errorText = await telegramRes.text();
    return new Response(JSON.stringify({ error: "Telegram API failed", details: errorText }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
