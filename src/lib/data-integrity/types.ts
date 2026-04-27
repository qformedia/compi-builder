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

export interface IntegrityCheck<TItem extends { id: string }> {
  id: string;
  title: string;
  description: string;
  fetchCount: (token: string) => Promise<IntegritySectionCount[]>;
  fetch: (token: string) => Promise<IntegritySection<TItem>[]>;
  Row: ComponentType<{
    item: TItem;
    token: string;
    onFixed: (id: string, summary?: string) => void;
    settings: AppSettings;
  }>;
}
