import { type ReactNode, useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AlertTriangle, ExternalLink, Loader2, RefreshCw, Sparkles, UserPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CreatorPicker } from "@/components/CreatorPicker";
import { HubSpotIcon, PlatformIcon, getPlatform } from "@/components/ClipCard";
import { IntegrityFixedPill } from "@/lib/data-integrity/components/IntegrityFixedPill";
import type { Clip, AppSettings } from "@/types";
import type { CreatorOption } from "@/lib/hubspot";
import { hubspotCreatorUrl } from "@/lib/hubspot-urls";
import {
  resolveCreatorFromClipUrl,
  matchCreatorsForHandle,
  createCreatorFromEnrichment,
  type EnrichedProfile,
  type CreatorMatch,
  type MatchConfidence,
} from "@/lib/creator-resolver";
import { classifyResolveError } from "@/lib/resolve-error-message";
import {
  MissingConfigNudge,
  type MissingConfigKind,
} from "@/components/MissingConfigNudge";
import { cn } from "@/lib/utils";

type PanelState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "resolved"; profile: EnrichedProfile; matches: CreatorMatch[] }
  | {
      kind: "error";
      message: string;
      /** When set, an inline `<MissingConfigNudge>` is rendered above the
       *  manual creator picker so the user can fix the underlying config. */
      nudge?: MissingConfigKind;
    }
  | { kind: "applied"; name: string }
  | { kind: "manual" };

const CONF_BADGE: Record<MatchConfidence, string> = {
  high: "border-emerald-200 bg-emerald-50 text-emerald-800",
  highish: "border-emerald-200/80 bg-emerald-50/80 text-emerald-900",
  medium: "border-amber-200 bg-amber-50 text-amber-900",
  low: "border-slate-200 bg-slate-50 text-slate-700",
};

const CONF_LABEL: Record<MatchConfidence, string> = {
  high: "exact",
  highish: "strong",
  medium: "verify",
  low: "weak",
};

const STRONG_MATCHES: ReadonlyArray<MatchConfidence> = ["high", "highish", "medium"];

function daysSinceResolved(ms: number | undefined): number {
  if (ms == null) return 0;
  return Math.max(0, Math.floor((Date.now() - ms) / 86_400_000));
}

/** Map our internal platform key (lowercase) to the display value `PlatformIcon` expects. */
const PLATFORM_DISPLAY: Record<string, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  douyin: "Douyin",
  bilibili: "Bilibili",
  xiaohongshu: "Xiaohongshu",
  kuaishou: "Kuaishou",
};

function platformDisplayFromKey(key: string): string {
  return PLATFORM_DISPLAY[key.toLowerCase()] ?? "Video";
}

/**
 * Platforms where the backend's live author resolver actually works.
 * Anything else (Xiaohongshu, Bilibili, Douyin, Kuaishou, Pinterest, …) goes
 * straight to the HubSpot manual picker — yt-dlp can't extract authors there
 * reliably, and the noisy errors aren't worth the cost.
 *
 * Compared case-insensitively against `getPlatform(url)`.
 */
const LIVE_RESOLVABLE_PLATFORMS: ReadonlySet<string> = new Set([
  "tiktok",
  "instagram",
  "youtube",
]);

