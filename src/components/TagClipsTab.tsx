import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ClipPreview } from "@/components/ClipPreview";
import { TagPicker } from "@/components/TagPicker";
import { getEmbedUrl } from "@/components/ClipCard";
import { parseHashtagList, resolveTagLabel } from "@/lib/tags";
import { getPersistedThumb, persistThumb, isPersistableThumbUrl, clearPersistedThumb } from "@/lib/thumb-cache";
import {
  Loader2,
  ExternalLink,
  Instagram,
  Music2,
  RefreshCw,
  Tags,
  Check,
  Play,
  X,
  Image as ImageIcon,
  AlertTriangle,
  BarChart3,
  Pause,
  RotateCw,
  Heart,
  Eye,
  MessageCircle,
  Share2,
} from "lucide-react";
import type { TagOption } from "@/lib/tags";
import type { AppSettings } from "@/types";

interface UntaggedClip {
  id: string;
  link: string;
  creatorName: string;
  creatorStatus: string;
  creatorMainLink: string | null;
  dateFound: string | null;
  createdate: string | null;
  caption: string | null;
  thumbnail: string | null;
  socialMediaTags: string | null;
  score: string | null;
  tags: string[];
  likes: string | null;
  plays: string | null;
  comments: string | null;
  shares: string | null;
  metricStatus: "idle" | "fetching" | "done" | "failed";
  platform: "instagram" | "tiktok" | "other";
  /** HubSpot CDN URL for the original video; when set, in-app preview prefers it over social embeds */
  originalClip?: string;
  pendingTags: string[];
  pendingScore: string;
  thumbLoading: boolean;
  thumbFailed: boolean;
}

const SCORE_OPTIONS = ["XL", "L", "M", "S", "XS", "Non-Acceptable"];

const STATUS_OPTIONS = [
  { value: "_all", label: "All statuses" },
  { value: "Granted", label: "Granted" },
  { value: "To Contact", label: "To Contact" },
  { value: "Contacted", label: "Contacted" },
];

interface SocialTagModal {
  clipId: string;
  socialTag: string;
  type: "suggest" | "create";
  suggestion?: TagOption;
}

type PreviewUploadStatus = "queued" | "uploading" | "failed";

interface PreviewUploadState {
  status: PreviewUploadStatus;
  error?: string;
}

interface Props {
  token: string;
  tagOptions: TagOption[];
  settings: AppSettings;
  onTagsCreated?: () => void;
}

interface Owner {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
}

interface CreatorLinkProps {
  name: string;
  profileUrl: string | null;
  className?: string;
}

/** Renders a creator name as a profile-opening button when `profileUrl` is set, otherwise as plain text. */
function CreatorLink({ name, profileUrl, className }: CreatorLinkProps) {
  if (!profileUrl) {
    return <span className={className} title={name}>{name}</span>;
  }
  return (
    <button
      type="button"
      onClick={() => openUrl(profileUrl)}
      className={`${className ?? ""} hover:underline cursor-pointer text-left`}
      title={`Open ${name} profile`}
    >
      {name}
    </button>
  );
}

