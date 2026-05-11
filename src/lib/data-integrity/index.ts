import type { IntegrityCheck } from "./types";
import { clipsMissingCreatorCheck } from "./checks/clips-missing-creator";
import { clipsMissingTagsInPublishedCheck } from "./checks/clips-missing-tags-in-published";
import { clipsToDeleteCheck } from "./checks/clips-to-delete";
import { creatorUrlsCheck } from "./checks/creator-urls";

export * from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const INTEGRITY_CHECKS: IntegrityCheck<any>[] = [
  clipsMissingCreatorCheck,
  clipsMissingTagsInPublishedCheck,
  clipsToDeleteCheck,
  creatorUrlsCheck,
];
