import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { resolveOwnerId } from "@/lib/owner-email";

interface OptionalSettingsPayload {
  ownerEmail?: string;
  ownerId?: string;
  socialkitApiKey?: string;
  socialfetchApiKey?: string;
}

interface Props {
  open: boolean;
  hubspotToken: string;
  missingEmail: boolean;
  missingSocialKit: boolean;
  missingSocialFetch: boolean;
  onSave: (payload: OptionalSettingsPayload) => void;
  onSkip: () => void;
}

export function MissingOptionalSettingsDialog({
  open,
  hubspotToken,
  missingEmail,
  missingSocialKit,
  missingSocialFetch,
  onSave,
  onSkip,
}: Props) {
  const [email, setEmail] = useState("");
  const [socialKit, setSocialKit] = useState("");
  const [socialFetch, setSocialFetch] = useState("");
  const [saving, setSaving] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setEmailError(null);

    const payload: OptionalSettingsPayload = {};
    if (missingSocialKit && socialKit.trim()) {
      payload.socialkitApiKey = socialKit.trim();
    }
    if (missingSocialFetch && socialFetch.trim()) {
      payload.socialfetchApiKey = socialFetch.trim();
    }

    if (missingEmail && email.trim()) {
      try {
        const id = await resolveOwnerId(hubspotToken, email.trim());
        payload.ownerEmail = email.trim();
        payload.ownerId = id;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setEmailError(msg);
        setSaving(false);
        return;
      }
    }

    setSaving(false);
    onSave(payload);
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => {
      if (!isOpen && !saving) onSkip();
    }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Complete Setup</DialogTitle>
          <DialogDescription>
            You are missing some optional settings. Filling these out now helps avoid errors later. You can skip this and configure them in Settings anytime.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-6 py-4 max-h-[60vh] overflow-y-auto">
          {missingEmail && (
            <div className="grid gap-2">
              <Label htmlFor="startup-owner-email">Your Email (for HubSpot ownership)</Label>
              <Input
                id="startup-owner-email"
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setEmailError(null);
                }}
                placeholder="you@company.com"
                disabled={saving}
              />
              {emailError && (
                <p className="text-xs text-destructive">{emailError}</p>
              )}
              <p className="text-xs text-muted-foreground">
                Used as the Owner when creating clips via General Search. Verified against HubSpot on save.
              </p>
            </div>
          )}

          {missingSocialKit && (
            <div className="grid gap-2">
              <Label htmlFor="startup-socialkit">SocialKit (optional)</Label>
              <Input
                id="startup-socialkit"
                type="password"
                value={socialKit}
                onChange={(e) => setSocialKit(e.target.value)}
                placeholder="access key from socialkit.dev"
                autoComplete="off"
                disabled={saving}
              />
              <p className="text-xs text-muted-foreground">
                Used as a fallback when free Instagram resolution fails.
              </p>
            </div>
          )}

          {missingSocialFetch && (
            <div className="grid gap-2">
              <Label htmlFor="startup-socialfetch">SocialFetch (optional)</Label>
              <Input
                id="startup-socialfetch"
                type="password"
                value={socialFetch}
                onChange={(e) => setSocialFetch(e.target.value)}
                placeholder="API key from socialfetch.dev"
                autoComplete="off"
                disabled={saving}
              />
              <p className="text-xs text-muted-foreground">
                Last-resort paid fallback for TikTok / Instagram / YouTube creator resolution and media download.
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onSkip} disabled={saving}>
            Skip
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
