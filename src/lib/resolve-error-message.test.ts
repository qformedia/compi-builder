import { describe, expect, it } from "vitest";

import { classifyResolveError } from "./resolve-error-message";
import type { ResolveCreatorError } from "./creator-resolver";

/**
 * Build a Tauri-style caught error: an Error whose `.message` is the
 * JSON-encoded `ResolveCreatorError` returned by the Rust command. Mirrors
 * what `invoke()` actually rejects with.
 */
function caughtError(payload: ResolveCreatorError): Error {
  return new Error(JSON.stringify(payload));
}

describe("classifyResolveError", () => {
  it("returns platform_not_supported for unresolvable_platform code", () => {
    const out = classifyResolveError(
      caughtError({ code: "unresolvable_platform", attempts: [] }),
    );
    expect(out.kind).toBe("platform_not_supported");
    expect(out.message).toMatch(/manually/i);
  });

  it("recommends configuring cookies when IG is gated and ig_ytdlp_cookies was skipped", () => {
    // The exact bug from the user report: oEmbed/embed both 4xx (gated),
    // ig_ytdlp_cookies skipped because no cookies configured, and SocialKit
    // returns needs_login because IG also gates it.
    const payload: ResolveCreatorError = {
      code: "all_failed",
      attempts: [
        { step: "ig_oembed", outcome: "failed", reason: "http_404" },
        { step: "ig_embed", outcome: "failed", reason: "http_404" },
        {
          step: "ig_ytdlp_cookies",
          outcome: "skipped",
          reason: "no_cookies_configured",
        },
        {
          step: "ig_socialkit",
          outcome: "failed",
          reason: "needs_login: HTTP 404: media not found",
        },
      ],
    };
    const out = classifyResolveError(caughtError(payload));
    expect(out.kind).toBe("needs_login");
    expect(out.message).toMatch(/Browser for Cookies/i);
  });

  it("does not blame missing SocialKit key when SocialKit actually ran and failed", () => {
    // The original bug: the frontend always said "Add a SocialKit key" even
    // when the key was set and the call ran but came back needs_login.
    const payload: ResolveCreatorError = {
      code: "all_failed",
      attempts: [
        { step: "ig_oembed", outcome: "failed", reason: "http_404" },
        { step: "ig_embed", outcome: "failed", reason: "http_404" },
        { step: "ig_ytdlp_cookies", outcome: "failed", reason: "needs_login: …" },
        { step: "ig_socialkit", outcome: "failed", reason: "needs_login: HTTP 404: …" },
      ],
    };
    const out = classifyResolveError(caughtError(payload));
    expect(out.kind).toBe("needs_login");
    expect(out.message).not.toMatch(/SocialKit/i);
    expect(out.message).not.toMatch(/SocialFetch/i);
  });

  it("recommends adding both SocialKit and SocialFetch keys when both are skipped for missing keys", () => {
    const payload: ResolveCreatorError = {
      code: "all_failed",
      attempts: [
        { step: "ig_oembed", outcome: "failed", reason: "oembed_missing_author" },
        { step: "ig_embed", outcome: "failed", reason: "embed_missing_author" },
        { step: "ig_ytdlp_cookies", outcome: "skipped", reason: "no_cookies_configured" },
        { step: "ig_socialkit", outcome: "skipped", reason: "no_api_key" },
        { step: "socialfetch", outcome: "skipped", reason: "no_api_key" },
      ],
    };
    const out = classifyResolveError(caughtError(payload));
    expect(out.kind).toBe("needs_paid_fallback");
    expect(out.message).toMatch(/SocialKit/i);
    expect(out.message).toMatch(/SocialFetch/i);
  });

  it("singles out SocialKit when SocialFetch already has a key", () => {
    const payload: ResolveCreatorError = {
      code: "all_failed",
      attempts: [
        { step: "ig_oembed", outcome: "failed", reason: "http_500" },
        { step: "ig_embed", outcome: "failed", reason: "http_500" },
        { step: "ig_ytdlp_cookies", outcome: "skipped", reason: "no_cookies_configured" },
        { step: "ig_socialkit", outcome: "skipped", reason: "no_api_key" },
        { step: "socialfetch", outcome: "failed", reason: "unresolvable_data" },
      ],
    };
    const out = classifyResolveError(caughtError(payload));
    expect(out.kind).toBe("needs_paid_fallback");
    expect(out.message).toMatch(/SocialKit key/i);
    expect(out.message).not.toMatch(/SocialFetch/i);
  });

  it("handles bad_api_key as a top-priority error", () => {
    const payload: ResolveCreatorError = {
      code: "all_failed",
      attempts: [
        { step: "ig_oembed", outcome: "failed", reason: "http_403" },
        {
          step: "ig_socialkit",
          outcome: "failed",
          reason: "bad_api_key: HTTP 401: invalid",
        },
      ],
    };
    const out = classifyResolveError(caughtError(payload));
    expect(out.kind).toBe("bad_api_key");
    expect(out.message).toMatch(/SocialKit/i);
    expect(out.message).toMatch(/Settings/i);
  });

  it("handles rate_limited as a top-priority error", () => {
    const payload: ResolveCreatorError = {
      code: "all_failed",
      attempts: [
        { step: "ig_oembed", outcome: "failed", reason: "http_429" },
        {
          step: "socialfetch",
          outcome: "failed",
          reason: "rate_limited: HTTP 429: too many",
        },
      ],
    };
    const out = classifyResolveError(caughtError(payload));
    expect(out.kind).toBe("rate_limited");
    expect(out.message).toMatch(/rate limit/i);
  });

  it("falls back to network message for plain network errors", () => {
    const payload: ResolveCreatorError = {
      code: "all_failed",
      attempts: [
        { step: "ig_oembed", outcome: "failed", reason: "network: timeout" },
        { step: "ig_embed", outcome: "failed", reason: "network: timeout" },
      ],
    };
    const out = classifyResolveError(caughtError(payload));
    expect(out.kind).toBe("network");
    expect(out.message).toMatch(/network/i);
  });

  it("returns generic 'manual picker' message when nothing was actionable", () => {
    const payload: ResolveCreatorError = {
      code: "all_failed",
      attempts: [
        { step: "ig_oembed", outcome: "failed", reason: "oembed_missing_author" },
        { step: "ig_embed", outcome: "failed", reason: "embed_missing_author" },
      ],
    };
    const out = classifyResolveError(caughtError(payload));
    expect(out.kind).toBe("unknown");
    expect(out.message).toMatch(/manually/i);
  });

  it("handles legacy unstructured 'unresolvable_url' string from old backends", () => {
    const out = classifyResolveError(new Error("unresolvable_url"));
    expect(out.kind).toBe("unknown");
    expect(out.message).toMatch(/manually/i);
    // Crucially: does NOT mention SocialKit, which was the buggy old behaviour.
    expect(out.message).not.toMatch(/SocialKit/i);
  });

  it("preserves arbitrary string errors as the message", () => {
    const out = classifyResolveError(new Error("Network is offline"));
    expect(out.kind).toBe("unknown");
    expect(out.message).toBe("Network is offline");
  });

  it("handles caught non-Error values gracefully", () => {
    const out = classifyResolveError("just a string");
    expect(out.kind).toBe("unknown");
    expect(out.message).toBe("just a string");
  });
});
