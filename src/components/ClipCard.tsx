import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import {
  ExternalLink,
  AlertTriangle,
  Loader2,
  Plus,
  Check,
  X,
  Trash2,
  Download,
  CheckCircle,
  XCircle,
} from "lucide-react";

// ── Score badge colors (mimicking HubSpot) ──────────────────────────────────

export const SCORE_COLORS: Record<string, string> = {
  XL: "bg-purple-500 text-white",
  L: "bg-teal-500 text-white",
  M: "bg-cyan-500 text-white",
  S: "bg-orange-400 text-white",
  XS: "bg-rose-400 text-white",
  "Non-Acceptable": "bg-gray-700 text-white",
};

// ── Types ────────────────────────────────────────────────────────────────────

export interface ClipCardData {
  id: string;
  link: string;
  tags: string[];
  creatorName: string;
  creatorMainLink?: string;
  creatorId?: string;
  score?: string;
  editedDuration?: number;
  dateFound?: string;
  linkNotWorking?: boolean;
  availableAskFirst?: boolean;
  numPublishedVideoProjects?: number;
  // Project-specific fields (optional)
  downloadStatus?: "pending" | "downloading" | "complete" | "failed";
  downloadError?: string;
}

export interface ClipCardProps {
  clip: ClipCardData;
  // Thumbnail
  thumbCache: React.RefObject<Map<string, string | null>>;
  cookiesBrowser: string;
  cookiesFile: string;
  onCookieError?: (msg: string) => void;
  // Preview
  isActive?: boolean;
  onTogglePreview?: () => void;
  // Project actions
  inProject?: boolean;
  hasProject?: boolean;
  onToggleProject?: () => void;
  onRemove?: () => void;
  onRetryDownload?: () => void;
  // "Used Xx" popover context
  hubspotToken?: string;
  searchTags?: string[];
}

// ── Component ────────────────────────────────────────────────────────────────

interface VideoProjectInfo {
  id: string;
  name: string;
  tag: string;
  pubDate: string;
  youtubeVideoId: string;
  status: string;
}

