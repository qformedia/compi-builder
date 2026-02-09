import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  ExternalLink,
  AlertTriangle,
  Loader2,
  Plus,
  Check,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { TagPicker } from "@/components/TagPicker";
import { searchClipsByTags } from "@/lib/hubspot";
import type { AppSettings, Clip, Project } from "@/types";

interface Props {
  settings: AppSettings;
  project: Project | null;
  addClip: (clip: Clip) => void;
  removeClip: (hubspotId: string) => void;
}

export function SearchTab({ settings, project, addClip, removeClip }: Props) {
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [clips, setClips] = useState<Clip[]>([]);
  const [total, setTotal] = useState(0);
  const [nextAfter, setNextAfter] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [previewClip, setPreviewClip] = useState<Clip | null>(null);
  const [expandedCreators, setExpandedCreators] = useState<Set<string>>(
    new Set(),
  );

  const grouped = useMemo(() => {
    const map = new Map<string, Clip[]>();
    for (const clip of clips) {
      const key = clip.creatorName;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(clip);
    }
    return map;
  }, [clips]);

  const search = async (loadMore = false) => {
    if (selectedTags.length === 0) return;
    setLoading(true);
    setError(undefined);
    try {
      const result = await searchClipsByTags(
        settings.hubspotToken,
        selectedTags,
        loadMore ? nextAfter : undefined,
      );
      setClips(loadMore ? [...clips, ...result.clips] : result.clips);
      setTotal(result.total);
      setNextAfter(result.nextAfter);
      if (!loadMore) {
        setExpandedCreators(
          new Set(result.clips.map((c) => c.creatorName)),
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const toggleCreator = (name: string) => {
    setExpandedCreators((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const isInProject = (clipId: string) =>
    project?.clips.some((c) => c.hubspotId === clipId) ?? false;

  return (
    <div className="flex h-full gap-4 py-4">
      {/* Left panel: search + results */}
      <div className="flex flex-1 flex-col gap-3">
        <div className="flex gap-2">
          <div className="flex-1">
            <TagPicker selected={selectedTags} onChange={setSelectedTags} />
          </div>
          <Button
            onClick={() => search(false)}
            disabled={selectedTags.length === 0 || loading}
          >
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Search
          </Button>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {!project && clips.length === 0 && (
          <p className="text-sm text-orange-500">
            Create a project in the Project tab first to add clips.
          </p>
        )}

        {clips.length > 0 && (
          <p className="text-sm text-muted-foreground">
            {total} clip{total !== 1 ? "s" : ""} found ({clips.length} loaded)
          </p>
        )}

        <ScrollArea className="flex-1">
          <div className="flex flex-col gap-2 pr-4">
            {Array.from(grouped.entries()).map(([creator, creatorClips]) => (
              <div key={creator}>
                <button
                  onClick={() => toggleCreator(creator)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm font-medium hover:bg-muted"
                >
                  {expandedCreators.has(creator) ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                  {creator}
                  <span className="text-muted-foreground">
                    ({creatorClips.length})
                  </span>
                </button>

                {expandedCreators.has(creator) && (
                  <div className="ml-6 flex flex-col gap-1.5">
                    {creatorClips.map((clip) => (
                      <ClipRow
                        key={clip.id}
                        clip={clip}
                        isSelected={previewClip?.id === clip.id}
                        inProject={isInProject(clip.id)}
                        onPreview={() => setPreviewClip(clip)}
                        onToggle={() =>
                          isInProject(clip.id)
                            ? removeClip(clip.id)
                            : addClip(clip)
                        }
                        hasProject={!!project}
                      />
                    ))}
                  </div>
                )}
                <Separator className="mt-1" />
              </div>
            ))}

            {nextAfter && (
              <Button
                variant="outline"
                onClick={() => search(true)}
                disabled={loading}
                className="mt-2"
              >
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Load more
              </Button>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Right panel: preview */}
      <div className="w-96 flex-shrink-0">
        <ClipPreview clip={previewClip} />
      </div>
    </div>
  );
}

function ClipRow({
  clip,
  isSelected,
  inProject,
  onPreview,
  onToggle,
  hasProject,
}: {
  clip: Clip;
  isSelected: boolean;
  inProject: boolean;
  onPreview: () => void;
  onToggle: () => void;
  hasProject: boolean;
}) {
  return (
    <Card
      className={`cursor-pointer p-2 transition-colors ${
        isSelected ? "border-primary" : ""
      }`}
      onClick={onPreview}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {clip.linkNotWorking && (
              <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 text-destructive" />
            )}
            <p className="truncate text-sm">{clip.link}</p>
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {clip.tags.slice(0, 4).map((tag) => (
              <Badge key={tag} variant="outline" className="text-xs">
                {tag}
              </Badge>
            ))}
            {clip.tags.length > 4 && (
              <Badge variant="outline" className="text-xs">
                +{clip.tags.length - 4}
              </Badge>
            )}
          </div>
          <div className="mt-1 flex gap-3 text-xs text-muted-foreground">
            {clip.score && <span>Score: {clip.score}</span>}
            {clip.editedDuration != null && (
              <span>{clip.editedDuration}s</span>
            )}
            {clip.numPublishedVideoProjects != null &&
              clip.numPublishedVideoProjects > 0 && (
                <span>Used {clip.numPublishedVideoProjects}x</span>
              )}
            {clip.availableAskFirst && (
              <span className="text-orange-500">Ask first</span>
            )}
          </div>
        </div>
        {hasProject && (
          <Button
            size="icon"
            variant={inProject ? "default" : "ghost"}
            className="h-7 w-7 flex-shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            title={inProject ? "Remove from project" : "Add to project"}
          >
            {inProject ? (
              <Check className="h-4 w-4" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
          </Button>
        )}
      </div>
    </Card>
  );
}

function ClipPreview({ clip }: { clip: Clip | null }) {
  if (!clip) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-dashed p-4">
        <p className="text-sm text-muted-foreground">
          Select a clip to preview
        </p>
      </div>
    );
  }

  const embedUrl = getEmbedUrl(clip.link);

  return (
    <div className="flex h-full flex-col gap-3 rounded-lg border p-4">
      <div className="relative aspect-[9/16] w-full overflow-hidden rounded-md bg-muted">
        {embedUrl ? (
          <iframe
            src={embedUrl}
            className="absolute inset-0 h-full w-full"
            allowFullScreen
            allow="autoplay; encrypted-media"
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground">
              Preview not available for this platform
            </p>
          </div>
        )}
      </div>

      <Button variant="outline" size="sm" asChild>
        <a href={clip.link} target="_blank" rel="noopener noreferrer">
          <ExternalLink className="mr-2 h-4 w-4" />
          Open in browser
        </a>
      </Button>

      <div className="text-sm">
        <p className="font-medium">{clip.creatorName}</p>
        {clip.editedDuration != null && (
          <p className="text-muted-foreground">
            Duration: {clip.editedDuration}s
          </p>
        )}
        {clip.clipMixLinks.length > 0 && (
          <div className="mt-2">
            <p className="text-xs font-medium">Compilation links:</p>
            {clip.clipMixLinks.map((link, i) => (
              <a
                key={i}
                href={link}
                target="_blank"
                rel="noopener noreferrer"
                className="block truncate text-xs text-blue-500 hover:underline"
              >
                {link}
              </a>
            ))}
          </div>
        )}
        {clip.notes && (
          <p className="mt-2 text-xs text-muted-foreground">{clip.notes}</p>
        )}
      </div>
    </div>
  );
}

function getEmbedUrl(url: string): string | null {
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
      const match = url.match(/\/(reel|p)\/([^/?]+)/);
      if (match) return `https://www.instagram.com/${match[1]}/${match[2]}/embed`;
    }

    return null;
  } catch {
    return null;
  }
}
