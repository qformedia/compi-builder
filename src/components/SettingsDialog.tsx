import { useState } from "react";
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
import { FolderOpen } from "lucide-react";
import type { AppSettings } from "@/types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: AppSettings;
  onSave: (settings: AppSettings) => void;
}

export function SettingsDialog({ open, onOpenChange, settings, onSave }: Props) {
  const [draft, setDraft] = useState(settings);

  // Reset draft when dialog opens
  const handleOpenChange = (next: boolean) => {
    if (next) setDraft(settings);
    onOpenChange(next);
  };

  const handleSave = () => {
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
        </div>
        <DialogFooter>
          <Button onClick={handleSave}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
