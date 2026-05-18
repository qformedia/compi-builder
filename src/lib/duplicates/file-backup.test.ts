import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backupMergeFiles, type BackedUpFile } from "./file-backup";

// The global Tauri mock in src/test/setup.ts replaces `invoke` with vi.fn().
const invokeMock = vi.mocked(invoke);

// Vite types `import.meta.env` as `Readonly`, but the underlying object is a
// mutable bag at runtime. Cast through a mutable view so the tests can set
// the credentials the production code requires.
const env = import.meta.env as Record<string, string | undefined>;

beforeEach(() => {
  invokeMock.mockReset();
  // The production code reads these via `import.meta.env`; without them it
  // throws before invoking the backend, which short-circuits every test here.
  env.VITE_SUPABASE_URL = "https://test.supabase.co";
  env.VITE_SUPABASE_ANON_KEY = "test-anon-key";
  env.VITE_SUPABASE_CREATOR_MERGE_FILES_BUCKET = "test-bucket";
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeFile(overrides: Partial<BackedUpFile> = {}): BackedUpFile {
  return {
    side: "a",
    property: "license_file",
    hubspotFileId: "12345",
    status: "ok",
    ...overrides,
  };
}

describe("backupMergeFiles", () => {
  it("short-circuits without invoking the backend when both sides have no files", async () => {
    const result = await backupMergeFiles("token", "pair-1", {}, {});
    expect(result).toEqual({ files: [], failedCount: 0 });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("counts only entries with status === 'failed'", async () => {
    // The Rust backend now omits HubSpot-404 records entirely (treated as
    // benign skips), so the only failures that should count toward the
    // user-visible warning banner are the ones it actually returns with
    // status: 'failed'.
    invokeMock.mockResolvedValueOnce([
      makeFile({ hubspotFileId: "ok-1", status: "ok" }),
      makeFile({ hubspotFileId: "fail-1", status: "failed", error: "boom" }),
      makeFile({ hubspotFileId: "ok-2", status: "ok" }),
    ] satisfies BackedUpFile[]);

    const result = await backupMergeFiles(
      "token",
      "pair-1",
      { license_file: "ok-1;fail-1" },
      { traceability_file: "ok-2" },
    );

    expect(result.failedCount).toBe(1);
    expect(result.files).toHaveLength(3);
  });

  it("logs every failed backup to console.error with side/property/id/error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    invokeMock.mockResolvedValueOnce([
      makeFile({
        side: "b",
        property: "traceability_file",
        hubspotFileId: "777",
        name: "contract.pdf",
        status: "failed",
        error: "HubSpot signed-url error (403): forbidden",
      }),
    ] satisfies BackedUpFile[]);

    await backupMergeFiles(
      "token",
      "pair-1",
      {},
      { traceability_file: "777" },
    );

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = errorSpy.mock.calls[0][0] as string;
    // Each piece of context is asserted independently so adding fields later
    // (e.g. mime, size) doesn't break the test, and so a reordering refactor
    // catches the right regression — the user needs to know *which* file and
    // *why*.
    expect(message).toContain("777");
    expect(message).toContain("side=b");
    expect(message).toContain("property=traceability_file");
    expect(message).toContain("contract.pdf");
    expect(message).toContain("HubSpot signed-url error (403): forbidden");
  });

  it("does not log successes", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    invokeMock.mockResolvedValueOnce([
      makeFile({ hubspotFileId: "ok-1", status: "ok" }),
      makeFile({ hubspotFileId: "ok-2", status: "ok" }),
    ] satisfies BackedUpFile[]);

    await backupMergeFiles(
      "token",
      "pair-1",
      { license_file: "ok-1;ok-2" },
      {},
    );

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("includes a placeholder when a failed entry has no error string", async () => {
    // Defence-in-depth: the Rust backend always populates `error` for
    // failures, but a misformatted payload shouldn't make the log line
    // silently lose its trailing context (which would make grepping the
    // console useless).
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    invokeMock.mockResolvedValueOnce([
      makeFile({ status: "failed" }),
    ] satisfies BackedUpFile[]);

    await backupMergeFiles("token", "pair-1", { license_file: "12345" }, {});
    expect(errorSpy.mock.calls[0][0]).toContain("<no error string>");
  });

  it("deduplicates the same file id within one side before invoking", async () => {
    // Reflects the in-function `seenIds` dedup; without it we would upload
    // the same bytes twice for a record that has the same id in both
    // license_file and traceability_file.
    invokeMock.mockResolvedValueOnce([]);

    await backupMergeFiles(
      "token",
      "pair-1",
      { license_file: "555", traceability_file: "555" },
      {},
    );

    const [, args] = invokeMock.mock.calls[0];
    const items = (args as { items: unknown[] }).items;
    expect(items).toHaveLength(1);
  });

  it("preserves the same file id appearing on both sides as two distinct items", async () => {
    // The dedup is per-side, so a fileId shared across both records flows
    // through as two items (different `side`) and lands at two distinct
    // storage paths — the Rust side prefixes the path with the side.
    invokeMock.mockResolvedValueOnce([]);

    await backupMergeFiles(
      "token",
      "pair-1",
      { license_file: "555" },
      { license_file: "555" },
    );

    const [, args] = invokeMock.mock.calls[0];
    const items = (args as { items: { side: string }[] }).items;
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.side).sort()).toEqual(["a", "b"]);
  });

  it("throws when Supabase credentials are missing", async () => {
    delete env.VITE_SUPABASE_URL;
    await expect(
      backupMergeFiles("token", "pair-1", { license_file: "1" }, {}),
    ).rejects.toThrow(/Supabase credentials missing/);
  });
});
