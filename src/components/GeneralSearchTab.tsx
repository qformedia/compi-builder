import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { saveSession, getSessions, type ClipSessionRecord } from "@/lib/clip-sessions";
import { checkAllUrls, type UrlComplianceResult } from "@/lib/url-compliance";
import { listExcludedOwners } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Loader2,
  ExternalLink,
  CheckCircle,
  AlertCircle,
  UserPlus,
  Pencil,
  Trash2,
  X,
  Instagram,
  Music2,
  Clipboard,
  ClipboardCheck,
  Copy,
  ArrowRight,
  AlertTriangle,
  Download,
  ChevronDown,
  ChevronRight,
  History,
  RefreshCw,
} from "lucide-react";
import type { AppSettings } from "@/types";
import { TagPicker } from "@/components/TagPicker";
import { fetchTagOptions, fetchCreatorTagOptions, type TagOption } from "@/lib/tags";

interface ParsedEntry {
  url: string;
  platform: "instagram" | "tiktok";
  handle: string | null;
  profileUrl: string | null;
}

type CreatorStatus = "pending" | "resolving" | "existing" | "new" | "failed";

interface ClipEntry {
  url: string;
  platform: "instagram" | "tiktok";
  handle: string | null;
  displayName: string | null;
  profileUrl: string | null;
  creatorStatus: CreatorStatus;
  creatorId: string | null;
  creatorName: string | null;
  /** Tags currently set on the matched HubSpot creator (existing-creator only).
   * Empty array means HubSpot returned the creator with no tags; null means
   * we have not looked them up yet (new creator or pre-resolution state). */
  existingCreatorTags: string[] | null;
  // Metadata from resolution
  caption: string | null;
  thumbnail: string | null;
  // Metrics (may come from handle resolution for IG via yt-dlp)
  likes: number | null;
  comments: number | null;
  views: number | null;
  shares: number | null;
  timestamp: number | null;
  metricsSource: string | null;
  // Editing state
  manualHandle: string;
  // Pre-existing clip (found during resolve phase)
  existingClipId: string | null;
  // Post-creation
  clipId: string | null;
  created: boolean;
  createError: string | null;
  // Metrics fetch status
  metricStatus: "idle" | "fetching" | "done" | "failed";
  metricError: string | null;
}

type Phase = "input" | "review" | "creating" | "done";

type SearchType = "General Search" | "Specific Search";
/**
 * Controls how the creator-tag picker is applied during a Specific Search run.
 *
 * - `new_untagged` (default): tag newly created creators, and existing
 *   creators whose `tags` property is empty. Existing creators that already
 *   have any tag are left untouched.
 * - `append_all`: append the selected tags to every creator (new + existing),
 *   merging with whatever they already have. Never overwrites.
 */
type CreatorTagMode = "new_untagged" | "append_all";

