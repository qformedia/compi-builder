import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { INTEGRITY_CHECKS, type IntegritySection, type IntegritySectionCount } from "@/lib/data-integrity";

const COUNT_TTL_MS = 60_000;

export type IntegrityErrorKind = "rateLimit" | "other";

export type IntegrityCheckError = {
  kind: IntegrityErrorKind;
  message: string;
};

export type IntegrityCheckData = {
  counts?: IntegritySectionCount[];
  sections?: IntegritySection<Record<string, unknown> & { id: string }>[];
  countsAt?: number;
  fullAt?: number;
  nextAfter?: string;
  error?: IntegrityCheckError;
};

type CheckDataMap = Record<string, IntegrityCheckData>;

export type IntegritySummary = { critical: number; warning: number; info: number };

export type IntegrityErrorNotice = {
  checkId: string;
  checkTitle: string;
  kind: IntegrityErrorKind;
  message: string;
};

/** Batched for useLayoutEffect in DataIntegrityPage after a check fetch completes. */
export type CheckFetchUiSync = {
  checkId: string;
  reset: boolean;
  sections: IntegritySection<Record<string, unknown> & { id: string }>[];
  total: number;
};

type IntegrityContextValue = {
  checkData: CheckDataMap;
  checkLoading: Record<string, boolean>;
  checkPageLoading: Record<string, boolean>;
  refreshAllLoading: boolean;
  hasLoadedOnce: boolean;
  lastRun: Date | null;
  summary: IntegritySummary;
  errors: IntegrityErrorNotice[];
  loadCheck: (check: (typeof INTEGRITY_CHECKS)[number], resetSectionKeys: boolean) => Promise<void>;
  loadMoreCheck: (check: (typeof INTEGRITY_CHECKS)[number]) => Promise<void>;
  ensureFullLoaded: (check: (typeof INTEGRITY_CHECKS)[number], resetSectionKeys: boolean) => Promise<void>;
  loadAll: (options?: { resetSectionKeys?: boolean; force?: boolean }) => Promise<void>;
  /** Incremented when one or more checks finish successfully; read batch then. */
  syncVersion: number;
  consumeCheckFetchSyncBatch: () => CheckFetchUiSync[];
};

const IntegrityContext = createContext<IntegrityContextValue | null>(null);

/**
 * Owns data integrity check fetch state and summary so the app shell (e.g. banner) and
 * DataIntegrityPage share one set of results without double-fetching.
 */
