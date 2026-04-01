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
import { TagPicker } from "@/components/TagPicker";
import { getEmbedUrl } from "@/components/ClipCard";
import { resolveTagLabel } from "@/lib/tags";
import { getPersistedThumb, persistThumb } from "@/lib/thumb-cache";
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
  platform: "instagram" | "tiktok" | "other";
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

interface Props {
  token: string;
  tagOptions: TagOption[];
  settings: AppSettings;
  onTagsCreated?: () => void;
}

export function TagClipsTab({ token, tagOptions, settings, onTagsCreated }: Props) {
  const [clips, setClips] = useState<UntaggedClip[]>([]);
  const [loading, setLoading] = useState(false);
  const [nextAfter, setNextAfter] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("_all");
  const [socialTagModal, setSocialTagModal] = useState<SocialTagModal | null>(null);
  const [creatingTag, setCreatingTag] = useState(false);
  const thumbFetchedRef = useRef(new Set<string>());
  const thumbQueueRef = useRef<string[]>([]);
  const thumbActiveRef = useRef(0);
  const MAX_CONCURRENT_THUMBS = 3;

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
      return {
        id: r.id,
        link,
        creatorName: p.creator_name ?? "Unknown",
        creatorStatus: p.creator_status ?? "",
        creatorMainLink: p.creator_main_link ?? null,
        dateFound: p.date_found ?? null,
        createdate: p.createdate ?? null,
        caption: p.social_media_caption ?? null,
        thumbnail: hubspotThumb ?? cachedThumb,
        socialMediaTags: p.social_media_tags ?? null,
        score: p.score ?? null,
        tags: p.tags ? p.tags.split(";").map((t) => resolveTagLabel(t.trim())) : [],
        platform: detectPlatform(link),
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
  }, [token, statusFilter]);

  useEffect(() => {
    thumbFetchedRef.current.clear();
    thumbQueueRef.current = [];
    fetchClips();
  }, [fetchClips]);

  const processThumbQueue = useCallback(async () => {
    while (thumbQueueRef.current.length > 0 && thumbActiveRef.current < MAX_CONCURRENT_THUMBS) {
      const clipId = thumbQueueRef.current.shift();
      if (!clipId) continue;
      thumbActiveRef.current++;

      (async () => {
        let clipLink = "";
        setClips((prev) => {
          const c = prev.find((x) => x.id === clipId);
          if (c) clipLink = c.link;
          return prev.map((x) => (x.id === clipId ? { ...x, thumbLoading: true } : x));
        });

        if (!clipLink) { thumbActiveRef.current--; processThumbQueue(); return; }

        // 1. Check localStorage cache first
        const persisted = getPersistedThumb(clipLink);
        if (persisted) {
          setClips((prev) => prev.map((c) => (c.id === clipId ? { ...c, thumbnail: persisted, thumbLoading: false } : c)));
          thumbActiveRef.current--;
          processThumbQueue();
          return;
        }

        // 2. Fetch from backend (oEmbed / yt-dlp)
        try {
          const thumbUrl: string | null = await invoke("fetch_thumbnail", {
            url: clipLink,
            cookiesBrowser: settings.cookiesBrowser || null,
            cookiesFile: settings.cookiesFile || null,
            evil0ctalApiUrl: settings.evil0ctalApiUrl || null,
          });
          if (thumbUrl) {
            let finalUrl = thumbUrl;
            // 3. Upload to HubSpot so it persists across sessions
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
        }
        thumbActiveRef.current--;
        processThumbQueue();
      })();
    }
  }, [token, settings.cookiesBrowser, settings.cookiesFile, settings.evil0ctalApiUrl]);

  const enqueueThumbFetch = useCallback((clipId: string) => {
    if (thumbFetchedRef.current.has(clipId)) return;
    thumbFetchedRef.current.add(clipId);
    thumbQueueRef.current.push(clipId);
    processThumbQueue();
  }, [processThumbQueue]);

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

  const previewClip = previewId ? clips.find((c) => c.id === previewId) : null;
  const previewEmbed = previewClip ? getEmbedUrl(previewClip.link) : null;

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left: video player panel */}
      {previewClip && previewEmbed && (
        <div className="w-[380px] flex-shrink-0 border-r flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b flex-shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <PlatformIcon platform={previewClip.platform} />
              <span className="text-xs font-medium truncate" title={previewClip.creatorName}>
                {previewClip.creatorName}
              </span>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setPreviewId(null)} className="h-6 px-2 text-xs cursor-pointer">
              Close
            </Button>
          </div>
          <div className="flex-1 min-h-0">
            <iframe
              key={previewClip.id}
              src={previewEmbed}
              className="w-full h-full border-0"
              allow="autoplay; encrypted-media"
              allowFullScreen
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
          </div>
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
                        {embedUrl && (
                          <button
                            onClick={() => setPreviewId(isPreviewing ? null : clip.id)}
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
                        </div>

                        {/* Creator + date */}
                        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                          <span className="truncate max-w-[160px]" title={clip.creatorName}>{clip.creatorName}</span>
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
                            {clip.socialMediaTags.split(";").filter((t) => t.trim()).map((tag, idx) => {
                              const trimmed = tag.trim();
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
