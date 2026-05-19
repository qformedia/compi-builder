/**
 * Tests for the flag-pair helpers added with the Integrity "Mark as
 * potential duplicate" / external-script integration feature. The
 * helpers wrap the Supabase client; we replace the real client with a
 * lightweight in-memory stand-in so the tests run as pure unit tests
 * without any network dependency.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Vite types `import.meta.env` as Readonly. The real runtime object is
// mutable; cast through here so `getClient()` in the module under test
// doesn't throw on construction.
const env = import.meta.env as Record<string, string | undefined>;

// Captured per test so each spec can drive the in-memory client through
// distinct scenarios (no existing row, already-flagged, etc.).
interface FakeQueryState {
  existing: { status: string; source: string | null } | null;
  /** Last `.upsert(...)` payload, exposed so tests can assert what we
   *  wrote to `duplicate_pair_resolutions`. */
  upsertedResolution: Record<string, unknown> | null;
  /** Captured `duplicate_pair_events` insert payloads, in call order. */
  eventInserts: Record<string, unknown>[];
  /** Override to simulate a Supabase error on the next event insert
   *  (used to verify the CHECK-constraint fallback). */
  nextEventInsertError: { code?: string; message?: string } | null;
  /** Override to simulate a Supabase error on the next read of
   *  `duplicate_pair_resolutions` (used to verify the missing-column
   *  / migration-needed fallback). */
  nextResolutionReadError: { code?: string; message?: string } | null;
  /** Override to simulate a Supabase error on the next upsert into
   *  `duplicate_pair_resolutions`. */
  nextResolutionUpsertError: { code?: string; message?: string } | null;
}

let state: FakeQueryState;

// Build a chainable PostgREST-like query object that captures the calls
// our helpers make. Only models the fragments `flagPotentialDuplicate`
// touches — extending is cheap if more code starts reading via this
// stub.
function fakeFrom(table: string) {
  if (table === "duplicate_pair_resolutions") {
    return {
      select: (_cols: string) => ({
        eq: (_col: string, _val: string) => ({
          maybeSingle: async () => {
            if (state.nextResolutionReadError) {
              const err = state.nextResolutionReadError;
              state.nextResolutionReadError = null;
              return { data: null, error: err };
            }
            return { data: state.existing, error: null };
          },
        }),
      }),
      upsert: (payload: Record<string, unknown>, _opts: unknown) => {
        if (state.nextResolutionUpsertError) {
          const err = state.nextResolutionUpsertError;
          state.nextResolutionUpsertError = null;
          return Promise.resolve({ error: err });
        }
        state.upsertedResolution = payload;
        return Promise.resolve({ error: null });
      },
    };
  }
  if (table === "duplicate_pair_events") {
    return {
      insert: (payload: Record<string, unknown>) => {
        if (state.nextEventInsertError) {
          const err = state.nextEventInsertError;
          state.nextEventInsertError = null;
          return Promise.resolve({ error: err });
        }
        state.eventInserts.push(payload);
        return Promise.resolve({ error: null });
      },
    };
  }
  throw new Error(`fakeFrom: unexpected table ${table}`);
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: fakeFrom,
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnThis(),
      track: vi.fn(),
      untrack: vi.fn(),
      unsubscribe: vi.fn(),
      presenceState: vi.fn(() => ({})),
    })),
  })),
}));

import {
  flagPotentialDuplicate,
  flagPotentialDuplicatesBulk,
} from "./supabase";

