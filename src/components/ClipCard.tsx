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
  Play,
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
  originalClip?: string;
  // Project-specific fields (optional)
  downloadStatus?: "pending" | "downloading" | "complete" | "failed";
  downloadError?: string;
  localFile?: string;
}

export interface ClipCardProps {
  clip: ClipCardData;
  // Thumbnail
  thumbCache: React.RefObject<Map<string, string | null>>;
  cookiesBrowser: string;
  cookiesFile: string;
  evil0ctalApiUrl?: string;
  /** rootFolder + projectName needed to resolve localFile for thumbnail extraction */
  rootFolder?: string;
  projectName?: string;
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
  // When true + originalClip exists, use HubSpot video instead of social embed
  preferHubSpotPreview?: boolean;
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
  evil0ctalApiUrl,
  rootFolder,
  projectName,
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
  preferHubSpotPreview = false,
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
        evil0ctalApiUrl: evil0ctalApiUrl || null,
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
      } else if (clip.localFile && rootFolder && projectName) {
        // Last resort: extract a frame from the downloaded video via ffmpeg
        try {
          const absPath = clip.localFile.startsWith("/") || clip.localFile.includes(":\\")
            ? clip.localFile
            : `${rootFolder}/${projectName}/${clip.localFile}`;
          const b64 = await invoke<string | null>("extract_video_thumbnail", { videoPath: absPath });
          if (b64) {
            const dataUrl = `data:image/jpeg;base64,${b64}`;
            setThumb(dataUrl);
            thumbCache.current?.set(clip.link, dataUrl);
            persistThumb(clip.link, dataUrl);
          } else {
            thumbCache.current?.set(clip.link, null);
            setThumbError(true);
            setThumbErrorMsg("No thumbnail found");
          }
        } catch {
          thumbCache.current?.set(clip.link, null);
          setThumbError(true);
          setThumbErrorMsg("No thumbnail found");
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
  }, [clip.link, clip.localFile, clip.fetchedThumbnail, clip.id, thumbCache, cookiesBrowser, cookiesFile, evil0ctalApiUrl, rootFolder, projectName, onCookieError, hubspotToken]);

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

  const useHubSpotVideo = isActive && preferHubSpotPreview && !!clip.originalClip;
  const embedUrl = isActive && !useHubSpotVideo ? getEmbedUrl(clip.link) : null;
  const platform = getPlatform(clip.link);
  const ds = clip.downloadStatus;
  const showLicenseType =
    clip.licenseType && clip.licenseType.toLowerCase() !== "recurrent";

  return (
    <div
      ref={cardRef}
      className={`group relative flex snap-start flex-col overflow-hidden rounded-lg bg-card transition-shadow hover:shadow-md ${compact ? "w-full" : "w-52 flex-shrink-0 border"}`}
    >
      {/* Thumbnail / Preview area */}
      <div
        className="relative aspect-[9/16] w-full cursor-pointer overflow-hidden bg-muted"
        onClick={onTogglePreview}
      >
        {useHubSpotVideo ? (
          <HubSpotVideoPlayer src={clip.originalClip!} onClose={() => onTogglePreview?.()} />
        ) : isActive && embedUrl ? (
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
              <span className="block rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white/80 text-center overflow-hidden whitespace-nowrap text-ellipsis max-w-[8rem] hover:overflow-visible hover:whitespace-normal hover:break-words hover:max-w-full">
                {clip.notes}
              </span>
            )}
          </div>
        )}
      </div>

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
            <div className="group/moretags relative">
              <Badge variant="outline" className="text-[10px] px-1 py-0 cursor-default">
                +{clip.tags.length - 3}
              </Badge>
              <div className="pointer-events-none absolute bottom-full left-0 mb-1 hidden group-hover/moretags:flex flex-wrap gap-1 z-20 max-w-40 rounded bg-popover border shadow-md px-2 py-1.5">
                {clip.tags.slice(3).map((tag) => {
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
              </div>
            </div>
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
          title={`Open on ${platform}`}
        >
          <PlatformIcon platform={platform} className="h-3.5 w-3.5" />
        </button>
      </div>}
    </div>
  );
}

// ── Compact HubSpot video player (fits in the small card thumbnail) ──────────

