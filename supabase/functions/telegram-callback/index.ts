// telegram-callback — handles inline-keyboard taps from the admin DM.
//
// Receives `callback_query` updates proxied by the `telegram-bot` Edge
// Function. V1 supports two actions:
//   - approve:<feedback_id> → flip feedback.status to 'ai_processing'
//   - reject:<feedback_id>  → flip feedback.status to 'resolved' with
//                              ai_response.outcome='rejected'
//
// V2 will replace the approve branch with a real Cursor Background Agent
// dispatch (Plan with Opus → Build with GPT-5.1 → Review with Opus). The
// TODO marker below is the single place to wire that in.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const TELEGRAM_WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

interface CallbackQuery {
  id: string;
  from: { id: number; username?: string; first_name?: string };
  message?: {
    message_id: number;
    chat: { id: number };
    text?: string;
  };
  data?: string;
}

interface CallbackUpdate {
  update_id: number;
  callback_query?: CallbackQuery;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function tgApi(method: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return await res.json();
}

async function answerCallbackQuery(callbackQueryId: string, text?: string) {
  await tgApi("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: text ?? "",
  });
}

async function editMessageText(chatId: number, messageId: number, text: string) {
  await tgApi("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
  });
}

function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

function parseCallbackData(raw: string): { action: string; id: string } | null {
  const idx = raw.indexOf(":");
  if (idx < 0) return null;
  return { action: raw.slice(0, idx), id: raw.slice(idx + 1) };
}

async function handleApprove(feedbackId: string): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb
    .from("feedback")
    .update({ status: "ai_processing" })
    .eq("id", feedbackId);
  if (error) throw error;

  // TODO(V2): dispatch Cursor Background Agent here.
  //   Stage 1 — Plan (Claude Opus): post the plan back to Miquel's admin DM
  //     with `Approve plan` / `Reject` inline buttons.
  //   Stage 2 — Build (GPT-5.1): execute the approved plan on a fresh branch,
  //     run tests, open a draft PR.
  //   Stage 3 — Review (Claude Opus): one final pass over the diff, leave
  //     comments / fix-ups, mark the PR ready-for-review.
  // The dispatcher will live in `supabase/functions/dispatch-code-agent/`
  // (or be inlined here) and POST to Cursor's `/v1/agents` endpoint with the
  // feedback row + chat transcript + repo URL as the prompt.
}

async function handleReject(feedbackId: string): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb
    .from("feedback")
    .update({
      status: "resolved",
      ai_response: { outcome: "rejected", at: new Date().toISOString() },
    })
    .eq("id", feedbackId);
  if (error) throw error;
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

  if (!TELEGRAM_BOT_TOKEN) {
    return jsonResponse({ error: "Missing TELEGRAM_BOT_TOKEN" }, 500);
  }

  let update: CallbackUpdate;
  try {
    update = (await req.json()) as CallbackUpdate;
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const cq = update.callback_query;
  if (!cq?.data) {
    return jsonResponse({ ok: true, ignored: "no callback_query data" });
  }

  const parsed = parseCallbackData(cq.data);
  if (!parsed) {
    await answerCallbackQuery(cq.id, "Unknown action");
    return jsonResponse({ ok: true, ignored: "unparsable data" });
  }

  const reviewer = cq.from.username
    ? `@${cq.from.username}`
    : cq.from.first_name ?? `user_${cq.from.id}`;

  try {
    if (parsed.action === "approve") {
      await handleApprove(parsed.id);
      await answerCallbackQuery(cq.id, "Approved");
      if (cq.message) {
        const original = cq.message.text ?? "(message)";
        await editMessageText(
          cq.message.chat.id,
          cq.message.message_id,
          `${original}\n\n✅ Approved by ${reviewer} — V2 will dispatch the Code agent here (TODO).`,
        );
      }
      return jsonResponse({ ok: true, action: "approve" });
    }

    if (parsed.action === "reject") {
      await handleReject(parsed.id);
      await answerCallbackQuery(cq.id, "Rejected");
      if (cq.message) {
        const original = cq.message.text ?? "(message)";
        await editMessageText(
          cq.message.chat.id,
          cq.message.message_id,
          `${original}\n\n❌ Rejected by ${reviewer}.`,
        );
      }
      return jsonResponse({ ok: true, action: "reject" });
    }

    await answerCallbackQuery(cq.id, "Unknown action");
    return jsonResponse({ ok: true, action: parsed.action, ignored: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[telegram-callback] error:", msg);
    await answerCallbackQuery(cq.id, "Failed — see logs");
    return jsonResponse({ ok: false, error: msg }, 200);
  }
});
