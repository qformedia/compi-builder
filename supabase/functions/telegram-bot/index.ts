// MiniMiki Telegram bot — webhook entry.
//
// Telegram only allows one webhook per bot, so this function is the single
// receiver for all updates. Message updates are handled in-process via
// `runConversation`; callback_query updates (admin Approve / Reject) are
// proxied to the sibling `telegram-callback` Edge Function so each function
// stays small and independently testable.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { runConversation, type TelegramUpdate } from "./bot.ts";

const TELEGRAM_BOT_USERNAME = Deno.env.get("TELEGRAM_BOT_USERNAME") ?? "minimiki_bot";
const TELEGRAM_WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

interface CallbackQueryUpdate extends TelegramUpdate {
  callback_query?: {
    id: string;
    from: { id: number; username?: string; first_name?: string };
    message?: { message_id: number; chat: { id: number } };
    data?: string;
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function proxyCallback(update: CallbackQueryUpdate): Promise<void> {
  // We don't await the response body; we only care that the dispatch succeeded.
  // Edge Function URLs follow the pattern <project>.functions.supabase.co/<name>.
  if (!SUPABASE_URL) return;
  const url = `${SUPABASE_URL}/functions/v1/telegram-callback`;
  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(SUPABASE_ANON_KEY ? { Authorization: `Bearer ${SUPABASE_ANON_KEY}` } : {}),
      ...(TELEGRAM_WEBHOOK_SECRET
        ? { "X-Telegram-Bot-Api-Secret-Token": TELEGRAM_WEBHOOK_SECRET }
        : {}),
    },
    body: JSON.stringify(update),
  }).catch(() => {
    // Telegram cares about the webhook returning 200; we don't surface
    // proxy failures back to it. Errors are logged via the callback fn.
  });
}

serve(async (req) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  if (TELEGRAM_WEBHOOK_SECRET) {
    const got = req.headers.get("x-telegram-bot-api-secret-token");
    if (got !== TELEGRAM_WEBHOOK_SECRET) {
      return jsonResponse({ error: "Forbidden" }, 403);
    }
  }

  let update: CallbackQueryUpdate;
  try {
    update = (await req.json()) as CallbackQueryUpdate;
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  try {
    if (update.callback_query) {
      await proxyCallback(update);
      return jsonResponse({ ok: true, routed: "callback" });
    }

    await runConversation(update, { botUsername: TELEGRAM_BOT_USERNAME });
    return jsonResponse({ ok: true });
  } catch (err) {
    const msg = describeError(err);
    console.error("[telegram-bot] handler error:", msg);
    // Return 200 so Telegram doesn't retry the same update endlessly.
    return jsonResponse({ ok: false, error: msg });
  }
});

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const stack = err.stack ? `\n${err.stack}` : "";
    return `${err.name}: ${err.message}${stack}`;
  }
  if (err && typeof err === "object") {
    try {
      return JSON.stringify(err, Object.getOwnPropertyNames(err as object));
    } catch {
      return String(err);
    }
  }
  return String(err);
}
