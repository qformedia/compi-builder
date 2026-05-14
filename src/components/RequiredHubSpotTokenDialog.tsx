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

interface Props {
  open: boolean;
  onSave: (token: string) => void;
}

export function RequiredHubSpotTokenDialog({ open, onSave }: Props) {
  const [token, setToken] = useState("");

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>HubSpot Token Required</DialogTitle>
          <DialogDescription>
            CompiFlow requires a HubSpot Private App Token to run. This token is used to sync video projects and tags.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="required-token">Private App Token</Label>
            <Input
              id="required-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="pat-na1-..."
              autoComplete="off"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            onClick={() => {
              if (token.trim()) onSave(token.trim());
            }}
            disabled={!token.trim()}
          >
            Save & Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
