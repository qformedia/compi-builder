import { useEffect, useMemo, useState, type ClipboardEvent } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { AlertCircle, Bug, CheckCircle2, Lightbulb, Loader2, Send, Trash2, Upload } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { isSupabaseConfigured, submitFeedback, uploadFeedbackScreenshot } from "@/lib/supabase";
import type { FeedbackFrequency, FeedbackImportance, FeedbackPayload, FeedbackType } from "@/types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Step = "type" | "form" | "success";

interface ScreenshotDraft {
  id: string;
  name: string;
  blob: Blob;
  previewUrl: string;
}

const MAX_ATTACHMENTS = 3;
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

const bugFrequencyOptions: { value: FeedbackFrequency; label: string }[] = [
  { value: "once", label: "It happened once" },
  { value: "sometimes", label: "It happens sometimes" },
  { value: "always", label: "It happens every time" },
];

const featureImportanceOptions: { value: FeedbackImportance; label: string }[] = [
  { value: "nice_to_have", label: "Nice to have" },
  { value: "important", label: "Important" },
  { value: "critical", label: "Critical for my work" },
];

export function FeedbackDialog({ open, onOpenChange }: Props) {
  const [step, setStep] = useState<Step>("type");
  const [type, setType] = useState<FeedbackType | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [frequency, setFrequency] = useState<FeedbackFrequency | undefined>();
  const [importance, setImportance] = useState<FeedbackImportance | undefined>();
  const [reporterName, setReporterName] = useState("");
  const [screenshots, setScreenshots] = useState<ScreenshotDraft[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [titleTouched, setTitleTouched] = useState(false);
  const [descriptionTouched, setDescriptionTouched] = useState(false);

  const titleLabel = type === "bug" ? "What happened?" : "What would you like to see?";
  const descriptionLabel = type === "bug" ? "What were you trying to do?" : "Tell us more";

  const submitDisabledReason = useMemo(() => {
    if (!isSupabaseConfigured) return "Feedback is not configured";
    if (title.trim().length < 3) return "Add a short title first";
    if (description.trim().length < 10) return "Add a bit more detail in the description";
    if (type === "bug" && !frequency) return "Select how often the problem happens";
    if (type === "bug" && !importance) return "Select how important this is to fix";
    if (type === "feature" && !importance) return "Select how important this is";
    return null;
  }, [type, title, description, frequency, importance]);

  const canSubmit = useMemo(() => {
    if (!type) return false;
    const hasCoreFields = title.trim().length >= 3 && description.trim().length >= 10;
    if (!hasCoreFields || submitting || !isSupabaseConfigured) return false;
    return type === "bug" ? Boolean(frequency) && Boolean(importance) : Boolean(importance);
  }, [type, title, description, frequency, importance, submitting]);

  const resetState = () => {
    for (const screenshot of screenshots) {
      URL.revokeObjectURL(screenshot.previewUrl);
    }
    setStep("type");
    setType(null);
    setTitle("");
    setDescription("");
    setFrequency(undefined);
    setImportance(undefined);
    setReporterName("");
    setScreenshots([]);
    setSubmitting(false);
    setError(null);
    setTitleTouched(false);
    setDescriptionTouched(false);
  };

  useEffect(() => {
    if (!open) {
      // Delay reset so the close animation finishes before state clears.
      const timer = setTimeout(resetState, 250);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const addImageDrafts = async (files: File[]) => {
    const validFiles = files.filter((file) => file.type.startsWith("image/") && file.size <= MAX_FILE_SIZE_BYTES);
    if (validFiles.length === 0) {
      setError(`Only image files up to ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB are supported.`);
      return;
    }

    const remainingSlots = MAX_ATTACHMENTS - screenshots.length;
    if (remainingSlots <= 0) {
      setError(`You can upload up to ${MAX_ATTACHMENTS} screenshots.`);
      return;
    }

    const selected = validFiles.slice(0, remainingSlots);
    const drafts = selected.map((file) => ({
      id: crypto.randomUUID(),
      name: file.name || `screenshot-${Date.now()}.png`,
      blob: file,
      previewUrl: URL.createObjectURL(file),
    }));

    setError(null);
    setScreenshots((prev) => [...prev, ...drafts]);
  };

  const onAttachFromDisk = async () => {
    try {
      const picked = await openDialog({
        multiple: true,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
      });
      if (!picked) return;

      const paths = Array.isArray(picked) ? picked : [picked];
      const files: File[] = [];

      for (const path of paths) {
        try {
          const fileUrl = convertFileSrc(path);
          const response = await fetch(fileUrl);
          const blob = await response.blob();
          const extension = path.split(".").pop() || "png";
          files.push(new File([blob], `screenshot-${Date.now()}.${extension}`, { type: blob.type || `image/${extension}` }));
        } catch {
          // Keep processing remaining files even if one fails.
        }
      }

      await addImageDrafts(files);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(`Unable to attach screenshot: ${message}`);
    }
  };

  const onPasteScreenshot = async (event: ClipboardEvent) => {
    const pastedImages: File[] = [];
    for (const item of event.clipboardData.items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) pastedImages.push(file);
      }
    }
    if (pastedImages.length === 0) return;

    event.preventDefault();
    await addImageDrafts(pastedImages);
  };

  const removeScreenshot = (id: string) => {
    setScreenshots((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((item) => item.id !== id);
    });
  };

  const submit = async () => {
    if (!canSubmit || !type) return;
    setSubmitting(true);
    setError(null);
    try {
      const screenshotUrls = await Promise.all(
        screenshots.map((screenshot) =>
          uploadFeedbackScreenshot(screenshot.blob, screenshot.name)
        ),
      );

      const payload: FeedbackPayload = {
        type,
        title: title.trim(),
        description: description.trim(),
        frequency: type === "bug" ? frequency : undefined,
        importance: importance,
        reporter_name: reporterName.trim() || undefined,
        screenshots: screenshotUrls,
        app_version: __APP_VERSION__,
        os_info: navigator.userAgent,
      };

      await submitFeedback(payload);
      setStep("success");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(`Could not submit feedback: ${message}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={step === "form" ? "sm:max-w-2xl" : "sm:max-w-xl"}
        onPaste={onPasteScreenshot}
      >
        {step !== "success" && (
          <DialogHeader>
            <DialogTitle>Share feedback</DialogTitle>
            <DialogDescription>
              {step === "type"
                ? "What would you like to tell us?"
                : type === "bug"
                  ? "Tell us what went wrong and we'll look into it."
                  : "Tell us about your idea and why it would help."}
            </DialogDescription>
          </DialogHeader>
        )}

        {step === "type" && (
          <div className="space-y-3">
            <Button
              variant="outline"
              className="h-auto w-full justify-start gap-3 p-4 text-left cursor-pointer"
              onClick={() => {
                setType("bug");
                setStep("form");
              }}
            >
              <Bug className="h-5 w-5 text-destructive" />
              <div>
                <p className="font-medium">Report a Problem</p>
                <p className="text-xs text-muted-foreground">
                  Something did not work as expected.
                </p>
              </div>
            </Button>
            <Button
              variant="outline"
              className="h-auto w-full justify-start gap-3 p-4 text-left cursor-pointer"
              onClick={() => {
                setType("feature");
                setStep("form");
              }}
            >
              <Lightbulb className="h-5 w-5 text-amber-500" />
              <div>
                <p className="font-medium">Suggest an Improvement</p>
                <p className="text-xs text-muted-foreground">
                  Share ideas for improvements or new features.
                </p>
              </div>
            </Button>
          </div>
        )}

        {step === "form" && type && (
          <div className="space-y-4">
            {!isSupabaseConfigured && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 flex-none" />
                <p>
                  Feedback is not configured. Add <code>VITE_SUPABASE_URL</code> and{" "}
                  <code>VITE_SUPABASE_ANON_KEY</code> in your environment variables.
                </p>
              </div>
            )}

            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between">
                <Label htmlFor="feedback-title">{titleLabel}</Label>
                <span className="text-xs text-muted-foreground tabular-nums">{title.length}/150</span>
              </div>
              <Input
                id="feedback-title"
                value={title}
                onChange={(event) => { setTitle(event.target.value); setTitleTouched(true); }}
                placeholder={type === "bug" ? "Example: Export button does nothing" : "Example: Add keyboard shortcuts"}
                maxLength={150}
              />
              {titleTouched && title.trim().length < 3 && (
                <p className="text-xs text-destructive">Please add at least a few words.</p>
              )}
            </div>

            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between">
                <Label htmlFor="feedback-description">{descriptionLabel}</Label>
                {description.length > 0 && (
                  <span className="text-xs text-muted-foreground tabular-nums">{description.length}/5000</span>
                )}
              </div>
              <Textarea
                id="feedback-description"
                value={description}
                onChange={(event) => { setDescription(event.target.value); setDescriptionTouched(true); }}
                placeholder={
                  type === "bug"
                    ? "Describe what you expected, what actually happened, and steps to reproduce."
                    : "Describe how this feature would help you and when you would use it."
                }
                maxLength={5000}
                className="min-h-28"
              />
              {descriptionTouched && description.trim().length < 10 && (
                <p className="text-xs text-destructive">A bit more detail helps us understand the issue.</p>
              )}
            </div>

            {type === "bug" && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>How often does it happen?</Label>
                  <Select value={frequency} onValueChange={(value) => setFrequency(value as FeedbackFrequency)}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Choose frequency" />
                    </SelectTrigger>
                    <SelectContent>
                      {bugFrequencyOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>How important is this to fix?</Label>
                  <Select value={importance} onValueChange={(value) => setImportance(value as FeedbackImportance)}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Choose importance" />
                    </SelectTrigger>
                    <SelectContent>
                      {featureImportanceOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            {type === "feature" && (
              <div className="space-y-2">
                <Label>How important is this to you?</Label>
                <Select value={importance} onValueChange={(value) => setImportance(value as FeedbackImportance)}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose importance" />
                  </SelectTrigger>
                  <SelectContent>
                    {featureImportanceOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Screenshots (optional)</Label>
                <span className="text-xs text-muted-foreground">{screenshots.length}/{MAX_ATTACHMENTS}</span>
              </div>
              <div className="rounded-md border border-dashed p-3">
                <div className="mt-0 flex items-center gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onAttachFromDisk}
                    disabled={screenshots.length >= MAX_ATTACHMENTS}
                    className="cursor-pointer"
                  >
                    <Upload className="mr-1.5 h-3.5 w-3.5" />
                    Attach image
                  </Button>
                  <span className="text-xs text-muted-foreground italic">or paste from clipboard (⌘V)</span>
                </div>
                {screenshots.length > 0 && (
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    {screenshots.map((shot) => (
                      <div key={shot.id} className="relative overflow-hidden rounded border">
                        <img src={shot.previewUrl} alt={shot.name} className="h-20 w-full object-cover" />
                        <button
                          type="button"
                          onClick={() => removeScreenshot(shot.id)}
                          className="absolute right-1 top-1 rounded bg-black/60 p-1 text-white hover:bg-black/80"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="feedback-name">Your name (optional)</Label>
              <Input
                id="feedback-name"
                value={reporterName}
                onChange={(event) => setReporterName(event.target.value)}
                placeholder="Example: Alex"
                maxLength={120}
              />
            </div>

            {error && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                {error}
              </div>
            )}
          </div>
        )}

        {step === "success" && (
          <div className="flex flex-col items-center justify-center gap-4 py-10 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-500/10">
              <CheckCircle2 className="h-9 w-9 text-green-500" />
            </div>
            <div className="space-y-1">
              <p className="font-medium">Thank you for your feedback!</p>
              <p className="text-sm text-muted-foreground">
                We received your message and will review it soon.
              </p>
            </div>
          </div>
        )}

        <DialogFooter>
          {step === "type" ? (
            <Button variant="outline" onClick={() => onOpenChange(false)} className="cursor-pointer">
              Close
            </Button>
          ) : step === "form" ? (
            <div className="flex w-full justify-between gap-2">
              <Button
                variant="outline"
                onClick={() => setStep("type")}
                className="cursor-pointer"
              >
                Back
              </Button>
              <Button
                onClick={submit}
                disabled={!canSubmit}
                title={submitDisabledReason ?? undefined}
                className="cursor-pointer"
              >
                {submitting ? (
                  <>
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                    Sending...
                  </>
                ) : (
                  <>
                    <Send className="mr-1.5 h-4 w-4" />
                    Send feedback
                  </>
                )}
              </Button>
            </div>
          ) : (
            <Button onClick={() => onOpenChange(false)} className="cursor-pointer">
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
