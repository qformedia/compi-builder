import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FolderOpen, FileText, Loader2, CheckCircle } from "lucide-react";
import type { AppSettings } from "@/types";

/** Translate raw updater error messages into a short, user-friendly hint. */
function summariseUpdateError(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes("404") || s.includes("not found") || s.includes("no release"))
    return "no update file found on server";
  if (s.includes("network") || s.includes("connect") || s.includes("dns") || s.includes("fetch"))
    return "network error — check your internet connection";
  if (s.includes("signature") || s.includes("invalid signature") || s.includes("verification"))
    return "update signature is invalid";
  if (s.includes("403") || s.includes("unauthorized") || s.includes("forbidden"))
    return "server access denied";
  if (s.includes("timeout"))
    return "request timed out — check your internet connection";
  return "unexpected error";
}

const BROWSER_OPTIONS = [
  { value: "chrome", label: "Google Chrome" },
  { value: "firefox", label: "Firefox" },
  { value: "safari", label: "Safari" },
  { value: "edge", label: "Microsoft Edge" },
  { value: "brave", label: "Brave" },
  { value: "opera", label: "Opera" },
  { value: "chromium", label: "Chromium" },
];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: AppSettings;
  onSave: (settings: AppSettings) => void;
  onCheckUpdate?: () => Promise<"up-to-date" | "available" | { error: string }>;
}