beforeEach(() => {
  state = {
    existing: null,
    upsertedResolution: null,
    eventInserts: [],
    nextEventInsertError: null,
    nextResolutionReadError: null,
    nextResolutionUpsertError: null,
  };
  env.VITE_SUPABASE_URL = "https://test.supabase.co";
  env.VITE_SUPABASE_ANON_KEY = "test-anon-key";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("flagPotentialDuplicate — pair-key canonicalisation", () => {
  it("sorts record ids lexicographically so the pair_key honors the CHECK constraint", async () => {
    const result = await flagPotentialDuplicate({
      // Pass them in the wrong order — helper must sort.
      recordIdA: "500",
      recordIdB: "100",
      source: "integrity-mark",
      actor: "tester",
    });
    expect(result).toEqual({ kind: "flagged", pairKey: "100:500" });
    expect(state.upsertedResolution?.pair_key).toBe("100:500");
    expect(state.upsertedResolution?.record_id_a).toBe("100");
    expect(state.upsertedResolution?.record_id_b).toBe("500");
  });

  it("rejects flagging a record as a duplicate of itself", async () => {
    const result = await flagPotentialDuplicate({
      recordIdA: "100",
      recordIdB: "100",
      source: "integrity-mark",
      actor: "tester",
    });
    expect(result.kind).toBe("error");
    expect(state.upsertedResolution).toBeNull();
    expect(state.eventInserts).toEqual([]);
  });
});

describe("flagPotentialDuplicate — skip rules", () => {
  it("skips with reason 'already-resolved' when the row is already resolved", async () => {
    state.existing = { status: "resolved", source: null };
    const result = await flagPotentialDuplicate({
      recordIdA: "100",
      recordIdB: "200",
      source: "external-script:cleanup",
      actor: "tester",
    });
    expect(result).toEqual({ kind: "skipped", pairKey: "100:200", reason: "already-resolved" });
    expect(state.upsertedResolution).toBeNull();
    expect(state.eventInserts).toEqual([]);
  });

  it("skips with reason 'already-dismissed' when the row was marked Not a duplicate", async () => {
    state.existing = { status: "dismissed", source: null };
    const result = await flagPotentialDuplicate({
      recordIdA: "100",
      recordIdB: "200",
      source: "external-script:cleanup",
      actor: "tester",
    });
    expect(result.kind).toBe("skipped");
    if (result.kind === "skipped") expect(result.reason).toBe("already-dismissed");
    expect(state.upsertedResolution).toBeNull();
  });

  it("skips with reason 'already-flagged' when a pending row already has a non-null source", async () => {
    state.existing = { status: "pending", source: "external-script:earlier-run" };
    const result = await flagPotentialDuplicate({
      recordIdA: "100",
      recordIdB: "200",
      source: "external-script:cleanup",
      actor: "tester",
    });
    expect(result.kind).toBe("skipped");
    if (result.kind === "skipped") expect(result.reason).toBe("already-flagged");
    expect(state.upsertedResolution).toBeNull();
  });

  it("allows flagging when an unsourced pending row exists (auto-detected, never marked)", async () => {
    // This is the case where the desktop user opened a detected pair,
    // chose Reopen on it earlier, and now an external script wants to
    // attach provenance. We let the upsert through so the source
    // sticks.
    state.existing = { status: "pending", source: null };
    const result = await flagPotentialDuplicate({
      recordIdA: "100",
      recordIdB: "200",
      source: "integrity-mark",
      actor: "tester",
    });
    expect(result).toEqual({ kind: "flagged", pairKey: "100:200" });
    expect(state.upsertedResolution?.source).toBe("integrity-mark");
  });
});

describe("flagPotentialDuplicate — event audit", () => {
  it("appends a 'flagged' event with the source + record ids in the payload", async () => {
    await flagPotentialDuplicate({
      recordIdA: "200",
      recordIdB: "100",
      source: "external-script:cleanup",
      actor: "tester",
      note: "matched on display_name",
    });
    expect(state.eventInserts).toHaveLength(1);
    const ev = state.eventInserts[0];
    expect(ev.pair_key).toBe("100:200");
    expect(ev.event_type).toBe("flagged");
    expect(ev.actor).toBe("tester");
    expect(ev.payload).toEqual({
      record_id_a: "100",
      record_id_b: "200",
      source: "external-script:cleanup",
      note: "matched on display_name",
    });
  });

  it("still writes the resolution row when the events CHECK constraint rejects 'flagged' (old DB)", async () => {
    // Older Supabase projects without the migration applied reject the
    // event insert with 23514. The state row is the important half —
    // verify it still lands.
    state.nextEventInsertError = { code: "23514", message: "violates check constraint" };
    const result = await flagPotentialDuplicate({
      recordIdA: "100",
      recordIdB: "200",
      source: "integrity-mark",
      actor: "tester",
    });
    expect(result).toEqual({ kind: "flagged", pairKey: "100:200" });
    expect(state.upsertedResolution?.status).toBe("pending");
  });

  it("returns an error (without writing the state row) for non-CHECK insert failures", async () => {
    state.nextEventInsertError = { code: "42P01", message: "table does not exist" };
    const result = await flagPotentialDuplicate({
      recordIdA: "100",
      recordIdB: "200",
      source: "integrity-mark",
      actor: "tester",
    });
    expect(result.kind).toBe("error");
    expect(state.upsertedResolution).toBeNull();
  });
});

describe("flagPotentialDuplicate — missing-column / migration-needed", () => {
  // The flag feature relies on `source` and `flagged_at` columns added by
  // migration 20260519090000. If a Supabase project ships the desktop app
  // without applying that migration, every bulk-flag call used to return
  // a raw PostgREST blob and the user saw `Marked 0 · N failed` with no
  // hint about what to fix. These cases pin the friendlier fallback.
  it("returns a clear migration-needed message when the read step hits 42703", async () => {
    state.nextResolutionReadError = {
      code: "42703",
      message: 'column duplicate_pair_resolutions.source does not exist',
    };
    const result = await flagPotentialDuplicate({
      recordIdA: "100",
      recordIdB: "200",
      source: "integrity-mark-bulk",
      actor: "tester",
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/migration/i);
      expect(result.message).toContain("20260519090000_flag_potential_duplicate_pairs.sql");
    }
    // Failing fast: no event audit, no resolution upsert.
    expect(state.eventInserts).toEqual([]);
    expect(state.upsertedResolution).toBeNull();
  });

  it("returns the same migration-needed message when only the upsert hits 42703", async () => {
    // Read works (older deploy that has `source` exposed via PostgREST
    // schema cache after a partial migration), but the upsert references
    // `flagged_at` which is still missing. Same remediation path.
    state.nextResolutionUpsertError = {
      code: "42703",
      message: "Could not find the 'flagged_at' column of 'duplicate_pair_resolutions'",
    };
    const result = await flagPotentialDuplicate({
      recordIdA: "100",
      recordIdB: "200",
      source: "integrity-mark-bulk",
      actor: "tester",
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(/migration/i);
      expect(result.message).toContain("20260519090000_flag_potential_duplicate_pairs.sql");
    }
    expect(state.upsertedResolution).toBeNull();
  });

  it("propagates the migration-needed message through the bulk runner so the UI can render it", async () => {
    // First read fails with 42703; the helper short-circuits before the
    // upsert. Each item in the bulk run gets the same clear message so
    // `creator-urls.tsx` can surface it under the bulk button.
    state.nextResolutionReadError = {
      code: "42703",
      message: 'column duplicate_pair_resolutions.source does not exist',
    };
    const results = await flagPotentialDuplicatesBulk({
      items: [
        { recordIdA: "100", recordIdB: "200", source: "integrity-mark-bulk" },
      ],
      actor: "tester",
      concurrency: 1,
    });
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe("error");
    if (results[0].kind === "error") {
      expect(results[0].message).toContain("20260519090000_flag_potential_duplicate_pairs.sql");
    }
  });
});

describe("flagPotentialDuplicatesBulk", () => {
  it("returns one result per input item in the same order", async () => {
    const items = [
      { recordIdA: "100", recordIdB: "200", source: "integrity-mark-bulk" },
      { recordIdA: "300", recordIdB: "400", source: "integrity-mark-bulk" },
      { recordIdA: "500", recordIdB: "600", source: "integrity-mark-bulk" },
    ];
    const results = await flagPotentialDuplicatesBulk({ items, actor: "tester" });
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.pairKey)).toEqual(["100:200", "300:400", "500:600"]);
    expect(results.every((r) => r.kind === "flagged")).toBe(true);
  });

  it("reports progress with cumulative counts", async () => {
    const items = [
      { recordIdA: "100", recordIdB: "200", source: "integrity-mark-bulk" },
      { recordIdA: "300", recordIdB: "400", source: "integrity-mark-bulk" },
    ];
    const progressEvents: Array<[number, number]> = [];
    await flagPotentialDuplicatesBulk({
      items,
      actor: "tester",
      onProgress: (done, total) => progressEvents.push([done, total]),
      concurrency: 1,
    });
    // First call is the initial 0/total; subsequent calls increment.
    expect(progressEvents[0]).toEqual([0, 2]);
    expect(progressEvents[progressEvents.length - 1]).toEqual([2, 2]);
  });

  it("handles an empty input list without touching Supabase", async () => {
    const results = await flagPotentialDuplicatesBulk({ items: [], actor: "tester" });
    expect(results).toEqual([]);
    expect(state.upsertedResolution).toBeNull();
    expect(state.eventInserts).toEqual([]);
  });
});
