/**
 * Smart classifier for resolve-creator failures.
 *
 * The Rust resolver (`src-tauri/src/resolver.rs`) returns a structured
 * `ResolveCreatorError` with per-step `attempts` (skipped vs failed +
 * reason). This module turns that into a single actionable message for the
 * UI, replacing the old hardcoded "Add a SocialKit key" string that fired
 * even when the real problem was an Instagram post gated to logged-in
 * viewers.
 *
 * Rule of thumb: report what the user can fix. If a step *failed* with
 * `needs_login`, tell them about cookies. If every paid step was *skipped*
 * because no API key is set, tell them about the keys. Don't blame missing
 * config when the issue was upstream.
 */

import type {
  ResolveAttempt,
  ResolveCreatorError,
} from "./creator-resolver";
import { parseResolveError } from "./creator-resolver";

export type ResolveErrorKind =
  | "platform_not_supported"
  | "needs_login"
  | "rate_limited"
  | "bad_api_key"
  | "needs_paid_fallback"
  | "needs_socialfetch"
  | "network"
  | "unknown";

export interface ClassifiedResolveError {
  /** Stable kind for analytics / tests. */
  kind: ResolveErrorKind;
  /** User-facing one-liner. Goes into the inline "error" state. */
  message: string;
  /** Optional structured payload — preserved for debugging / log surfacing. */
  raw: ResolveCreatorError | null;
}

/**
 * Classify a caught error from `resolve_creator_from_clip_url` into a
 * single user-facing message. Always returns a value — falls back to a
 * generic "couldn't look up author" string when the error shape is
 * unrecognised.
 */
export function classifyResolveError(err: unknown): ClassifiedResolveError {
  const parsed = parseResolveError(err);
  const fallbackMessage = (() => {
    if (err instanceof Error && err.message) return err.message;
    if (typeof err === "string" && err) return err;
    return "Couldn't look up author.";
  })();

  if (!parsed) {
    // Legacy / unstructured error — preserve old "unresolvable" behaviour
    // for safety, but stop telling people to add SocialKit when we're not
    // sure that's the right fix.
    const msg = fallbackMessage;
    if (msg === "unresolvable_url" || msg.includes("unresolvable")) {
      return {
        kind: "unknown",
        message:
          "Couldn't resolve this URL automatically. Pick the creator manually below.",
        raw: null,
      };
    }
    return { kind: "unknown", message: msg, raw: null };
  }

  if (parsed.code === "unresolvable_platform") {
    return {
      kind: "platform_not_supported",
      message:
        "This platform doesn't have a live author resolver — pick the creator manually below.",
      raw: parsed,
    };
  }

  // Walk the per-step attempt log in priority order: real failures with
  // actionable reasons trump skips.
  const failed = parsed.attempts.filter((a) => a.outcome === "failed");
  const skipped = parsed.attempts.filter((a) => a.outcome === "skipped");

  // 1. Rate limiting wins everything else — there's no point telling the
  //    user to add a key when the upstream API just told them to slow down.
  if (anyReasonStartsWith(failed, "rate_limited")) {
    return {
      kind: "rate_limited",
      message:
        "Hit a rate limit upstream. Wait a minute and try again, or pick the creator manually below.",
      raw: parsed,
    };
  }

  // 2. Bad / rejected API keys.
  if (anyReasonStartsWith(failed, "bad_api_key")) {
    const which =
      failed.find((a) => a.reason.startsWith("bad_api_key"))?.step ?? "API";
    const niceName = niceServiceName(which);
    return {
      kind: "bad_api_key",
      message: `Your ${niceName} key was rejected. Update it in Settings or pick the creator manually below.`,
      raw: parsed,
    };
  }

  // 3. The "logged-out gating" path. If something failed with
  //    needs_login AND ig_ytdlp_cookies was skipped (no cookies
  //    configured), the user can fix this for free by configuring a
  //    Browser for Cookies.
  const igYtdlpSkippedNoCookies = skipped.some(
    (a) => a.step === "ig_ytdlp_cookies" && a.reason === "no_cookies_configured",
  );
  const anythingSaysLoginRequired = anyReasonContains(failed, "needs_login");
  if (anythingSaysLoginRequired && igYtdlpSkippedNoCookies) {
    return {
      kind: "needs_login",
      message:
        "Instagram is gating this post to logged-in viewers. Open Settings and pick a Browser for Cookies (Chrome, Firefox, etc.) so we can see the post the way you do.",
      raw: parsed,
    };
  }
  if (anythingSaysLoginRequired) {
    return {
      kind: "needs_login",
      message:
        "This post is gated to logged-in viewers. We tried with your browser cookies but couldn't see the author — pick the creator manually below.",
      raw: parsed,
    };
  }

  // 4. Every paid fallback was skipped because no key was configured.
  //    Recommend whichever path is cheapest for the user (SocialKit IG-only,
  //    SocialFetch broader coverage).
  const socialkitSkippedNoKey = skipped.some(
    (a) => a.step === "ig_socialkit" && a.reason === "no_api_key",
  );
  const socialfetchSkippedNoKey = skipped.some(
    (a) => a.step === "socialfetch" && a.reason === "no_api_key",
  );
  if (socialkitSkippedNoKey && socialfetchSkippedNoKey) {
    return {
      kind: "needs_paid_fallback",
      message:
        "Free resolvers couldn't find this author. Add a SocialKit or SocialFetch key in Settings to enable the paid fallbacks, or pick manually below.",
      raw: parsed,
    };
  }
  if (socialkitSkippedNoKey) {
    return {
      kind: "needs_paid_fallback",
      message:
        "Free resolvers couldn't find this author. Add a SocialKit key in Settings to enable the paid Instagram fallback, or pick manually below.",
      raw: parsed,
    };
  }
  if (socialfetchSkippedNoKey) {
    return {
      kind: "needs_socialfetch",
      message:
        "Free resolvers couldn't find this author. Add a SocialFetch key in Settings to enable the paid fallback, or pick manually below.",
      raw: parsed,
    };
  }

  // 5. Network / 5xx / parse failures from any step.
  if (anyReasonStartsWith(failed, "network")) {
    return {
      kind: "network",
      message:
        "Network error talking to the resolver services. Check your connection and try again, or pick the creator manually below.",
      raw: parsed,
    };
  }

  // 6. Generic fallback. We tried everything and got back nothing useful.
  return {
    kind: "unknown",
    message:
      "Couldn't resolve this URL automatically. Pick the creator manually below.",
    raw: parsed,
  };
}

function anyReasonStartsWith(arr: ResolveAttempt[], prefix: string): boolean {
  return arr.some((a) => a.reason.startsWith(prefix));
}

function anyReasonContains(arr: ResolveAttempt[], needle: string): boolean {
  return arr.some((a) => a.reason.includes(needle));
}

function niceServiceName(step: string): string {
  if (step.startsWith("ig_socialkit") || step === "socialkit") return "SocialKit";
  if (step === "socialfetch") return "SocialFetch";
  return "API";
}
