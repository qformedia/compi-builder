import type { IntegrityCheck } from "./types";
import { clipsMissingCreatorCheck } from "./checks/clips-missing-creator";

export * from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const INTEGRITY_CHECKS: IntegrityCheck<any>[] = [clipsMissingCreatorCheck];