export function SettingsDialog({ open, onOpenChange, settings, onSave, onCheckUpdate }: Props) {
  const [draft, setDraft] = useState(settings);
  const [updateCheck, setUpdateCheck] = useState<"idle" | "checking" | "up-to-date" | "available" | { error: string }>("idle");
  const [saving, setSaving] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);

  // Reset draft when dialog opens
  const handleOpenChange = (next: boolean) => {
    if (next) { setDraft(settings); setEmailError(null); }
    if (!saving) onOpenChange(next);
  };

  const handleSave = async () => {
    const emailChanged = draft.ownerEmail.trim() !== settings.ownerEmail;
    const emailCleared = !draft.ownerEmail.trim();

    // If email was cleared, reset ownerId too
    if (emailCleared) {
      onSave({ ...draft, ownerEmail: "", ownerId: "" });
      onOpenChange(false);
      return;
    }

    // If email changed, resolve the owner ID
    if (emailChanged && draft.ownerEmail.trim()) {
      setSaving(true);
      setEmailError(null);
      try {
        const id = await invoke<string>("resolve_owner_id", {
          token: draft.hubspotToken,
          email: draft.ownerEmail.trim(),
        });
        onSave({ ...draft, ownerEmail: draft.ownerEmail.trim(), ownerId: id });
        onOpenChange(false);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setEmailError(msg);
      } finally {
        setSaving(false);
      }
      return;
    }

    onSave(draft);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          {/* HubSpot Token */}
          <div className="grid gap-2">
            <Label htmlFor="token">HubSpot Private App Token</Label>
            <Input
              id="token"
              type="password"
              value={draft.hubspotToken}
              onChange={(e) =>
                setDraft({ ...draft, hubspotToken: e.target.value })
              }
              placeholder="pat-na1-..."
            />
          </div>

          {/* Root Folder */}
          <div className="grid gap-2">
            <Label htmlFor="folder">Projects Root Folder</Label>
            <div className="flex gap-2">
              <Input
                id="folder"
                value={draft.rootFolder}
                onChange={(e) =>
                  setDraft({ ...draft, rootFolder: e.target.value })
                }
                placeholder="/Users/you/Videos/CompiBuilder"
              />
              <Button
                variant="outline"
                size="icon"
                onClick={async () => {
                  const selected = await openDialog({ directory: true });
                  if (selected) {
                    setDraft({ ...draft, rootFolder: selected });
                  }
                }}
              >
                <FolderOpen className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Each video project will create a subfolder here.
            </p>
          </div>

          {/* Browser Cookies */}
          <div className="grid gap-2">
            <Label>Browser for Cookies</Label>
            <Select
              value={draft.cookiesBrowser || "_none"}
              onValueChange={(val) =>
                setDraft({ ...draft, cookiesBrowser: val === "_none" ? "" : val })
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Select browser..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_none">None (disabled)</SelectItem>
                {BROWSER_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="rounded-md bg-muted p-2.5 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">
                Required for Instagram, Douyin, and private content
              </p>
              <p className="mt-1">
                Select the browser where you are logged into Instagram / Douyin.
                The app reads your browser cookies automatically to download
                videos and fetch thumbnails. No extensions or exports needed.
              </p>
              <p className="mt-1.5 font-medium text-orange-500">
                Keep Chrome closed while downloading if you get cookie errors.
              </p>
            </div>
          </div>

          {/* Owner Email */}
          <div className="grid gap-2">
            <Label htmlFor="owner-email">Your Email (for HubSpot ownership)</Label>
            <Input
              id="owner-email"
              type="email"
              value={draft.ownerEmail}
              onChange={(e) => {
                setDraft({ ...draft, ownerEmail: e.target.value, ownerId: "" });
                setEmailError(null);
              }}
              placeholder="you@company.com"
            />
            {emailError && (
              <p className="text-xs text-destructive">{emailError}</p>
            )}
            {draft.ownerId && (
              <p className="text-xs text-green-600 flex items-center gap-1">
                <CheckCircle className="h-3 w-3" /> Verified
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Used as the Owner when creating clips via General Search. Verified against HubSpot on save.
            </p>
          </div>

          {/* HubSpot Preview */}
          <div className="flex items-center justify-between gap-4">
            <div className="grid gap-0.5">
              <Label htmlFor="hs-preview">Preview from HubSpot</Label>
              <p className="text-xs text-muted-foreground">
                Play uploaded videos from HubSpot instead of embedding from social networks
              </p>
            </div>
            <button
              id="hs-preview"
              role="switch"
              aria-checked={draft.preferHubSpotPreview ?? true}
              onClick={() => setDraft({ ...draft, preferHubSpotPreview: !(draft.preferHubSpotPreview ?? true) })}
              className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                (draft.preferHubSpotPreview ?? true) ? "bg-primary" : "bg-muted-foreground/30"
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                  (draft.preferHubSpotPreview ?? true) ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </button>
          </div>

          {/* Advanced settings */}
          <details className="group">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
              Advanced settings
            </summary>
            <div className="mt-2 grid gap-4">
              {/* Evil0ctal API for Chinese platforms */}
              <div className="grid gap-2">
                <Label htmlFor="evil0ctal-url">Douyin/Kuaishou/Bilibili API URL</Label>
                <Input
                  id="evil0ctal-url"
                  value={draft.evil0ctalApiUrl}
                  onChange={(e) =>
                    setDraft({ ...draft, evil0ctalApiUrl: e.target.value })
                  }
                  placeholder="https://your-app.railway.app"
                />
                <p className="text-xs text-muted-foreground">
                  Self-hosted{" "}
                  <a
                    href="https://github.com/Evil0ctal/Douyin_TikTok_Download_API"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    Douyin/TikTok Download API
                  </a>{" "}
                  for Douyin, Kuaishou, and Bilibili. Falls back to yt-dlp if empty or unavailable.
                </p>
              </div>

              {/* Manual Cookies File */}
              <div className="grid gap-2">
                <Label htmlFor="cookies">Manual cookies.txt file</Label>
                <div className="flex gap-2">
                  <Input
                    id="cookies"
                    value={draft.cookiesFile}
                    onChange={(e) =>
                      setDraft({ ...draft, cookiesFile: e.target.value })
                    }
                    placeholder="Optional: path to cookies.txt"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={async () => {
                      const selected = await openDialog({
                        filters: [{ name: "Cookies", extensions: ["txt"] }],
                      });
                      if (selected) {
                        setDraft({ ...draft, cookiesFile: selected });
                      }
                    }}
                  >
                    <FileText className="h-4 w-4" />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Only needed if browser cookies above don't work. Export with the{" "}
                  <a
                    href="https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    Get cookies.txt LOCALLY
                  </a>{" "}
                  extension.
                </p>
              </div>
            </div>
          </details>
        </div>
        <DialogFooter className="flex-row items-center !justify-between">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>v{__APP_VERSION__}</span>
            {onCheckUpdate && (
              <>
                <button
                  className="underline hover:text-foreground cursor-pointer disabled:opacity-50 disabled:no-underline"
                  disabled={updateCheck === "checking"}
                  onClick={async () => {
                    setUpdateCheck("checking");
                    const result = await onCheckUpdate();
                    setUpdateCheck(result);
                    if (result === "up-to-date" || result === "available") {
                      setTimeout(() => setUpdateCheck("idle"), 4000);
                    }
                  }}
                >
                  {updateCheck === "checking" ? (
                    <span className="flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" />Checking...</span>
                  ) : "Check for updates"}
                </button>
                {updateCheck === "up-to-date" && (
                  <span className="flex items-center gap-1 text-green-600"><CheckCircle className="h-3 w-3" />Up to date</span>
                )}
                {updateCheck === "available" && (
                  <span className="text-primary">Update available!</span>
                )}
                {typeof updateCheck === "object" && "error" in updateCheck && (
                  <span className="text-destructive" title={updateCheck.error}>
                    Check failed — {summariseUpdateError(updateCheck.error)}
                  </span>
                )}
              </>
            )}
          </div>
          <Button onClick={handleSave} disabled={saving} className="cursor-pointer">
            {saving && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            {saving ? "Verifying..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
