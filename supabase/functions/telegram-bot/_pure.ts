// Pure helpers for the MiniMiki Telegram bot.
//
// This file MUST stay free of Deno-specific imports (`npm:`,
// `https://deno.land/...`, `Deno.env.get`, etc.) so it can be exercised
// from vitest under Node alongside the Deno runtime in production.

export type ChatType = "private" | "group" | "supergroup" | "channel";
export type SessionSource = "telegram_dm" | "telegram_group" | "app_handoff";

export interface PureUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface PureMessageEntity {
  type: string;
  offset: number;
  length: number;
}

export interface PureMessage {
  text?: string;
  entities?: PureMessageEntity[];
  chat: { type: ChatType };
  reply_to_message?: { from?: { username?: string } };
}

export function shouldRespond(message: PureMessage, botUsername: string): boolean {
  const chatType = message.chat.type;
  if (chatType === "private") return true;
  if (chatType !== "group" && chatType !== "supergroup") return false;

  const text = message.text ?? "";
  if (text.startsWith("/")) return true;
  if (message.reply_to_message?.from?.username === botUsername) return true;

  if (message.entities && botUsername) {
    const mention = `@${botUsername}`;
    for (const entity of message.entities) {
      if (entity.type !== "mention") continue;
      const slice = text.slice(entity.offset, entity.offset + entity.length);
      if (slice.toLowerCase() === mention.toLowerCase()) return true;
    }
  }
  return false;
}

export function stripBotMention(text: string, botUsername: string): string {
  if (!botUsername) return text;
  const mention = new RegExp(`@${botUsername}\\b`, "ig");
  return text.replace(mention, "").trim();
}

export function parseStartCommand(text: string): { token?: string } | null {
  if (!text.startsWith("/start")) return null;
  const parts = text.split(/\s+/);
  return { token: parts[1] };
}

export function chatTypeToSource(chatType: ChatType): SessionSource {
  if (chatType === "private") return "telegram_dm";
  return "telegram_group";
}

export function displayName(user: PureUser): string {
  const parts = [user.first_name, user.last_name].filter(Boolean);
  if (parts.length) return parts.join(" ");
  if (user.username) return `@${user.username}`;
  return `user_${user.id}`;
}

export interface BuildSubmitFeedbackRowInput {
  type: "bug" | "feature";
  title: string;
  description: string;
  frequency?: "once" | "sometimes" | "always";
  importance?: "nice_to_have" | "important" | "critical";
  summary?: string;
  reporter_name?: string;
}

export interface SubmitFeedbackRow {
  type: "bug" | "feature";
  title: string;
  description: string;
  frequency: "once" | "sometimes" | "always" | null;
  importance: "nice_to_have" | "important" | "critical" | null;
  reporter_name: string | null;
  screenshots: string[];
  app_version: null;
  os_info: string;
  status: "triaging";
  ai_response: { summary: string } | null;
  chat_session_id: string;
}

/** Build the exact row shape we INSERT into `public.feedback`. Pure so the
 *  shape is locked down by tests and stays in sync with the migration. */
export function buildSubmitFeedbackRow(
  input: BuildSubmitFeedbackRowInput,
  sessionId: string,
): SubmitFeedbackRow {
  return {
    type: input.type,
    title: input.title.slice(0, 150),
    description: input.description.slice(0, 5000),
    frequency: input.frequency ?? null,
    importance: input.importance ?? null,
    reporter_name: input.reporter_name ?? null,
    screenshots: [],
    app_version: null,
    os_info: "via @minimiki_bot",
    status: "triaging",
    ai_response: input.summary ? { summary: input.summary } : null,
    chat_session_id: sessionId,
  };
}