function canLiveResolve(url: string): boolean {
  return LIVE_RESOLVABLE_PLATFORMS.has(getPlatform(url).toLowerCase());
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface UseCreatorSuggestionArgs {
  clip: Clip;
  token: string;
  settings: AppSettings;
  onLinked: (name: string) => void;
  onSuggestStart?: () => void;
}

export interface CreatorSuggestionUI {
  kind: PanelState["kind"];
  /** Compact element for the right-actions column of the integrity row. */
  trigger: ReactNode;
  /** Full-width element rendered below the row. `null` when compact is enough. */
  panel: ReactNode | null;
}

/**
 * Owns the creator suggestion state machine and returns split UI elements
 * (`trigger` for the compact right column, `panel` for the full-width
 * expanded section below the row).
 */
export function useCreatorSuggestion({
  clip,
  token,
  settings,
  onLinked,
  onSuggestStart,
}: UseCreatorSuggestionArgs): CreatorSuggestionUI {
  const [st, setSt] = useState<PanelState>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);

  const finalizeLink = useCallback(
    async (creatorId: string, name: string) => {
      await invoke("associate_clip_to_creator", {
        token,
        clipId: clip.id,
        creatorId,
      });
      setSt({ kind: "applied", name });
      onLinked(name);
    },
    [clip.id, onLinked, token],
  );

  const linkClipToCreator = useCallback(
    async (creatorId: string, name: string) => {
      setBusy(true);
      setActionErr(null);
      try {
        await finalizeLink(creatorId, name);
      } catch (e) {
        setActionErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [finalizeLink],
  );

  const runSuggest = useCallback(
    async (forceLive: boolean) => {
      if (!canLiveResolve(clip.link)) {
        setSt({ kind: "manual" });
        return;
      }
      setSt({ kind: "loading" });
      setActionErr(null);
      try {
        const profile = await resolveCreatorFromClipUrl(token, clip.id, clip.link, {
          socialkitApiKey: settings.socialkitApiKey,
          socialfetchApiKey: settings.socialfetchApiKey,
          cookiesBrowser: settings.cookiesBrowser,
          cookiesFile: settings.cookiesFile,
          forceLive,
        });
        const matches = await matchCreatorsForHandle(token, profile);
        setSt({ kind: "resolved", profile, matches });
      } catch (e) {
        // Classifier consumes the structured `ResolveCreatorError` JSON now
        // emitted by the Rust resolver and returns an actionable message.
        // See `src/lib/resolve-error-message.ts` for the rule set; it
        // notably stops blaming a missing SocialKit key when the failure was
        // upstream (gated post, rate limit, bad key, network).
        const classified = classifyResolveError(e);
        const nudge: MissingConfigKind | undefined =
          classified.kind === "needs_paid_fallback"
            ? "socialkit"
            : classified.kind === "needs_socialfetch"
              ? "socialfetch"
              : undefined;
        setSt({ kind: "error", message: classified.message, nudge });
      }
    },
    [
      clip.id,
      clip.link,
      settings.cookiesBrowser,
      settings.cookiesFile,
      settings.socialkitApiKey,
      settings.socialfetchApiKey,
      token,
    ],
  );

  const onCreateNew = useCallback(async () => {
    if (st.kind !== "resolved") return;
    setBusy(true);
    setActionErr(null);
    try {
      const created = await createCreatorFromEnrichment(token, st.profile);
      if (!created.id) {
        setActionErr("Create succeeded but HubSpot id missing.");
        return;
      }
      await finalizeLink(created.id, created.name || st.profile.handle);
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [finalizeLink, st, token]);

  const onManualPick = useCallback(
    (creator: CreatorOption | null) => {
      if (!creator) return;
      void linkClipToCreator(creator.id, creator.name);
    },
    [linkClipToCreator],
  );

  // ---- idle ---------------------------------------------------------------

  if (st.kind === "idle") {
    const liveResolvable = canLiveResolve(clip.link);
    return {
      kind: "idle" as const,
      trigger: (
        <div className="flex flex-col gap-1 sm:items-end">
          <div className="flex flex-wrap justify-end gap-1">
            {liveResolvable && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="h-7 cursor-pointer gap-1 text-[10px]"
                onClick={() => {
                  onSuggestStart?.();
                  void runSuggest(false);
                }}
              >
                <Sparkles className="h-3 w-3" />
                Suggest creator
              </Button>
            )}
            <CreatorPicker
              token={token}
              value={null}
              onChange={onManualPick}
              emptyButtonLabel={liveResolvable ? "Pick manually…" : "Pick creator…"}
            />
          </div>
        </div>
      ),
      panel: null,
    };
  }

  // ---- loading ------------------------------------------------------------

  if (st.kind === "loading") {
    return {
      kind: "loading" as const,
      trigger: (
        <span className="inline-flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Looking up author…
        </span>
      ),
      panel: null,
    };
  }

  // ---- applied ------------------------------------------------------------

  if (st.kind === "applied") {
    return {
      kind: "applied" as const,
      trigger: <IntegrityFixedPill label={`Fixed → ${st.name}`} />,
      panel: null,
    };
  }

  // ---- error --------------------------------------------------------------

  if (st.kind === "error") {
    return {
      kind: "error" as const,
      trigger: (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 cursor-pointer text-[11px] text-muted-foreground"
          onClick={() => setSt({ kind: "idle" })}
        >
          Dismiss
        </Button>
      ),
      panel: (
        <div className="relative flex w-full flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 shadow-sm">
          <button
            type="button"
            onClick={() => setSt({ kind: "idle" })}
            className="absolute right-2 top-2 flex h-6 w-6 cursor-pointer items-center justify-center rounded text-destructive/70 hover:bg-destructive/10 hover:text-destructive"
            title="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
          <div className="flex items-start gap-2 pr-6">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-destructive" />
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-medium text-destructive">
                Couldn't resolve creator automatically
              </p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-destructive/80">
                {st.message}
              </p>
            </div>
          </div>
          {st.nudge && (
            <MissingConfigNudge kind={st.nudge} className="text-[12px]" />
          )}
          <div className="rounded-md border border-border bg-background p-2.5">
            <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Pick a creator manually
            </p>
            <CreatorPicker
              token={token}
              value={null}
              onChange={onManualPick}
              emptyButtonLabel="Search HubSpot creators…"
            />
          </div>
        </div>
      ),
    };
  }

  // ---- resolved -----------------------------------------------------------

  if (st.kind === "resolved") {
    const p = st.profile;
    const hasStrong = st.matches.some((m) => STRONG_MATCHES.includes(m.confidence));
    const fromCache = p.source === "hubspot_cache" && p.cachedAt != null;

    return {
      kind: "resolved" as const,
      trigger: (
        <button
          type="button"
          onClick={() => setSt({ kind: "idle" })}
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Cancel"
        >
          <X className="h-4 w-4" />
        </button>
      ),
      panel: (
        <div className="relative flex w-full flex-col gap-3 rounded-lg border border-border bg-background p-4 shadow-sm text-left">
          <button
            type="button"
            onClick={() => setSt({ kind: "idle" })}
            className="absolute right-2 top-2 flex h-6 w-6 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Cancel"
          >
            <X className="h-3.5 w-3.5" />
          </button>
          {/* Header: who did we find? */}
          <div className="flex items-start gap-3 border-b border-border/60 pb-3 pr-6">
            <ProfileAvatar
              key={p.profileUrl}
              src={p.avatar}
              platform={platformDisplayFromKey(p.platform)}
              sizeClass="h-12 w-12"
              iconClass="h-6 w-6"
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[14px] font-semibold text-foreground">
                  @{p.handle}
                </span>
                {fromCache && (
                  <span className="inline-flex items-center gap-1">
                    <span className="rounded-full border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      Cached · {daysSinceResolved(p.cachedAt)}d
                    </span>
                    <button
                      type="button"
                      title="Re-resolve live (bypasses cache)"
                      onClick={() => {
                        void runSuggest(true);
                      }}
                      className="inline-flex cursor-pointer items-center rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={busy}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </button>
                  </span>
                )}
              </div>
              {p.displayName && (
                <p className="mt-0.5 text-[12px] text-muted-foreground">{p.displayName}</p>
              )}
              <a
                href={p.profileUrl}
                onClick={(e) => {
                  e.preventDefault();
                  void openUrl(p.profileUrl);
                }}
                className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-sky-700 hover:underline"
              >
                Open profile <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </div>

          {/* Matches */}
          {st.matches.length > 0 ? (
            <div className="flex flex-col gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {st.matches.length === 1
                  ? "Suggested match"
                  : `Suggested matches · ${st.matches.length}`}
              </p>
              <ul className="flex flex-col gap-1.5">
                {st.matches.map((m) => (
                  <MatchRow
                    key={m.creatorId}
                    match={m}
                    disabled={busy}
                    onApply={() => linkClipToCreator(m.creatorId, m.name)}
                  />
                ))}
              </ul>
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
              No existing creator matches this handle.
            </div>
          )}

          {actionErr && (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
              {actionErr}
            </p>
          )}

          {/* Footer actions */}
          <div className="flex flex-col gap-2 border-t border-border/60 pt-3 sm:flex-row sm:items-center sm:justify-between">
            {!hasStrong ? (
              <Button
                type="button"
                variant="default"
                size="sm"
                className="h-8 cursor-pointer gap-1.5 text-[11px]"
                disabled={busy}
                onClick={() => {
                  void onCreateNew();
                }}
              >
                <UserPlus className="h-3.5 w-3.5" />
                Create new Creator from @{p.handle}
              </Button>
            ) : (
              <span className="text-[11px] text-muted-foreground">
                Apply one of the suggested matches above.
              </span>
            )}
            <button
              type="button"
              onClick={() => setSt({ kind: "manual" })}
              className="cursor-pointer text-[11px] font-medium text-muted-foreground hover:text-foreground hover:underline"
            >
              None of these — pick manually
            </button>
          </div>
        </div>
      ),
    };
  }

  // ---- manual -------------------------------------------------------------

  if (st.kind === "manual") {
    return {
      kind: "manual" as const,
      trigger: (
        <button
          type="button"
          onClick={() => setSt({ kind: "idle" })}
          className="cursor-pointer text-[11px] font-medium text-muted-foreground hover:text-foreground hover:underline"
        >
          Back to Suggest
        </button>
      ),
      panel: (
        <div className="relative flex w-full flex-col gap-2 rounded-lg border border-border bg-background p-4 shadow-sm">
          <button
            type="button"
            onClick={() => setSt({ kind: "idle" })}
            className="absolute right-2 top-2 flex h-6 w-6 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Back to Suggest"
          >
            <X className="h-3.5 w-3.5" />
          </button>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground pr-6">
            Pick a creator manually
          </p>
          <CreatorPicker
            token={token}
            value={null}
            onChange={onManualPick}
            emptyButtonLabel="Search HubSpot creators…"
          />
        </div>
      ),
    };
  }

  // Exhaustiveness — all PanelState variants are handled above.
  return { kind: "idle" as const, trigger: null, panel: null };
}

// ---------------------------------------------------------------------------
// Backwards-compatible wrapper (renders trigger + panel inline)
// ---------------------------------------------------------------------------

interface Props {
  clip: Clip;
  token: string;
  settings: AppSettings;
  onLinked: (name: string) => void;
  onSuggestStart?: () => void;
}

export function CreatorSuggestionPanel({
  clip,
  token,
  settings,
  onLinked,
  onSuggestStart,
}: Props) {
  const { trigger, panel } = useCreatorSuggestion({
    clip,
    token,
    settings,
    onLinked,
    onSuggestStart,
  });
  return (
    <>
      {trigger}
      {panel}
    </>
  );
}

// ---------------------------------------------------------------------------
// Helper components
// ---------------------------------------------------------------------------

interface ProfileAvatarProps {
  src: string | undefined;
  platform: string;
  /** Tailwind size classes for the container. Defaults to "h-10 w-10" (40px). */
  sizeClass?: string;
  /** Tailwind size classes for the platform fallback icon. */
  iconClass?: string;
}

/** Square avatar with a platform-icon fallback when the URL is missing or fails to load. */
function ProfileAvatar({
  src,
  platform,
  sizeClass = "h-10 w-10",
  iconClass = "h-5 w-5",
}: ProfileAvatarProps) {
  const [failed, setFailed] = useState(false);
  const showImg = !!src && !failed;
  return (
    <div
      className={cn(
        "flex flex-shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/60 bg-muted",
        sizeClass,
      )}
    >
      {showImg ? (
        <img
          src={src}
          alt=""
          className="h-full w-full object-cover"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <PlatformIcon platform={platform} className={cn("text-muted-foreground/70", iconClass)} />
      )}
    </div>
  );
}

interface SocialLinkChipProps {
  url: string;
  /** Optional override; we usually infer from the URL. */
  platform?: string;
}

/** Tiny inline icon + truncated URL for one creator social link. */
function SocialLinkChip({ url, platform }: SocialLinkChipProps) {
  const platformName = platform ?? getPlatform(url);
  return (
    <button
      type="button"
      title={url}
      onClick={(e) => {
        e.stopPropagation();
        void openUrl(url);
      }}
      className="inline-flex max-w-full min-w-0 cursor-pointer items-center gap-1 rounded text-muted-foreground hover:text-foreground"
    >
      <PlatformIcon platform={platformName} className="h-3 w-3 flex-shrink-0" />
      <span className="truncate">{url}</span>
    </button>
  );
}

/** Build the deduped list of social links to render under a match name. */
function matchSocialLinks(m: CreatorMatch): Array<{ url: string; platform?: string }> {
  const seen = new Set<string>();
  const links: Array<{ url: string; platform?: string }> = [];
  const push = (url: string | undefined, platform?: string) => {
    if (!url) return;
    const key = url.trim().toLowerCase().replace(/\/+$/, "");
    if (!key || seen.has(key)) return;
    seen.add(key);
    links.push({ url, platform });
  };
  push(m.instagram, "Instagram");
  push(m.tiktok, "TikTok");
  push(m.mainLink);
  return links;
}

interface MatchRowProps {
  match: CreatorMatch;
  disabled: boolean;
  onApply: () => Promise<void> | void;
}

function MatchRow({ match: m, disabled, onApply }: MatchRowProps) {
  const links = matchSocialLinks(m);
  const crossLink =
    m.confidence === "medium" && m.otherPlatformUrl === "tiktok"
      ? m.tiktok
      : m.confidence === "medium" && m.otherPlatformUrl === "instagram"
        ? m.instagram
        : null;
  const crossLabel =
    m.otherPlatformUrl === "tiktok"
      ? "Open TikTok on file — verify same person"
      : "Open Instagram on file — verify same person";

  return (
    <li className="flex flex-row items-center justify-between gap-3 rounded-md border border-border/60 bg-card px-3 py-2 transition-colors hover:border-border hover:bg-muted/30">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[12px] font-semibold text-foreground">{m.name}</p>
          <Badge
            variant="outline"
            className={cn(
              "h-auto whitespace-normal text-left text-[10px] font-medium leading-tight",
              CONF_BADGE[m.confidence] ?? CONF_BADGE.low,
            )}
          >
            {(CONF_LABEL[m.confidence] ?? m.confidence)}: {m.reason}
          </Badge>
        </div>
        {links.length > 0 && (
          <ul className="mt-1 flex flex-col gap-0.5 text-[10px]">
            {links.map((l) => (
              <li key={l.url} className="min-w-0">
                <SocialLinkChip url={l.url} platform={l.platform} />
              </li>
            ))}
          </ul>
        )}
        {crossLink && (
          <p className="mt-1 text-[10px] text-amber-800">
            <button
              type="button"
              onClick={() => {
                void openUrl(crossLink);
              }}
              className="cursor-pointer underline hover:text-amber-900"
            >
              {crossLabel}
            </button>
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          size="sm"
          className="h-8 w-20 cursor-pointer text-[11px] font-medium"
          disabled={disabled}
          onClick={() => {
            void onApply();
          }}
        >
          Apply
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-8 w-8 shrink-0 cursor-pointer"
          title="Open creator in HubSpot"
          onClick={() => {
            void openUrl(hubspotCreatorUrl(m.creatorId));
          }}
        >
          <HubSpotIcon className="h-3.5 w-3.5" />
        </Button>
      </div>
    </li>
  );
}