function HubSpotVideoPlayer({ src, onClose }: { src: string; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [paused, setPaused] = useState(false);
  const [progress, setProgress] = useState(0);
  const progressBarRef = useRef<HTMLDivElement>(null);

  const togglePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { v.play(); setPaused(false); }
    else { v.pause(); setPaused(true); }
  };

  const seek = (e: React.MouseEvent) => {
    e.stopPropagation();
    const v = videoRef.current;
    const bar = progressBarRef.current;
    if (!v || !bar || !v.duration) return;
    const rect = bar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    v.currentTime = pct * v.duration;
  };

  return (
    <>
      <video
        ref={videoRef}
        src={src}
        className="absolute inset-0 h-full w-full object-cover"
        autoPlay
        playsInline
        loop
        onTimeUpdate={() => {
          const v = videoRef.current;
          if (v && v.duration) setProgress(v.currentTime / v.duration);
        }}
        onClick={togglePlay}
      />
      {/* Close button */}
      <button
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        className="absolute right-1 top-1 z-10 rounded-full bg-black/60 p-1 text-white hover:bg-black/80"
      >
        <X className="h-3.5 w-3.5" />
      </button>
      {/* Play/pause overlay (only when paused) */}
      {paused && (
        <div className="absolute inset-0 flex items-center justify-center" onClick={togglePlay}>
          <div className="rounded-full bg-black/50 p-2">
            <Play className="h-5 w-5 text-white" fill="white" />
          </div>
        </div>
      )}
      {/* Thin progress bar at bottom */}
      <div
        ref={progressBarRef}
        className="absolute bottom-0 left-0 right-0 z-10 h-1.5 cursor-pointer bg-white/20"
        onClick={seek}
      >
        <div
          className="h-full bg-white/80 transition-[width] duration-100"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
    </>
  );
}

// ── Platform icon ────────────────────────────────────────────────────────────

