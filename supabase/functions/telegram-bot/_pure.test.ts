import { describe, expect, it } from "vitest";
import {
  buildSubmitFeedbackRow,
  chatTypeToSource,
  displayName,
  parseStartCommand,
  shouldRespond,
  stripBotMention,
} from "./_pure";

describe("buildSubmitFeedbackRow", () => {
  const sessionId = "11111111-1111-1111-1111-111111111111";

  it("links the inserted row back to the chat session", () => {
    const row = buildSubmitFeedbackRow(
      { type: "bug", title: "x", description: "y".repeat(20) },
      sessionId,
    );
    expect(row.chat_session_id).toBe(sessionId);
  });

  it("matches the feedback table schema (defaults + status='triaging')", () => {
    const row = buildSubmitFeedbackRow(
      {
        type: "feature",
        title: "Add a CSV export button",
        description: "Would be nice to have a one-click CSV export from the Arrange tab.",
        importance: "important",
        summary: "User wants a CSV export shortcut on Arrange",
      },
      sessionId,
    );

    expect(row).toEqual({
      type: "feature",
      title: "Add a CSV export button",
      description: "Would be nice to have a one-click CSV export from the Arrange tab.",
      frequency: null,
      importance: "important",
      reporter_name: null,
      screenshots: [],
      app_version: null,
      os_info: "via @minimiki_bot",
      status: "triaging",
      ai_response: { summary: "User wants a CSV export shortcut on Arrange" },
      chat_session_id: sessionId,
    });
  });

  it("clamps title to 150 chars and description to 5000 chars", () => {
    const row = buildSubmitFeedbackRow(
      { type: "bug", title: "a".repeat(300), description: "b".repeat(7000) },
      sessionId,
    );
    expect(row.title).toHaveLength(150);
    expect(row.description).toHaveLength(5000);
  });

  it("omits ai_response when no summary is given", () => {
    const row = buildSubmitFeedbackRow(
      { type: "bug", title: "x", description: "y".repeat(20) },
      sessionId,
    );
    expect(row.ai_response).toBeNull();
  });
});

describe("shouldRespond", () => {
  it("always replies in private chats", () => {
    expect(
      shouldRespond({ chat: { type: "private" }, text: "hi" }, "minimiki_bot"),
    ).toBe(true);
  });

  it("ignores groups unless the bot is mentioned, replied-to, or commanded", () => {
    expect(
      shouldRespond(
        { chat: { type: "group" }, text: "just chatting" },
        "minimiki_bot",
      ),
    ).toBe(false);
  });

  it("replies to a /command in groups", () => {
    expect(
      shouldRespond(
        { chat: { type: "supergroup" }, text: "/help" },
        "minimiki_bot",
      ),
    ).toBe(true);
  });

  it("replies when @mentioned in groups", () => {
    expect(
      shouldRespond(
        {
          chat: { type: "group" },
          text: "@minimiki_bot how do I download a clip?",
          entities: [{ type: "mention", offset: 0, length: 13 }],
        },
        "minimiki_bot",
      ),
    ).toBe(true);
  });

  it("replies when message is a reply to the bot in a group", () => {
    expect(
      shouldRespond(
        {
          chat: { type: "group" },
          text: "thanks",
          reply_to_message: { from: { username: "minimiki_bot" } },
        },
        "minimiki_bot",
      ),
    ).toBe(true);
  });
});

describe("stripBotMention", () => {
  it("removes the @mention so the LLM sees a clean question", () => {
    expect(
      stripBotMention("@minimiki_bot how do I add a clip?", "minimiki_bot"),
    ).toBe("how do I add a clip?");
  });

  it("is case-insensitive", () => {
    expect(stripBotMention("Hey @MiniMiki_Bot", "minimiki_bot")).toBe("Hey");
  });

  it("is a no-op without a username", () => {
    expect(stripBotMention("hi", "")).toBe("hi");
  });
});

describe("parseStartCommand", () => {
  it("extracts the handoff token from /start <token>", () => {
    expect(parseStartCommand("/start mm_abc12345")).toEqual({ token: "mm_abc12345" });
  });

  it("returns an empty object for /start with no token", () => {
    expect(parseStartCommand("/start")).toEqual({ token: undefined });
  });

  it("returns null for non-/start text", () => {
    expect(parseStartCommand("hello there")).toBeNull();
  });
});

describe("chatTypeToSource", () => {
  it("private → telegram_dm", () => {
    expect(chatTypeToSource("private")).toBe("telegram_dm");
  });
  it("group/supergroup → telegram_group", () => {
    expect(chatTypeToSource("group")).toBe("telegram_group");
    expect(chatTypeToSource("supergroup")).toBe("telegram_group");
  });
});

describe("displayName", () => {
  it("prefers first + last name", () => {
    expect(displayName({ id: 1, first_name: "Alex", last_name: "Lee" })).toBe("Alex Lee");
  });
  it("falls back to @username", () => {
    expect(displayName({ id: 1, username: "alexl" })).toBe("@alexl");
  });
  it("uses user_<id> as last resort", () => {
    expect(displayName({ id: 42 })).toBe("user_42");
  });
});
