import { openUrl } from "@tauri-apps/plugin-opener";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DirectVideoPlayer, getEmbedUrl } from "@/components/ClipCard";
import type { Clip } from "@/types";

interface ClipPreviewProps {
  clip: Pick<Clip, "link" | "originalClip">;
  preferHubSpotPreview?: boolean;
  onClose: () => void;
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      className="absolute right-1 top-1 z-10 rounded-full bg-black/60 p-1 text-white hover:bg-black/80"
      title="Close preview"
    >
      <X className="h-3.5 w-3.5" />
    </button>
  );
}

/**
 * Shared inline clip preview used by Data Integrity rows and the Tag tab.
 * Render order:
 *   1. HubSpot-hosted MP4 (when `preferHubSpotPreview` and `clip.originalClip`)
 *   2. Platform embed iframe (Instagram `/embed/captioned/`, TikTok, YouTube)
 *   3. "No in-app preview" fallback with an "Open in browser" CTA
 *
 * Instagram occasionally serves a "broken or removed" placeholder inside the
 * iframe for restricted/private reels — that's an upstream content issue,
 * not something we can fix client-side. Most reels embed fine.
 */
export function ClipPreview({ clip, preferHubSpotPreview, onClose }: ClipPreviewProps) {
  const useHubSpotVideo = preferHubSpotPreview && !!clip.originalClip;
  if (useHubSpotVideo) {
    return <DirectVideoPlayer src={clip.originalClip!} onClose={onClose} />;
  }

  const embedUrl = getEmbedUrl(clip.link);
  if (embedUrl) {
    return (
      <>
        <iframe
          src={embedUrl}
          className="absolute inset-0 h-full w-full"
          allowFullScreen
          allow="autoplay; encrypted-media"
        />
        <CloseButton onClose={onClose} />
      </>
    );
  }

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-muted p-4 text-center">
      <p className="text-sm font-medium text-foreground">No in-app preview</p>
      <p className="text-xs leading-relaxed text-muted-foreground">
        This platform does not have an embeddable preview here.
      </p>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={() => openUrl(clip.link)}
      >
        Open in browser
      </Button>
      <CloseButton onClose={onClose} />
    </div>
  );
}
