import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CheckCircle2, ExternalLink, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CreatorPicker } from "@/components/CreatorPicker";
import { PlatformIcon, getPlatform } from "@/components/ClipCard";
import type { Clip, AppSettings } from "@/types";
import type { CreatorOption } from "@/lib/hubspot";
import {
  resolveCreatorFromClipUrl,
  matchCreatorsForHandle,
  createCreatorFromEnrichment,
  type EnrichedProfile,
  type CreatorMatch,
  type MatchConfidence,
} from "@/lib/creator-resolver";
import { cn } from "@/lib/utils";

type PanelState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "resolved"; profile: EnrichedProfile; matches: CreatorMatch[] }
  | { kind: "error"; message: string }
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
  const [st, setSt] = useState<PanelState>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);

  /** Pure side-effect: associate clip↔creator and transition into the "applied" state. */
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

  /** Wraps `finalizeLink` with the panel's busy/error UI for direct user actions. */
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
      // Unsupported networks (Xiaohongshu, Bilibili, Douyin, Kuaishou, Pinterest)
      // skip the live resolver entirely and drop straight into the HubSpot picker.
      if (!canLiveResolve(clip.link)) {
        setSt({ kind: "manual" });
        return;
      }
      setSt({ kind: "loading" });
      setActionErr(null);
      try {
        const profile = await resolveCreatorFromClipUrl(token, clip.id, clip.link, {
          socialkitApiKey: settings.socialkitApiKey,
          cookiesBrowser: settings.cookiesBrowser,
          cookiesFile: settings.cookiesFile,
          forceLive,
        });
        const matches = await matchCreatorsForHandle(token, profile);
        setSt({ kind: "resolved", profile, matches });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setSt({
          kind: "error",
          message:
            msg === "unresolvable_url" || msg.includes("unresolvable")
              ? "Couldn't resolve from public endpoints. Add a SocialKit key in Settings to enable the paid Instagram fallback, or pick manually below."
              : msg || "Failed to look up author.",
        });
      }
    },
    [
      clip.id,
      clip.link,
      settings.cookiesBrowser,
      settings.cookiesFile,
      settings.socialkitApiKey,
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

  if (st.kind === "applied") {
    return (
      <span className="inline-flex max-w-[220px] items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-800">
        <CheckCircle2 className="h-3 w-3 flex-shrink-0" />
        <span className="truncate">Fixed → {st.name}</span>
      </span>
    );
  }

  if (st.kind === "error") {
    return (
      <div className="flex w-full min-w-0 max-w-sm flex-col items-stretch gap-1.5">
        <p className="text-[10px] leading-tight text-destructive">{st.message}</p>
        <div className="flex flex-wrap gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 cursor-pointer text-[11px]"
            onClick={() => setSt({ kind: "idle" })}
          >
            Dismiss
          </Button>
        </div>
        <CreatorPicker
          token={token}
          value={null}
          onChange={onManualPick}
          emptyButtonLabel="Pick creator…"
        />
      </div>
    );
  }

  if (st.kind === "loading") {
    return (
      <span className="inline-flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Looking up author…
      </span>
    );
  }

  if (st.kind === "resolved") {
    const p = st.profile;
    const hasStrong = st.matches.some((m) => STRONG_MATCHES.includes(m.confidence));
    const fromCache = p.source === "hubspot_cache" && p.cachedAt != null;
    return (
      <div className="flex w-full min-w-0 max-w-lg flex-col gap-2 rounded-md border border-border/80 bg-card/30 p-2.5 text-left">
        <div className="flex min-w-0 items-start gap-2">
          <ProfileAvatar
            key={p.profileUrl}
            src={p.avatar}
            platform={platformDisplayFromKey(p.platform)}
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5 text-[12px] font-medium">
              <span>@{p.handle}</span>
              {fromCache && (
                <span className="inline-flex items-center gap-1 text-[10px] font-normal text-muted-foreground">
                  <span className="rounded-full border border-border bg-muted/40 px-1.5 py-0.5">
                    Cached · {daysSinceResolved(p.cachedAt)}d
                  </span>
                  <button
                    type="button"
                    title="Re-resolve live (bypasses cache)"
                    onClick={() => {
                      void runSuggest(true);
                    }}
                    className="inline-flex cursor-pointer rounded p-0.5 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={busy}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </button>
                </span>
              )}
            </div>
            {p.displayName && (
              <p className="text-[10px] text-muted-foreground">{p.displayName}</p>
            )}
            <a
              href={p.profileUrl}
              onClick={(e) => {
                e.preventDefault();
                void openUrl(p.profileUrl);
              }}
              className="mt-0.5 inline-flex items-center gap-0.5 text-[10px] text-sky-700 hover:underline"
            >
              Open profile <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </div>

        {st.matches.length > 0 && (
          <ul className="space-y-1.5">
            {st.matches.map((m) => (
              <MatchRow
                key={m.creatorId}
                match={m}
                disabled={busy}
                onApply={() => linkClipToCreator(m.creatorId, m.name)}
              />
            ))}
          </ul>
        )}

        {!hasStrong && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-7 text-[10px] cursor-pointer"
            disabled={busy}
            onClick={() => {
              void onCreateNew();
            }}
          >
            Create new Creator
          </Button>
        )}

        {actionErr && <p className="text-[10px] text-destructive">{actionErr}</p>}

        <div className="border-t border-border/40 pt-1.5">
          <button
            type="button"
            onClick={() => setSt({ kind: "manual" })}
            className="text-[10px] text-muted-foreground hover:text-foreground hover:underline"
          >
            None of these — pick manually
          </button>
        </div>
      </div>
    );
  }

  if (st.kind === "manual") {
    return (
      <div className="flex w-full min-w-0 max-w-sm flex-col gap-1.5">
        <CreatorPicker
          token={token}
          value={null}
          onChange={onManualPick}
          emptyButtonLabel="Pick creator…"
        />
        <button
          type="button"
          onClick={() => setSt({ kind: "idle" })}
          className="self-start text-[10px] text-muted-foreground hover:underline"
        >
          Back to Suggest
        </button>
      </div>
    );
  }

  const liveResolvable = canLiveResolve(clip.link);

  return (
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
  );
}

