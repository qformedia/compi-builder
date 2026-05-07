// MiniMiki bot brain.
//
// Single-file conversation runtime: finds-or-creates a chat session,
// loads history, calls the LLM with streaming + tool use, persists every
// turn, and streams the assistant reply back to Telegram via debounced
// editMessageText calls.
//
// Files split is deliberately conservative — see Design Principle #1 in
// the plan ("one file until pain demands two").

import { streamText, tool, type CoreMessage } from "npm:ai@4";
import { createOpenAICompatible } from "npm:@ai-sdk/openai-compatible@0.2";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { z } from "npm:zod@3";
import { buildSystemPrompt, FALLBACK_GREETING, type PromptContext } from "./prompts.ts";
import {
  buildSubmitFeedbackRow,
  chatTypeToSource,
  displayName,
  parseStartCommand,
  shouldRespond,
  stripBotMention,
  type BuildSubmitFeedbackRowInput,
} from "./_pure.ts";

export {
  buildSubmitFeedbackRow,
  chatTypeToSource,
  displayName,
  parseStartCommand,
  shouldRespond,
  stripBotMention,
};

// ── Environment ──────────────────────────────────────────────────────────

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const GITHUB_TOKEN = Deno.env.get("GITHUB_TOKEN") ?? "";
const GITHUB_REPO = Deno.env.get("GITHUB_REPO") ?? "Quantastic/compi-builder";
const GITHUB_DEFAULT_BRANCH = Deno.env.get("GITHUB_DEFAULT_BRANCH") ?? "main";

const MINIMIKI_PROVIDER = Deno.env.get("MINIMIKI_PROVIDER") ?? "deepseek";
const MINIMIKI_MODEL = Deno.env.get("MINIMIKI_MODEL") ?? "deepseek-chat";
const MINIMIKI_API_KEY = Deno.env.get("MINIMIKI_API_KEY") ?? "";
const MINIMIKI_BASE_URL =
  Deno.env.get("MINIMIKI_BASE_URL") ?? "https://api.deepseek.com/v1";

function parseIdSet(raw: string): ReadonlySet<number> {
  return new Set(
    raw
      .split(",")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n)),
  );
}

// Allowlist of Telegram user IDs that are allowed to invoke the
// repo-reading tools (`search_repo`, `read_file`). Anyone NOT in this list
// can still chat with MiniMiki and submit bugs/features (assuming they're
// allowed to chat at all — see ALLOWED_USER_IDS below), but the bot will
// not quote source code or file contents to them.
const MINIMIKI_ADMIN_USER_IDS = parseIdSet(Deno.env.get("MINIMIKI_ADMIN_USER_IDS") ?? "");

// Hard allowlist for DM access. If set, only these Telegram user IDs can
// chat with MiniMiki in a private (1:1) conversation. If empty/unset, DMs
// are open to anyone — useful only during the initial test phase.
const MINIMIKI_ALLOWED_USER_IDS = parseIdSet(Deno.env.get("MINIMIKI_ALLOWED_USER_IDS") ?? "");

// Hard allowlist for group access. If set, the bot only responds in these
// group / supergroup chat IDs (negative numbers, e.g. -1001234567890). Any
// other group the bot gets added to is silently ignored.
const MINIMIKI_ALLOWED_CHAT_IDS = parseIdSet(Deno.env.get("MINIMIKI_ALLOWED_CHAT_IDS") ?? "");

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// Inner agent loop safety net (not a "conversation limit"; this just
// prevents a runaway tool-call loop within a single user turn).
const MAX_AGENT_STEPS = 10;

// ── Telegram types (subset we actually use) ─────────────────────────────

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
}

export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  reply_to_message?: TelegramMessage & { from?: TelegramUser };
  entities?: TelegramMessageEntity[];
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

interface ReplyMarkup {
  inline_keyboard?: InlineKeyboardButton[][];
}

// ── Supabase client (service role) ──────────────────────────────────────

let supabaseClient: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!supabaseClient) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars");
    }
    supabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
  }
  return supabaseClient;
}

/** Test seam — reset memoised client between unit tests. */
export function resetSupabaseClient() {
  supabaseClient = null;
}

// ── Telegram helpers ─────────────────────────────────────────────────────

async function tgApi<T>(method: string, body: unknown): Promise<T> {
  const res = await fetch(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!json.ok) {
    throw new Error(`Telegram ${method} failed: ${json.description ?? res.status}`);
  }
  return json.result as T;
}

