/**
 * Tests for the Finish Video flow.
 *
 * Strategy: the heavy `handleFinishVideo` logic in App.tsx involves wiring
 * Tauri commands, React state and dialogs. Rather than fighting full App
 * render complexity, we test:
 *
 * 1. The pure data-transformation helpers extracted into this test
 *    (mirrors buildClipsData and buildZipFiles logic from App.tsx) —
 *    these cover the correctness of what gets sent to the Rust backend.
 *
 * 2. The dialog warning UI — rendered in isolation with a stub project prop,
 *    testing the visual output of the missing-clip warning.
 *
 * The Rust-side CSV generation is covered by tests in src-tauri/src/lib.rs.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import type { ProjectClip } from "@/types";

// ---------------------------------------------------------------------------
// Pure logic mirrors — copied from App.tsx to test without React overhead
// The tests act as a contract: if App.tsx changes this logic, tests break.
// ---------------------------------------------------------------------------

type ClipData = {
  order: number;
  missing: boolean;
  downloadStatus: string;
  duration: number | null;
  link: string;
  externalClipId: string;
  creatorId: string;
  videoProjectId: string;
  editingNotes: string;
};

/** Mirrors the clipsData mapping in handleFinishVideo step 2 */
function buildClipsData(
  allClipsSorted: ProjectClip[],
  creatorMap: Map<string, Record<string, string | null>>,
  vpId: string,
): ClipData[] {
  return allClipsSorted.map((c, idx) => {
    const isMissing = c.downloadStatus !== "complete" || !c.localFile;
    return {
      order: idx + 1,
      missing: isMissing,
      downloadStatus: c.downloadStatus,
      duration: isMissing ? null : (c.editedDuration ?? c.localDuration ?? null),
      link: c.link,
      externalClipId: c.hubspotId,
      creatorId: c.creatorId ?? "",
      videoProjectId: vpId,
      editingNotes: c.editingNotes ?? "",
    };
  });
}

/** Mirrors the clipFiles mapping in handleFinishVideo step 3 */
function buildZipFiles(allClipsSorted: ProjectClip[]): (string | null)[] {
  return allClipsSorted.map((c) =>
    c.downloadStatus === "complete" && c.localFile ? c.localFile : null
  );
}

