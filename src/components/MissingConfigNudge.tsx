/**
 * Dismissible inline banner that nudges the user to set a missing piece of
 * configuration (SocialKit key, SocialFetch key, HubSpot owner email).
 *
 * ## Why
 *
 * The resolver and downloader cascades skip steps gracefully when their
 * config isn't set, but new users sometimes don't realise that *some* free
 * paths failed *because* they haven't configured the paid fallbacks yet.
 * This banner makes that link explicit without nagging.
 *
 * ## Dismissal model
 *
 * - One key per `kind` in `localStorage`.
 * - Dismissed timestamp is stored as ms since epoch.
 * - The banner re-appears after `RE_SHOW_AFTER_MS` (7 days) so the user
 *   gets a periodic reminder if they keep hitting the underlying problem.
 * - No central state, no sync — fully self-contained per kind.
 */
import { useCallback, useEffect, useState, type ReactElement } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type MissingConfigKind =
  | "socialkit"
  | "socialfetch"
  | "hubspot_owner_email";

export interface MissingConfigNudgeProps {
  kind: MissingConfigKind;
  /** Optional handler to open Settings — usually opens the settings dialog
   *  with the relevant section in focus. */
  onOpenSettings?: () => void;
  className?: string;
}

const RE_SHOW_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const STORAGE_PREFIX = "mc-nudge-dismissed-";

function storageKey(kind: MissingConfigKind): string {
  return `${STORAGE_PREFIX}${kind}`;
}

function isCurrentlyDismissed(kind: MissingConfigKind): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(storageKey(kind));
    if (!raw) return false;
    const ms = Number.parseInt(raw, 10);
    if (!Number.isFinite(ms)) return false;
    return Date.now() - ms < RE_SHOW_AFTER_MS;
  } catch {
    return false;
  }
}

const COPY: Record<MissingConfigKind, { title: string; body: string; cta: string }> = {
  socialkit: {
    title: "Add a SocialKit key to unlock the paid Instagram fallback",
    body: "Free Instagram resolution sometimes can't see the author (private profile, gated reel, etc.). A SocialKit key lets the app fall back to the paid /instagram/stats endpoint when free paths fail.",
    cta: "Open Settings",
  },
  socialfetch: {
    title: "Add a SocialFetch key for one more layer of fallback",
    body: "SocialFetch covers TikTok, Instagram, and YouTube creator resolution and TikTok / Instagram media download. It only runs when every cheaper path has already failed, so you never pay for a clip that resolved for free.",
    cta: "Open Settings",
  },
  hubspot_owner_email: {
    title: "Add your HubSpot owner email so new creators are assigned to you",
    body: "Without an owner email, creators we create from clip metadata won't be assigned to anyone in HubSpot. Set it once in Settings and forget about it.",
    cta: "Open Settings",
  },
};

export function MissingConfigNudge({
  kind,
  onOpenSettings,
  className,
}: MissingConfigNudgeProps): ReactElement | null {
  const [hidden, setHidden] = useState<boolean>(() => isCurrentlyDismissed(kind));

  // Refresh on mount in case localStorage changed (multi-window edits).
  useEffect(() => {
    setHidden(isCurrentlyDismissed(kind));
  }, [kind]);

  const dismiss = useCallback(() => {
    try {
      window.localStorage.setItem(storageKey(kind), String(Date.now()));
    } catch {
      /* localStorage unavailable — that's fine, banner just won't persist */
    }
    setHidden(true);
  }, [kind]);

  if (hidden) return null;

  const { title, body, cta } = COPY[kind];

  return (
    <div
      role="status"
      data-kind={kind}
      className={cn(
        "flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50/60 p-3 text-sm text-amber-900",
        className,
      )}
    >
      <div className="flex-1">
        <p className="font-medium" data-testid="missing-config-nudge-title">
          {title}
        </p>
        <p className="mt-1 text-amber-900/80">{body}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {onOpenSettings && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={onOpenSettings}
          >
            {cta}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label="Dismiss for 7 days"
          onClick={dismiss}
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}

/**
 * Test-only helper to clear a dismissal. Exposed so unit tests can reset
 * state without poking at localStorage internals.
 */
export function __clearMissingConfigNudgeDismissal(kind: MissingConfigKind): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(storageKey(kind));
  } catch {
    /* noop */
  }
}