export function ClipCard({
  clip,
  thumbCache,
  cookiesBrowser,
  cookiesFile,
  onCookieError,
  isActive = false,
  onTogglePreview,
  inProject,
  hasProject,
  onToggleProject,
  onRemove,
  onRetryDownload,
  hubspotToken,
  searchTags = [],
}: ClipCardProps) {
  const [thumb, setThumb] = useState<string | null>(
    thumbCache.current?.get(clip.link) ?? null,
  );
  const [thumbLoading, setThumbLoading] = useState(false);
  const [thumbError, setThumbError] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  // "Used Xx" popover state
  const [vpOpen, setVpOpen] = useState(false);
  const [vpLoading, setVpLoading] = useState(false);
  const [vpProjects, setVpProjects] = useState<VideoProjectInfo[] | null>(null);

  const loadVideoProjects = useCallback(async () => {
    if (vpProjects !== null || !hubspotToken) return; // already loaded or no token
    setVpLoading(true);
    try {
      const results = await invoke<VideoProjectInfo[]>("fetch_clip_video_projects", {
        token: hubspotToken,
        clipId: clip.id,
      });
      setVpProjects(results);
    } catch {
      setVpProjects([]);
    } finally {
      setVpLoading(false);
    }
  }, [clip.id, hubspotToken, vpProjects]);

  // Lazy-load thumbnail when card scrolls into view
  const loadThumb = useCallback(async () => {
    if (thumbCache.current?.has(clip.link)) {
      setThumb(thumbCache.current.get(clip.link) ?? null);
      return;
    }
    setThumbLoading(true);
    setThumbError(false);
    try {
      const url = await invoke<string | null>("fetch_thumbnail", {
        url: clip.link,
        cookiesBrowser: cookiesBrowser || null,
        cookiesFile: cookiesFile || null,
      });
      thumbCache.current?.set(clip.link, url);
      setThumb(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      thumbCache.current?.set(clip.link, null);
      setThumbError(true);
      if (msg.toLowerCase().includes("cookie") && onCookieError) {
        onCookieError(msg);
      }
    } finally {
      setThumbLoading(false);
    }
  }, [clip.link, thumbCache, cookiesBrowser, cookiesFile, onCookieError]);

  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          loadThumb();
          observer.disconnect();
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadThumb]);

  const embedUrl = isActive ? getEmbedUrl(clip.link) : null;
  const platform = getPlatform(clip.link);
  const ds = clip.downloadStatus;

  return (
    <div
      ref={cardRef}
      className="group relative flex w-52 flex-shrink-0 snap-start flex-col overflow-hidden rounded-lg border bg-card transition-shadow hover:shadow-md"
    >
      {/* Thumbnail / Preview area */}
      <div
        className="relative aspect-[9/16] w-full cursor-pointer overflow-hidden bg-muted"
        onClick={onTogglePreview}
      >
        {isActive && embedUrl ? (
          <>
            <iframe
              src={embedUrl}
              className="absolute inset-0 h-full w-full"
              allowFullScreen
              allow="autoplay; encrypted-media"
            />
            <button
              onClick={(e) => {
                e.stopPropagation();
                onTogglePreview?.();
              }}
              className="absolute right-1 top-1 z-10 rounded-full bg-black/60 p-1 text-white hover:bg-black/80"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </>
        ) : thumb ? (
          <img
            src={thumb}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-muted-foreground">
            {thumbLoading ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : thumbError ? (
              <>
                <AlertTriangle className="h-4 w-4 text-muted-foreground/50" />
                <span className="px-2 text-center text-[9px] leading-tight text-muted-foreground">
                  No preview
                </span>
              </>
            ) : (
              <span className="text-xs font-medium uppercase">{platform}</span>
            )}
          </div>
        )}

        {/* Link broken warning */}
        {clip.linkNotWorking && (
          <div className="absolute left-1 top-1 rounded-full bg-destructive p-1">
            <AlertTriangle className="h-3 w-3 text-white" />
          </div>
        )}

        {/* Download status overlay */}
        {ds === "downloading" && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40">
            <Loader2 className="h-6 w-6 animate-spin text-white" />
          </div>
        )}
        {ds === "complete" && (
          <div className="absolute right-1.5 top-1.5">
            <CheckCircle className="h-4 w-4 text-green-400 drop-shadow" />
          </div>
        )}
        {ds === "failed" && (
          <div className="absolute right-1.5 top-1.5">
            <XCircle className="h-4 w-4 text-red-400 drop-shadow" />
          </div>
        )}

        {/* Score badge */}
        {clip.score && (
          <div className="absolute left-1.5 bottom-1.5">
            <span
              className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold uppercase leading-none ${SCORE_COLORS[clip.score] ?? "bg-gray-500 text-white"}`}
            >
              {clip.score}
            </span>
          </div>
        )}

        {/* Duration overlay */}
        {clip.editedDuration != null && (
          <div className="absolute bottom-1.5 right-1.5">
            <span className="rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white">
              {formatDuration(clip.editedDuration)}
            </span>
          </div>
        )}
      </div>

      {/* Info section */}
      <div className="flex flex-col gap-1 p-2">
        {/* Creator name → HubSpot | icon → social profile */}
        {clip.creatorName && (
          <div className="flex items-center gap-1 min-w-0">
            {clip.creatorId ? (
              <button
                className="truncate text-[10px] font-medium text-left hover:underline"
                onClick={(e) => {
                  e.stopPropagation();
                  openUrl(`https://app-eu1.hubspot.com/contacts/146859718/record/2-191972671/${clip.creatorId}`);
                }}
                title="Open creator in HubSpot"
              >
                {clip.creatorName}
              </button>
            ) : (
              <span className="truncate text-[10px] font-medium">{clip.creatorName}</span>
            )}
            {clip.creatorMainLink && (
              <button
                className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  openUrl(clip.creatorMainLink!);
                }}
                title="Open creator profile"
              >
                <ExternalLink className="h-2.5 w-2.5" />
              </button>
            )}
          </div>
        )}

        {/* Tags */}
        <div className="flex flex-wrap gap-1">
          {clip.tags.slice(0, 3).map((tag) => (
            <Badge key={tag} variant="outline" className="text-[10px] px-1 py-0">
              {tag}
            </Badge>
          ))}
          {clip.tags.length > 3 && (
            <Badge variant="outline" className="text-[10px] px-1 py-0">
              +{clip.tags.length - 3}
            </Badge>
          )}
        </div>

        {/* Meta line */}
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          {clip.dateFound && (
            <span>
              {new Date(clip.dateFound).toLocaleDateString(undefined, {
                year: "numeric",
                month: "short",
                day: "numeric",
              })}
            </span>
          )}
          {clip.numPublishedVideoProjects != null &&
            clip.numPublishedVideoProjects > 0 && (
              <Popover open={vpOpen} onOpenChange={(open) => {
                setVpOpen(open);
                if (open) loadVideoProjects();
              }}>
                <PopoverTrigger asChild>
                  <button
                    className="cursor-pointer underline decoration-dotted underline-offset-2 hover:text-foreground transition-colors"
                    onClick={(e) => e.stopPropagation()}
                  >
                    Used {clip.numPublishedVideoProjects}x
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  className="w-64 p-3"
                  align="start"
                  onClick={(e) => e.stopPropagation()}
                >
                  <p className="mb-2 text-xs font-semibold">Video Projects</p>
                  {vpLoading ? (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" /> Loading…
                    </div>
                  ) : vpProjects && vpProjects.length > 0 ? (
                    <ul className="flex flex-col gap-2">
                      {vpProjects.map((vp) => {
                        const tags = vp.tag
                          ? vp.tag.split(";").map((c) => c.trim())
                          : [];
                        const searchTagsLower = searchTags.map((t) => t.toLowerCase());
                        const dateStr = vp.pubDate
                          ? new Date(vp.pubDate).toLocaleDateString(undefined, {
                              year: "numeric",
                              month: "short",
                              day: "numeric",
                            })
                          : "";
                        const hubspotUrl = `https://app-eu1.hubspot.com/contacts/146859718/record/2-192286893/${vp.id}`;
                        const youtubeUrl = vp.youtubeVideoId
                          ? `https://www.youtube.com/watch?v=${vp.youtubeVideoId}`
                          : null;
                        return (
                          <li key={vp.id} className="text-xs">
                            <div className="flex items-center gap-1">
                              <button
                                className="font-medium text-left hover:underline truncate"
                                onClick={() => openUrl(hubspotUrl)}
                                title="Open in HubSpot"
                              >
                                {vp.name}
                              </button>
                              {youtubeUrl && (
                                <button
                                  className="flex-shrink-0 text-red-500 hover:text-red-600 transition-colors"
                                  onClick={() => openUrl(youtubeUrl)}
                                  title="Watch on YouTube"
                                >
                                  <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
                                  </svg>
                                </button>
                              )}
                            </div>
                            {dateStr && (
                              <span className="text-[10px] text-muted-foreground">{dateStr}</span>
                            )}
                            {tags.length > 0 && (
                              <div className="mt-0.5 flex flex-wrap gap-1">
                                {tags.map((cat) => {
                                  const matches = searchTagsLower.includes(cat.toLowerCase());
                                  return (
                                    <Badge
                                      key={cat}
                                      variant="outline"
                                      className={`text-[10px] px-1 py-0 ${
                                        matches
                                          ? "border-primary bg-primary/10 text-primary font-semibold"
                                          : ""
                                      }`}
                                    >
                                      {cat}
                                    </Badge>
                                  );
                                })}
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="text-xs text-muted-foreground">No projects found</p>
                  )}
                </PopoverContent>
              </Popover>
            )}
          {clip.availableAskFirst && (
            <span className="text-orange-500 font-medium">Ask first</span>
          )}
        </div>

        {/* Download error */}
        {ds === "failed" && clip.downloadError && (
          <p className="text-[9px] leading-tight text-destructive">
            {clip.downloadError}
          </p>
        )}
      </div>

      {/* Action buttons bar */}
      <div className="mt-auto flex border-t">
        {/* Add/Remove for search context */}
        {hasProject && onToggleProject && (
          <button
            onClick={onToggleProject}
            className={`flex flex-1 items-center justify-center gap-1 py-1.5 text-xs font-medium transition-colors ${
              inProject
                ? "bg-primary text-primary-foreground"
                : "hover:bg-muted"
            }`}
            title={inProject ? "Remove from project" : "Add to project"}
          >
            {inProject ? (
              <><Check className="h-3.5 w-3.5" /> Added</>
            ) : (
              <><Plus className="h-3.5 w-3.5" /> Add</>
            )}
          </button>
        )}

        {/* Retry download for failed clips */}
        {ds === "failed" && onRetryDownload && (
          <button
            onClick={onRetryDownload}
            className="flex flex-1 items-center justify-center gap-1 py-1.5 text-xs font-medium text-orange-600 transition-colors hover:bg-muted"
            title="Retry download"
          >
            <Download className="h-3.5 w-3.5" /> Retry
          </button>
        )}

        {/* Remove from project */}
        {onRemove && (
          <button
            onClick={onRemove}
            className="flex items-center justify-center gap-1 px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
            title="Remove from project"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}

        {/* Open in browser */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            // Instagram: open as /p/ instead of /reel/ or /reels/ for better compatibility
            let url = clip.link;
            if (url.includes("instagram.com")) {
              url = url.replace(/\/reels?\//i, "/p/");
            }
            openUrl(url);
          }}
          className={`flex flex-1 items-center justify-center gap-1 py-1.5 text-xs font-medium transition-colors hover:bg-muted hover:text-foreground${
            (hasProject && onToggleProject) || onRemove || (ds === "failed" && onRetryDownload)
              ? " border-l text-muted-foreground"
              : ""
          }`}
          title="Open in browser"
        >
          <ExternalLink className="h-3.5 w-3.5" /> Open
        </button>
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}:${s.toString().padStart(2, "0")}` : `${s}s`;
}

export function getPlatform(url: string): string {
  if (url.includes("tiktok.com")) return "TikTok";
  if (url.includes("instagram.com")) return "Instagram";
  if (url.includes("youtube.com") || url.includes("youtu.be")) return "YouTube";
  if (url.includes("douyin.com")) return "Douyin";
  if (url.includes("bilibili.com")) return "Bilibili";
  if (url.includes("xiaohongshu.com")) return "Xiaohongshu";
  return "Video";
}

export function getEmbedUrl(url: string): string | null {
  try {
    const u = new URL(url);

    if (u.hostname.includes("tiktok.com")) {
      const videoId = url.match(/video\/(\d+)/)?.[1];
      if (videoId) return `https://www.tiktok.com/embed/v2/${videoId}`;
    }

    if (
      u.hostname.includes("youtube.com") ||
      u.hostname.includes("youtu.be")
    ) {
      const videoId = u.hostname.includes("youtu.be")
        ? u.pathname.slice(1)
        : u.searchParams.get("v");
      if (videoId) return `https://www.youtube.com/embed/${videoId}`;
      const shortsMatch = u.pathname.match(/\/shorts\/([^/?]+)/);
      if (shortsMatch) return `https://www.youtube.com/embed/${shortsMatch[1]}`;
    }

    if (u.hostname.includes("instagram.com")) {
      const match = url.match(/\/(reel|reels|p)\/([^/?]+)/);
      if (match)
        return `https://www.instagram.com/reel/${match[2]}/embed`;
    }

    return null;
  } catch {
    return null;
  }
}
