import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
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
import {
  listExcludedOwners,
  excludeOwner,
  unexcludeOwner,
  isSupabaseConfigured,
} from "@/lib/supabase";
import type { AppSettings } from "@/types";

declare const __APP_VERSION__: string;

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
  settings: AppSettings;
  onSave: (settings: AppSettings) => void;
  onCheckUpdate?: () => Promise<"up-to-date" | "available" | { error: string }>;
}

export function SettingsPage({ settings, onSave, onCheckUpdate }: Props) {
  const [draft, setDraft] = useState(settings);
  const [updateCheck, setUpdateCheck] = useState<"idle" | "checking" | "up-to-date" | "available" | { error: string }>("idle");
  const [saving, setSaving] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Excluded owners state
  const [hsOwners, setHsOwners] = useState<Array<{ id: string; email: string; firstName: string; lastName: string }>>([]);
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set());
  const [ownersLoading, setOwnersLoading] = useState(false);
  const [ownersError, setOwnersError] = useState<string | null>(null);
  const [excludeToggling, setExcludeToggling] = useState<string | null>(null);

  useEffect(() => {
    setDraft(settings);
    setEmailError(null);
  }, [settings]);

  const loadOwnerData = useCallback(async (token: string) => {
    if (!token.trim()) return;
    setOwnersLoading(true);
    setOwnersError(null);
    // Owners and excludes are loaded independently so a missing/empty
    // hs_excluded_owners table (e.g. migration not yet applied) doesn't
    // hide the owners list.
    try {
      const owners = await invoke<Array<{ id: string; email: string; firstName: string; lastName: string }>>(
        "list_owners",
        { token },
      );
      owners.sort((a, b) => {
        const nameA = `${a.firstName} ${a.lastName}`.trim().toLowerCase();
        const nameB = `${b.firstName} ${b.lastName}`.trim().toLowerCase();
        return nameA.localeCompare(nameB);
      });
      setHsOwners(owners);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setOwnersError(msg || "Failed to load HubSpot owners");
      setHsOwners([]);
    } finally {
      setOwnersLoading(false);
    }

    try {
      const excluded = await listExcludedOwners();
      setExcludedIds(new Set(excluded.map((e) => e.ownerId)));
    } catch {
      setExcludedIds(new Set());
    }
  }, []);

  useEffect(() => {
    loadOwnerData(draft.hubspotToken);
  }, [draft.hubspotToken, loadOwnerData]);

  const handleToggleExclude = async (
    owner: { id: string; email: string; firstName: string; lastName: string },
    exclude: boolean,
  ) => {
    setExcludeToggling(owner.id);
    try {
      if (exclude) {
        const displayName = [owner.firstName, owner.lastName].filter(Boolean).join(" ") || undefined;
        await excludeOwner({
          ownerId: owner.id,
          email: owner.email || undefined,
          displayName,
        });
        setExcludedIds((prev) => new Set(prev).add(owner.id));
      } else {
        await unexcludeOwner(owner.id);
        setExcludedIds((prev) => {
          const next = new Set(prev);
          next.delete(owner.id);
          return next;
        });
      }
    } catch {
      // Silently fail — will retry on next toggle or reload
    } finally {
      setExcludeToggling(null);
    }
  };

  const handleSave = async () => {
    const emailChanged = draft.ownerEmail.trim() !== settings.ownerEmail;
    const emailCleared = !draft.ownerEmail.trim();

    if (emailCleared) {
      onSave({ ...draft, ownerEmail: "", ownerId: "" });
      flashSaved();
      return;
    }

    if (emailChanged && draft.ownerEmail.trim()) {
      setSaving(true);
      setEmailError(null);
      try {
        const id = await invoke<string>("resolve_owner_id", {
          token: draft.hubspotToken,
          email: draft.ownerEmail.trim(),
        });
        onSave({ ...draft, ownerEmail: draft.ownerEmail.trim(), ownerId: id });
        flashSaved();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setEmailError(msg);
      } finally {
        setSaving(false);
      }
      return;
    }

    onSave(draft);
    flashSaved();
  };

  const flashSaved = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-6 space-y-6">
        <h2 className="text-lg font-semibold">Settings</h2>

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
          {draft.hubspotToken.trim() && !draft.ownerEmail.trim() && (
            <p className="text-xs text-amber-700">
              You have a HubSpot token but no owner email — new creators won't
              be assigned to anyone. Set an owner email to fix.
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

            <div className="grid gap-2">
              <Label htmlFor="socialkit">SocialKit (optional)</Label>
              <Input
                id="socialkit"
                type="password"
                value={draft.socialkitApiKey}
                onChange={(e) => setDraft({ ...draft, socialkitApiKey: e.target.value })}
                placeholder="access key from socialkit.dev"
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                Used as a fallback when free Instagram resolution fails. Leave empty to skip — those
                clips fall back to the manual creator picker.
              </p>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="socialfetch">SocialFetch (optional)</Label>
              <Input
                id="socialfetch"
                type="password"
                value={draft.socialfetchApiKey}
                onChange={(e) => setDraft({ ...draft, socialfetchApiKey: e.target.value })}
                placeholder="API key from socialfetch.dev"
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                Last-resort paid fallback for TikTok / Instagram / YouTube creator
                resolution and TikTok / Instagram media download. Only billed when every
                cheaper path has already failed. Leave empty to skip.
              </p>
            </div>

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

            {/* Excluded Owners */}
            <details className="group/excluded">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
                Excluded owners
              </summary>
              <div className="mt-2 grid gap-2">
                <p className="text-xs text-muted-foreground">
                  Toggle off any HubSpot user you want hidden from the Create &gt; Owner dropdown
                  (e.g. ex-teammates, pending invites). Synced across all CompiFlow installs.
                </p>
                {!draft.hubspotToken.trim() ? (
                  <p className="text-xs text-muted-foreground italic">
                    Add a HubSpot token above to manage owner visibility.
                  </p>
                ) : !isSupabaseConfigured ? (
                  <p className="text-xs text-muted-foreground italic">
                    Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to
                    manage owner visibility.
                  </p>
                ) : ownersLoading ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Loading owners...
                  </div>
                ) : ownersError ? (
                  <p className="text-xs text-destructive">
                    Couldn't load HubSpot owners — {ownersError}
                  </p>
                ) : hsOwners.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">
                    No HubSpot owners returned. Check your token has the required scopes.
                  </p>
                ) : (
                  <div className="max-h-72 overflow-y-auto rounded-md border divide-y">
                    {hsOwners.map((o) => {
                      const name = [o.firstName, o.lastName].filter(Boolean).join(" ") || o.email || o.id;
                      const isExcluded = excludedIds.has(o.id);
                      const isVisible = !isExcluded;
                      const toggling = excludeToggling === o.id;
                      return (
                        <div
                          key={o.id}
                          className="flex items-center gap-3 px-3 py-2 text-xs hover:bg-muted/40"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="truncate font-medium text-foreground">{name}</div>
                            {o.email && (
                              <div className="truncate text-muted-foreground">{o.email}</div>
                            )}
                          </div>
                          {toggling && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                          <button
                            type="button"
                            role="switch"
                            aria-checked={isVisible}
                            aria-label={`${name} ${isVisible ? "visible" : "hidden"} in Create dropdown`}
                            disabled={toggling}
                            onClick={() => handleToggleExclude(o, isVisible)}
                            className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-50 ${
                              isVisible ? "bg-primary" : "bg-muted-foreground/30"
                            }`}
                          >
                            <span
                              className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                                isVisible ? "translate-x-4" : "translate-x-0"
                              }`}
                            />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </details>
          </div>
        </details>

        {/* Footer: save + version */}
        <div className="flex items-center justify-between border-t pt-4">
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
            {saved ? (
              <span className="flex items-center gap-1.5"><CheckCircle className="h-3.5 w-3.5" />Saved</span>
            ) : saving ? "Verifying..." : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
