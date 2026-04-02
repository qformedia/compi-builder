import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { saveSession, getSessions, type ClipSessionRecord } from "@/lib/clip-sessions";
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
  ArrowRight,
  AlertTriangle,
  Download,
  ChevronDown,
  ChevronRight,
  History,
} from "lucide-react";
import type { AppSettings } from "@/types";

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
  profileUrl: string | null;
  creatorStatus: CreatorStatus;
  creatorId: string | null;
  creatorName: string | null;
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
}

type Phase = "input" | "review" | "creating" | "done";

interface Props {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
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
  const [emailDraft, setEmailDraft] = useState("");
  const [emailResolving, setEmailResolving] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [owners, setOwners] = useState<Array<{ id: string; email: string; firstName: string; lastName: string }>>([]);
  const [selectedOwnerId, setSelectedOwnerId] = useState(settings.ownerId || "");
  const [searchType, setSearchType] = useState<"General Search" | "Specific Search">("General Search");
  const [sessionHistory, setSessionHistory] = useState<ClipSessionRecord[]>([]);
  const [historyVisible, setHistoryVisible] = useState(5);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const historyLoaded = useRef(false);

  const token = settings.hubspotToken;

  useEffect(() => {
    if (!token) return;
    invoke<Array<{ id: string; email: string; firstName: string; lastName: string }>>("list_owners", { token })
      .then(setOwners)
      .catch(() => {});
  }, [token]);

  useEffect(() => {
    if (settings.ownerId) setSelectedOwnerId(settings.ownerId);
  }, [settings.ownerId]);

  useEffect(() => {
    if (!historyLoaded.current) {
      historyLoaded.current = true;
      setSessionHistory(getSessions());
    }
  }, []);

  const handleParse = useCallback(async () => {
    if (!rawUrls.trim()) return;

    const parsed: ParsedEntry[] = await invoke("parse_clip_urls", { raw: rawUrls });
    if (parsed.length === 0) return;

    const newEntries: ClipEntry[] = parsed.map((p) => ({
      url: p.url,
      platform: p.platform,
      handle: p.handle,
      profileUrl: p.profileUrl,
      creatorStatus: "pending",
      creatorId: null,
      creatorName: null,
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
    }));

    setEntries(newEntries);
    setPhase("review");

    // Start resolving: first check for existing clips
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
  }, [rawUrls, token, settings]);

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
    const updated = [...items];
    setEntries([...updated]);

