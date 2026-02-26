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
  FolderOpen,
  StickyNote,
} from "lucide-react";

// ── Persistent thumbnail cache (survives app restarts & cookie issues) ───────

const THUMB_STORAGE_KEY = "compi-thumb-cache";

function getPersistedThumb(clipUrl: string): string | null {
  try {
    const raw = localStorage.getItem(THUMB_STORAGE_KEY);
    if (!raw) return null;
    const cache = JSON.parse(raw);
    return cache[clipUrl] ?? null;
  } catch {
    return null;
  }
}

function persistThumb(clipUrl: string, thumbUrl: string) {
  try {
    const raw = localStorage.getItem(THUMB_STORAGE_KEY);
    const cache = raw ? JSON.parse(raw) : {};
    cache[clipUrl] = thumbUrl;
    localStorage.setItem(THUMB_STORAGE_KEY, JSON.stringify(cache));
  } catch { /* localStorage full or unavailable */ }
}

function clearPersistedThumb(clipUrl: string) {
  try {
    const raw = localStorage.getItem(THUMB_STORAGE_KEY);
    if (!raw) return;
    const cache = JSON.parse(raw);
    delete cache[clipUrl];
    localStorage.setItem(THUMB_STORAGE_KEY, JSON.stringify(cache));
  } catch { /* ignore */ }
}

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
  licenseType?: string;
  notes?: string;
  fetchedThumbnail?: string;
  editingNotes?: string;
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
  onImportFile?: () => void;
  // "Used Xx" popover context
  hubspotToken?: string;
  searchTags?: string[];
  // Compact mode: thumbnail + overlays only (no info/tags/action bar)
  compact?: boolean;
  // Increment to trigger retry of failed thumbnails (e.g. on window focus)
  thumbRetryKey?: number;
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
  onImportFile,
  hubspotToken,
  searchTags = [],
  compact = false,
  thumbRetryKey = 0,
}: ClipCardProps) {
  const [thumb, setThumb] = useState<string | null>(
    thumbCache.current?.get(clip.link) ?? null,
  );
  const [thumbLoading, setThumbLoading] = useState(false);
  const [thumbError, setThumbError] = useState(false);
  const [thumbErrorMsg, setThumbErrorMsg] = useState<string | null>(null);
  const thumbRetriedRef = useRef(false);
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

  // Lazy-load thumbnail: HubSpot → in-memory cache → localStorage → fetch → upload to HubSpot
  const loadThumb = useCallback(async (isRetry = false) => {
    // 1. Check HubSpot-stored thumbnail (permanent, no fetch needed)
    if (clip.fetchedThumbnail) {
      thumbCache.current?.set(clip.link, clip.fetchedThumbnail);
      setThumb(clip.fetchedThumbnail);
      return;
    }

    // 2. Check in-memory cache
    if (!isRetry && thumbCache.current?.has(clip.link)) {
      const cached = thumbCache.current.get(clip.link);
      if (cached != null) {
        setThumb(cached);
        return;
      }
    }

    // 3. Check persistent localStorage cache (skip on retry since cached URL may be stale)
    if (!isRetry) {
      const persisted = getPersistedThumb(clip.link);
      if (persisted) {
        thumbCache.current?.set(clip.link, persisted);
        setThumb(persisted);
        return;
      }
    }

    // 4. Fetch fresh
    setThumbLoading(true);
    setThumbError(false);
    setThumbErrorMsg(null);
    try {
      const url = await invoke<string | null>("fetch_thumbnail", {
        url: clip.link,
        cookiesBrowser: cookiesBrowser || null,
        cookiesFile: cookiesFile || null,
      });

      if (url) {
        setThumb(url);

        // Upload to HubSpot and cache the permanent URL
        if (hubspotToken && clip.id) {
          try {
            const hubspotUrl = await invoke<string>("upload_clip_thumbnail", {
              token: hubspotToken,
              clipId: clip.id,
              thumbnailUrl: url,
            });
            thumbCache.current?.set(clip.link, hubspotUrl);
            persistThumb(clip.link, hubspotUrl);
            setThumb(hubspotUrl);
          } catch {
            // Upload failed; cache original as fallback
            thumbCache.current?.set(clip.link, url);
            persistThumb(clip.link, url);
          }
        } else {
          thumbCache.current?.set(clip.link, url);
          persistThumb(clip.link, url);
        }
      } else {
        thumbCache.current?.set(clip.link, null);
        setThumbError(true);
        setThumbErrorMsg("No thumbnail found");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      thumbCache.current?.set(clip.link, null);
      setThumbError(true);
      setThumbErrorMsg(msg);
      if (msg.toLowerCase().includes("cookie") && onCookieError) {
        onCookieError(msg);
      }
    } finally {
      setThumbLoading(false);
    }
  }, [clip.link, clip.fetchedThumbnail, clip.id, thumbCache, cookiesBrowser, cookiesFile, onCookieError, hubspotToken]);

  // Initial load via IntersectionObserver
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

  // Retry failed thumbnails when thumbRetryKey changes (e.g. on window focus)
  useEffect(() => {
    if (thumbRetryKey === 0) return;
    if (!thumbError) return;
    thumbCache.current?.delete(clip.link);
    loadThumb(true);
  }, [thumbRetryKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const embedUrl = isActive ? getEmbedUrl(clip.link) : null;
  const platform = getPlatform(clip.link);
  const ds = clip.downloadStatus;
  const showLicenseType =
    clip.licenseType && clip.licenseType.toLowerCase() !== "recurrent";

  return (
    <div
      ref={cardRef}
      className={`group relative flex flex-shrink-0 snap-start flex-col overflow-hidden rounded-lg bg-card transition-shadow hover:shadow-md ${compact ? "w-28" : "w-52 border"}`}
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
            onError={() => {
              if (thumbRetriedRef.current) {
                setThumb(null);
                setThumbError(true);
                setThumbErrorMsg("Image URL expired");
                return;
              }
              thumbRetriedRef.current = true;
              thumbCache.current?.delete(clip.link);
              clearPersistedThumb(clip.link);
              setThumb(null);
              loadThumb(true);
            }}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-muted-foreground">
            {thumbLoading ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : thumbError ? (
              <>
                <AlertTriangle className="h-4 w-4 text-muted-foreground/50" />
                <span className="px-2 text-center text-[9px] leading-tight text-muted-foreground/70">
                  {thumbErrorMsg || "No preview"}
                </span>
              </>
            ) : (
              <span className="text-xs font-medium uppercase">{platform}</span>
            )}
          </div>
        )}

        {/* Top-left: duration + link broken warning + editing notes icon */}
        {(clip.editedDuration != null || clip.linkNotWorking || clip.editingNotes) && (
          <div className="absolute left-1.5 top-1.5 flex flex-col items-start gap-1">
            <div className="flex items-center gap-1">
              {clip.editedDuration != null && (
                <span className="rounded bg-black/70 px-1.5 py-0.5 text-[13px] font-medium text-white">
                  {formatDuration(clip.editedDuration)}
                </span>
              )}
              {clip.linkNotWorking && (
                <span className="rounded-full bg-destructive p-1">
                  <AlertTriangle className="h-3 w-3 text-white" />
                </span>
              )}
            </div>
            {clip.editingNotes && (
              <div className="group/enotes relative">
                <span className="flex items-center gap-0.5 rounded bg-amber-400/90 px-1 py-0.5 text-[10px] font-semibold text-amber-950">
                  <StickyNote className="h-2.5 w-2.5" />
                </span>
                <div className="pointer-events-none absolute left-0 top-full mt-1 hidden group-hover/enotes:block z-20 w-40 rounded bg-black/90 px-2 py-1.5 text-[11px] leading-snug text-white shadow-lg whitespace-pre-wrap">
                  {clip.editingNotes}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Download status overlay (only spinner while downloading) */}
        {ds === "downloading" && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40">
            <Loader2 className="h-6 w-6 animate-spin text-white" />
          </div>
        )}

        {/* Score badge */}
        {clip.score && (
          <div className="absolute right-1.5 top-1.5">
            <span
              className={`inline-block rounded px-2 py-1 text-[15px] font-bold uppercase leading-none ${SCORE_COLORS[clip.score.toUpperCase()] ?? SCORE_COLORS[clip.score] ?? "bg-gray-500 text-white"}`}
            >
              {clip.score}
            </span>
          </div>
        )}

        {/* Bottom-center: license type + notes */}
        {(showLicenseType || clip.notes) && (
          <div className="absolute bottom-1.5 left-1/2 -translate-x-1/2 flex flex-col items-center gap-0.5 max-w-[90%]">
            {showLicenseType && (
              <span className="rounded bg-amber-500/90 px-1.5 py-0.5 text-[10px] font-semibold text-white whitespace-nowrap">
                {clip.licenseType}
              </span>
            )}
            {clip.notes && (
              <div className="group/notes relative max-w-full">
                <span className="block truncate rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white/80 max-w-[8rem]">
                  {clip.notes}
                </span>
                <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover/notes:block z-20 w-48 rounded bg-black/90 px-2 py-1.5 text-[11px] leading-snug text-white shadow-lg">
                  {clip.notes}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Compact action bar (arrange mode only) */}
      {compact && (
        <div className="flex border-t">
          <button
            onClick={(e) => {
              e.stopPropagation();
              openUrl(`https://app-eu1.hubspot.com/contacts/146859718/record/2-192287471/${clip.id}`);
            }}
            className="flex flex-1 items-center justify-center py-1 cursor-pointer transition-colors hover:bg-muted"
            title="Open in HubSpot"
          >
            <HubSpotIcon className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              let url = clip.link;
              if (url.includes("instagram.com")) {
                url = url.replace(/\/reels?\//i, "/p/");
              }
              openUrl(url);
            }}
            className="flex flex-1 items-center justify-center py-1 border-l cursor-pointer transition-colors hover:bg-muted"
            title="Open in browser"
          >
            <ExternalLink className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* Info section (hidden in compact mode) */}
      {!compact && <div className="flex flex-col gap-1 p-2">
        {/* Creator name → links to External Clip in HubSpot */}
        {clip.creatorName && (
          <button
            className="truncate text-[10px] font-medium text-left cursor-pointer hover:underline"
            onClick={(e) => {
              e.stopPropagation();
              openUrl(`https://app-eu1.hubspot.com/contacts/146859718/record/2-192287471/${clip.id}`);
            }}
            title="Open clip in HubSpot"
          >
            {clip.creatorName}
          </button>
        )}

        {/* Tags */}
        <div className="flex flex-wrap gap-1">
          {clip.tags.slice(0, 3).map((tag) => {
            const isSearched = searchTags.some((t) => t.toLowerCase() === tag.toLowerCase());
            return (
              <Badge
                key={tag}
                variant="outline"
                className={`text-[10px] px-1 py-0 ${
                  isSearched
                    ? "border-green-400 bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300 dark:border-green-700"
                    : ""
                }`}
              >
                {tag}
              </Badge>
            );
          })}
          {clip.tags.length > 3 && (
            <Badge variant="outline" className="text-[10px] px-1 py-0">
              +{clip.tags.length - 3}
            </Badge>
          )}
        </div>

        {/* Meta line */}
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          {clip.dateFound && (() => {
            const d = new Date(clip.dateFound);
            const isRecent = Date.now() - d.getTime() < 30 * 24 * 60 * 60 * 1000;
            return (
              <span className={isRecent ? "text-green-500 font-semibold" : ""}>
                {d.toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })}
              </span>
            );
          })()}
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
                                          ? "border-green-400 bg-green-100 text-green-700 font-semibold dark:bg-green-950 dark:text-green-300 dark:border-green-700"
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
      </div>}

      {/* Action buttons bar (hidden in compact mode) */}
      {!compact && <div className="mt-auto flex border-t">
        {/* Add/Remove for search context */}
        {hasProject && onToggleProject && (
          <button
            onClick={onToggleProject}
            className={`flex flex-1 items-center justify-center gap-1 py-1.5 text-xs font-medium cursor-pointer transition-colors ${
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

        {/* Download status + Retry + Browse for non-complete clips */}
        {(ds === "failed" || ds === "downloading") && onRetryDownload && (
          <button
            onClick={onRetryDownload}
            className="flex items-center justify-center gap-1 px-2 py-1.5 text-xs font-medium text-orange-600 transition-colors hover:bg-muted cursor-pointer"
            title="Retry download"
          >
            <Download className="h-3.5 w-3.5" /> Retry
          </button>
        )}
        {(ds === "failed" || ds === "pending" || ds === "downloading") && onImportFile && (
          <button
            onClick={onImportFile}
            className="flex items-center justify-center gap-1 px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted cursor-pointer"
            title="Import file manually"
          >
            <FolderOpen className="h-3.5 w-3.5" /> Browse
          </button>
        )}
        {ds === "complete" && (
          <span className="flex items-center gap-1 px-2 py-1.5 text-[10px] text-green-600">
            <CheckCircle className="h-3 w-3" />
          </span>
        )}
        {ds === "pending" && onRemove && (
          <span className="flex items-center gap-1 px-2 py-1.5 text-[10px] text-muted-foreground">
            <Download className="h-3 w-3" />
          </span>
        )}

        {/* Remove from project */}
        {onRemove && (
          <button
            onClick={onRemove}
            className="flex items-center justify-center gap-1 px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-destructive cursor-pointer"
            title="Remove from project"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}

        {/* Open in HubSpot */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            openUrl(`https://app-eu1.hubspot.com/contacts/146859718/record/2-192287471/${clip.id}`);
          }}
          className="flex items-center justify-center px-2 py-1.5 border-l cursor-pointer transition-colors hover:bg-muted"
          title="Open in HubSpot"
        >
          <HubSpotIcon className="h-3.5 w-3.5" />
        </button>

        {/* Open in browser */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            let url = clip.link;
            if (url.includes("instagram.com")) {
              url = url.replace(/\/reels?\//i, "/p/");
            }
            openUrl(url);
          }}
          className="flex items-center justify-center px-2 py-1.5 border-l cursor-pointer transition-colors hover:bg-muted"
          title="Open in browser"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      </div>}
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

/** HubSpot sprocket icon (orange) */
export function HubSpotIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 512 512"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M374.8 185.5v-56.8a44.3 44.3 0 0 0 25.6-40V87a44.3 44.3 0 0 0-44.3-44.3h-1.7A44.3 44.3 0 0 0 310 87v1.7a44.3 44.3 0 0 0 25.6 40v56.8a129.3 129.3 0 0 0-62.5 29l-166-129.2a47.2 47.2 0 1 0-17.8 23.7l162.9 126.7a129.8 129.8 0 0 0 5.3 179.5L227 448.7a46 46 0 0 0-13.4-2 47.2 47.2 0 1 0 47.2 47.2 46 46 0 0 0-2-13.4l30-32.2a129.7 129.7 0 0 0 155.6-5.8A129.8 129.8 0 0 0 374.8 185.5ZM355.3 382a74.8 74.8 0 1 1 0-105.8 74.8 74.8 0 0 1 0 105.8Z"
        fill="#FF7A59"
      />
    </svg>
  );
}