interface Props {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

/**
 * Two-button segmented control for picking the HubSpot "Found in" value.
 * Rendered with `shrink-0` so it stays visible when the parent flex column
 * is forced to shrink at smaller window heights.
 */
function SearchTypeToggle({
  value,
  onChange,
}: {
  value: SearchType;
  onChange: (next: SearchType) => void;
}) {
  const options: Array<{ key: SearchType; activeBg: string }> = [
    { key: "General Search", activeBg: "bg-[rgb(106,120,209)]" },
    { key: "Specific Search", activeBg: "bg-[rgb(0,164,189)]" },
  ];
  return (
    <div className="flex w-full shrink-0 rounded-md overflow-hidden border bg-muted">
      {options.map(({ key, activeBg }, i) => {
        const active = value === key;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            className={`flex-1 px-3 py-2 text-xs font-medium cursor-pointer transition-colors ${
              i > 0 ? "border-l" : ""
            } ${
              active
                ? `${activeBg} text-white`
                : "bg-background text-foreground hover:bg-accent"
            }`}
          >
            {key}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Compact two-pill toggle that picks how creator tags are applied during the
 * run. Mirrors `SearchTypeToggle`'s shape but rendered smaller so it fits on
 * the same row as the creator-picker label without dominating it.
 */
function CreatorTagModeToggle({
  value,
  onChange,
}: {
  value: CreatorTagMode;
  onChange: (next: CreatorTagMode) => void;
}) {
  const options: Array<{ key: CreatorTagMode; label: string; title: string }> = [
    {
      key: "new_untagged",
      label: "New + untagged",
      title: "Tag new creators and existing creators with no tags.",
    },
    {
      key: "append_all",
      label: "Append to all",
      title: "Append the selected tags to every creator (new and existing).",
    },
  ];
  return (
    <div className="flex shrink-0 rounded-md overflow-hidden border bg-muted text-[10px] leading-none">
      {options.map(({ key, label, title }, i) => {
        const active = value === key;
        return (
          <button
            key={key}
            type="button"
            title={title}
            onClick={() => onChange(key)}
            className={`px-2 py-1 font-medium cursor-pointer transition-colors ${
              i > 0 ? "border-l" : ""
            } ${
              active
                ? "bg-[rgb(0,164,189)] text-white"
                : "bg-background text-foreground hover:bg-accent"
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

const PlatformIcon = ({ platform, className }: { platform: string; className?: string }) =>
  platform === "instagram"
    ? <Instagram className={className ?? "h-4 w-4 text-pink-500"} />
    : <Music2 className={className ?? "h-4 w-4 text-cyan-500"} />;

/**
 * Lets the user verify a creator handle without opening the heavy Instagram
 * profile page in their default browser. Instagram profile pages are known
 * to leak memory in Chrome; the popover shows the resolved name, thumbnail,
 * caption, and metrics so most verifications can stay in-app. The external
 * profile link is kept as a deemphasized escape hatch.
 */
function HandleVerifyPopover({ entry }: { entry: ClipEntry }) {
  const { handle, displayName, profileUrl, thumbnail, caption, likes, views, comments, platform } = entry;
  const hasMetrics = likes != null || views != null || comments != null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="text-xs font-medium hover:underline cursor-pointer truncate max-w-[120px] text-left"
          title={`Verify @${handle}`}
        >
          @{handle}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3" align="start">
        <div className="flex gap-2.5">
          <div className="w-14 h-14 rounded bg-muted flex-shrink-0 overflow-hidden flex items-center justify-center">
            {thumbnail ? (
              <img src={thumbnail} alt="" className="h-full w-full object-cover" />
            ) : (
              <PlatformIcon platform={platform} className="h-5 w-5 text-muted-foreground" />
            )}
          </div>
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex items-center gap-1.5 min-w-0">
              <PlatformIcon platform={platform} className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="text-sm font-medium truncate">@{handle}</span>
            </div>
            {displayName && (
              <p className="text-[11px] text-muted-foreground truncate">{displayName}</p>
            )}
            {hasMetrics && (
              <div className="flex flex-wrap gap-x-2 text-[10px] text-muted-foreground">
                {likes != null && <span>{likes.toLocaleString()} likes</span>}
                {views != null && <span>{views.toLocaleString()} views</span>}
                {comments != null && <span>{comments.toLocaleString()} comments</span>}
              </div>
            )}
          </div>
        </div>
        {caption && (
          <p className="mt-2 text-[11px] text-muted-foreground line-clamp-3 leading-snug whitespace-pre-wrap">
            {caption}
          </p>
        )}
        {profileUrl && (
          <div className="mt-3 flex items-center justify-end border-t pt-2">
            <button
              type="button"
              onClick={() => openUrl(profileUrl)}
              className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground cursor-pointer"
              title="Open profile in your default browser"
            >
              <ExternalLink className="h-3 w-3" />
              Open profile externally
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function GeneralSearchTab({ settings, onSettingsChange }: Props) {
  const [rawUrls, setRawUrls] = useState("");
  const [entries, setEntries] = useState<ClipEntry[]>([]);
  const [phase, setPhase] = useState<Phase>("input");
  const [resolving, setResolving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createProgress, setCreateProgress] = useState({ current: 0, total: 0 });
  const [metricsFetching, setMetricsFetching] = useState(false);
  const [metricsProgress, setMetricsProgress] = useState({ current: 0, total: 0 });
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const [existingClipsModalOpen, setExistingClipsModalOpen] = useState(false);
  const [pendingResolve, setPendingResolve] = useState<ClipEntry[] | null>(null);
  const [complianceModalOpen, setComplianceModalOpen] = useState(false);
  const [complianceResults, setComplianceResults] = useState<{ fixed: UrlComplianceResult[]; invalid: UrlComplianceResult[] } | null>(null);
  const [complianceFixedRaw, setComplianceFixedRaw] = useState<string | null>(null);
  const [emailDraft, setEmailDraft] = useState("");
  const [emailResolving, setEmailResolving] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [owners, setOwners] = useState<Array<{ id: string; email: string; firstName: string; lastName: string }>>([]);
  const [selectedOwnerId, setSelectedOwnerId] = useState(settings.ownerId || "");
  const [searchType, setSearchType] = useState<SearchType>("General Search");
  const [sessionTags, setSessionTags] = useState<string[]>([]);
  const [tagOptions, setTagOptions] = useState<TagOption[]>([]);
  const [sessionCreatorTags, setSessionCreatorTags] = useState<string[]>([]);
  const [creatorTagOptions, setCreatorTagOptions] = useState<TagOption[]>([]);
  const [creatorTagMode, setCreatorTagMode] = useState<CreatorTagMode>("new_untagged");
  const [sessionHistory, setSessionHistory] = useState<ClipSessionRecord[]>([]);
  const [historyVisible, setHistoryVisible] = useState(5);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const historyLoaded = useRef(false);

  // Monotonic "session token". Bumped at every point that starts a fresh
  // entries session (`continueAfterCompliance`, `handleReset`). Long-running
  // async loops in this file snapshot it once and short-circuit before each
  // `setEntries`/progress write or further RPC if the ref has moved on,
  // preventing a previous batch's loop from stomping the current entries
  // (see bug: 21-clip IG batch resolve-phase flip).
  const runIdRef = useRef(0);

  interface LatestClip {
    id: string;
    link: string;
    creatorName: string | null;
    /** HubSpot object creation time — primary sort key for "latest" */
    createDate: string | null;
    dateFound: string | null;
    thumbnail: string | null;
    caption: string | null;
    likes: string | null;
    views: string | null;
  }
  const [latestInsta, setLatestInsta] = useState<LatestClip | null>(null);
  const [latestTiktok, setLatestTiktok] = useState<LatestClip | null>(null);
  const [latestLoading, setLatestLoading] = useState(false);
  const [copiedLatestLabel, setCopiedLatestLabel] = useState<string | null>(null);

  const copyLatestLink = useCallback(async (link: string, label: string) => {
    try {
      await navigator.clipboard.writeText(link);
      setCopiedLatestLabel(label);
      setTimeout(
        () => setCopiedLatestLabel((cur) => (cur === label ? null : cur)),
        2000,
      );
    } catch {
      // Clipboard writes can fail in some webview contexts; silently ignore.
    }
  }, []);

  const token = settings.hubspotToken;

  useEffect(() => {
    if (!token) return;
    Promise.all([
      invoke<Array<{ id: string; email: string; firstName: string; lastName: string }>>("list_owners", { token }),
      listExcludedOwners().catch(() => []),
    ]).then(([all, excluded]) => {
      const excludedIds = new Set(excluded.map((e) => e.ownerId));
      setOwners(all.filter((o) => !excludedIds.has(o.id)));
    }).catch(() => {});
  }, [token]);

  useEffect(() => {
    if (settings.ownerId) setSelectedOwnerId(settings.ownerId);
  }, [settings.ownerId]);

  useEffect(() => {
    if (!token) return;
    fetchTagOptions(token)
      .then(setTagOptions)
      .catch((err) => {
        console.error("[GeneralSearchTab] fetchTagOptions failed:", err);
      });
    fetchCreatorTagOptions(token)
      .then(setCreatorTagOptions)
      .catch((err) => {
        console.error("[GeneralSearchTab] fetchCreatorTagOptions failed:", err);
      });
  }, [token]);

  useEffect(() => {
    if (!historyLoaded.current) {
      historyLoaded.current = true;
      setSessionHistory(getSessions());
    }
  }, []);

  const handleSearchTypeChange = useCallback((next: SearchType) => {
    setSearchType(next);
    if (next === "General Search") {
      setSessionTags([]);
      setSessionCreatorTags([]);
      setCreatorTagMode("new_untagged");
    }
  }, []);

  const sessionTagLabels = useMemo(
    () =>
      sessionTags.map(
        (value) => tagOptions.find((o) => o.value === value)?.label ?? value,
      ),
    [sessionTags, tagOptions],
  );

  /**
   * Applied to the clip TagPicker. Whenever the clip selection changes AND
   * the creator picker is empty, pre-select the subset of clip tags whose
   * label also exists in the creator-tag taxonomy. Matching is case- and
   * whitespace-insensitive on label, since `Creators.tags` and
   * `External Clips.tags` are independent HubSpot enums whose internal
   * values can drift even when the human-facing label is identical.
   *
   * Once the creator picker has any tag (synced or manual), syncing stops —
   * the user is in control. If they clear the creator picker back to empty,
   * the next clip-tag change re-syncs.
   */
  const handleSessionTagsChange = useCallback((next: string[]) => {
    setSessionTags(next);
    if (sessionCreatorTags.length !== 0) return;
    if (next.length === 0) return;
    const clipLabelByValue = new Map(
      tagOptions.map((o) => [o.value, o.label.trim().toLowerCase()]),
    );
    const creatorByLabel = new Map(
      creatorTagOptions.map((o) => [o.label.trim().toLowerCase(), o.value]),
    );
    const overlap: string[] = [];
    for (const v of next) {
      const label = clipLabelByValue.get(v);
      if (!label) continue;
      const creatorValue = creatorByLabel.get(label);
      if (creatorValue && !overlap.includes(creatorValue)) {
        overlap.push(creatorValue);
      }
    }
    if (overlap.length > 0) setSessionCreatorTags(overlap);
  }, [sessionCreatorTags, tagOptions, creatorTagOptions]);

  const loadLatestClips = useCallback(async () => {
    if (!token) {
      setLatestInsta(null);
      setLatestTiktok(null);
      setLatestLoading(false);
      return;
    }
    setLatestLoading(true);

    const parseClip = (data: { results?: Array<{ id: string; properties: Record<string, string | null> }> }): LatestClip | null => {
      const r = data.results?.[0];
      if (!r) return null;
      const p = r.properties;
      return {
        id: r.id,
        link: p.link ?? "",
        creatorName: p.creator_name ?? null,
        createDate: p.hs_createdate ?? null,
        dateFound: p.date_found ?? null,
        thumbnail: p.fetched_social_thumbnail ?? null,
        caption: p.social_media_caption ?? null,
        likes: p.likes ?? null,
        views: p.plays ?? null,
      };
    };

    try {
      const [insta, tiktok] = await Promise.all([
        invoke<{ results?: Array<{ id: string; properties: Record<string, string | null> }> }>("search_latest_clips_by_platform", {
          token, foundIn: "General Search", linkContains: "instagram",
        }).then(parseClip).catch(() => null),
        invoke<{ results?: Array<{ id: string; properties: Record<string, string | null> }> }>("search_latest_clips_by_platform", {
          token, foundIn: "General Search", linkContains: "tiktok",
        }).then(parseClip).catch(() => null),
      ]);
      setLatestInsta(insta);
      setLatestTiktok(tiktok);
    } finally {
      setLatestLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void loadLatestClips();
  }, [loadLatestClips]);

  const continueAfterCompliance = useCallback(async (urlText: string) => {
    // New session — invalidate any in-flight resolve/create/metrics loop
    // from the previous batch so it can't write back into our entries.
    runIdRef.current += 1;

    const parsed: ParsedEntry[] = await invoke("parse_clip_urls", { raw: urlText });
    if (parsed.length === 0) return;

    const newEntries: ClipEntry[] = parsed.map((p) => ({
      url: p.url,
      platform: p.platform,
      handle: p.handle,
      displayName: null,
      profileUrl: p.profileUrl,
      creatorStatus: "pending",
      creatorId: null,
      creatorName: null,
      existingCreatorTags: null,
      caption: null,
      thumbnail: null,
      likes: null,
      comments: null,
      views: null,
      shares: null,
      timestamp: null,
      metricsSource: null,
      manualHandle: "",
      existingClipId: null,
      clipId: null,
      created: false,
      createError: null,
      metricStatus: "idle",
      metricError: null,
    }));

    setEntries(newEntries);
    setPhase("review");

    setResolving(true);
    const checked = await checkExistingClips(newEntries);
    const existingCount = checked.filter((e) => e.existingClipId).length;

    if (existingCount > 0) {
      setEntries(checked);
      setPendingResolve(checked);
      setExistingClipsModalOpen(true);
      setResolving(false);
      return;
    }

    await resolveHandlesAndCreators(checked);
    setResolving(false);
  }, [token, settings]);

  const handleParse = useCallback(async () => {
    if (!rawUrls.trim()) return;

    const lines = rawUrls.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    const results = checkAllUrls(lines);

    const fixed = results.filter((r) => r.status === "fixed");
    const invalid = results.filter((r) => r.status === "invalid");

    const validLines = results
      .filter((r) => r.status === "ok" || r.status === "fixed")
      .map((r) => r.fixedUrl);

    if (validLines.length === 0 && invalid.length > 0) {
      setComplianceResults({ fixed, invalid });
      setComplianceFixedRaw(null);
      setComplianceModalOpen(true);
      return;
    }

    const fixedRaw = validLines.join("\n");

    if (fixed.length > 0 || invalid.length > 0) {
      setComplianceResults({ fixed, invalid });
      setComplianceFixedRaw(fixedRaw);
      setComplianceModalOpen(true);
      return;
    }

    await continueAfterCompliance(fixedRaw);
  }, [rawUrls, continueAfterCompliance]);

  const handleComplianceContinue = useCallback(async () => {
    setComplianceModalOpen(false);
    if (complianceFixedRaw) {
      await continueAfterCompliance(complianceFixedRaw);
    }
    setComplianceResults(null);
    setComplianceFixedRaw(null);
  }, [complianceFixedRaw, continueAfterCompliance]);

  const checkExistingClips = async (items: ClipEntry[]): Promise<ClipEntry[]> => {
    const updated = [...items];
    for (let i = 0; i < updated.length; i++) {
      try {
        const existing: { found: boolean; id?: string } = await invoke("find_clip_by_link", {
          token,
          link: updated[i].url,
        });
        if (existing.found && existing.id) {
          updated[i] = { ...updated[i], existingClipId: existing.id };
        }
      } catch { /* ignore lookup errors, will create as normal */ }
    }
    return updated;
  };

  const handleExistingClipsRemove = async () => {
    if (!pendingResolve) return;
    const filtered = pendingResolve.filter((e) => !e.existingClipId);
    setExistingClipsModalOpen(false);
    setPendingResolve(null);

    if (filtered.length === 0) {
      setEntries([]);
      setPhase("input");
      return;
    }

    setEntries(filtered);
    setResolving(true);
    await resolveHandlesAndCreators(filtered);
    setResolving(false);
  };

  const handleExistingClipsKeep = async () => {
    if (!pendingResolve) return;
    setExistingClipsModalOpen(false);
    const items = pendingResolve;
    setPendingResolve(null);
    setResolving(true);
    await resolveHandlesAndCreators(items);
    setResolving(false);
  };

  const resolveHandlesAndCreators = async (items: ClipEntry[]) => {
    // Snapshot the session token. If a new batch starts (handleReset /
    // continueAfterCompliance bump runIdRef), we silently abandon every
    // remaining iteration and skip every state write — otherwise the
    // stale loop would overwrite the new batch's entries with this one's.
    const myRun = runIdRef.current;
    const isStale = () => runIdRef.current !== myRun;

    const updated = [...items];
    if (isStale()) return;
    setEntries([...updated]);

    // Resolve Instagram handles only for non-existing clips
    for (let i = 0; i < updated.length; i++) {
      if (isStale()) return;
      const entry = updated[i];
      if (entry.existingClipId) continue;
      if (entry.platform === "instagram" && !entry.handle) {
        updated[i] = { ...updated[i], creatorStatus: "resolving" };
        if (isStale()) return;
        setEntries([...updated]);

        try {
          const info: {
            handle: string;
            profileUrl: string;
            displayName?: string;
            caption?: string;
            thumbnail?: string;
            source: string;
            likes?: number;
            comments?: number;
            views?: number;
            timestamp?: number;
          } = await invoke("resolve_instagram_info", {
            url: entry.url,
            cookiesBrowser: settings.cookiesBrowser || null,
            cookiesFile: settings.cookiesFile || null,
          });

          updated[i] = {
            ...updated[i],
            handle: info.handle,
            displayName: info.displayName ?? null,
            profileUrl: info.profileUrl,
            caption: info.caption ?? null,
            thumbnail: info.thumbnail ?? null,
            likes: info.likes ?? null,
            comments: info.comments ?? null,
            views: info.views ?? null,
            timestamp: info.timestamp ?? null,
            metricsSource: info.source === "ytdlp" ? "ytdlp" : null,
            creatorStatus: "pending",
          };
        } catch {
          updated[i] = { ...updated[i], creatorStatus: "failed" };
        }
        if (isStale()) return;
        setEntries([...updated]);
      }
    }

    // Lookup creators by platform (skip existing clips)
    const byPlatform: Record<string, { indices: number[]; profileUrls: string[] }> = {};
    for (let i = 0; i < updated.length; i++) {
      const entry = updated[i];
      if (entry.existingClipId) continue;
      if (!entry.profileUrl || entry.creatorStatus === "failed") continue;
      if (!byPlatform[entry.platform]) {
        byPlatform[entry.platform] = { indices: [], profileUrls: [] };
      }
      byPlatform[entry.platform].indices.push(i);
      byPlatform[entry.platform].profileUrls.push(entry.profileUrl);
    }

    for (const platform of Object.keys(byPlatform)) {
      if (isStale()) return;
      const { indices, profileUrls } = byPlatform[platform];
      // Deduplicate profile URLs for lookup
      const uniqueUrls = [...new Set(profileUrls)];

      try {
        const result: {
          results: Array<{
            profileUrl: string;
            found: boolean;
            creatorId?: string;
            name?: string;
            status?: string;
            tags?: string[];
          }>;
        } = await invoke("lookup_creators_by_social", {
          token,
          platform,
          profileUrls: uniqueUrls,
        });

        const lookupMap = new Map(
          result.results.map((r) => [r.profileUrl, r]),
        );

        for (const idx of indices) {
          const entry = updated[idx];
          if (!entry.profileUrl) continue;
          const lookup = lookupMap.get(entry.profileUrl);
          if (lookup?.found) {
            updated[idx] = {
              ...updated[idx],
              creatorStatus: "existing",
              creatorId: lookup.creatorId ?? null,
              creatorName: lookup.name ?? null,
              existingCreatorTags: Array.isArray(lookup.tags) ? lookup.tags : [],
            };
          } else {
            updated[idx] = {
              ...updated[idx],
              creatorStatus: "new",
              creatorName: updated[idx].handle,
              existingCreatorTags: null,
            };
          }
        }
      } catch {
        for (const idx of indices) {
          if (updated[idx].creatorStatus === "pending") {
            updated[idx] = { ...updated[idx], creatorStatus: "new" };
          }
        }
      }
      if (isStale()) return;
      setEntries([...updated]);
    }
  };

  const handleEditHandle = (index: number, newHandle: string) => {
    const updated = [...entries];
    const platform = updated[index].platform;
    const profileUrl = platform === "tiktok"
      ? `https://www.tiktok.com/@${newHandle}`
      : `https://www.instagram.com/${newHandle}/`;

    updated[index] = {
      ...updated[index],
      handle: newHandle,
      profileUrl,
      manualHandle: "",
      creatorStatus: "pending",
    };
    setEntries(updated);
    setEditingIndex(null);

    // Re-lookup this single creator. Snapshot the session token so a
    // late lookup from a previous batch can't write into a new session.
    const myRun = runIdRef.current;
    (async () => {
      try {
        const result: {
          results: Array<{
            profileUrl: string;
            found: boolean;
            creatorId?: string;
            name?: string;
            tags?: string[];
          }>;
        } = await invoke("lookup_creators_by_social", {
          token,
          platform,
          profileUrls: [profileUrl],
        });
        if (runIdRef.current !== myRun) return;
        const lookup = result.results[0];
        const reUpdated = [...entries];
        reUpdated[index] = {
          ...updated[index],
          creatorStatus: lookup?.found ? "existing" : "new",
          creatorId: lookup?.creatorId ?? null,
          creatorName: lookup?.found ? (lookup.name ?? newHandle) : newHandle,
          existingCreatorTags: lookup?.found
            ? (Array.isArray(lookup.tags) ? lookup.tags : [])
            : null,
        };
        setEntries(reUpdated);
      } catch { /* leave as pending */ }
    })();
  };

  const removeEntry = (index: number) => {
    setEntries((prev) => prev.filter((_, i) => i !== index));
  };

  const handleCreateAll = () => {
    if (!selectedOwnerId) {
      setEmailDraft(settings.ownerEmail);
      setEmailError(null);
      setEmailModalOpen(true);
      return;
    }
    runCreateAll(selectedOwnerId);
  };

  const handleEmailConfirm = async () => {
    const email = emailDraft.trim();
    if (!email) return;
    setEmailResolving(true);
    setEmailError(null);
    try {
      const id = await invoke<string>("resolve_owner_id", { token, email });
      onSettingsChange({ ...settings, ownerEmail: email, ownerId: id });
      setSelectedOwnerId(id);
      setEmailModalOpen(false);
      runCreateAll(id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setEmailError(msg);
    } finally {
      setEmailResolving(false);
    }
  };

  const runCreateAll = async (ownerId: string) => {
    // Snapshot the session token; if it moves we abandon the loop and
    // never call fetchMetadataForCreated for an abandoned batch.
    const myRun = runIdRef.current;
    const isStale = () => runIdRef.current !== myRun;

    setCreating(true);
    setPhase("creating");
    const updated = [...entries];
    const total = updated.length;
    setCreateProgress({ current: 0, total });

    // Group entries by unique profile URL to avoid creating duplicate creators
    const creatorMap = new Map<string, string>(); // profileUrl -> creatorId
    // Tracks which creators have already had their tags applied this run
    // so multi-clip sessions referencing the same creator don't double-PATCH.
    const creatorTaggedSet = new Set<string>();

    // Pre-populate with existing creators
    for (const entry of updated) {
      if (entry.creatorStatus === "existing" && entry.profileUrl && entry.creatorId) {
        creatorMap.set(entry.profileUrl, entry.creatorId);
      }
    }

    const isSpecificSearch = searchType === "Specific Search";
    const hasCreatorTags = isSpecificSearch && sessionCreatorTags.length > 0;

    for (let i = 0; i < updated.length; i++) {
      if (isStale()) return;
      const entry = updated[i];
      try {
        let creatorId = entry.profileUrl ? creatorMap.get(entry.profileUrl) : null;
        const wasNewCreator = entry.creatorStatus === "new";

        // Create creator if new and not already created for another clip
        if (!creatorId && wasNewCreator && entry.profileUrl && entry.handle) {
          const created: { id: string; name: string } = await invoke("create_creator", {
            token,
            name: entry.displayName || entry.handle,
            platform: entry.platform,
            profileUrl: entry.profileUrl,
            ownerId: null,
            ...(hasCreatorTags ? { tags: sessionCreatorTags } : {}),
          });
          creatorId = created.id;
          creatorMap.set(entry.profileUrl, creatorId);
          if (hasCreatorTags) {
            creatorTaggedSet.add(creatorId);
          }
        }

        // Apply session creator tags to existing HubSpot creators per the
        // selected mode. Skip if this creator was tagged already in this
        // run (e.g. it appears on multiple clips) or if no tags selected.
        if (
          hasCreatorTags &&
          creatorId &&
          !wasNewCreator &&
          !creatorTaggedSet.has(creatorId)
        ) {
          const existingTags = entry.existingCreatorTags ?? [];
          let nextTags: string[] | null = null;

          if (creatorTagMode === "new_untagged") {
            if (existingTags.length === 0) {
              nextTags = [...sessionCreatorTags];
            }
          } else {
            // append_all: merge existing + selected, dropping duplicates
            // (case-insensitive on the value to be safe with HubSpot's
            // own casing differences between properties).
            const seen = new Set<string>();
            const merged: string[] = [];
            for (const t of existingTags) {
              const key = t.trim().toLowerCase();
              if (!key || seen.has(key)) continue;
              seen.add(key);
              merged.push(t);
            }
            for (const t of sessionCreatorTags) {
              const key = t.trim().toLowerCase();
              if (!key || seen.has(key)) continue;
              seen.add(key);
              merged.push(t);
            }
            // Skip the PATCH when the merge would be a no-op.
            if (merged.length !== existingTags.length) {
              nextTags = merged;
            }
          }

          if (nextTags && nextTags.length > 0) {
            try {
              await invoke("update_creator_properties", {
                token,
                creatorId,
                properties: { tags: nextTags.join(";") },
              });
            } catch { /* best-effort creator tag update */ }
          }
          creatorTaggedSet.add(creatorId);
        }

        // Use existing clip or create new one
        let clipId: string;
        const alreadyExisted = !!entry.existingClipId;
        if (alreadyExisted) {
          // Pre-existing clips are linked only — session tags are not applied.
          clipId = entry.existingClipId!;
        } else {
          const clipResult: { id: string; link: string } = await invoke("create_external_clip", {
            token,
            link: entry.url,
            ownerId,
            foundIn: searchType,
            ...(searchType === "Specific Search" && sessionTags.length > 0
              ? { tags: sessionTags }
              : {}),
          });
          clipId = clipResult.id;
        }

        // Associate clip to creator (safe to call even if already associated)
        if (creatorId && clipId) {
          await invoke("associate_clip_to_creator", {
            token,
            clipId,
            creatorId,
          });
        }

        updated[i] = {
          ...updated[i],
          clipId,
          created: true,
          createError: alreadyExisted ? "Already existed — linked to creator" : null,
          creatorId: creatorId ?? updated[i].creatorId,
        };
      } catch (err) {
        updated[i] = {
          ...updated[i],
          createError: err instanceof Error ? err.message : String(err),
        };
      }

      if (isStale()) return;
      setCreateProgress({ current: i + 1, total });
      setEntries([...updated]);

      // Small delay between creates
      if (i < updated.length - 1) {
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    if (isStale()) return;
    setCreating(false);
    setPhase("done");

    // Async metadata fetch for all created clips. Skip when stale — the
    // user moved on and the metadata loop would otherwise stomp the new
    // batch's entries with this one's `updated` array.
    if (!isStale()) {
      fetchMetadataForCreated(updated);
    }
  };

  const fetchMetadataForCreated = async (items: ClipEntry[]) => {
    // Snapshot the session token. Every entries write is also routed
    // through a clipId-keyed functional update (defense-in-depth): even
    // if a stale callback slips past the guard, it can only touch the
    // entries whose clipId still matches, never replace the whole array.
    const myRun = runIdRef.current;
    const isStale = () => runIdRef.current !== myRun;

    setMetricsFetching(true);
    const updated = [...items];
    const eligible = updated.filter((e) => e.clipId && e.created && !e.existingClipId);
    if (isStale()) return;
    setMetricsProgress({ current: 0, total: eligible.length });
    let processed = 0;

    for (let i = 0; i < updated.length; i++) {
      if (isStale()) return;
      const entry = updated[i];
      if (!entry.clipId || !entry.created) continue;
      if (entry.existingClipId) continue;

      const targetClipId = entry.clipId;
      updated[i] = { ...updated[i], metricStatus: "fetching" };
      if (isStale()) return;
      setEntries((prev) =>
        prev.map((e) => (e.clipId === targetClipId ? { ...e, metricStatus: "fetching" } : e)),
      );

      try {
        let metrics: {
          displayName?: string | null;
          caption?: string | null;
          thumbnail?: string | null;
          likes?: number | null;
          comments?: number | null;
          views?: number | null;
          shares?: number | null;
          timestamp?: number | null;
        } | null = entry.metricsSource === "ytdlp"
          ? {
              caption: entry.caption,
              thumbnail: entry.thumbnail,
              likes: entry.likes,
              comments: entry.comments,
              views: entry.views,
              shares: entry.shares,
              timestamp: entry.timestamp,
            }
          : null;

        if (!metrics) {
          metrics = await invoke("fetch_clip_metrics", {
            url: entry.url,
            cookiesBrowser: settings.cookiesBrowser || null,
            cookiesFile: settings.cookiesFile || null,
          });
        }

        if (metrics) {
          const props: Record<string, string> = {};
          if (metrics.caption) props.social_media_caption = metrics.caption;
          if (metrics.likes != null) props.likes = String(metrics.likes);
          if (metrics.comments != null) props.comments = String(metrics.comments);
          if (metrics.views != null) props.plays = String(metrics.views);
          if (metrics.shares != null) props.shares = String(metrics.shares);
          if (metrics.timestamp) {
            props.posted_date = new Date(metrics.timestamp * 1000).toISOString().split("T")[0];
          }

          if (!props.social_media_caption && entry.caption) {
            props.social_media_caption = entry.caption;
          }

          const captionForTags = props.social_media_caption || entry.caption;
          if (captionForTags) {
            const hashtags = [...captionForTags.matchAll(/#([A-Za-z0-9_]+)/g)]
              .map((m) => m[1]);
            if (hashtags.length > 0) {
              props.social_media_tags = hashtags.join(";");
            }
          }

          if (Object.keys(props).length > 0) {
            await invoke("update_clip_properties", {
              token,
              clipId: entry.clipId,
              properties: props,
            });
          }

          if (metrics.displayName && !entry.displayName && entry.creatorId && entry.creatorStatus === "new") {
            try {
              await invoke("update_creator_properties", {
                token,
                creatorId: entry.creatorId,
                properties: { name: metrics.displayName },
              });
            } catch { /* best-effort update */ }
          }

          updated[i] = {
            ...updated[i],
            displayName: metrics.displayName ?? entry.displayName,
            caption: metrics.caption ?? entry.caption,
            likes: metrics.likes ?? entry.likes,
            comments: metrics.comments ?? entry.comments,
            views: metrics.views ?? entry.views,
            shares: metrics.shares ?? entry.shares,
            metricStatus: "done",
          };
        } else {
          updated[i] = { ...updated[i], metricStatus: "done" };
        }
      } catch (err) {
        updated[i] = { ...updated[i], metricStatus: "failed", metricError: err instanceof Error ? err.message : String(err) };
      }

      processed++;
      if (isStale()) return;
      setMetricsProgress({ current: processed, total: eligible.length });
      const patch = updated[i];
      setEntries((prev) =>
        prev.map((e) => (e.clipId === targetClipId ? { ...e, ...patch } : e)),
      );
    }

    if (isStale()) return;
    setMetricsFetching(false);

    // Persist session to local history
    const sessionClips = updated
      .filter((e) => e.clipId && e.created)
      .map((e) => {
        const captionText = e.caption ?? null;
        let tags: string | null = null;
        if (captionText) {
          const hashtags = [...captionText.matchAll(/#([A-Za-z0-9_]+)/g)].map((m) => m[1]);
          if (hashtags.length > 0) tags = hashtags.join(";");
        }
        return {
          clipId: e.clipId!,
          link: e.url,
          platform: e.platform,
          handle: e.handle,
          profileUrl: e.profileUrl,
          creatorId: e.creatorId,
          creatorName: e.creatorName ?? e.handle,
          creatorMainLink: e.profileUrl,
          caption: captionText,
          likes: e.likes,
          comments: e.comments,
          views: e.views,
          shares: e.shares,
          postedDate: e.timestamp ? new Date(e.timestamp * 1000).toISOString().split("T")[0] : null,
          socialMediaTags: tags,
          foundIn: searchType,
          existedAlready: !!e.existingClipId,
          ...(searchType === "Specific Search" && sessionTagLabels.length > 0 && !e.existingClipId
            ? { appliedTags: sessionTagLabels }
            : {}),
        };
      });

    // Only persist the session and refresh "Latest" cards when this run
    // is still the active one. An abandoned batch silently drops its
    // session record so it doesn't add a phantom row to "Recent Sessions".
    if (isStale()) return;
    if (sessionClips.length > 0) {
      saveSession({
        id: String(Date.now()),
        date: new Date().toISOString(),
        searchType,
        clipCount: sessionClips.length,
        clips: sessionClips,
      });
      setSessionHistory(getSessions());
    }
    void loadLatestClips();
  };

  const handleReset = () => {
    // Invalidate any in-flight loop before clearing state, otherwise its
    // next `setEntries([...updated])` would re-populate the cleared list
    // with the previous batch.
    runIdRef.current += 1;
    setRawUrls("");
    setEntries([]);
    setPhase("input");
    setCreateProgress({ current: 0, total: 0 });
    setSessionTags([]);
  };

  const readyToCreate = entries.length > 0
    && entries.every((e) => e.creatorStatus !== "resolving" && e.creatorStatus !== "pending")
    && !resolving;

  const failedEntries = entries.filter((e) => e.creatorStatus === "failed");
  const newCreators = entries.filter((e) => e.creatorStatus === "new");
  const existingCreators = entries.filter((e) => e.creatorStatus === "existing");
  const existingClips = entries.filter((e) => e.existingClipId);
  const newClips = entries.filter((e) => !e.existingClipId);
  // "done" phase counters
  const clipsCreated = entries.filter((e) => e.created && !e.existingClipId).length;
  const clipsExisted = entries.filter((e) => e.created && e.existingClipId).length;
  const creatorsCreated = entries.filter((e) => e.created && e.creatorStatus === "new").length;
  const creatorsExisted = entries.filter((e) => e.created && e.creatorStatus === "existing").length;
  const errorCount = entries.filter((e) => e.createError && !e.created).length;
  const metricsDone = entries.filter((e) => e.metricStatus === "done").length;
  const metricsFailed = entries.filter((e) => e.metricStatus === "failed").length;

  const StatusBadge = ({ status }: { status: CreatorStatus }) => {
    switch (status) {
      case "resolving":
        return <Badge variant="outline" className="gap-1"><Loader2 className="h-3 w-3 animate-spin" />Resolving</Badge>;
      case "existing":
        return <Badge variant="secondary" className="gap-1 text-green-700 bg-green-100 dark:bg-green-900/30 dark:text-green-400"><CheckCircle className="h-3 w-3" />Existing</Badge>;
      case "new":
        return <Badge variant="secondary" className="gap-1 text-blue-700 bg-blue-100 dark:bg-blue-900/30 dark:text-blue-400"><UserPlus className="h-3 w-3" />New</Badge>;
      case "failed":
        return <Badge variant="destructive" className="gap-1"><AlertCircle className="h-3 w-3" />Failed</Badge>;
      default:
        return <Badge variant="outline">Pending</Badge>;
    }
  };

  return (
    <div className="flex flex-col h-full p-4 gap-4">
      {phase === "input" && (
        <div className="flex flex-col gap-5 w-full px-6 pt-8 overflow-y-auto flex-1 min-h-0 [&>*]:shrink-0">
          <div className="space-y-2">
            <h2 className="text-lg font-semibold">Create Clips</h2>
            <p className="text-sm text-muted-foreground max-w-prose">
              Paste Instagram and TikTok clip URLs (one per line). The app will extract artist handles, check HubSpot for existing creators, and create everything for you.
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="urls">Clip URLs</Label>
            <Textarea
              id="urls"
              placeholder={"https://www.instagram.com/reel/ABC123/\nhttps://www.tiktok.com/@artist/video/789..."}
              value={rawUrls}
              onChange={(e) => setRawUrls(e.target.value)}
              rows={12}
              className="font-mono text-xs"
            />
            {rawUrls.trim() && (() => {
              const urlCount = rawUrls.trim().split("\n").filter((l) => l.trim()).length;
              return (
                <p className="text-xs text-muted-foreground">
                  {urlCount} URL{urlCount === 1 ? "" : "s"} detected
                </p>
              );
            })()}
          </div>

          <SearchTypeToggle value={searchType} onChange={handleSearchTypeChange} />

          {searchType === "Specific Search" && (
            <div className="rounded-lg border bg-muted/30 p-4 space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="grid gap-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Clip tags
                  </p>
                  <TagPicker
                    variant="inline"
                    options={tagOptions}
                    selected={sessionTags}
                    onChange={handleSessionTagsChange}
                  />
                  <p className="text-xs text-muted-foreground leading-snug">
                    Only newly created clips will be tagged. Existing clips found in HubSpot are left as-is.
                  </p>
                </div>
                <div className="grid gap-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Creator tags
                  </p>
                  <TagPicker
                    variant="inline"
                    options={creatorTagOptions}
                    selected={sessionCreatorTags}
                    onChange={setSessionCreatorTags}
                  />
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground leading-snug min-w-0">
                      {creatorTagMode === "new_untagged"
                        ? "New creators and existing creators with no tags will be tagged."
                        : "Selected tags will be appended to every creator (new and existing)."}
                    </p>
                    <CreatorTagModeToggle
                      value={creatorTagMode}
                      onChange={setCreatorTagMode}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="flex">
            <Button
              onClick={handleParse}
              disabled={!rawUrls.trim() || !token}
              variant="create"
              className="cursor-pointer w-fit"
            >
              <Clipboard className="mr-2 h-4 w-4" />
              Process URLs
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </div>

          {!token && (
            <p className="text-xs text-destructive">Set your HubSpot token in Settings first.</p>
          )}

          {/* Latest ingested clips */}
          {(latestInsta || latestTiktok || latestLoading) && (
            <div className="mt-4 border-t pt-4 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium">Latest General Search Clips</h3>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 cursor-pointer"
                  onClick={() => void loadLatestClips()}
                  disabled={latestLoading}
                  title="Refresh latest clips"
                >
                  {latestLoading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
              {latestLoading ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" /> Loading...
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { clip: latestInsta, label: "Instagram", icon: <Instagram className="h-3.5 w-3.5 text-pink-500" /> },
                    { clip: latestTiktok, label: "TikTok", icon: <Music2 className="h-3.5 w-3.5 text-cyan-500" /> },
                  ].map(({ clip, label, icon }) =>
                    clip ? (
                      <div
                        key={label}
                        className="flex gap-2.5 rounded-md border p-2 text-left"
                      >
                        <div className="w-14 h-14 rounded bg-muted flex-shrink-0 overflow-hidden flex items-center justify-center">
                          {clip.thumbnail ? (
                            <img src={clip.thumbnail} alt="" className="h-full w-full object-cover" />
                          ) : (
                            icon
                          )}
                        </div>
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <div className="flex items-center gap-1.5">
                            {icon}
                            <span className="text-xs font-medium truncate">{label}</span>
                          </div>
                          {clip.creatorName && (
                            <p className="text-[11px] text-muted-foreground truncate">{clip.creatorName}</p>
                          )}
                          {clip.createDate && (
                            <p className="text-[10px] text-muted-foreground">
                              {new Date(clip.createDate).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                            </p>
                          )}
                          <div className="flex gap-2 text-[10px] text-muted-foreground">
                            {clip.likes && <span>{Number(clip.likes).toLocaleString()} likes</span>}
                            {clip.views && <span>{Number(clip.views).toLocaleString()} views</span>}
                          </div>
                          <div className="flex items-center gap-1 pt-0.5 min-w-0">
                            <button
                              type="button"
                              onClick={() => openUrl(clip.link)}
                              className="text-muted-foreground hover:text-foreground cursor-pointer flex-shrink-0"
                              title="Open in browser"
                            >
                              <ExternalLink className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => void copyLatestLink(clip.link, label)}
                              className="text-muted-foreground hover:text-foreground cursor-pointer flex-shrink-0"
                              title={copiedLatestLabel === label ? "Copied" : "Copy link"}
                            >
                              {copiedLatestLabel === label
                                ? <ClipboardCheck className="h-3 w-3 text-green-600" />
                                : <Copy className="h-3 w-3" />}
                            </button>
                            <span
                              className="text-[10px] text-muted-foreground truncate min-w-0"
                              title={clip.link}
                            >
                              {clip.link}
                            </span>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div key={label} className="flex items-center gap-2 rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                        {icon}
                        <span>No {label} clips yet</span>
                      </div>
                    )
                  )}
                </div>
              )}
            </div>
          )}

          {/* Session history */}
          {sessionHistory.length > 0 && (
            <div className="mt-4 border-t pt-4 space-y-2">
              <div className="flex items-center gap-2">
                <History className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-medium">Recent Sessions</h3>
              </div>
              <div className="space-y-1.5">
                {sessionHistory.slice(0, historyVisible).map((session) => {
                  const isExpanded = expandedSession === session.id;
                  const dateStr = new Date(session.date).toLocaleDateString(undefined, {
                    month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit",
                  });
                  return (
                    <div key={session.id} className="rounded-md border">
                      <div className="flex items-center justify-between px-3 py-2">
                        <button
                          onClick={() => setExpandedSession(isExpanded ? null : session.id)}
                          className="flex items-center gap-2 text-xs cursor-pointer hover:text-foreground text-muted-foreground min-w-0"
                        >
                          {isExpanded ? <ChevronDown className="h-3 w-3 flex-shrink-0" /> : <ChevronRight className="h-3 w-3 flex-shrink-0" />}
                          <span className="font-medium text-foreground">{dateStr}</span>
                          <Badge variant="outline" className="text-[10px] h-4 px-1.5">{session.searchType}</Badge>
                          <span>{session.clipCount} clip{session.clipCount !== 1 ? "s" : ""}</span>
                        </button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="cursor-pointer h-6 px-2 text-xs gap-1"
                          onClick={async () => {
                            const escape = (s: string) => {
                              if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
                              return s;
                            };
                            const header = "Clip ID,Link,Platform,Handle,Creator ID,Creator Main Link,Found In,Caption,Likes,Comments,Views,Shares,Posted Date,Social Media Tags,Applied Tags,Already Existed";
                            const rows = session.clips.map((c) =>
                              [
                                c.clipId,
                                c.link,
                                c.platform,
                                c.handle ?? "",
                                c.creatorId ?? "",
                                c.creatorMainLink ?? "",
                                c.foundIn,
                                escape(c.caption ?? ""),
                                c.likes != null ? String(c.likes) : "",
                                c.comments != null ? String(c.comments) : "",
                                c.views != null ? String(c.views) : "",
                                c.shares != null ? String(c.shares) : "",
                                c.postedDate ?? "",
                                escape(c.socialMediaTags ?? ""),
                                escape((c.appliedTags ?? []).join(";")),
                                c.existedAlready ? "Yes" : "No",
                              ].join(",")
                            );
                            const csv = [header, ...rows].join("\n");
                            const defaultName = `clips-${session.searchType.replace(/\s/g, "-").toLowerCase()}-${new Date(session.date).toISOString().split("T")[0]}.csv`;
                            await invoke("save_text_file", { content: csv, defaultName });
                          }}
                        >
                          <Download className="h-3 w-3" />
                          CSV
                        </Button>
                      </div>
                      {isExpanded && (
                        <div className="border-t px-3 py-2 space-y-1">
                          {session.clips.map((c, idx) => (
                            <div key={`${c.clipId}-${idx}`} className="flex items-center gap-1.5 text-[11px]">
                              {c.platform === "instagram"
                                ? <Instagram className="h-3 w-3 text-pink-500 flex-shrink-0" />
                                : <Music2 className="h-3 w-3 text-cyan-500 flex-shrink-0" />}
                              <button
                                onClick={() => openUrl(c.link)}
                                className="text-foreground hover:underline cursor-pointer truncate min-w-0 text-left"
                                title={c.link}
                              >
                                {c.link}
                              </button>
                              {c.handle && <span className="text-muted-foreground flex-shrink-0">@{c.handle}</span>}
                              {c.appliedTags && c.appliedTags.length > 0 && (
                                <Badge variant="secondary" className="text-[9px] h-3.5 px-1">
                                  {c.appliedTags.join(", ")}
                                </Badge>
                              )}
                              {c.existedAlready && <Badge variant="outline" className="text-[9px] h-3.5 px-1">existed</Badge>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
                {sessionHistory.length > historyVisible && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="cursor-pointer w-full text-xs text-muted-foreground"
                    onClick={() => setHistoryVisible((v) => v + 5)}
                  >
                    Load More ({sessionHistory.length - historyVisible} remaining)
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {(phase === "review" || phase === "creating" || phase === "done") && (
        <div className="flex flex-col flex-1 min-h-0 gap-4">
          {/* Summary bar */}
          <div className="flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-2">
              {resolving ? (
                <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Resolving {entries.length} clips...
                </span>
              ) : phase === "creating" ? (
                <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Creating {createProgress.current}/{createProgress.total}...
                </span>
              ) : (
                <>
                  {/* Clips summary pill */}
                  <div className="flex items-center gap-1.5 rounded-md border px-2.5 py-1">
                    <Clipboard className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-xs font-medium mr-0.5">Clips</span>
                    {phase === "review" ? (
                      <>
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 text-blue-700 bg-blue-100 dark:bg-blue-900/30 dark:text-blue-400">{newClips.length} new</Badge>
                        {existingClips.length > 0 && (
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 text-amber-700 bg-amber-100 dark:bg-amber-900/30 dark:text-amber-400">{existingClips.length} existing</Badge>
                        )}
                      </>
                    ) : (
                      <>
                        {clipsCreated > 0 && <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 text-green-700 bg-green-100 dark:bg-green-900/30 dark:text-green-400">{clipsCreated} created</Badge>}
                        {clipsExisted > 0 && <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 text-amber-700 bg-amber-100 dark:bg-amber-900/30 dark:text-amber-400">{clipsExisted} existed</Badge>}
                      </>
                    )}
                  </div>
                  {/* Creators summary pill */}
                  <div className="flex items-center gap-1.5 rounded-md border px-2.5 py-1">
                    <UserPlus className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-xs font-medium mr-0.5">Creators</span>
                    {phase === "review" ? (
                      <>
                        {newCreators.length > 0 && <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 text-blue-700 bg-blue-100 dark:bg-blue-900/30 dark:text-blue-400">{newCreators.length} new</Badge>}
                        {existingCreators.length > 0 && <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 text-green-700 bg-green-100 dark:bg-green-900/30 dark:text-green-400">{existingCreators.length} existing</Badge>}
                        {failedEntries.length > 0 && <Badge variant="destructive" className="text-[10px] px-1.5 py-0 h-4">{failedEntries.length} failed</Badge>}
                      </>
                    ) : (
                      <>
                        {creatorsCreated > 0 && <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 text-green-700 bg-green-100 dark:bg-green-900/30 dark:text-green-400">{creatorsCreated} created</Badge>}
                        {creatorsExisted > 0 && <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 text-amber-700 bg-amber-100 dark:bg-amber-900/30 dark:text-amber-400">{creatorsExisted} existed</Badge>}
                      </>
                    )}
                  </div>
                  {/* Error + metrics status */}
                  {phase === "done" && errorCount > 0 && (
                    <Badge variant="destructive" className="text-[10px] px-1.5 py-0 h-4">{errorCount} errors</Badge>
                  )}
                  {phase === "done" && (metricsFetching || metricsDone > 0 || metricsFailed > 0) && (
                    <div className="flex items-center gap-1.5 rounded-md border px-2.5 py-1">
                      {metricsFetching ? (
                        <Loader2 className="h-3.5 w-3.5 text-muted-foreground animate-spin" />
                      ) : (
                        <CheckCircle className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                      <span className="text-xs font-medium mr-0.5">Metrics</span>
                      {metricsFetching && (
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">{metricsProgress.current}/{metricsProgress.total}</Badge>
                      )}
                      {metricsDone > 0 && (
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 text-green-700 bg-green-100 dark:bg-green-900/30 dark:text-green-400">{metricsDone} ok</Badge>
                      )}
                      {metricsFailed > 0 && (
                        <Popover>
                          <PopoverTrigger asChild>
                            <button className="text-[10px] px-1.5 py-0 h-4 rounded-md font-medium text-red-700 bg-red-100 dark:bg-red-900/30 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-900/50 cursor-pointer underline decoration-dotted">
                              {metricsFailed} failed
                            </button>
                          </PopoverTrigger>
                          <PopoverContent className="w-96 max-h-72 overflow-y-auto p-0" align="end">
                            <div className="px-3 py-2 border-b">
                              <p className="text-xs font-medium">Failed metrics ({metricsFailed})</p>
                            </div>
                            <div className="divide-y">
                              {entries.filter((e) => e.metricStatus === "failed").map((e, idx) => (
                                <div key={`${e.url}-${idx}`} className="px-3 py-2 space-y-0.5">
                                  <div className="flex items-center gap-1.5">
                                    <button
                                      onClick={() => openUrl(e.url)}
                                      className="text-[11px] text-foreground hover:underline cursor-pointer truncate min-w-0 text-left"
                                      title={e.url}
                                    >
                                      {e.url}
                                    </button>
                                    {e.clipId && (
                                      <button
                                        onClick={() => openUrl(`https://app-eu1.hubspot.com/contacts/146859718/record/2-192287471/${e.clipId}`)}
                                        className="text-muted-foreground hover:text-foreground cursor-pointer flex-shrink-0"
                                        title="Open in HubSpot"
                                      >
                                        <ExternalLink className="h-3 w-3" />
                                      </button>
                                    )}
                                  </div>
                                  {e.metricError && (
                                    <p className="text-[10px] text-red-500 dark:text-red-400 break-words leading-3.5">{e.metricError}</p>
                                  )}
                                </div>
                              ))}
                            </div>
                          </PopoverContent>
                        </Popover>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="flex items-center gap-2">
              {phase === "review" && owners.length > 0 && (
                <Select value={selectedOwnerId} onValueChange={setSelectedOwnerId}>
                  <SelectTrigger className="h-8 w-44 text-xs">
                    <SelectValue placeholder="Select owner..." />
                  </SelectTrigger>
                  <SelectContent>
                    {owners.map((o) => (
                      <SelectItem key={o.id} value={o.id}>
                        {o.firstName && o.lastName ? `${o.firstName} ${o.lastName}` : o.email}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {phase === "review" && (
                <Button
                  onClick={handleCreateAll}
                  disabled={!readyToCreate || creating || !selectedOwnerId}
                  size="sm"
                  variant="create"
                  className="cursor-pointer"
                >
                  {creating ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
                  Create All
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={handleReset} className="cursor-pointer">
                Start Over
              </Button>
            </div>
          </div>

          {/* Entries table */}
          <div className="flex-1 overflow-y-auto -mx-4 px-4">
            <div className="space-y-1.5">
              {entries.map((entry, i) => (
                <div
                  key={`${entry.url}-${i}`}
                  className={`flex items-center gap-3 rounded-md border px-3 py-2 text-sm ${
                    entry.created && !entry.createError ? "border-green-200 bg-green-50/50 dark:border-green-900/50 dark:bg-green-950/20" :
                    entry.created && entry.createError ? "border-amber-200 bg-amber-50/50 dark:border-amber-900/50 dark:bg-amber-950/20" :
                    entry.createError && !entry.created ? "border-red-200 bg-red-50/50 dark:border-red-900/50 dark:bg-red-950/20" :
                    ""
                  }`}
                >
                  <PlatformIcon platform={entry.platform} />

                  <button
                    onClick={() => openUrl(entry.url)}
                    className="text-xs font-mono truncate max-w-[200px] text-muted-foreground hover:text-foreground hover:underline cursor-pointer text-left"
                    title={entry.url}
                  >
                    {entry.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 40)}...
                  </button>

                  <div className="flex items-center gap-1.5 min-w-[140px]">
                    {editingIndex === i ? (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (entry.manualHandle.trim()) {
                            handleEditHandle(i, entry.manualHandle.trim());
                          }
                        }}
                        className="flex items-center gap-1"
                      >
                        <Input
                          value={entry.manualHandle}
                          onChange={(e) => {
                            const updated = [...entries];
                            updated[i] = { ...updated[i], manualHandle: e.target.value };
                            setEntries(updated);
                          }}
                          placeholder="username"
                          className="h-6 w-28 text-xs"
                          autoFocus
                        />
                        <Button type="submit" size="sm" variant="ghost" className="h-6 w-6 p-0 cursor-pointer text-green-600 hover:text-green-700">
                          <CheckCircle className="h-3 w-3" />
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-6 w-6 p-0 cursor-pointer text-muted-foreground hover:text-destructive"
                          onClick={() => {
                            const updated = [...entries];
                            updated[i] = { ...updated[i], manualHandle: "" };
                            setEntries(updated);
                            setEditingIndex(null);
                          }}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </form>
                    ) : (
                      <>
                        {entry.handle ? (
                          <HandleVerifyPopover entry={entry} />
                        ) : (
                          <span className="text-xs text-muted-foreground italic">unknown</span>
                        )}
                        {phase === "review" && (
                          <button
                            onClick={() => setEditingIndex(i)}
                            className="text-muted-foreground hover:text-foreground cursor-pointer"
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                        )}
                      </>
                    )}
                  </div>

                  <StatusBadge status={entry.creatorStatus} />

                  {entry.existingClipId && !entry.created && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 whitespace-nowrap">
                      Clip exists
                    </span>
                  )}

                  {entry.creatorName && entry.creatorStatus === "existing" && (
                    <span className="text-xs text-muted-foreground truncate max-w-[100px]" title={entry.creatorName}>
                      {entry.creatorName}
                    </span>
                  )}

                  {entry.created && entry.clipId && (
                    <button
                      onClick={() => openUrl(`https://app-eu1.hubspot.com/contacts/146859718/record/2-192287471/${entry.clipId}`)}
                      className="text-muted-foreground hover:text-foreground cursor-pointer"
                      title="Open in HubSpot"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </button>
                  )}

                  {entry.createError && (
                    <span
                      className={`text-xs truncate max-w-[180px] ${entry.created ? "text-amber-600 dark:text-amber-400" : "text-destructive"}`}
                      title={entry.createError}
                    >
                      {entry.createError}
                    </span>
                  )}

                  {entry.metricStatus === "fetching" && (
                    <span title="Fetching metrics..."><Loader2 className="h-3 w-3 animate-spin text-muted-foreground" /></span>
                  )}
                  {entry.metricStatus === "done" && (
                    <span title="Metrics fetched"><CheckCircle className="h-3 w-3 text-green-500" /></span>
                  )}
                  {entry.metricStatus === "failed" && (
                    <span title={entry.metricError || "Metrics fetch failed"}><AlertCircle className="h-3 w-3 text-red-500" /></span>
                  )}

                  <div className="ml-auto">
                    {phase === "review" && (
                      <button
                        onClick={() => removeEntry(i)}
                        className="text-muted-foreground hover:text-destructive cursor-pointer"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <Dialog open={complianceModalOpen} onOpenChange={setComplianceModalOpen}>
        <DialogContent className="sm:max-w-lg max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {complianceResults?.invalid.length ? (
                <AlertTriangle className="h-5 w-5 text-amber-500" />
              ) : (
                <CheckCircle className="h-5 w-5 text-emerald-500" />
              )}
              URL Compliance
            </DialogTitle>
            <DialogDescription>
              {complianceResults && (() => {
                const { fixed, invalid } = complianceResults;
                const parts: string[] = [];
                if (fixed.length > 0) parts.push(`${fixed.length} URL${fixed.length > 1 ? "s" : ""} auto-fixed`);
                if (invalid.length > 0) parts.push(`${invalid.length} URL${invalid.length > 1 ? "s" : ""} invalid and removed`);
                return parts.join(", ") + ".";
              })()}
            </DialogDescription>
          </DialogHeader>
          <div className="overflow-y-auto flex-1 space-y-4 pr-1">
            {complianceResults?.fixed.length ? (
              <div>
                <h4 className="text-sm font-medium mb-2 flex items-center gap-1.5">
                  <CheckCircle className="h-3.5 w-3.5 text-emerald-500" />
                  Auto-fixed
                </h4>
                <div className="space-y-2">
                  {complianceResults.fixed.map((r, i) => (
                    <div key={i} className="rounded-md border p-2 text-xs space-y-1">
                      <div className="text-muted-foreground line-through break-all">{r.originalUrl}</div>
                      <div className="flex items-center gap-1">
                        <ArrowRight className="h-3 w-3 shrink-0 text-emerald-500" />
                        <span className="break-all">{r.fixedUrl}</span>
                      </div>
                      <div className="text-muted-foreground italic">{r.issues.join("; ")}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {complianceResults?.invalid.length ? (
              <div>
                <h4 className="text-sm font-medium mb-2 flex items-center gap-1.5">
                  <AlertCircle className="h-3.5 w-3.5 text-destructive" />
                  Invalid — removed
                </h4>
                <div className="space-y-2">
                  {complianceResults.invalid.map((r, i) => (
                    <div key={i} className="rounded-md border border-destructive/30 p-2 text-xs space-y-1">
                      <div className="break-all">{r.originalUrl || "(empty)"}</div>
                      <div className="text-destructive italic">{r.issues.join("; ")}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            {complianceFixedRaw ? (
              <Button onClick={handleComplianceContinue} className="cursor-pointer">
                Continue
              </Button>
            ) : (
              <Button onClick={() => { setComplianceModalOpen(false); setComplianceResults(null); setComplianceFixedRaw(null); }} className="cursor-pointer">
                OK
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={existingClipsModalOpen} onOpenChange={setExistingClipsModalOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Existing clips found
            </DialogTitle>
            <DialogDescription>
              {pendingResolve && (() => {
                const existCount = pendingResolve.filter((e) => e.existingClipId).length;
                const newCount = pendingResolve.length - existCount;
                return (
                  <>
                    <span className="font-medium text-amber-600 dark:text-amber-400">{existCount}</span> of{" "}
                    {pendingResolve.length} clips already exist in HubSpot.
                    {newCount > 0
                      ? <> You can remove them and continue with the <span className="font-medium">{newCount}</span> new clips, or keep all.</>
                      : <> All clips already exist. You can remove them or keep all to re-link creators.</>
                    }
                  </>
                );
              })()}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex gap-2 sm:justify-end">
            <Button variant="outline" onClick={handleExistingClipsKeep} className="cursor-pointer">
              Keep all
            </Button>
            <Button onClick={handleExistingClipsRemove} className="cursor-pointer">
              Remove duplicates
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={emailModalOpen} onOpenChange={(open) => { if (!emailResolving) setEmailModalOpen(open); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Set your email</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Enter your HubSpot email. It will be verified and saved for future sessions.
          </p>
          <form
            onSubmit={(e) => { e.preventDefault(); handleEmailConfirm(); }}
            className="grid gap-3 pt-2"
          >
            <div className="grid gap-2">
              <Label htmlFor="owner-email-modal">Email</Label>
              <Input
                id="owner-email-modal"
                type="email"
                placeholder="you@company.com"
                value={emailDraft}
                onChange={(e) => { setEmailDraft(e.target.value); setEmailError(null); }}
                disabled={emailResolving}
                autoFocus
              />
              {emailError && (
                <p className="text-xs text-destructive">{emailError}</p>
              )}
            </div>
            <DialogFooter>
              <Button
                type="submit"
                disabled={!emailDraft.trim() || !emailDraft.includes("@") || emailResolving}
                className="cursor-pointer"
              >
                {emailResolving && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                {emailResolving ? "Verifying..." : "Continue"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