    // Resolve Instagram handles only for non-existing clips
    for (let i = 0; i < updated.length; i++) {
      const entry = updated[i];
      if (entry.existingClipId) continue;
      if (entry.platform === "instagram" && !entry.handle) {
        updated[i] = { ...updated[i], creatorStatus: "resolving" };
        setEntries([...updated]);

        try {
          const info: {
            handle: string;
            profileUrl: string;
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
            };
          } else {
            updated[idx] = {
              ...updated[idx],
              creatorStatus: "new",
              creatorName: updated[idx].handle,
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

    // Re-lookup this single creator
    (async () => {
      try {
        const result: {
          results: Array<{
            profileUrl: string;
            found: boolean;
            creatorId?: string;
            name?: string;
          }>;
        } = await invoke("lookup_creators_by_social", {
          token,
          platform,
          profileUrls: [profileUrl],
        });
        const lookup = result.results[0];
        const reUpdated = [...entries];
        reUpdated[index] = {
          ...updated[index],
          creatorStatus: lookup?.found ? "existing" : "new",
          creatorId: lookup?.creatorId ?? null,
          creatorName: lookup?.found ? (lookup.name ?? newHandle) : newHandle,
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
    setCreating(true);
    setPhase("creating");
    const updated = [...entries];
    const total = updated.length;
    setCreateProgress({ current: 0, total });

    // Group entries by unique profile URL to avoid creating duplicate creators
    const creatorMap = new Map<string, string>(); // profileUrl -> creatorId

    // Pre-populate with existing creators
    for (const entry of updated) {
      if (entry.creatorStatus === "existing" && entry.profileUrl && entry.creatorId) {
        creatorMap.set(entry.profileUrl, entry.creatorId);
      }
    }

    for (let i = 0; i < updated.length; i++) {
      const entry = updated[i];
      try {
        let creatorId = entry.profileUrl ? creatorMap.get(entry.profileUrl) : null;

        // Create creator if new and not already created for another clip
        if (!creatorId && entry.creatorStatus === "new" && entry.profileUrl && entry.handle) {
          const created: { id: string; name: string } = await invoke("create_creator", {
            token,
            name: entry.handle,
            platform: entry.platform,
            profileUrl: entry.profileUrl,
            ownerId,
          });
          creatorId = created.id;
          creatorMap.set(entry.profileUrl, creatorId);
        }

        // Use existing clip or create new one
        let clipId: string;
        const alreadyExisted = !!entry.existingClipId;
        if (alreadyExisted) {
          clipId = entry.existingClipId!;
        } else {
          const clipResult: { id: string; link: string } = await invoke("create_external_clip", {
            token,
            link: entry.url,
            ownerId,
            foundIn: searchType,
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

      setCreateProgress({ current: i + 1, total });
      setEntries([...updated]);

      // Small delay between creates
      if (i < updated.length - 1) {
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    setCreating(false);
    setPhase("done");

    // Async metadata fetch for all created clips
    fetchMetadataForCreated(updated);
  };

  const fetchMetadataForCreated = async (items: ClipEntry[]) => {
    setMetricsFetching(true);
    const updated = [...items];
    const eligible = updated.filter((e) => e.clipId && e.created && !e.existingClipId);
    setMetricsProgress({ current: 0, total: eligible.length });
    let processed = 0;

    for (let i = 0; i < updated.length; i++) {
      const entry = updated[i];
      if (!entry.clipId || !entry.created) continue;
      if (entry.existingClipId) continue;

      updated[i] = { ...updated[i], metricStatus: "fetching" };
      setEntries([...updated]);

      try {
        let metrics = entry.metricsSource === "ytdlp"
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

          updated[i] = {
            ...updated[i],
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
      } catch {
        updated[i] = { ...updated[i], metricStatus: "failed" };
      }

      processed++;
      setMetricsProgress({ current: processed, total: eligible.length });
      setEntries([...updated]);
    }

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
        };
      });

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
  };

  const handleReset = () => {
    setRawUrls("");
    setEntries([]);
    setPhase("input");
    setCreateProgress({ current: 0, total: 0 });
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

  const PlatformIcon = ({ platform }: { platform: string }) =>
    platform === "instagram"
      ? <Instagram className="h-4 w-4 text-pink-500" />
      : <Music2 className="h-4 w-4 text-cyan-500" />;

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
        <div className="flex flex-col gap-4 max-w-2xl mx-auto w-full pt-8">
          <div className="space-y-3">
            <h2 className="text-lg font-semibold">Create Clips</h2>
            <p className="text-sm text-muted-foreground">
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
            {rawUrls.trim() && (
              <p className="text-xs text-muted-foreground">
                {rawUrls.trim().split("\n").filter((l) => l.trim()).length} URLs detected
              </p>
            )}
          </div>

          <div className="flex rounded-md overflow-hidden border">
            <button
              onClick={() => setSearchType("General Search")}
              className="flex-1 px-3 py-1.5 text-xs font-medium cursor-pointer transition-colors"
              style={
                searchType === "General Search"
                  ? { backgroundColor: "rgb(106, 120, 209)", color: "#fff" }
                  : {}
              }
            >
              General Search
            </button>
            <button
              onClick={() => setSearchType("Specific Search")}
              className="flex-1 px-3 py-1.5 text-xs font-medium cursor-pointer transition-colors border-l"
              style={
                searchType === "Specific Search"
                  ? { backgroundColor: "rgb(0, 164, 189)", color: "#fff" }
                  : {}
              }
            >
              Specific Search
            </button>
          </div>

          <Button
            onClick={handleParse}
            disabled={!rawUrls.trim() || !token}
            className="cursor-pointer"
          >
            <Clipboard className="mr-2 h-4 w-4" />
            Process URLs
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>

          {!token && (
            <p className="text-xs text-destructive">Set your HubSpot token in Settings first.</p>
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
                            const header = "Clip ID,Link,Platform,Handle,Creator ID,Creator Main Link,Found In,Caption,Likes,Comments,Views,Shares,Posted Date,Social Media Tags,Already Existed";
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
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 text-red-700 bg-red-100 dark:bg-red-900/30 dark:text-red-400">{metricsFailed} failed</Badge>
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
                          <button
                            onClick={() => entry.profileUrl && openUrl(entry.profileUrl)}
                            className="text-xs font-medium hover:underline cursor-pointer truncate max-w-[120px]"
                            title={entry.profileUrl ?? undefined}
                          >
                            @{entry.handle}
                          </button>
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
                    <span title="Metrics fetch failed"><AlertCircle className="h-3 w-3 text-red-500" /></span>
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