export async function sendMessage(
  chatId: number,
  text: string,
  opts: { reply_markup?: ReplyMarkup; reply_to_message_id?: number } = {},
): Promise<TelegramMessage> {
  return tgApi<TelegramMessage>("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    ...opts,
  });
}

export async function editMessageText(
  chatId: number,
  messageId: number,
  text: string,
): Promise<void> {
  try {
    await tgApi("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "Markdown",
    });
  } catch (err) {
    // Telegram throws "message is not modified" when the new text equals
    // the old. That's harmless during streaming; swallow it.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/not modified/i.test(msg)) throw err;
  }
}

export async function sendPhoto(
  chatId: number,
  photoUrl: string,
  caption: string,
  opts: { reply_markup?: ReplyMarkup } = {},
): Promise<TelegramMessage> {
  return tgApi<TelegramMessage>("sendPhoto", {
    chat_id: chatId,
    photo: photoUrl,
    caption,
    parse_mode: "Markdown",
    ...opts,
  });
}

export async function sendChatAction(
  chatId: number,
  action: "typing" | "upload_photo",
): Promise<void> {
  try {
    await tgApi("sendChatAction", { chat_id: chatId, action });
  } catch {
    // Best-effort; ignore failures.
  }
}

// ── Session + message persistence ────────────────────────────────────────

export interface ChatSessionRow {
  id: string;
  source: PromptContext["source"];
  telegram_chat_id: number | null;
  telegram_user_id: number | null;
  telegram_user_name: string | null;
  app_version: string | null;
  status: "open" | "closed" | "converted_to_feedback";
  summary: string | null;
  started_at: string;
  closed_at: string | null;
}

export async function findActiveSession(
  chatId: number,
  userId: number,
): Promise<ChatSessionRow | null> {
  const { data, error } = await getSupabase()
    .from("chat_sessions")
    .select("*")
    .eq("telegram_chat_id", chatId)
    .eq("telegram_user_id", userId)
    .eq("status", "open")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as ChatSessionRow | null;
}