export function IntegrityProvider({
  token,
  children,
}: {
  /** HubSpot private app token. Empty string disables fetches. */
  token: string;
  children: ReactNode;
}) {
  const [checkData, setCheckData] = useState<CheckDataMap>({});
  const [checkLoading, setCheckLoading] = useState<Record<string, boolean>>({});
  const [checkPageLoading, setCheckPageLoading] = useState<Record<string, boolean>>({});
  const [refreshAllLoading, setRefreshAllLoading] = useState(false);
  const [lastRun, setLastRun] = useState<Date | null>(null);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [syncVersion, setSyncVersion] = useState(0);
  const loadAllRunIdRef = useRef(0);
  const checkDataRef = useRef<CheckDataMap>({});
  const checkFetchSyncQueueRef = useRef<CheckFetchUiSync[]>([]);

  useEffect(() => {
    checkDataRef.current = checkData;
  }, [checkData]);

  const classifyError = useCallback((error: unknown): IntegrityCheckError => {
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: message.includes("(429") || message.toLowerCase().includes("rate_limit") ? "rateLimit" : "other",
      message,
    };
  }, []);

  const countsFromSections = useCallback(
    (sections: IntegritySection<Record<string, unknown> & { id: string }>[]): IntegritySectionCount[] =>
      sections.map((section) => ({
        id: section.id,
        title: section.title,
        severity: section.severity,
        defaultOpen: section.defaultOpen,
        total: section.items.length,
      })),
    [],
  );

  const totalFromCounts = useCallback((counts?: IntegritySectionCount[]): number => {
    return counts?.reduce((sum, section) => sum + section.total, 0) ?? 0;
  }, []);

  const mergeSections = useCallback(
    (
      existing: IntegritySection<Record<string, unknown> & { id: string }>[] | undefined,
      incoming: IntegritySection<Record<string, unknown> & { id: string }>[],
    ): IntegritySection<Record<string, unknown> & { id: string }>[] => {
      if (!existing) return incoming;
      const byId = new Map(existing.map((section) => [section.id, { ...section, items: [...section.items] }]));
      for (const section of incoming) {
        const current = byId.get(section.id);
        if (current) {
          current.items.push(...section.items);
        } else {
          byId.set(section.id, { ...section, items: [...section.items] });
        }
      }
      return Array.from(byId.values());
    },
    [],
  );

  const loadCheckCount = useCallback(
    async (check: (typeof INTEGRITY_CHECKS)[number], force = false) => {
      if (!token) return;
      const id = check.id;
      const existing = checkDataRef.current[id];
      if (
        !force &&
        existing?.counts &&
        existing.countsAt &&
        Date.now() - existing.countsAt < COUNT_TTL_MS
      ) {
        return;
      }

      setCheckLoading((l) => ({ ...l, [id]: true }));
      try {
        const counts = await check.fetchCount(token);
        setCheckData((prev) => ({
          ...prev,
          [id]: {
            ...prev[id],
            counts,
            countsAt: Date.now(),
            error: undefined,
          },
        }));
      } catch (e) {
        const error = classifyError(e);
        setCheckData((prev) => ({
          ...prev,
          [id]: {
            ...prev[id],
            error,
          },
        }));
      } finally {
        setCheckLoading((l) => ({ ...l, [id]: false }));
        setLastRun(new Date());
      }
    },
    [classifyError, token],
  );

  const loadCheck = useCallback(
    async (check: (typeof INTEGRITY_CHECKS)[number], resetSectionKeys: boolean) => {
      if (!token) return;
      const id = check.id;
      setCheckLoading((l) => ({ ...l, [id]: true }));
      try {
        const page = await check.fetch(token);
        const typedSections = page.sections as IntegrityCheckData["sections"];
        const existingCounts = checkDataRef.current[id]?.counts;
        const counts = existingCounts ?? countsFromSections(typedSections ?? []);
        setCheckData((prev) => ({
          ...prev,
          [id]: {
            ...prev[id],
            counts,
            sections: typedSections,
            countsAt: prev[id]?.countsAt ?? Date.now(),
            fullAt: Date.now(),
            nextAfter: page.nextAfter,
            error: undefined,
          },
        }));
        const total = totalFromCounts(counts) || typedSections?.reduce((a, s) => a + s.items.length, 0) || 0;
        checkFetchSyncQueueRef.current.push({
          checkId: id,
          reset: resetSectionKeys,
          sections: typedSections ?? [],
          total,
        });
        setSyncVersion((n) => n + 1);
      } catch (e) {
        const error = classifyError(e);
        setCheckData((prev) => ({
          ...prev,
          [id]: {
            ...prev[id],
            error,
          },
        }));
      } finally {
        setCheckLoading((l) => ({ ...l, [id]: false }));
        setLastRun(new Date());
      }
    },
    [classifyError, countsFromSections, token, totalFromCounts],
  );

  const loadMoreCheck = useCallback(
    async (check: (typeof INTEGRITY_CHECKS)[number]) => {
      if (!token) return;
      const id = check.id;
      const existing = checkDataRef.current[id];
      if (!existing?.nextAfter || checkLoading[id] || checkPageLoading[id]) return;

      setCheckPageLoading((l) => ({ ...l, [id]: true }));
      try {
        const page = await check.fetch(token, existing.nextAfter);
        const typedSections = page.sections as IntegrityCheckData["sections"];
        const mergedSections = mergeSections(existing.sections, typedSections ?? []);
        setCheckData((prev) => ({
          ...prev,
          [id]: {
            ...prev[id],
            sections: mergedSections,
            fullAt: Date.now(),
            nextAfter: page.nextAfter,
            error: undefined,
          },
        }));
        checkFetchSyncQueueRef.current.push({
          checkId: id,
          reset: false,
          sections: mergedSections,
          total: totalFromCounts(existing.counts) || mergedSections.reduce((a, s) => a + s.items.length, 0),
        });
        setSyncVersion((n) => n + 1);
      } catch (e) {
        const error = classifyError(e);
        setCheckData((prev) => ({
          ...prev,
          [id]: {
            ...prev[id],
            error,
          },
        }));
      } finally {
        setCheckPageLoading((l) => ({ ...l, [id]: false }));
        setLastRun(new Date());
      }
    },
    [checkLoading, checkPageLoading, classifyError, mergeSections, token, totalFromCounts],
  );

  const ensureFullLoaded = useCallback(
    async (check: (typeof INTEGRITY_CHECKS)[number], resetSectionKeys: boolean) => {
      if (!token) return;
      const data = checkData[check.id];
      const total = totalFromCounts(data?.counts);
      if (total <= 0 || checkLoading[check.id]) return;
      if (data?.sections) return;
      await loadCheck(check, resetSectionKeys);
    },
    [checkData, checkLoading, loadCheck, token, totalFromCounts],
  );

  const loadAll = useCallback(
    async (options?: { resetSectionKeys?: boolean; force?: boolean }) => {
      if (!token) return;
      const force = options?.force ?? options?.resetSectionKeys ?? false;
      setRefreshAllLoading(true);
      const runId = ++loadAllRunIdRef.current;
      try {
        await Promise.all(INTEGRITY_CHECKS.map((c) => loadCheckCount(c, force)));
      } finally {
        if (loadAllRunIdRef.current === runId) {
          setRefreshAllLoading(false);
          setHasLoadedOnce(true);
        }
      }
    },
    [token, loadCheckCount],
  );

  useEffect(() => {
    if (token) {
      void loadAll();
    } else {
      setCheckData({});
      setCheckLoading({});
      setCheckPageLoading({});
      setHasLoadedOnce(false);
      checkFetchSyncQueueRef.current = [];
    }
  }, [token, loadAll]);

  const summary = useMemo((): IntegritySummary => {
    let c = 0;
    let w = 0;
    let i = 0;
    for (const check of INTEGRITY_CHECKS) {
      const d = checkData[check.id];
      if (!d) continue;
      const counts = d.counts ?? (d.sections ? countsFromSections(d.sections) : []);
      for (const s of counts) {
        const n = s.total;
        if (n === 0) continue;
        if (s.severity === "critical") c += n;
        else if (s.severity === "warning") w += n;
        else i += n;
      }
    }
    return { critical: c, warning: w, info: i };
  }, [checkData, countsFromSections]);

  const errors = useMemo((): IntegrityErrorNotice[] => {
    return INTEGRITY_CHECKS.flatMap((check) => {
      const error = checkData[check.id]?.error;
      return error
        ? [{ checkId: check.id, checkTitle: check.title, kind: error.kind, message: error.message }]
        : [];
    });
  }, [checkData]);

  const consumeCheckFetchSyncBatch = useCallback((): CheckFetchUiSync[] => {
    const batch = checkFetchSyncQueueRef.current;
    checkFetchSyncQueueRef.current = [];
    return batch;
  }, []);

  const value: IntegrityContextValue = useMemo(
    () => ({
      checkData,
      checkLoading,
      checkPageLoading,
      refreshAllLoading,
      hasLoadedOnce,
      lastRun,
      summary,
      errors,
      loadCheck,
      loadMoreCheck,
      ensureFullLoaded,
      loadAll,
      syncVersion,
      consumeCheckFetchSyncBatch,
    }),
    [
      checkData,
      checkLoading,
      checkPageLoading,
      refreshAllLoading,
      hasLoadedOnce,
      lastRun,
      summary,
      errors,
      loadCheck,
      loadMoreCheck,
      ensureFullLoaded,
      loadAll,
      syncVersion,
      consumeCheckFetchSyncBatch,
    ],
  );

  return <IntegrityContext.Provider value={value}>{children}</IntegrityContext.Provider>;
}

export function useIntegrity(): IntegrityContextValue {
  const ctx = useContext(IntegrityContext);
  if (!ctx) {
    throw new Error("useIntegrity must be used within IntegrityProvider");
  }
  return ctx;
}
