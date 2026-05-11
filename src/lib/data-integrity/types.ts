import type { ComponentType } from "react";
import type { AppSettings } from "@/types";

export type Severity = "critical" | "warning" | "info";

const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

export function maxSeverity(severities: Severity[]): Severity {
  if (severities.length === 0) return "info";
  return severities.reduce<Severity>(
    (acc, s) => (SEVERITY_RANK[s] > SEVERITY_RANK[acc] ? s : acc),
    "info",
  );
}

/** A subgroup inside a check. For ungrouped checks, use one section with `title: ""`. */
export interface IntegritySection<TItem extends { id: string }> {
  id: string;
  title: string;
  severity: Severity;
  defaultOpen?: boolean;
  items: TItem[];
}

export interface IntegritySectionCount {
  id: string;
  title: string;
  severity: Severity;
  defaultOpen?: boolean;
  total: number;
}

export interface IntegritySectionPage<TItem extends { id: string }> {
  sections: IntegritySection<TItem>[];
  nextAfter?: string;
}

export interface IntegrityCheck<TItem extends { id: string }> {
  id: string;
  title: string;
  description: string;
  /**
   * `force` is set by the integrity provider when the user triggered an
   * explicit refresh (the "Refresh all" header button or the banner's
   * Retry). Checks that maintain their own derived caches (e.g. a parsed
   * CSV) should bypass them when force is true so a hard reset actually
   * fetches fresh data.
   */
  fetchCount: (
    token: string,
    opts?: { force?: boolean },
  ) => Promise<IntegritySectionCount[]>;
  fetch: (token: string, after?: string) => Promise<IntegritySectionPage<TItem>>;
  Row: ComponentType<{
    item: TItem;
    token: string;
    onFixed: (id: string, summary?: string) => void;
    settings: AppSettings;
  }>;
  BulkActions?: ComponentType<{
    sections: IntegritySection<TItem>[];
    token: string;
    settings: AppSettings;
    onFixed: (id: string, summary?: string) => void;
  }>;
}