export async function createSession(input: {
  source: PromptContext["source"];
  telegramChatId: number;
  telegramUserId: number;
  telegramUserName?: string;
  appVersion?: string;
}): Promise<ChatSessionRow> {
  const { data, error } = await getSupabase()
    .from("chat_sessions")
    .insert({
      source: input.source,
      telegram_chat_id: input.telegramChatId,
      telegram_user_id: input.telegramUserId,
      telegram_user_name: input.telegramUserName ?? null,
      app_version: input.appVersion ?? null,
      status: "open",
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as ChatSessionRow;
}

export async function closeSession(sessionId: string): Promise<void> {
  const { error } = await getSupabase()
    .from("chat_sessions")
    .update({ status: "closed", closed_at: new Date().toISOString() })
    .eq("id", sessionId);
  if (error) throw error;
}

export async function persistMessage(input: {
  sessionId: string;
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
}): Promise<void> {
  const { error } = await getSupabase().from("chat_messages").insert({
    session_id: input.sessionId,
    role: input.role,
    content: input.content ?? null,
    tool_name: input.toolName ?? null,
    tool_input: input.toolInput ?? null,
    tool_output: input.toolOutput ?? null,
  });
  if (error) throw error;
}

export async function loadConversationHistory(
  sessionId: string,
): Promise<CoreMessage[]> {
  // We only feed user/assistant text turns back into the LLM. Tool calls
  // were used by the model in past turns to produce its visible reply, and
  // the visible reply is what carries information forward. This keeps
  // history reconstruction simple and sidesteps tool_call_id pairing.
  const { data, error } = await getSupabase()
    .from("chat_messages")
    .select("role, content, created_at")
    .eq("session_id", sessionId)
    .in("role", ["user", "assistant"])
    .not("content", "is", null)
    .order("created_at", { ascending: true });
  if (error) throw error;
  const rows = (data ?? []) as Array<{ role: "user" | "assistant"; content: string }>;
  return rows.map((row) => ({ role: row.role, content: row.content })) as CoreMessage[];
}

// ── Handoff consumption (single-use SELECT + DELETE) ─────────────────────

export interface HandoffPayload {
  user?: string;
  appVersion?: string;
  page?: string;
  projectName?: string;
  lastError?: string;
}

export interface HandoffRow {
  token: string;
  screenshot_url: string | null;
  context: HandoffPayload;
}

export async function consumeHandoff(token: string): Promise<HandoffRow | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("minimiki_handoffs")
    .select("token, screenshot_url, context, expires_at")
    .eq("token", token)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  if (new Date(data.expires_at as string).getTime() < Date.now()) {
    await sb.from("minimiki_handoffs").delete().eq("token", token);
    return null;
  }
  await sb.from("minimiki_handoffs").delete().eq("token", token);
  return {
    token: data.token as string,
    screenshot_url: (data.screenshot_url as string | null) ?? null,
    context: (data.context as HandoffPayload) ?? {},
  };
}

// ── Tools ────────────────────────────────────────────────────────────────

const githubHeaders = (): HeadersInit => ({
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
});

async function searchRepoImpl(query: string): Promise<{ matches: Array<{ path: string; snippet: string; url: string }> }> {
  const q = encodeURIComponent(`${query} repo:${GITHUB_REPO}`);
  const res = await fetch(`https://api.github.com/search/code?q=${q}&per_page=5`, {
    headers: githubHeaders(),
  });
  if (!res.ok) {
    return { matches: [] };
  }
  const json = (await res.json()) as {
    items?: Array<{ path: string; html_url: string; text_matches?: Array<{ fragment: string }> }>;
  };
  const matches = (json.items ?? []).slice(0, 5).map((item) => ({
    path: item.path,
    snippet: item.text_matches?.[0]?.fragment?.slice(0, 400) ?? "",
    url: item.html_url,
  }));
  return { matches };
}

async function readFileImpl(
  path: string,
  lineStart?: number,
  lineEnd?: number,
): Promise<{ path: string; content: string; truncated: boolean }> {
  const cleanPath = path.replace(/^\/+/, "");
  const url = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_DEFAULT_BRANCH}/${cleanPath}`;
  const res = await fetch(url, {
    headers: GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {},
  });
  if (!res.ok) {
    throw new Error(`Could not read ${path} (HTTP ${res.status})`);
  }
  let text = await res.text();
  if (typeof lineStart === "number" || typeof lineEnd === "number") {
    const lines = text.split("\n");
    const start = Math.max(0, (lineStart ?? 1) - 1);
    const end = Math.min(lines.length, lineEnd ?? lines.length);
    text = lines.slice(start, end).join("\n");
  }
  const truncated = text.length > 3000;
  return {
    path: cleanPath,
    content: truncated ? `${text.slice(0, 3000)}\n…(truncated)` : text,
    truncated,
  };
}

export async function submitFeedbackImpl(
  input: BuildSubmitFeedbackRowInput,
  sessionId: string,
): Promise<{ feedback_id: string }> {
  const sb = getSupabase();
  const row = buildSubmitFeedbackRow(input, sessionId);
  const { data, error } = await sb.from("feedback").insert(row).select("id").single();
  if (error) throw error;
  await sb
    .from("chat_sessions")
    .update({ status: "converted_to_feedback", summary: input.summary ?? input.title })
    .eq("id", sessionId);
  return { feedback_id: data!.id as string };
}

export function isAdminUser(telegramUserId: number): boolean {
  // If the allowlist is empty, default to "no one is admin" so the bot
  // is safe-by-default. Set MINIMIKI_ADMIN_USER_IDS in secrets to grant
  // code-reading access.
  return MINIMIKI_ADMIN_USER_IDS.has(telegramUserId);
}

/** Decide whether to handle this message at all.
 *  - `allow`        → process normally
 *  - `deny_silent`  → ignore (used in non-allowlisted groups so the bot
 *                     stays quiet)
 *  - `deny_dm`      → reply with a polite "not on the allowlist" message */
export function checkAccess(message: TelegramMessage): "allow" | "deny_silent" | "deny_dm" {
  const chatType = message.chat.type;
  const userId = message.from?.id;

  if (chatType === "private") {
    // DM: enforce user-id allowlist if it's configured.
    if (MINIMIKI_ALLOWED_USER_IDS.size === 0) return "allow";
    if (userId && MINIMIKI_ALLOWED_USER_IDS.has(userId)) return "allow";
    return "deny_dm";
  }

  if (chatType === "group" || chatType === "supergroup") {
    // Group: enforce chat-id allowlist if it's configured. Anyone in the
    // approved group can use the bot — we don't filter individual user
    // IDs in groups (would be painful to maintain).
    if (MINIMIKI_ALLOWED_CHAT_IDS.size === 0) return "allow";
    if (MINIMIKI_ALLOWED_CHAT_IDS.has(message.chat.id)) return "allow";
    return "deny_silent";
  }

  // Channels and unknown types: never respond.
  return "deny_silent";
}

function buildTools(sessionId: string, isAdmin: boolean) {
  const submitFeedback = tool({
    description:
      "Send a clean bug report or feature request to Miquel. Call this only after the user has confirmed they want the issue sent. After calling, briefly confirm with the user and stop.",
    parameters: z.object({
      type: z.enum(["bug", "feature"]),
      title: z.string().min(3).max(150),
      description: z.string().min(10).max(5000),
      frequency: z.enum(["once", "sometimes", "always"]).optional(),
      importance: z.enum(["nice_to_have", "important", "critical"]).optional(),
      summary: z.string().max(500).optional().describe(
        "One-sentence digest for Miquel's Telegram. Plain English, no jargon.",
      ),
      reporter_name: z.string().max(120).optional(),
    }),
    execute: (input) => submitFeedbackImpl(input as BuildSubmitFeedbackRowInput, sessionId),
  });

  if (!isAdmin) {
    // Non-admins never get repo-grep tools. They can still chat and file
    // bugs/features; questions about code are answered from the prose in
    // the system prompt only.
    return { submit_feedback: submitFeedback };
  }

  return {
    search_repo: tool({
      description:
        "Search the CompiFlow GitHub repo for code matching a query. Returns up to 5 file paths and snippets. Use this when you need to find where something lives in the code.",
      parameters: z.object({
        query: z.string().describe("The search query, e.g. 'download_clip provider cascade'."),
      }),
      execute: ({ query }) => searchRepoImpl(query),
    }),
    read_file: tool({
      description:
        "Read a file from the CompiFlow GitHub repo (default branch). Returns up to 3000 chars of content. Use for CHANGELOG, source files, docs.",
      parameters: z.object({
        path: z.string().describe("Repository-relative path, e.g. 'CHANGELOG.md' or 'src/App.tsx'."),
        lineStart: z.number().int().positive().optional().describe("Optional 1-based start line."),
        lineEnd: z.number().int().positive().optional().describe("Optional 1-based end line (inclusive)."),
      }),
      execute: ({ path, lineStart, lineEnd }) => readFileImpl(path, lineStart, lineEnd),
    }),
    submit_feedback: submitFeedback,
  };
}

// ── LLM call ─────────────────────────────────────────────────────────────

export interface LLMResult {
  text: string;
  toolCalls: Array<{ name: string; input: unknown; output?: unknown }>;
}

export interface CallLLMInput {
  system: string;
  history: CoreMessage[];
  userMessage: string;
  sessionId: string;
  isAdmin: boolean;
  /** Called with the cumulative assistant text every time new tokens arrive.
   *  Use this to push live updates to Telegram via debounced editMessageText. */
  onPartial?: (partialText: string) => void | Promise<void>;
}

export async function callLLM(input: CallLLMInput): Promise<LLMResult> {
  if (!MINIMIKI_API_KEY) {
    throw new Error("MINIMIKI_API_KEY is not set; cannot call LLM");
  }

  const provider = createOpenAICompatible({
    name: MINIMIKI_PROVIDER,
    apiKey: MINIMIKI_API_KEY,
    baseURL: MINIMIKI_BASE_URL,
  });

  const result = streamText({
    model: provider(MINIMIKI_MODEL),
    system: input.system,
    messages: [...input.history, { role: "user", content: input.userMessage }],
    tools: buildTools(input.sessionId, input.isAdmin),
    maxSteps: MAX_AGENT_STEPS,
  });

  let buffer = "";
  for await (const chunk of result.textStream) {
    buffer += chunk;
    if (input.onPartial) {
      try {
        await input.onPartial(buffer);
      } catch (err) {
        // Streaming UI failures must not abort the LLM call.
        console.error("[telegram-bot] onPartial error:", err);
      }
    }
  }

  const finalText = await result.text;
  const steps = await result.steps;

  const toolCalls: LLMResult["toolCalls"] = [];
  for (const step of steps ?? []) {
    const calls = (step as { toolCalls?: Array<{ toolName: string; args: unknown }> }).toolCalls ?? [];
    const results =
      (step as { toolResults?: Array<{ toolName: string; result: unknown }> }).toolResults ?? [];
    for (let i = 0; i < calls.length; i += 1) {
      toolCalls.push({
        name: calls[i].toolName,
        input: calls[i].args,
        output: results[i]?.result,
      });
    }
  }

  return { text: finalText, toolCalls };
}

// ── Conversation runtime ─────────────────────────────────────────────────

export interface RunConversationDeps {
  botUsername: string;
}

export async function runConversation(
  update: TelegramUpdate,
  deps: RunConversationDeps,
): Promise<void> {
  const message = update.message ?? update.edited_message;
  if (!message || !message.from) return;
  if (!shouldRespond(message, deps.botUsername)) return;

  const access = checkAccess(message);
  if (access === "deny_silent") return;
  if (access === "deny_dm") {
    await sendMessage(
      message.chat.id,
      "Sorry — MiniMiki is currently in private beta for the Quantastic team. " +
        "Ping Miquel (@miquel_tolosa) if you should have access.",
    );
    return;
  }

  const text = message.text?.trim() ?? "";

  // /new closes the active session.
  if (text === "/new" || text.startsWith("/new ")) {
    const existing = await findActiveSession(message.chat.id, message.from.id);
    if (existing) await closeSession(existing.id);
    await sendMessage(
      message.chat.id,
      "Started a fresh conversation. What's on your mind?",
    );
    return;
  }

  // /help — quick orientation.
  if (text === "/help") {
    await sendMessage(
      message.chat.id,
      [
        "*MiniMiki* — your CompiFlow assistant.",
        "",
        "I can:",
        "- Answer questions about how CompiFlow works.",
        "- Help you report a bug or suggest a feature (I'll send a clean summary to Miquel).",
        "",
        "Commands:",
        "`/new` — start a fresh conversation",
        "`/help` — show this message",
      ].join("\n"),
    );
    return;
  }

  // /start [token] — handoff or fresh greeting.
  const startCmd = parseStartCommand(text);
  if (startCmd) {
    await handleStartCommand({
      chatId: message.chat.id,
      user: message.from,
      chatType: message.chat.type,
      token: startCmd.token,
    });
    return;
  }

  // Find or create active session.
  const session = await findOrOpenSession({
    chatId: message.chat.id,
    user: message.from,
    chatType: message.chat.type,
  });

  // Drop the bot mention so the LLM sees clean text.
  const cleanText = stripBotMention(text, deps.botUsername);
  if (!cleanText) return;

  await sendChatAction(message.chat.id, "typing");
  await persistMessage({ sessionId: session.id, role: "user", content: cleanText });

  const placeholder = await sendMessage(message.chat.id, "…");
  const history = await loadConversationHistory(session.id);
  const isAdmin = isAdminUser(message.from.id);
  const ctx: PromptContext = {
    source: chatTypeToSource(message.chat.type),
    userName: displayName(message.from),
    isAdmin,
  };

  // Debounced streaming back to Telegram via editMessageText. Telegram's
  // edit-rate ceiling for one chat is roughly 1 edit/sec sustained, so we
  // flush at most every 700ms or when the buffer grows by 120+ chars
  // since the last flush — whichever comes first. The final, full text is
  // pushed once when the stream completes (regardless of debounce state).
  const STREAM_INTERVAL_MS = 700;
  const STREAM_CHAR_BUMP = 120;
  let lastEditAt = 0;
  let lastEditedLen = 0;
  let streamInFlight: Promise<void> = Promise.resolve();
  const streamFlush = (text: string): void => {
    const now = Date.now();
    const sinceLast = now - lastEditAt;
    const grewEnough = text.length - lastEditedLen >= STREAM_CHAR_BUMP;
    if (sinceLast < STREAM_INTERVAL_MS && !grewEnough) return;
    lastEditAt = now;
    lastEditedLen = text.length;
    const snapshot = text;
    streamInFlight = streamInFlight
      .then(() => editMessageText(message.chat.id, placeholder.message_id, snapshot))
      .catch((err) => console.error("[telegram-bot] streaming edit failed:", err));
  };

  let llmResult: LLMResult;
  try {
    llmResult = await callLLM({
      system: buildSystemPrompt(ctx),
      history: history.slice(0, -1), // drop the user message we just persisted (already passed via userMessage)
      userMessage: cleanText,
      sessionId: session.id,
      isAdmin,
      onPartial: streamFlush,
    });
    // Wait for any in-flight edit to settle before the final flush so we
    // don't race a stale partial over the final text.
    await streamInFlight;
  } catch (err) {
    const msg = err instanceof Error
      ? `${err.name}: ${err.message}`
      : (() => {
          try { return JSON.stringify(err, Object.getOwnPropertyNames(err as object)); }
          catch { return String(err); }
        })();
    console.error("[telegram-bot] LLM error:", msg, err);
    await editMessageText(
      message.chat.id,
      placeholder.message_id,
      "Something glitched on my end. Miquel will see this — please try again in a moment.",
    );
    await persistMessage({
      sessionId: session.id,
      role: "tool",
      toolName: "internal_error",
      toolOutput: { error: msg },
    });
    return;
  }

  const finalText = llmResult.text.trim() || "(no reply)";
  await editMessageText(message.chat.id, placeholder.message_id, finalText);
  await persistMessage({ sessionId: session.id, role: "assistant", content: finalText });
  for (const call of llmResult.toolCalls) {
    await persistMessage({
      sessionId: session.id,
      role: "tool",
      toolName: call.name,
      toolInput: call.input,
      toolOutput: call.output,
    });
  }
}

async function handleStartCommand(input: {
  chatId: number;
  user: TelegramUser;
  chatType: TelegramChat["type"];
  token?: string;
}): Promise<void> {
  // If there's already an open session, close it so /start always begins fresh.
  const existing = await findActiveSession(input.chatId, input.user.id);
  if (existing) await closeSession(existing.id);

  let handoff: HandoffRow | null = null;
  if (input.token) {
    try {
      handoff = await consumeHandoff(input.token);
    } catch {
      handoff = null;
    }
  }

  const session = await createSession({
    source: handoff ? "app_handoff" : chatTypeToSource(input.chatType),
    telegramChatId: input.chatId,
    telegramUserId: input.user.id,
    telegramUserName: displayName(input.user),
    appVersion: handoff?.context?.appVersion,
  });

  if (handoff?.context) {
    await persistMessage({
      sessionId: session.id,
      role: "tool",
      toolName: "app_handoff_context",
      toolOutput: handoff.context,
    });
  }

  const greeting = handoff
    ? buildHandoffGreeting(handoff)
    : FALLBACK_GREETING;

  const replyMarkup: ReplyMarkup = {
    inline_keyboard: [
      [{ text: "Report a problem", callback_data: "miniaction:bug" }],
      [{ text: "Suggest a feature", callback_data: "miniaction:feature" }],
      [{ text: "Just a question", callback_data: "miniaction:question" }],
    ],
  };

  if (handoff?.screenshot_url) {
    await sendChatAction(input.chatId, "upload_photo");
    await sendPhoto(input.chatId, handoff.screenshot_url, greeting, {
      reply_markup: replyMarkup,
    });
  } else {
    await sendMessage(input.chatId, greeting, { reply_markup: replyMarkup });
  }

  await persistMessage({
    sessionId: session.id,
    role: "assistant",
    content: greeting,
  });
}

function buildHandoffGreeting(handoff: HandoffRow): string {
  const ctx = handoff.context ?? {};
  const bits: string[] = [];
  if (ctx.page) bits.push(`the *${ctx.page}* page`);
  if (ctx.projectName) bits.push(`project *${ctx.projectName}*`);

  const where = bits.length ? ` on ${bits.join(" in ")}` : "";
  const errorBit = ctx.lastError
    ? `\n\nI noticed this recent error: \`${ctx.lastError.slice(0, 200)}\``
    : "";

  return [
    `Hey! I see you opened MiniMiki${where}.${errorBit}`,
    "",
    handoff.screenshot_url
      ? "I've also got the screenshot you sent — quote anything from it and I'll dig in."
      : "",
    "What can I help with: a question, a bug, or a feature idea?",
  ]
    .filter(Boolean)
    .join("\n");
}

async function findOrOpenSession(input: {
  chatId: number;
  user: TelegramUser;
  chatType: TelegramChat["type"];
}): Promise<ChatSessionRow> {
  const existing = await findActiveSession(input.chatId, input.user.id);
  if (existing) return existing;
  return createSession({
    source: chatTypeToSource(input.chatType),
    telegramChatId: input.chatId,
    telegramUserId: input.user.id,
    telegramUserName: displayName(input.user),
  });
}