export function PlatformIcon({ platform, className }: { platform: string; className?: string }) {
  if (platform === "TikTok") {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="currentColor">
        <path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/>
      </svg>
    );
  }
  if (platform === "Douyin") {
    return (
      <svg className={className} viewBox="0 0 48 48" fill="none">
        <path d="M21.5 4h5c.2 3.3 1.3 6.3 3.6 8.5 2.3 2.3 5 3.3 8.4 3.5v5c-3-.1-5.7-.8-8.2-2.2v14.7c0 5.8-4.7 10.5-10.5 10.5S9.3 39.3 9.3 33.5 14 23 19.8 23v5.2c-2.9 0-5.3 2.4-5.3 5.3s2.4 5.3 5.3 5.3 5.2-2.4 5.2-5.3V4h-3.5z" fill="#fe2c55"/>
        <path d="M23.5 2h5c.2 3.3 1.3 6.3 3.6 8.5 2.3 2.3 5 3.3 8.4 3.5v5c-3-.1-5.7-.8-8.2-2.2v14.7c0 5.8-4.7 10.5-10.5 10.5S11.3 37.3 11.3 31.5 16 21 21.8 21v5.2c-2.9 0-5.3 2.4-5.3 5.3s2.4 5.3 5.3 5.3 5.2-2.4 5.2-5.3V2h-3.5z" fill="#25f4ee"/>
        <path d="M22.5 3h5c.2 3.3 1.3 6.3 3.6 8.5 2.3 2.3 5 3.3 8.4 3.5v5c-3-.1-5.7-.8-8.2-2.2v14.7c0 5.8-4.7 10.5-10.5 10.5S10.3 38.3 10.3 32.5 15 22 20.8 22v5.2c-2.9 0-5.3 2.4-5.3 5.3s2.4 5.3 5.3 5.3 5.2-2.4 5.2-5.3V3h-3.5z" fill="currentColor"/>
      </svg>
    );
  }
  if (platform === "Instagram") {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="currentColor">
        <path d="M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077"/>
      </svg>
    );
  }
  if (platform === "YouTube") {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="currentColor">
        <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
      </svg>
    );
  }
  if (platform === "Bilibili") {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="currentColor">
        <path d="M17.813 4.653h.854c1.51.054 2.769.578 3.773 1.574 1.004.995 1.524 2.249 1.56 3.76v7.36c-.036 1.51-.556 2.769-1.56 3.773s-2.262 1.524-3.773 1.56H5.333c-1.51-.036-2.769-.556-3.773-1.56S.036 18.858 0 17.347v-7.36c.036-1.511.556-2.765 1.56-3.76 1.004-.996 2.262-1.52 3.773-1.574h.774l-1.174-1.12a1.234 1.234 0 0 1-.373-.906c0-.356.124-.658.373-.907l.027-.027c.267-.249.573-.373.92-.373.347 0 .653.124.92.373L9.653 4.44c.071.071.134.142.187.213h4.267a.836.836 0 0 1 .16-.213l2.853-2.747c.267-.249.573-.373.92-.373.347 0 .662.151.929.4.267.249.391.551.391.907 0 .355-.124.657-.373.906zM5.333 7.24c-.746.018-1.373.276-1.88.773-.506.498-.769 1.13-.786 1.894v7.52c.017.764.28 1.395.786 1.893.507.498 1.134.756 1.88.773h13.334c.746-.017 1.373-.275 1.88-.773.506-.498.769-1.129.786-1.893v-7.52c-.017-.765-.28-1.396-.786-1.894-.507-.497-1.134-.755-1.88-.773zM8 11.107c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c0-.373.129-.689.386-.947.258-.257.574-.386.947-.386zm8 0c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c.017-.391.15-.711.4-.96.249-.249.56-.373.933-.373Z"/>
      </svg>
    );
  }
  if (platform === "Xiaohongshu") {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="currentColor">
        <path d="M22.405 9.879c.002.016.01.02.07.019h.725a.797.797 0 0 0 .78-.972.794.794 0 0 0-.884-.618.795.795 0 0 0-.692.794c0 .101-.002.666.001.777zm-11.509 4.808c-.203.001-1.353.004-1.685.003a2.528 2.528 0 0 1-.766-.126.025.025 0 0 0-.03.014L7.7 16.127a.025.025 0 0 0 .01.032c.111.06.336.124.495.124.66.01 1.32.002 1.981 0 .01 0 .02-.006.023-.015l.712-1.545a.025.025 0 0 0-.024-.036zM.477 9.91c-.071 0-.076.002-.076.01a.834.834 0 0 0-.01.08c-.027.397-.038.495-.234 3.06-.012.24-.034.389-.135.607-.026.057-.033.042.003.112.046.092.681 1.523.787 1.74.008.015.011.02.017.02.008 0 .033-.026.047-.044.147-.187.268-.391.371-.606.306-.635.44-1.325.486-1.706.014-.11.021-.22.03-.33l.204-2.616.022-.293c.003-.029 0-.033-.03-.034zm7.203 3.757a1.427 1.427 0 0 1-.135-.607c-.004-.084-.031-.39-.235-3.06a.443.443 0 0 0-.01-.082c-.004-.011-.052-.008-.076-.008h-1.48c-.03.001-.034.005-.03.034l.021.293c.076.982.153 1.964.233 2.946.05.4.186 1.085.487 1.706.103.215.223.419.37.606.015.018.037.051.048.049.02-.003.742-1.642.804-1.765.036-.07.03-.055.003-.112zm3.861-.913h-.872a.126.126 0 0 1-.116-.178l1.178-2.625a.025.025 0 0 0-.023-.035l-1.318-.003a.148.148 0 0 1-.135-.21l.876-1.954a.025.025 0 0 0-.023-.035h-1.56c-.01 0-.02.006-.024.015l-.926 2.068c-.085.169-.314.634-.399.938a.534.534 0 0 0-.02.191.46.46 0 0 0 .23.378.981.981 0 0 0 .46.119h.59c.041 0-.688 1.482-.834 1.972a.53.53 0 0 0-.023.172.465.465 0 0 0 .23.398c.15.092.342.12.475.12l1.66-.001c.01 0 .02-.006.023-.015l.575-1.28a.025.025 0 0 0-.024-.035zm-6.93-4.937H3.1a.032.032 0 0 0-.034.033c0 1.048-.01 2.795-.01 6.829 0 .288-.269.262-.28.262h-.74c-.04.001-.044.004-.04.047.001.037.465 1.064.555 1.263.01.02.03.033.051.033.157.003.767.009.938-.014.153-.02.3-.06.438-.132.3-.156.49-.419.595-.765.052-.172.075-.353.075-.533.002-2.33 0-4.66-.007-6.991a.032.032 0 0 0-.032-.032zm11.784 6.896c0-.014-.01-.021-.024-.022h-1.465c-.048-.001-.049-.002-.05-.049v-4.66c0-.072-.005-.07.07-.07h.863c.08 0 .075.004.075-.074V8.393c0-.082.006-.076-.08-.076h-3.5c-.064 0-.075-.006-.075.073v1.445c0 .083-.006.077.08.077h.854c.075 0 .07-.004.07.07v4.624c0 .095.008.084-.085.084-.37 0-1.11-.002-1.304 0-.048.001-.06.03-.06.03l-.697 1.519s-.014.025-.008.036c.006.01.013.008.058.008 1.748.003 3.495.002 5.243.002.03-.001.034-.006.035-.033v-1.539zm4.177-3.43c0 .013-.007.023-.02.024-.346.006-.692.004-1.037.004-.014-.002-.022-.01-.022-.024-.005-.434-.007-.869-.01-1.303 0-.072-.006-.071.07-.07l.733-.003c.041 0 .081.002.12.015.093.025.16.107.165.204.006.431.002 1.153.001 1.153zm2.67.244a1.953 1.953 0 0 0-.883-.222h-.18c-.04-.001-.04-.003-.042-.04V10.21c0-.132-.007-.263-.025-.394a1.823 1.823 0 0 0-.153-.53 1.533 1.533 0 0 0-.677-.71 2.167 2.167 0 0 0-1-.258c-.153-.003-.567 0-.72 0-.07 0-.068.004-.068-.065V7.76c0-.031-.01-.041-.046-.039H17.93s-.016 0-.023.007c-.006.006-.008.012-.008.023v.546c-.008.036-.057.015-.082.022h-.95c-.022.002-.028.008-.03.032v1.481c0 .09-.004.082.082.082h.913c.082 0 .072.128.072.128V11.19s.003.117-.06.117h-1.482c-.068 0-.06.082-.06.082v1.445s-.01.068.064.068h1.457c.082 0 .076-.006.076.079v3.225c0 .088-.007.081.082.081h1.43c.09 0 .082.007.082-.08v-3.27c0-.029.006-.035.033-.035l2.323-.003c.098 0 .191.02.28.061a.46.46 0 0 1 .274.407c.008.395.003.79.003 1.185 0 .259-.107.367-.33.367h-1.218c-.023.002-.029.008-.028.033.184.437.374.871.57 1.303a.045.045 0 0 0 .04.026c.17.005.34.002.51.003.15-.002.517.004.666-.01a2.03 2.03 0 0 0 .408-.075c.59-.18.975-.698.976-1.313v-1.981c0-.128-.01-.254-.034-.38 0 .078-.029-.641-.724-.998z"/>
      </svg>
    );
  }
  if (platform === "Kuaishou") {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="currentColor">
        <path d="M18.315 12.264c2.33 0 4.218 1.88 4.218 4.2V19.8c0 2.32-1.888 4.2-4.218 4.2h-6.202a4.218 4.218 0 0 1-4.023-2.938l-3.676 1.833a2.04 2.04 0 0 1-2.731-.903 2.015 2.015 0 0 1-.216-.907v-5.94a2.03 2.03 0 0 1 2.035-2.024 2.044 2.044 0 0 1 .919.218l3.673 1.85a4.218 4.218 0 0 1 4.02-2.925zm-.062 2.162h-6.078c-1.153 0-2.09.921-2.108 2.065v3.247c0 1.148.925 2.081 2.073 2.1h6.113c1.153 0 2.09-.922 2.109-2.065v-3.247a2.104 2.104 0 0 0-2.074-2.1zM4.18 15.72a.554.554 0 0 0-.555.542v3.734a.556.556 0 0 0 .798.496l.01-.004 3.463-1.756V17.51l-3.467-1.73a.557.557 0 0 0-.249-.06zM9.28 0a5.667 5.667 0 0 1 4.98 2.965 4.921 4.921 0 0 1 3.36-1.317c2.714 0 4.913 2.177 4.913 4.863 0 2.686-2.2 4.863-4.912 4.863a4.921 4.921 0 0 1-3.996-2.034 5.651 5.651 0 0 1-4.345 2.034c-3.131 0-5.67-2.546-5.67-5.687C3.61 2.546 6.149 0 9.28 0Zm8.34 3.926c-1.441 0-2.61 1.157-2.61 2.585s1.169 2.585 2.61 2.585c1.443 0 2.612-1.157 2.612-2.585s-1.169-2.585-2.611-2.585zM9.28 2.287a3.395 3.395 0 0 0-3.39 3.4c0 1.877 1.518 3.4 3.39 3.4a3.395 3.395 0 0 0 3.39-3.4c0-1.878-1.518-3.4-3.39-3.4z"/>
      </svg>
    );
  }
  return <ExternalLink className={className} />;
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
  if (url.includes("kuaishou.com")) return "Kuaishou";
  return "Video";
}

/** Returns a warning string if the URL looks like a profile/page rather than
 *  a video link, or null if it seems fine. */
export function getNonVideoUrlWarning(url: string): string | null {
  const lower = url.toLowerCase();
  const platform = getPlatform(url);

  // Known video URL patterns -- these are always valid
  if (/\/(video|reel|p|shorts|watch)\b/i.test(lower)) return null;
  // Xiaohongshu /explore/{id} is a video link (has an alphanumeric ID after /explore/)
  if (lower.includes("xiaohongshu.com/explore/") && /\/explore\/[a-z0-9]+/.test(lower)) return null;
  // Bilibili /video/BVxxx is already caught by /video/ above
  // Kuaishou /short-video/{id} is a video link
  if (lower.includes("kuaishou.com/short-video/")) return null;

  const nonVideoPatterns = ["/user/", "/profile/", "/hashtag/", "/search", "/explore", "/@"];
  const isNonVideo = nonVideoPatterns.some((p) => lower.includes(p));
  if (isNonVideo) {
    return `This looks like a ${platform} profile or page, not a video link. Download may fail.`;
  }
  return null;
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