export function TagClipsTab({ token, tagOptions, settings, onTagsCreated }: Props) {
  const [clips, setClips] = useState<UntaggedClip[]>([]);
  const [loading, setLoading] = useState(false);
  const [nextAfter, setNextAfter] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("_all");
  const [ownerFilter, setOwnerFilter] = useState("_all");
  const [owners, setOwners] = useState<Owner[]>([]);
  const [socialTagModal, setSocialTagModal] = useState<SocialTagModal | null>(null);
  const [creatingTag, setCreatingTag] = useState(false);
  const thumbFetchedRef = useRef(new Set<string>());
  const thumbQueueRef = useRef<string[]>([]);
  const thumbActiveRef = useRef(0);
  const clipsRef = useRef<UntaggedClip[]>([]);
  const previewUploadQueueRef = useRef<string[]>([]);
  const previewUploadActiveRef = useRef(false);
  const previewUploadQueuedRef = useRef(new Set<string>());
  const [previewUploadStates, setPreviewUploadStates] = useState<Record<string, PreviewUploadState>>({});
  const MAX_CONCURRENT_THUMBS = 3;

  useEffect(() => {
    clipsRef.current = clips;
  }, [clips]);

  const clearPreviewUploadState = useCallback((clipId: string) => {
    setPreviewUploadStates((prev) => {
      const next = { ...prev };
      delete next[clipId];
      return next;
    });
  }, []);

  // ── Social metrics backfill queue ──────────────────────────────────
  interface MetricsQueueItem { clipId: string; link: string; platform: "instagram" | "tiktok" | "other" }
  interface MetricsFailure { clipId: string; link: string; error: string }
  const [metricsRunning, setMetricsRunning] = useState(false);
  const [metricsPaused, setMetricsPaused] = useState(false);
  const [metricsAutoPaused, setMetricsAutoPaused] = useState(false);
  const [metricsProgress, setMetricsProgress] = useState({ current: 0, total: 0, ok: 0, failed: 0 });
  const [metricsFailures, setMetricsFailures] = useState<MetricsFailure[]>([]);
  const metricsQueueRef = useRef<MetricsQueueItem[]>([]);
  const metricsPausedRef = useRef(false);
  const metricsCancelledRef = useRef(false);
  const consecutiveFailsRef = useRef(0);
  const metricsNextAfterRef = useRef<string | null>(null);
  const metricsPhaseRef = useRef<"granted" | "all" | "done">("granted");
  const metricsProcessedRef = useRef(new Set<string>());

  const detectPlatformForMetrics = (url: string): "instagram" | "tiktok" | "other" => {
    if (url.includes("instagram.com")) return "instagram";
    if (url.includes("tiktok.com")) return "tiktok";
    return "other";
  };

  const loadMetricsPage = useCallback(async (after: string | null, creatorStatus: string | null): Promise<{ items: MetricsQueueItem[]; nextAfter: string | null; total: number }> => {
    const data: {
      total: number;
      results: Array<{ id: string; properties: Record<string, string | null> }>;
      paging?: { next?: { after: string } };
    } = await invoke("search_clips_missing_metrics", {
      token,
      after,
      creatorStatus,
    });

    const items: MetricsQueueItem[] = data.results
      .filter((r) => {
        const link = r.properties.link;
        if (!link) return false;
        const broken = r.properties.link_not_working_anymore;
        if (broken && broken !== "false") return false;
        if (!link.includes("instagram.com") && !link.includes("tiktok.com")) return false;
        return true;
      })
      .map((r) => ({
        clipId: r.id,
        link: r.properties.link!,
        platform: detectPlatformForMetrics(r.properties.link!),
      }));

    return { items, nextAfter: data.paging?.next?.after ?? null, total: data.total };
  }, [token]);

  const processMetricsQueue = useCallback(async () => {
    const statusForPhase = () => metricsPhaseRef.current === "granted" ? "Granted" : null;

    while (true) {
      if (metricsCancelledRef.current) break;
      if (metricsPausedRef.current) break;

      // Refill queue if empty
      if (metricsQueueRef.current.length === 0) {
        if (metricsPhaseRef.current === "done") break;

        try {
          const { items, nextAfter } = await loadMetricsPage(
            metricsNextAfterRef.current,
            statusForPhase(),
          );
          metricsNextAfterRef.current = nextAfter;

          const newItems = items.filter((it) => !metricsProcessedRef.current.has(it.clipId));
          if (newItems.length > 0) {
            metricsQueueRef.current.push(...newItems);
            setMetricsProgress((p) => ({ ...p, total: p.total + newItems.length }));
          }

          // No more pages in this phase -> advance
          if (!nextAfter && items.length === 0) {
            if (metricsPhaseRef.current === "granted") {
              metricsPhaseRef.current = "all";
              metricsNextAfterRef.current = null;
              continue;
            } else {
              metricsPhaseRef.current = "done";
              break;
            }
          }
          if (!nextAfter && items.length > 0) {
            // Last page of this phase; after processing these, advance
          }
        } catch (err) {
          console.error("Failed to load metrics page:", err);
          break;
        }

        continue;
      }

      const item = metricsQueueRef.current.shift()!;
      metricsProcessedRef.current.add(item.clipId);
      setClips((prev) => prev.map((c) => c.id === item.clipId ? { ...c, metricStatus: "fetching" as const } : c));

      try {
        const metrics: {
          caption?: string;
          likes?: number;
          comments?: number;
          views?: number;
          shares?: number;
          timestamp?: number;
          thumbnail?: string;
        } | null = await invoke("fetch_clip_metrics", {
          url: item.link,
          cookiesBrowser: settings.cookiesBrowser || null,
          cookiesFile: settings.cookiesFile || null,
        });

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

          const captionForTags = props.social_media_caption;
          if (captionForTags) {
            const hashtags = [...captionForTags.matchAll(/#([A-Za-z0-9_]+)/g)].map((m) => m[1]);
            if (hashtags.length > 0) props.social_media_tags = hashtags.join(";");
          }

          if (Object.keys(props).length > 0) {
            await invoke("update_clip_properties", { token, clipId: item.clipId, properties: props });
          }

          setClips((prev) => prev.map((c) =>
            c.id === item.clipId
              ? { ...c, metricStatus: "done" as const, caption: props.social_media_caption ?? c.caption, socialMediaTags: props.social_media_tags ?? c.socialMediaTags }
              : c
          ));
        } else {
          setClips((prev) => prev.map((c) => c.id === item.clipId ? { ...c, metricStatus: "done" as const } : c));
        }

        consecutiveFailsRef.current = 0;
        setMetricsProgress((p) => ({ ...p, current: p.current + 1, ok: p.ok + 1 }));
      } catch (err) {
        consecutiveFailsRef.current++;
        setMetricsProgress((p) => ({ ...p, current: p.current + 1, failed: p.failed + 1 }));
        setClips((prev) => prev.map((c) => c.id === item.clipId ? { ...c, metricStatus: "failed" as const } : c));
        setMetricsFailures((prev) => [...prev, {
          clipId: item.clipId,
          link: item.link,
          error: err instanceof Error ? err.message : String(err),
        }]);

        if (consecutiveFailsRef.current >= 5) {
          setMetricsAutoPaused(true);
          metricsPausedRef.current = true;
          setMetricsPaused(true);
          return;
        }
      }

      // Randomized platform-aware delay
      const randomBetween = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
      const delay = item.platform === "instagram" ? randomBetween(1_000, 10_000) : item.platform === "tiktok" ? randomBetween(1_000, 3_000) : 500;
      await new Promise((r) => setTimeout(r, delay));

      // Advance phase if queue drained and no next page
      if (metricsQueueRef.current.length === 0 && !metricsNextAfterRef.current) {
        if (metricsPhaseRef.current === "granted") {
          metricsPhaseRef.current = "all";
          metricsNextAfterRef.current = null;
        } else if (metricsPhaseRef.current === "all") {
          metricsPhaseRef.current = "done";
        }
      }
    }

    if (!metricsPausedRef.current) {
      setMetricsRunning(false);
    }
  }, [token, settings, loadMetricsPage]);

  const startMetricsFetch = useCallback(async () => {
    // Seed queue with visible clips that need metrics (IG/TikTok only, no caption yet)
    const visibleItems: MetricsQueueItem[] = clips
      .filter((c) =>
        !c.caption &&
        (c.link.includes("instagram.com") || c.link.includes("tiktok.com"))
      )
      .map((c) => ({ clipId: c.id, link: c.link, platform: c.platform }));

    metricsQueueRef.current = visibleItems;
    metricsProcessedRef.current = new Set(visibleItems.map((it) => it.clipId));
    metricsNextAfterRef.current = null;
    metricsPhaseRef.current = "granted";
    consecutiveFailsRef.current = 0;
    metricsCancelledRef.current = false;
    metricsPausedRef.current = false;
    setMetricsPaused(false);
    setMetricsAutoPaused(false);
    setMetricsProgress({ current: 0, total: visibleItems.length, ok: 0, failed: 0 });
    setMetricsFailures([]);
    setMetricsRunning(true);
    processMetricsQueue();
  }, [processMetricsQueue, clips]);

  const toggleMetricsPause = useCallback(() => {
    if (metricsPausedRef.current) {
      metricsPausedRef.current = false;
      consecutiveFailsRef.current = 0;
      setMetricsPaused(false);
      setMetricsAutoPaused(false);
      processMetricsQueue();
    } else {
      metricsPausedRef.current = true;
      setMetricsPaused(true);
    }
  }, [processMetricsQueue]);

  const stopMetricsFetch = useCallback(() => {
    metricsCancelledRef.current = true;
    metricsPausedRef.current = false;
    setMetricsRunning(false);
    setMetricsPaused(false);
    setMetricsAutoPaused(false);
  }, []);

  const fetchSingleClipMetrics = useCallback(async (clipId: string) => {
    const clip = clips.find((c) => c.id === clipId);
    if (!clip) return;

    setClips((prev) => prev.map((c) => c.id === clipId ? { ...c, metricStatus: "fetching" as const } : c));

    try {
      const metrics: {
        caption?: string; likes?: number; comments?: number;
        views?: number; shares?: number; timestamp?: number; thumbnail?: string;
      } | null = await invoke("fetch_clip_metrics", {
        url: clip.link,
        cookiesBrowser: settings.cookiesBrowser || null,
        cookiesFile: settings.cookiesFile || null,
      });

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
        const captionForTags = props.social_media_caption;
        if (captionForTags) {
          const hashtags = [...captionForTags.matchAll(/#([A-Za-z0-9_]+)/g)].map((m) => m[1]);
          if (hashtags.length > 0) props.social_media_tags = hashtags.join(";");
        }

        if (Object.keys(props).length > 0) {
          await invoke("update_clip_properties", { token, clipId, properties: props });
        }

        setClips((prev) => prev.map((c) =>
          c.id === clipId
            ? { ...c, metricStatus: "done" as const, caption: props.social_media_caption ?? c.caption, socialMediaTags: props.social_media_tags ?? c.socialMediaTags }
            : c
        ));
      } else {
        setClips((prev) => prev.map((c) => c.id === clipId ? { ...c, metricStatus: "done" as const } : c));
      }
    } catch {
      setClips((prev) => prev.map((c) => c.id === clipId ? { ...c, metricStatus: "failed" as const } : c));
    }
  }, [clips, token, settings]);

  useEffect(() => {
    if (!token) return;
    invoke<Owner[]>("list_owners", { token }).then(setOwners).catch(() => {});
  }, [token]);

  const detectPlatform = (url: string): "instagram" | "tiktok" | "other" => {
    if (url.includes("instagram.com")) return "instagram";
    if (url.includes("tiktok.com")) return "tiktok";
    return "other";
  };

  const parseResults = (results: Array<{ id: string; properties: Record<string, string | null> }>): UntaggedClip[] =>
    results.map((r) => {
      const p = r.properties;
      const link = p.link ?? "";
      const hubspotThumb = p.fetched_social_thumbnail ?? null;
      const cachedThumb = !hubspotThumb && link ? getPersistedThumb(link) : null;
      const durableCachedThumb =
        cachedThumb && isPersistableThumbUrl(cachedThumb) ? cachedThumb : null;
      return {
        id: r.id,
        link,
        creatorName: p.creator_name ?? "Unknown",
        creatorStatus: p.creator_status ?? "",
        creatorMainLink: p.creator_main_link ?? null,
        dateFound: p.date_found ?? null,
        createdate: p.createdate ?? null,
        caption: p.social_media_caption ?? null,
        thumbnail: hubspotThumb ?? durableCachedThumb,
        socialMediaTags: p.social_media_tags ?? null,
        score: p.score ?? null,
        tags: p.tags ? p.tags.split(";").map((t) => resolveTagLabel(t.trim())) : [],
        likes: p.likes ?? null,
        plays: p.plays ?? null,
        comments: p.comments ?? null,
        shares: p.shares ?? null,
        platform: detectPlatform(link),
        originalClip: p.original_clip ?? undefined,
        metricStatus: p.social_media_caption ? "done" as const : "idle" as const,
        pendingTags: [],
        pendingScore: "",
        thumbLoading: false,
        thumbFailed: false,
      };
    });

  const fetchClips = useCallback(async (after?: string) => {
    if (!token) return;
    setLoading(true);
    try {
      const data: {
        total: number;
        results: Array<{ id: string; properties: Record<string, string | null> }>;
        paging?: { next?: { after: string } };
      } = await invoke("search_untagged_clips", {
        token,
        after: after ?? null,
        creatorStatus: statusFilter === "_all" ? null : statusFilter,
        ownerId: ownerFilter === "_all" ? null : ownerFilter,
      });

      const parsed = parseResults(data.results);
      parsed.sort((a, b) => {
        const dfA = a.dateFound ?? "";
        const dfB = b.dateFound ?? "";
        if (dfA !== dfB) return dfB.localeCompare(dfA);
        const cdA = a.createdate ?? "";
        const cdB = b.createdate ?? "";
        return cdB.localeCompare(cdA);
      });
      if (after) {
        setClips((prev) => [...prev, ...parsed]);
      } else {
        setClips(parsed);
      }
      setTotal(data.total);
      setNextAfter(data.paging?.next?.after ?? null);
    } catch (err) {
      console.error("Failed to fetch untagged clips:", err);
    } finally {
      setLoading(false);
    }
  }, [token, statusFilter, ownerFilter]);

  useEffect(() => {
    thumbFetchedRef.current.clear();
    thumbQueueRef.current = [];
    fetchClips();
  }, [fetchClips]);

  const drainThumbQueue = useRef<() => void>(() => {});
  drainThumbQueue.current = () => {
    while (thumbQueueRef.current.length > 0 && thumbActiveRef.current < MAX_CONCURRENT_THUMBS) {
      const clipId = thumbQueueRef.current.shift();
      if (!clipId) continue;
      thumbActiveRef.current++;

      (async () => {
        try {
          let clipLink = "";
          setClips((prev) => {
            const c = prev.find((x) => x.id === clipId);
            if (c) clipLink = c.link;
            return prev.map((x) => (x.id === clipId ? { ...x, thumbLoading: true } : x));
          });

          if (!clipLink) return;

          const persisted = getPersistedThumb(clipLink);
          if (persisted && isPersistableThumbUrl(persisted)) {
            setClips((prev) => prev.map((c) => (c.id === clipId ? { ...c, thumbnail: persisted, thumbLoading: false } : c)));
            return;
          } else if (persisted) {
            clearPersistedThumb(clipLink);
          }

          const thumbPromise = invoke<string | null>("fetch_thumbnail", {
            url: clipLink,
            cookiesBrowser: settings.cookiesBrowser || null,
            cookiesFile: settings.cookiesFile || null,
            evil0ctalApiUrl: settings.evil0ctalApiUrl || null,
            clipId,
          });
          const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 20000));
          const thumbUrl = await Promise.race([thumbPromise, timeoutPromise]);

          if (thumbUrl) {
            let finalUrl = thumbUrl;
            if (token) {
              try {
                const hubspotUrl: string = await invoke("upload_clip_thumbnail", { token, clipId, thumbnailUrl: thumbUrl });
                finalUrl = hubspotUrl;
              } catch { /* upload failed, use original URL */ }
            }
            persistThumb(clipLink, finalUrl);
            setClips((prev) => prev.map((c) => (c.id === clipId ? { ...c, thumbnail: finalUrl, thumbLoading: false } : c)));
          } else {
            setClips((prev) => prev.map((c) => (c.id === clipId ? { ...c, thumbLoading: false, thumbFailed: true } : c)));
          }
        } catch {
          setClips((prev) => prev.map((c) => (c.id === clipId ? { ...c, thumbLoading: false, thumbFailed: true } : c)));
        } finally {
          thumbActiveRef.current--;
          drainThumbQueue.current();
        }
      })();
    }
  };

  const enqueueThumbFetch = useCallback((clipId: string) => {
    if (thumbFetchedRef.current.has(clipId)) return;
    thumbFetchedRef.current.add(clipId);
    thumbQueueRef.current.push(clipId);
    drainThumbQueue.current();
  }, []);

  const handlePendingTagChange = (clipId: string, newTags: string[]) => {
    setClips((prev) => prev.map((c) => (c.id === clipId ? { ...c, pendingTags: newTags } : c)));
  };

  const handleScoreChange = (clipId: string, value: string) => {
    setClips((prev) => prev.map((c) => (c.id === clipId ? { ...c, pendingScore: value } : c)));
  };

  const handleClearScore = (clipId: string) => {
    setClips((prev) => prev.map((c) => (c.id === clipId ? { ...c, pendingScore: "_clear" } : c)));
  };

  const tagLabelFor = (value: string) =>
    tagOptions.find((o) => o.value === value)?.label ?? value;

  const handleSave = async (clipId: string) => {
    const clip = clips.find((c) => c.id === clipId);
    if (!clip) return;
    const hasTags = clip.pendingTags.length > 0;
    const isClearing = clip.pendingScore === "_clear";
    const hasScore = isClearing || (clip.pendingScore !== "" && clip.pendingScore !== (clip.score ?? ""));
    if (!hasTags && !hasScore) return;

    setSavingId(clipId);
    try {
      const properties: Record<string, string> = {};
      if (hasTags) properties.tags = clip.pendingTags.join(";");
      if (isClearing) properties.score = "";
      else if (hasScore) properties.score = clip.pendingScore;

      await invoke("update_clip_properties", { token, clipId, properties });

      if (hasTags) {
        setClips((prev) => prev.filter((c) => c.id !== clipId));
        setTotal((prev) => Math.max(0, prev - 1));
      } else {
        const newScore = isClearing ? null : clip.pendingScore;
        setClips((prev) => prev.map((c) => (c.id === clipId ? { ...c, score: newScore, pendingScore: "" } : c)));
      }
    } catch (err) {
      console.error("Failed to save clip:", err);
    } finally {
      setSavingId(null);
    }
  };

  const findTagMatch = (socialTag: string): { exact: TagOption | null; similar: TagOption | null } => {
    const normalized = socialTag.toLowerCase().replace(/[^a-z0-9]/g, "");
    for (const opt of tagOptions) {
      const optNorm = opt.label.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (optNorm === normalized) return { exact: opt, similar: null };
    }
    // Fuzzy: check if one contains the other or starts similarly
    let bestMatch: TagOption | null = null;
    let bestScore = 0;
    for (const opt of tagOptions) {
      const optNorm = opt.label.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (optNorm.includes(normalized) || normalized.includes(optNorm)) {
        const score = Math.min(optNorm.length, normalized.length) / Math.max(optNorm.length, normalized.length);
        if (score > bestScore && score > 0.5) {
          bestScore = score;
          bestMatch = opt;
        }
      }
    }
    return { exact: null, similar: bestMatch };
  };

  const handleSocialTagClick = (clipId: string, socialTag: string) => {
    const { exact, similar } = findTagMatch(socialTag);
    if (exact) {
      setClips((prev) => prev.map((c) => {
        if (c.id !== clipId || c.pendingTags.includes(exact.value)) return c;
        return { ...c, pendingTags: [...c.pendingTags, exact.value] };
      }));
      return;
    }
    if (similar) {
      setSocialTagModal({ clipId, socialTag, type: "suggest", suggestion: similar });
    } else {
      setSocialTagModal({ clipId, socialTag, type: "create" });
    }
  };

  const handleConfirmSuggestion = () => {
    if (!socialTagModal?.suggestion) return;
    const { clipId, suggestion } = socialTagModal;
    setClips((prev) => prev.map((c) => {
      if (c.id !== clipId || c.pendingTags.includes(suggestion.value)) return c;
      return { ...c, pendingTags: [...c.pendingTags, suggestion.value] };
    }));
    setSocialTagModal(null);
  };

  const handleCreateNewTag = async () => {
    if (!socialTagModal) return;
    const { clipId, socialTag } = socialTagModal;
    const value = socialTag.toLowerCase().replace(/\s+/g, "_");
    setCreatingTag(true);
    try {
      await invoke("create_tag_option", { token, label: socialTag, value });
      onTagsCreated?.();
      setClips((prev) => prev.map((c) => {
        if (c.id !== clipId || c.pendingTags.includes(value)) return c;
        return { ...c, pendingTags: [...c.pendingTags, value] };
      }));
      setSocialTagModal(null);
    } catch (err) {
      console.error("Failed to create tag:", err);
    } finally {
      setCreatingTag(false);
    }
  };

  const PlatformIcon = ({ platform }: { platform: string }) =>
    platform === "instagram"
      ? <Instagram className="h-3.5 w-3.5 text-pink-500 flex-shrink-0" />
      : platform === "tiktok"
        ? <Music2 className="h-3.5 w-3.5 text-cyan-500 flex-shrink-0" />
        : <Tags className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />;

  const ThumbObserver = ({ clip }: { clip: UntaggedClip }) => {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
      if (clip.thumbnail || clip.thumbLoading || clip.thumbFailed) return;
      const el = ref.current;
      if (!el) return;
      const observer = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) {
            enqueueThumbFetch(clip.id);
            observer.disconnect();
          }
        },
        { threshold: 0.1 },
      );
      observer.observe(el);
      return () => observer.disconnect();
    }, [clip.id, clip.thumbnail, clip.thumbLoading, clip.thumbFailed]);
    return <div ref={ref} className="absolute inset-0" />;
  };

  const drainPreviewUploadQueue = useRef<() => void>(() => {});
  drainPreviewUploadQueue.current = () => {
    if (previewUploadActiveRef.current) return;

    const clipId = previewUploadQueueRef.current.shift();
    if (!clipId) return;

    const clip = clipsRef.current.find((c) => c.id === clipId);
    if (!clip || clip.originalClip) {
      previewUploadQueuedRef.current.delete(clipId);
      clearPreviewUploadState(clipId);
      drainPreviewUploadQueue.current();
      return;
    }

    previewUploadActiveRef.current = true;
    setPreviewUploadStates((prev) => ({
      ...prev,
      [clipId]: { status: "uploading" },
    }));

    (async () => {
      try {
        const hubspotUrl = await invoke<string>("ensure_clip_video_uploaded", {
          token,
          clipId,
          url: clip.link,
          cookiesBrowser: settings.cookiesBrowser || null,
          cookiesFile: settings.cookiesFile || null,
        });

        setClips((prev) =>
          prev.map((c) => (c.id === clipId ? { ...c, originalClip: hubspotUrl } : c)),
        );
        clearPreviewUploadState(clipId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setPreviewUploadStates((prev) => ({
          ...prev,
          [clipId]: { status: "failed", error: message },
        }));
      } finally {
        previewUploadQueuedRef.current.delete(clipId);
        previewUploadActiveRef.current = false;
        drainPreviewUploadQueue.current();
      }
    })();
  };

  const enqueuePreviewUpload = useCallback((clip: UntaggedClip) => {
    if (!token || clip.originalClip) return;

    const current = previewUploadStates[clip.id];
    if (current?.status === "queued" || current?.status === "uploading") return;
    if (previewUploadQueuedRef.current.has(clip.id)) return;

    previewUploadQueuedRef.current.add(clip.id);
    previewUploadQueueRef.current.push(clip.id);
    setPreviewUploadStates((prev) => ({
      ...prev,
      [clip.id]: { status: "queued" },
    }));
    drainPreviewUploadQueue.current();
  }, [previewUploadStates, token]);

  const handlePreviewToggle = useCallback((clip: UntaggedClip) => {
    const isOpen = previewId === clip.id;
    setPreviewId(isOpen ? null : clip.id);
    if (!isOpen) enqueuePreviewUpload(clip);
  }, [enqueuePreviewUpload, previewId]);

  const previewClip = previewId ? clips.find((c) => c.id === previewId) : null;
  const previewEmbed = previewClip ? getEmbedUrl(previewClip.link) : null;
  const preferHubSpotPreview = settings.preferHubSpotPreview !== false;
  const showLeftPreviewPanel =
    !!previewClip &&
    (preferHubSpotPreview
      ? Boolean(previewClip.originalClip || previewEmbed)
      : Boolean(previewEmbed));
  const previewUploadState = previewClip ? previewUploadStates[previewClip.id] : undefined;

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left: video player panel — HubSpot MP4 when available (matches ClipCard + Search tab) */}
      {showLeftPreviewPanel && previewClip && (
        <div className="w-[380px] flex-shrink-0 border-r flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b flex-shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <PlatformIcon platform={previewClip.platform} />
              <CreatorLink
                name={previewClip.creatorName}
                profileUrl={previewClip.creatorMainLink}
                className="text-xs font-medium truncate"
              />
            </div>
            <div className="flex items-center gap-2">
              {(previewUploadState?.status === "queued" || previewUploadState?.status === "uploading") && (
                <span
                  className="flex-shrink-0"
                  title={previewUploadState.status === "queued" ? "Queued for upload" : "Downloading & uploading to HubSpot…"}
                >
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                </span>
              )}
              {previewUploadState?.status === "failed" && (
                <button
                  type="button"
                  onClick={() => enqueuePreviewUpload(previewClip)}
                  className="flex h-5 items-center gap-1 rounded-full bg-destructive px-1.5 text-[10px] font-medium text-destructive-foreground cursor-pointer"
                  title={previewUploadState.error || "Retry upload"}
                >
                  <AlertTriangle className="h-3 w-3" />
                  Retry
                </button>
              )}
              <Button variant="ghost" size="sm" onClick={() => setPreviewId(null)} className="h-6 px-2 text-xs cursor-pointer">
                Close
              </Button>
            </div>
          </div>
          <div className="relative flex-1 min-h-0 w-full">
            <ClipPreview
              key={`${previewClip.id}-${previewClip.originalClip ?? "embed"}`}
              clip={previewClip}
              preferHubSpotPreview={preferHubSpotPreview}
              onClose={() => setPreviewId(null)}
            />
          </div>
          {previewClip.caption && (
            <div className="px-3 py-2 border-t max-h-24 overflow-auto flex-shrink-0">
              <p className="text-[11px] text-muted-foreground whitespace-pre-wrap break-words">
                {previewClip.caption}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Right: clip list */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
        <div className="flex items-center justify-between flex-shrink-0 px-4 pt-4 pb-2">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold">Untagged Clips</h2>
            <span className="text-xs text-muted-foreground">{total} total</span>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="h-7 w-36 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={ownerFilter} onValueChange={setOwnerFilter}>
              <SelectTrigger className="h-7 w-40 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_all">All owners</SelectItem>
                {owners.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.firstName && o.lastName ? `${o.firstName} ${o.lastName}` : o.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            {/* Social metrics backfill controls */}
            {metricsRunning ? (
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {!metricsPaused && <Loader2 className="h-3 w-3 animate-spin" />}
                  <span>{metricsProgress.current} fetched</span>
                  {(metricsProgress.ok > 0 || metricsProgress.failed > 0) && (
                    <span>
                      (
                      {metricsProgress.ok > 0 && <span className="text-green-600 dark:text-green-400">{metricsProgress.ok} ok</span>}
                      {metricsProgress.failed > 0 && (
                        <>
                          {metricsProgress.ok > 0 && ", "}
                          <Popover>
                            <PopoverTrigger asChild>
                              <button className="text-red-500 hover:text-red-600 underline decoration-dotted cursor-pointer">
                                {metricsProgress.failed} failed
                              </button>
                            </PopoverTrigger>
                            <PopoverContent className="w-96 max-h-72 overflow-y-auto p-0" align="end">
                              <div className="px-3 py-2 border-b">
                                <p className="text-xs font-medium">Failed clips ({metricsFailures.length})</p>
                              </div>
                              <div className="divide-y">
                                {metricsFailures.map((f, idx) => (
                                  <div key={`${f.clipId}-${idx}`} className="px-3 py-2 space-y-0.5">
                                    <div className="flex items-center gap-1.5">
                                      <button
                                        onClick={() => openUrl(f.link)}
                                        className="text-[11px] text-foreground hover:underline cursor-pointer truncate min-w-0 text-left"
                                        title={f.link}
                                      >
                                        {f.link}
                                      </button>
                                      <button
                                        onClick={() => openUrl(`https://app-eu1.hubspot.com/contacts/146859718/record/2-192287471/${f.clipId}`)}
                                        className="text-muted-foreground hover:text-foreground cursor-pointer flex-shrink-0"
                                        title="Open in HubSpot"
                                      >
                                        <ExternalLink className="h-3 w-3" />
                                      </button>
                                    </div>
                                    <p className="text-[10px] text-red-500 dark:text-red-400 break-words leading-3.5">{f.error}</p>
                                  </div>
                                ))}
                              </div>
                            </PopoverContent>
                          </Popover>
                        </>
                      )}
                      )
                    </span>
                  )}
                </div>
                {metricsAutoPaused && (
                  <Badge variant="destructive" className="text-[10px] h-5 px-1.5 gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    Auto-paused
                  </Badge>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={toggleMetricsPause}
                  className="cursor-pointer h-7 px-2 text-xs"
                >
                  {metricsPaused ? <RotateCw className="h-3 w-3 mr-1" /> : <Pause className="h-3 w-3 mr-1" />}
                  {metricsPaused ? "Resume" : "Pause"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={stopMetricsFetch}
                  className="cursor-pointer h-7 px-2 text-xs text-muted-foreground"
                >
                  <X className="h-3 w-3 mr-1" />
                  Stop
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={startMetricsFetch}
                disabled={!token}
                className="cursor-pointer"
              >
                <BarChart3 className="h-3.5 w-3.5 mr-1.5" />
                Fetch Social Metrics
              </Button>
            )}

            <Button
              variant="outline"
              size="sm"
              onClick={() => { setPreviewId(null); fetchClips(); }}
              disabled={loading}
              className="cursor-pointer"
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>

        {loading && clips.length === 0 ? (
          <div className="flex items-center justify-center flex-1 text-sm text-muted-foreground gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading untagged clips...
          </div>
        ) : clips.length === 0 ? (
          <div className="flex items-center justify-center flex-1 text-sm text-muted-foreground">
            No untagged clips found.
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto px-4 pb-4">
            <div className="space-y-2">
              {clips.map((clip) => {
                const isPreviewing = previewId === clip.id;
                const embedUrl = getEmbedUrl(clip.link);
                const canOpenPreview = preferHubSpotPreview
                  ? Boolean(clip.originalClip || embedUrl)
                  : Boolean(embedUrl);
                const isClearing = clip.pendingScore === "_clear";
                const scoreChanged = isClearing || (clip.pendingScore !== "" && clip.pendingScore !== (clip.score ?? ""));
                const hasPending = clip.pendingTags.length > 0 || scoreChanged;
                const displayScore = isClearing ? "" : (clip.pendingScore || clip.score || "");

                return (
                  <div
                    key={clip.id}
                    className={`rounded-lg border overflow-hidden flex ${isPreviewing ? "border-primary/40 ring-1 ring-primary/20" : ""}`}
                  >
                    {/* === Left: Identity + Content === */}
                    <div className="flex-1 min-w-0 p-3 flex gap-3">
                      {/* 9:16 thumbnail */}
                      <div className="w-11 aspect-[9/16] rounded-md overflow-hidden bg-muted flex items-center justify-center relative flex-shrink-0">
                        <ThumbObserver clip={clip} />
                        {clip.thumbnail ? (
                          <img src={clip.thumbnail} alt="" className="h-full w-full object-cover" />
                        ) : clip.thumbLoading ? (
                          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                        ) : (
                          <ImageIcon className="h-3 w-3 text-muted-foreground/40" />
                        )}
                        {canOpenPreview && (
                          <button
                            onClick={() => handlePreviewToggle(clip)}
                            className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 hover:opacity-100 transition-opacity cursor-pointer"
                          >
                            <Play className="h-4 w-4 text-white drop-shadow" />
                          </button>
                        )}
                      </div>

                      <div className="flex-1 min-w-0 flex flex-col gap-1">
                        {/* Link + platform + HubSpot */}
                        <div className="flex items-center gap-1.5">
                          <PlatformIcon platform={clip.platform} />
                          <button
                            onClick={() => openUrl(clip.link)}
                            className="text-xs text-foreground hover:underline cursor-pointer text-left truncate min-w-0"
                            title={clip.link}
                          >
                            {clip.link}
                          </button>
                          <button
                            onClick={() => openUrl(`https://app-eu1.hubspot.com/contacts/146859718/record/2-192287471/${clip.id}`)}
                            className="text-muted-foreground hover:text-foreground cursor-pointer flex-shrink-0"
                            title="Open in HubSpot"
                          >
                            <ExternalLink className="h-3 w-3" />
                          </button>
                          {(clip.platform === "instagram" || clip.platform === "tiktok") && clip.metricStatus !== "done" && (
                            clip.metricStatus === "fetching" ? (
                              <span className="flex-shrink-0" title="Fetching metrics...">
                                <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                              </span>
                            ) : (
                              <button
                                onClick={() => fetchSingleClipMetrics(clip.id)}
                                className={`flex-shrink-0 cursor-pointer ${clip.metricStatus === "failed" ? "text-red-500 hover:text-red-600" : "text-muted-foreground hover:text-foreground"}`}
                                title={clip.metricStatus === "failed" ? "Retry fetching social metrics" : "Fetch social metrics"}
                              >
                                <BarChart3 className="h-3 w-3" />
                              </button>
                            )
                          )}
                          {clip.metricStatus === "done" && !clip.caption && (
                            <span className="flex-shrink-0" title="Metrics fetched">
                              <Check className="h-3 w-3 text-green-500" />
                            </span>
                          )}
                        </div>

                        {/* Creator + date */}
                        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                          <CreatorLink
                            name={clip.creatorName}
                            profileUrl={clip.creatorMainLink}
                            className="truncate max-w-[160px]"
                          />
                          {clip.dateFound && <span>·</span>}
                          {clip.dateFound && <span>{clip.dateFound}</span>}
                        </div>

                        {/* Caption */}
                        {clip.caption && (
                          <p className="text-[11px] text-muted-foreground line-clamp-2 break-words leading-4 mt-0.5">
                            {clip.caption}
                          </p>
                        )}

                        {/* Social media tags (clickable to match/create HubSpot tags) */}
                        {clip.socialMediaTags && (
                          <div className="flex flex-wrap gap-1 mt-0.5">
                            {parseHashtagList(clip.socialMediaTags).map((trimmed, idx) => {
                              const { exact } = findTagMatch(trimmed);
                              const alreadyAdded = exact && clip.pendingTags.includes(exact.value);
                              return (
                                <button
                                  key={`${trimmed}-${idx}`}
                                  onClick={() => !alreadyAdded && handleSocialTagClick(clip.id, trimmed)}
                                  className={`text-[10px] px-1.5 py-0.5 rounded-full leading-3 whitespace-nowrap cursor-pointer transition-colors ${
                                    alreadyAdded
                                      ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300"
                                      : "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300 hover:bg-violet-200 dark:hover:bg-violet-800/40"
                                  }`}
                                  title={alreadyAdded ? `Already added as "${exact.label}"` : `Click to add "${trimmed}" as a tag`}
                                >
                                  {alreadyAdded && <span className="mr-0.5">✓</span>}
                                  #{trimmed}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* === Middle: Metrics === */}
                    {(clip.likes || clip.plays || clip.comments || clip.shares) && (
                      <div className="w-24 flex-shrink-0 border-l px-2.5 py-3 flex flex-col justify-center gap-1 text-[10px] text-muted-foreground">
                        {clip.likes && (
                          <div className="flex items-center gap-1.5" title="Likes">
                            <Heart className="h-3 w-3 text-pink-400 flex-shrink-0" />
                            <span>{Number(clip.likes).toLocaleString()}</span>
                          </div>
                        )}
                        {clip.plays && (
                          <div className="flex items-center gap-1.5" title="Views">
                            <Eye className="h-3 w-3 text-blue-400 flex-shrink-0" />
                            <span>{Number(clip.plays).toLocaleString()}</span>
                          </div>
                        )}
                        {clip.comments && (
                          <div className="flex items-center gap-1.5" title="Comments">
                            <MessageCircle className="h-3 w-3 text-amber-400 flex-shrink-0" />
                            <span>{Number(clip.comments).toLocaleString()}</span>
                          </div>
                        )}
                        {clip.shares && (
                          <div className="flex items-center gap-1.5" title="Shares">
                            <Share2 className="h-3 w-3 text-green-400 flex-shrink-0" />
                            <span>{Number(clip.shares).toLocaleString()}</span>
                          </div>
                        )}
                      </div>
                    )}

                    {/* === Right: Actions — tag picker + score + save === */}
                    <div className="w-72 flex-shrink-0 border-l p-3 flex flex-col justify-center gap-2 bg-muted/5">
                      {savingId === clip.id ? (
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Loader2 className="h-3 w-3 animate-spin" /> Saving...
                        </div>
                      ) : (
                        <>
                          {/* Tag picker + selected badges */}
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <div className="w-36 flex-shrink-0">
                              <TagPicker
                                options={tagOptions}
                                selected={clip.pendingTags}
                                onChange={(values) => handlePendingTagChange(clip.id, values)}
                                hideBadges
                              />
                            </div>
                            {clip.pendingTags.map((v) => (
                              <Badge key={v} variant="secondary" className="text-[10px] h-5 px-1.5 gap-0.5">
                                {tagLabelFor(v)}
                                <button onClick={() => handlePendingTagChange(clip.id, clip.pendingTags.filter((t) => t !== v))} className="hover:bg-muted rounded-full cursor-pointer">
                                  <X className="h-2.5 w-2.5" />
                                </button>
                              </Badge>
                            ))}
                          </div>

                          {/* Score + Save */}
                          <div className="flex items-center gap-1.5">
                            <Select value={displayScore} onValueChange={(v) => handleScoreChange(clip.id, v)}>
                              <SelectTrigger className="h-7 w-28 text-xs">
                                <SelectValue placeholder="Score" />
                              </SelectTrigger>
                              <SelectContent>
                                {SCORE_OPTIONS.map((s) => (
                                  <SelectItem key={s} value={s}>{s}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            {displayScore && (
                              <button
                                onClick={() => handleClearScore(clip.id)}
                                className="text-muted-foreground hover:text-destructive cursor-pointer p-0.5"
                                title="Clear score"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            )}
                            {hasPending && (
                              <Button
                                size="sm"
                                onClick={() => handleSave(clip.id)}
                                className="cursor-pointer h-7 px-3 gap-1 ml-auto"
                              >
                                <Check className="h-3.5 w-3.5" />
                                Save
                              </Button>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}

              {nextAfter && (
                <div className="flex justify-center py-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fetchClips(nextAfter)}
                    disabled={loading}
                    className="cursor-pointer"
                  >
                    {loading ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
                    Load More
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Social tag → HubSpot tag modal */}
      <Dialog open={!!socialTagModal} onOpenChange={(open) => !open && setSocialTagModal(null)}>
        <DialogContent className="max-w-md">
          {socialTagModal?.type === "suggest" && socialTagModal.suggestion && (
            <>
              <DialogHeader>
                <DialogTitle>Similar tag found</DialogTitle>
                <DialogDescription>
                  The social media tag <strong>#{socialTagModal.socialTag}</strong> doesn't have an exact match,
                  but a similar HubSpot tag exists:
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-center justify-center py-3">
                <Badge variant="secondary" className="text-sm px-3 py-1">
                  {socialTagModal.suggestion.label}
                </Badge>
              </div>
              <DialogFooter className="gap-2 sm:gap-0">
                <Button variant="outline" onClick={() => setSocialTagModal({ ...socialTagModal, type: "create" })} className="cursor-pointer">
                  No, create new
                </Button>
                <Button onClick={handleConfirmSuggestion} className="cursor-pointer">
                  Yes, use this tag
                </Button>
              </DialogFooter>
            </>
          )}
          {socialTagModal?.type === "create" && (
            <>
              <DialogHeader>
                <DialogTitle>Create new tag</DialogTitle>
                <DialogDescription>
                  No matching HubSpot tag found for <strong>#{socialTagModal.socialTag}</strong>.
                </DialogDescription>
              </DialogHeader>
              <div className="rounded-md border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30 p-3 flex gap-2.5 items-start">
                <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                  Before creating, make sure the format is correct and a similar tag doesn't already exist. Keeping tags clean and consistent is important.
                </p>
              </div>
              <div className="flex items-center gap-2 py-1">
                <span className="text-sm text-muted-foreground">New tag:</span>
                <Badge variant="outline" className="text-sm px-3 py-1">{socialTagModal.socialTag}</Badge>
              </div>
              <DialogFooter className="gap-2 sm:gap-0">
                <Button variant="outline" onClick={() => setSocialTagModal(null)} className="cursor-pointer">
                  Cancel
                </Button>
                <Button onClick={handleCreateNewTag} disabled={creatingTag} className="cursor-pointer">
                  {creatingTag && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                  Create tag
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