interface ProfileAvatarProps {
  src: string | undefined;
  platform: string;
}

/** Square avatar with a platform-icon fallback when the URL is missing or fails to load. */
function ProfileAvatar({ src, platform }: ProfileAvatarProps) {
  const [failed, setFailed] = useState(false);
  const showImg = !!src && !failed;
  return (
    <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center overflow-hidden rounded border border-border/60 bg-muted">
      {showImg ? (
        <img
          src={src}
          alt=""
          className="h-full w-full object-cover"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <PlatformIcon platform={platform} className="h-5 w-5 text-muted-foreground/70" />
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
    <li className="flex flex-col gap-0.5 rounded border border-border/50 bg-background/50 px-2 py-1.5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 text-[10px]">
        <p className="font-medium text-foreground">{m.name}</p>
        {links.length > 0 && (
          <ul className="mt-0.5 flex flex-col gap-0.5">
            {links.map((l) => (
              <li key={l.url} className="min-w-0">
                <SocialLinkChip url={l.url} platform={l.platform} />
              </li>
            ))}
          </ul>
        )}
        {crossLink && (
          <p className="mt-0.5 text-amber-800">
            <button
              type="button"
              onClick={() => {
                void openUrl(crossLink);
              }}
              className="underline"
            >
              {crossLabel}
            </button>
          </p>
        )}
        <Badge
          variant="outline"
          className={cn(
            "mt-1 h-4 text-[9px] font-medium",
            CONF_BADGE[m.confidence] ?? CONF_BADGE.low,
          )}
        >
          {(CONF_LABEL[m.confidence] ?? m.confidence)}: {m.reason}
        </Badge>
      </div>
      <Button
        type="button"
        size="sm"
        className="h-7 w-full shrink-0 text-[10px] sm:ml-2 sm:w-[72px]"
        disabled={disabled}
        onClick={() => {
          void onApply();
        }}
      >
        Apply
      </Button>
    </li>
  );
}