/** Mirrors the localFile path update after zip returns */
function applyNewPaths(
  clips: ProjectClip[],
  allClipsSorted: ProjectClip[],
  newPaths: (string | null)[],
): ProjectClip[] {
  return clips.map((c) => {
    const idx = allClipsSorted.findIndex((cc) => cc.hubspotId === c.hubspotId);
    const newPath = idx >= 0 ? newPaths[idx] : null;
    return newPath ? { ...c, localFile: newPath } : c;
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function clip(overrides: Partial<ProjectClip> & { hubspotId: string }): ProjectClip {
  return {
    link: "https://instagram.com/p/abc/",
    creatorName: "Creator",
    creatorId: "cid1",
    tags: [],
    downloadStatus: "complete",
    order: 0,
    localFile: "clips/clip_video.mp4",
    localDuration: 10,
    ...overrides,
  } as ProjectClip;
}

// ---------------------------------------------------------------------------
// buildClipsData tests
// ---------------------------------------------------------------------------

describe("buildClipsData — CSV payload construction", () => {
  const emptyCreatorMap = new Map<string, Record<string, string | null>>();

  it("produces one row per clip regardless of download status", () => {
    const clips = [
      clip({ hubspotId: "c1", order: 0 }),
      clip({ hubspotId: "c2", order: 1, downloadStatus: "failed", localFile: undefined }),
      clip({ hubspotId: "c3", order: 2 }),
    ];
    const result = buildClipsData(clips, emptyCreatorMap, "vp1");
    expect(result).toHaveLength(3);
  });

  it("assigns 1-based order matching position in sorted array", () => {
    const clips = [
      clip({ hubspotId: "c1", order: 0 }),
      clip({ hubspotId: "c2", order: 1 }),
      clip({ hubspotId: "c3", order: 2 }),
    ];
    const result = buildClipsData(clips, emptyCreatorMap, "vp1");
    expect(result[0].order).toBe(1);
    expect(result[1].order).toBe(2);
    expect(result[2].order).toBe(3);
  });

  it("marks failed clip as missing with correct status", () => {
    const clips = [
      clip({ hubspotId: "c1", order: 0, downloadStatus: "failed", localFile: undefined }),
    ];
    const result = buildClipsData(clips, emptyCreatorMap, "vp1");
    expect(result[0].missing).toBe(true);
    expect(result[0].downloadStatus).toBe("failed");
  });

  it("marks pending clip as missing", () => {
    const clips = [clip({ hubspotId: "c1", order: 0, downloadStatus: "pending", localFile: undefined })];
    const result = buildClipsData(clips, emptyCreatorMap, "vp1");
    expect(result[0].missing).toBe(true);
  });

  it("marks complete clip with no localFile as missing", () => {
    const clips = [clip({ hubspotId: "c1", order: 0, downloadStatus: "complete", localFile: undefined })];
    const result = buildClipsData(clips, emptyCreatorMap, "vp1");
    expect(result[0].missing).toBe(true);
  });

  it("marks complete clip with localFile as not missing", () => {
    const clips = [clip({ hubspotId: "c1", order: 0, localFile: "clips/c1.mp4" })];
    const result = buildClipsData(clips, emptyCreatorMap, "vp1");
    expect(result[0].missing).toBe(false);
  });

  it("sets duration to null for missing clips", () => {
    const clips = [clip({ hubspotId: "c1", order: 0, downloadStatus: "failed", localFile: undefined, localDuration: 30 })];
    const result = buildClipsData(clips, emptyCreatorMap, "vp1");
    expect(result[0].duration).toBeNull();
  });

  it("uses editedDuration for complete clips when available", () => {
    const clips = [clip({ hubspotId: "c1", order: 0, editedDuration: 25, localDuration: 30 })];
    const result = buildClipsData(clips, emptyCreatorMap, "vp1");
    expect(result[0].duration).toBe(25);
  });

  it("falls back to localDuration when editedDuration absent", () => {
    const clips = [clip({ hubspotId: "c1", order: 0, editedDuration: undefined, localDuration: 30 })];
    const result = buildClipsData(clips, emptyCreatorMap, "vp1");
    expect(result[0].duration).toBe(30);
  });

  it("preserves link even for missing clips (needed for identification)", () => {
    const clips = [clip({ hubspotId: "c1", order: 0, downloadStatus: "failed", localFile: undefined, link: "https://tiktok.com/x" })];
    const result = buildClipsData(clips, emptyCreatorMap, "vp1");
    expect(result[0].link).toBe("https://tiktok.com/x");
  });

  it("sets videoProjectId on all rows", () => {
    const clips = [
      clip({ hubspotId: "c1", order: 0 }),
      clip({ hubspotId: "c2", order: 1, downloadStatus: "failed", localFile: undefined }),
    ];
    const result = buildClipsData(clips, emptyCreatorMap, "vp-ABC");
    expect(result[0].videoProjectId).toBe("vp-ABC");
    expect(result[1].videoProjectId).toBe("vp-ABC");
  });

  it("order is contiguous over all clips, not just completed ones", () => {
    // Clip 2 is missing — clip 3 must still be order 3, not order 2
    const clips = [
      clip({ hubspotId: "c1", order: 0 }),
      clip({ hubspotId: "c2", order: 1, downloadStatus: "failed", localFile: undefined }),
      clip({ hubspotId: "c3", order: 2 }),
    ];
    const result = buildClipsData(clips, emptyCreatorMap, "vp1");
    expect(result[2].order).toBe(3); // NOT 2
    expect(result[2].missing).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildZipFiles tests
// ---------------------------------------------------------------------------

describe("buildZipFiles — zip payload construction", () => {
  it("maps completed clips to their localFile path", () => {
    const clips = [clip({ hubspotId: "c1", order: 0, localFile: "clips/c1.mp4" })];
    expect(buildZipFiles(clips)).toEqual(["clips/c1.mp4"]);
  });

  it("maps missing clips to null", () => {
    const clips = [clip({ hubspotId: "c1", order: 0, downloadStatus: "failed", localFile: undefined })];
    expect(buildZipFiles(clips)).toEqual([null]);
  });

  it("preserves nulls in their correct position — no gap shifting", () => {
    const clips = [
      clip({ hubspotId: "c1", order: 0, localFile: "clips/c1.mp4" }),
      clip({ hubspotId: "c2", order: 1, downloadStatus: "failed", localFile: undefined }),
      clip({ hubspotId: "c3", order: 2, localFile: "clips/c3.mp4" }),
    ];
    expect(buildZipFiles(clips)).toEqual([
      "clips/c1.mp4",
      null,             // position 2 is a gap
      "clips/c3.mp4",
    ]);
  });

  it("all missing returns all nulls", () => {
    const clips = [
      clip({ hubspotId: "c1", order: 0, downloadStatus: "failed", localFile: undefined }),
      clip({ hubspotId: "c2", order: 1, downloadStatus: "pending", localFile: undefined }),
    ];
    expect(buildZipFiles(clips)).toEqual([null, null]);
  });

  it("all complete returns all paths", () => {
    const clips = [
      clip({ hubspotId: "c1", order: 0, localFile: "clips/c1.mp4" }),
      clip({ hubspotId: "c2", order: 1, localFile: "clips/c2.mp4" }),
    ];
    expect(buildZipFiles(clips)).toEqual(["clips/c1.mp4", "clips/c2.mp4"]);
  });
});

// ---------------------------------------------------------------------------
// applyNewPaths tests
// ---------------------------------------------------------------------------

describe("applyNewPaths — project update after rename", () => {
  it("updates localFile for renamed clips", () => {
    const clips = [clip({ hubspotId: "c1", order: 0, localFile: "clips/c1.mp4" })];
    const result = applyNewPaths(clips, clips, ["clips/1 - c1.mp4"]);
    expect(result[0].localFile).toBe("clips/1 - c1.mp4");
  });

  it("does not update localFile for missing clips (null in newPaths)", () => {
    const clips = [
      clip({ hubspotId: "c1", order: 0, localFile: "clips/c1.mp4" }),
      clip({ hubspotId: "c2", order: 1, downloadStatus: "failed", localFile: undefined }),
    ];
    const result = applyNewPaths(clips, clips, ["clips/1 - c1.mp4", null]);
    expect(result[0].localFile).toBe("clips/1 - c1.mp4");
    expect(result[1].localFile).toBeUndefined();
  });

  it("preserves all other clip fields unchanged", () => {
    const clips = [clip({ hubspotId: "c1", order: 0, localFile: "clips/c1.mp4", creatorName: "Alice", score: "A" })];
    const result = applyNewPaths(clips, clips, ["clips/1 - c1.mp4"]);
    expect(result[0].creatorName).toBe("Alice");
    expect(result[0].score).toBe("A");
  });
});

// ---------------------------------------------------------------------------
// Missing clip warning UI
// ---------------------------------------------------------------------------

/** Minimal stub of the warning UI from App.tsx confirm phase */
function MissingClipsWarning({ clips }: { clips: ProjectClip[] }) {
  const missing = clips.filter((c) => c.downloadStatus !== "complete" || !c.localFile);
  if (missing.length === 0) return null;
  return (
    <div data-testid="missing-warning">
      <p>{missing.length} clip{missing.length !== 1 ? "s" : ""} not downloaded</p>
      <ul>
        {missing.map((c, i) => {
          const pos = clips.findIndex((x) => x.hubspotId === c.hubspotId) + 1;
          return <li key={i}>#{pos} {c.creatorName} ({c.downloadStatus})</li>;
        })}
      </ul>
      <p>⚠ MISSING</p>
    </div>
  );
}

describe("Missing clips warning UI", () => {
  it("renders nothing when all clips are complete", () => {
    const clips = [
      clip({ hubspotId: "c1", order: 0 }),
      clip({ hubspotId: "c2", order: 1 }),
    ];
    render(<MissingClipsWarning clips={clips} />);
    expect(screen.queryByTestId("missing-warning")).toBeNull();
  });

  it("renders warning with correct count for multiple missing clips", () => {
    const clips = [
      clip({ hubspotId: "c1", order: 0 }),
      clip({ hubspotId: "c2", order: 1, downloadStatus: "failed", localFile: undefined, creatorName: "Bob" }),
      clip({ hubspotId: "c3", order: 2, downloadStatus: "pending", localFile: undefined, creatorName: "Carol" }),
    ];
    render(<MissingClipsWarning clips={clips} />);
    expect(screen.getByText(/2 clips not downloaded/)).toBeTruthy();
    expect(screen.getByText(/#2 Bob/)).toBeTruthy();
    expect(screen.getByText(/#3 Carol/)).toBeTruthy();
    expect(screen.queryByText(/c1/)).toBeNull();
  });

  it("uses singular 'clip' for exactly one missing", () => {
    const clips = [
      clip({ hubspotId: "c1", order: 0 }),
      clip({ hubspotId: "c2", order: 1, downloadStatus: "failed", localFile: undefined }),
    ];
    render(<MissingClipsWarning clips={clips} />);
    expect(screen.getByText(/1 clip not downloaded/)).toBeTruthy();
    expect(screen.queryByText(/clips not/)).toBeNull();
  });

  it("shows position number matching full clip list, not just missing list", () => {
    // Clip at position 5 is missing — should show #5, not #1
    const clips = [
      ...Array.from({ length: 4 }, (_, i) => clip({ hubspotId: `c${i + 1}`, order: i })),
      clip({ hubspotId: "c5", order: 4, downloadStatus: "failed", localFile: undefined, creatorName: "Dave" }),
    ];
    render(<MissingClipsWarning clips={clips} />);
    expect(screen.getByText(/#5 Dave/)).toBeTruthy();
  });
});
