import { describe, it, expect } from "vitest";
import {
  classifyCreatorUrls,
  groupIssuesByBucket,
  type ClassifiedIssue,
} from "./creator-url-classifier";
import type { CreatorRowFull } from "./creator-csv";
import type { DuplicatePairResolution } from "@/lib/duplicates/supabase";

function creator(
  id: string,
  name: string,
  cols: Partial<Record<string, string>>,
): CreatorRowFull {
  return {
    id,
    name,
    raw: {
      "Record ID": id,
      Name: name,
      Instagram: "",
      "Secondary Instagram": "",
      TikTok: "",
      "Secondary TikTok": "",
      Youtube: "",
      ...cols,
    } as Record<string, string>,
  };
}

function resolution(
  pairKey: string,
  status: DuplicatePairResolution["status"],
  winnerRecordId: string | null = null,
): DuplicatePairResolution {
  return {
    pairKey,
    status,
    resolvedBy: "tester",
    resolvedAt: new Date("2026-05-13T10:00:00Z"),
    resolutionNotes: null,
    winnerRecordId,
    updatedAt: new Date("2026-05-13T10:00:00Z"),
  };
}

function only(issues: ClassifiedIssue[], bucket: ClassifiedIssue["bucket"]) {
  return issues.filter((i) => i.bucket === bucket);
}

describe("classifyCreatorUrls — auto-fixable bucket", () => {
  it("classifies a missing-www Instagram URL as auto-fixable with the canonical proposal", () => {
    const { issues, counts } = classifyCreatorUrls({
      creators: [creator("100", "alice", { Instagram: "https://instagram.com/foo/" })],
    });
    expect(counts).toEqual({
      "auto-fixable": 1,
      "duplicate-after-fix": 0,
      manual: 0,
    });
    expect(issues[0].bucket).toBe("auto-fixable");
    expect(issues[0].proposedUrl).toBe("https://www.instagram.com/foo/");
    expect(issues[0].proposedIssues).toEqual(expect.arrayContaining(["added www."]));
  });

  it("auto-fixes a TikTok URL with a trailing slash", () => {
    const { issues } = classifyCreatorUrls({
      creators: [creator("200", "bob", { TikTok: "https://www.tiktok.com/@bob/" })],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].bucket).toBe("auto-fixable");
    expect(issues[0].proposedUrl).toBe("https://www.tiktok.com/@bob");
  });

  it("lowercases an Instagram handle as part of the fix", () => {
    const { issues } = classifyCreatorUrls({
      creators: [creator("300", "carol", { Instagram: "https://www.instagram.com/Foo/" })],
    });
    expect(issues[0].proposedUrl).toBe("https://www.instagram.com/foo/");
    expect(issues[0].proposedIssues).toEqual(expect.arrayContaining(["lowercased handle"]));
  });

  it("does not emit anything for an already-valid URL", () => {
    const { issues, counts } = classifyCreatorUrls({
      creators: [creator("400", "dave", { Instagram: "https://www.instagram.com/dave/" })],
    });
    expect(issues).toEqual([]);
    expect(counts["auto-fixable"]).toBe(0);
  });
});

describe("classifyCreatorUrls — duplicate-after-fix bucket", () => {
  it("flags a fixable row whose canonical collides with another creator's existing URL", () => {
    const { issues } = classifyCreatorUrls({
      creators: [
        creator("100", "alice", { Instagram: "https://instagram.com/foo/" }),
        creator("200", "bob", { Instagram: "https://www.instagram.com/foo/" }),
      ],
    });
    expect(issues).toHaveLength(1);
    const dup = issues[0];
    expect(dup.bucket).toBe("duplicate-after-fix");
    expect(dup.creatorId).toBe("100");
    expect(dup.proposedUrl).toBe("https://www.instagram.com/foo/");
    expect(dup.collidesWith).toEqual([
      expect.objectContaining({ creatorId: "200", pairKey: "100:200" }),
    ]);
  });

  it("flags self-collisions between two bad rows that clean to the same canonical", () => {
    const { issues } = classifyCreatorUrls({
      creators: [
        creator("100", "alice", { Instagram: "https://INSTAGRAM.com/Foo" }),
        creator("200", "bob", { Instagram: "https://instagram.com/foo/?hl=en" }),
      ],
    });
    expect(issues).toHaveLength(2);
    expect(issues.every((i) => i.bucket === "duplicate-after-fix")).toBe(true);
    expect(issues[0].collidesWith?.[0].creatorId).toBe("200");
    expect(issues[1].collidesWith?.[0].creatorId).toBe("100");
    expect(issues[0].collidesWith?.[0].pairKey).toBe("100:200");
  });

  it("includes valid-canonical holders as collision targets even when they aren't broken themselves", () => {
    const { issues } = classifyCreatorUrls({
      creators: [
        creator("100", "alice", { Instagram: "https://instagram.com/foo" }),
        creator("200", "bob", { Instagram: "https://www.instagram.com/foo/" }),
        creator("300", "carol", { Instagram: "https://www.instagram.com/foo/" }),
      ],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].creatorId).toBe("100");
    expect(issues[0].collidesWith).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ creatorId: "200" }),
        expect.objectContaining({ creatorId: "300" }),
      ]),
    );
  });
});

describe("classifyCreatorUrls — within-record collisions", () => {
  it("routes a primary+secondary same-creator collision to manual with the dedicated reason", () => {
    const { issues } = classifyCreatorUrls({
      creators: [
        creator("500", "eve", {
          Instagram: "https://www.instagram.com/dup",
          "Secondary Instagram": "https://www.instagram.com/dup/",
        }),
      ],
    });
    const manual = only(issues, "manual");
    expect(manual).toHaveLength(1);
    expect(manual[0].creatorId).toBe("500");
    expect(manual[0].field).toBe("instagram");
    expect(manual[0].manualReason).toMatch(/primary and secondary/i);
  });

  it("doesn't double-count: only the invalid side of the within-record pair is emitted", () => {
    const { issues } = classifyCreatorUrls({
      creators: [
        creator("500", "eve", {
          // Primary is invalid (missing trailing slash) and would clean to the
          // secondary's already-valid canonical.
          Instagram: "https://www.instagram.com/dup",
          "Secondary Instagram": "https://www.instagram.com/dup/",
        }),
      ],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe("instagram");
  });
});

describe("classifyCreatorUrls — manual bucket", () => {
  it("routes IG post URLs (/p/) to manual", () => {
    const { issues } = classifyCreatorUrls({
      creators: [
        creator("600", "frank", { Instagram: "https://www.instagram.com/p/CN-cnz2HRTE/" }),
      ],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].bucket).toBe("manual");
    expect(issues[0].manualReason).toMatch(/post or non-profile/i);
  });

  it("routes all invalid YouTube URLs to manual (no auto-resolution in v1)", () => {
    const cases = [
      "https://www.youtube.com/@SomeHandle",
      "https://www.youtube.com/c/Vanity",
      "https://www.youtube.com/user/Legacy",
      "https://youtu.be/abc123",
      "https://www.youtube.com/watch?v=abc",
    ];
    for (const url of cases) {
      const { issues } = classifyCreatorUrls({
        creators: [creator(`yt-${url}`, "yt", { Youtube: url })],
      });
      expect(issues).toHaveLength(1);
      expect(issues[0].bucket).toBe("manual");
    }
  });

  it("routes a YouTube channel-ID typo (Uc → UC) to auto-fixable", () => {
    const { issues } = classifyCreatorUrls({
      creators: [
        creator("700", "grace", {
          Youtube: "https://www.youtube.com/channel/UcWrF0oN6unbXrWsTN7RctTw",
        }),
      ],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].bucket).toBe("auto-fixable");
    expect(issues[0].proposedUrl).toBe(
      "https://www.youtube.com/channel/UCWrF0oN6unbXrWsTN7RctTw",
    );
  });

  it("routes multi-URL cells (whitespace-glued) to manual", () => {
    const { issues } = classifyCreatorUrls({
      creators: [
        creator("800", "henry", {
          Instagram: "https://www.instagram.com/a/ https://www.instagram.com/b/",
        }),
      ],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].bucket).toBe("manual");
    expect(issues[0].manualReason).toMatch(/multiple urls/i);
  });

  it("routes a TikTok URL pasted in the Instagram column to manual with a move-or-delete reason", () => {
    const { issues } = classifyCreatorUrls({
      creators: [
        creator("900", "iris", { Instagram: "https://www.tiktok.com/@iris" }),
      ],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].bucket).toBe("manual");
    expect(issues[0].manualReason).toMatch(/tiktok.*move or delete/i);
  });
});

describe("classifyCreatorUrls — resolution-aware filtering", () => {
  it("drops a duplicate-after-fix row whose pair was dismissed", () => {
    const resolutions = new Map<string, DuplicatePairResolution>([
      ["100:200", resolution("100:200", "dismissed")],
    ]);
    const { issues } = classifyCreatorUrls({
      creators: [
        creator("100", "alice", { Instagram: "https://instagram.com/foo/" }),
        creator("200", "bob", { Instagram: "https://www.instagram.com/foo/" }),
      ],
      resolutions,
    });
    // Dismissed → "not a duplicate" → promote back to auto-fixable.
    expect(issues).toHaveLength(1);
    expect(issues[0].bucket).toBe("auto-fixable");
    expect(issues[0].creatorId).toBe("100");
  });

  it("promotes the merge winner's fixable row to auto-fixable when the pair is resolved", () => {
    const resolutions = new Map<string, DuplicatePairResolution>([
      ["100:200", resolution("100:200", "resolved", "100")],
    ]);
    const { issues } = classifyCreatorUrls({
      creators: [
        creator("100", "alice", { Instagram: "https://instagram.com/foo/" }),
        // Loser still in CSV (CSV is up to 24h stale, merge fresher).
        creator("200", "bob", { Instagram: "https://www.instagram.com/foo/" }),
      ],
      resolutions,
    });
    const winnerIssue = issues.find((i) => i.creatorId === "100");
    expect(winnerIssue?.bucket).toBe("auto-fixable");
  });

  it("drops the merge loser's row silently when the pair is resolved", () => {
    const resolutions = new Map<string, DuplicatePairResolution>([
      ["100:200", resolution("100:200", "resolved", "100")],
    ]);
    const { issues } = classifyCreatorUrls({
      creators: [
        // Winner is already valid in the CSV.
        creator("100", "alice", { Instagram: "https://www.instagram.com/foo/" }),
        // Loser is fixable but archived in HubSpot.
        creator("200", "bob", { Instagram: "https://instagram.com/foo/" }),
      ],
      resolutions,
    });
    // The loser row is dropped — writing to a merged-away record would 404.
    expect(issues.find((i) => i.creatorId === "200")).toBeUndefined();
  });

  it("keeps a duplicate-after-fix row when the pair is still pending", () => {
    const resolutions = new Map<string, DuplicatePairResolution>([
      ["100:200", resolution("100:200", "pending")],
    ]);
    const { issues } = classifyCreatorUrls({
      creators: [
        creator("100", "alice", { Instagram: "https://instagram.com/foo/" }),
        creator("200", "bob", { Instagram: "https://www.instagram.com/foo/" }),
      ],
      resolutions,
    });
    expect(issues[0].bucket).toBe("duplicate-after-fix");
  });

  it("keeps a duplicate-after-fix row when the pair was reopened", () => {
    const resolutions = new Map<string, DuplicatePairResolution>([
      ["100:200", resolution("100:200", "reopened", "100")],
    ]);
    const { issues } = classifyCreatorUrls({
      creators: [
        creator("100", "alice", { Instagram: "https://instagram.com/foo/" }),
        creator("200", "bob", { Instagram: "https://www.instagram.com/foo/" }),
      ],
      resolutions,
    });
    expect(issues[0].bucket).toBe("duplicate-after-fix");
  });
});

describe("classifyCreatorUrls — sort + grouping", () => {
  it("sorts by bucket (auto → dup → manual) then field then creator id", () => {
    const { issues } = classifyCreatorUrls({
      creators: [
        // Manual (IG post URL).
        creator("100", "a", { Instagram: "https://www.instagram.com/p/abc/" }),
        // Auto-fixable IG.
        creator("200", "b", { Instagram: "https://instagram.com/clean/" }),
        // Duplicate-after-fix IG, paired with 200's canonical.
        creator("300", "c", { Instagram: "https://instagram.com/clean" }),
        // Wait — 200 and 300 both clean to the same canonical, so BOTH become
        // duplicate-after-fix. Let's also add a separate auto-fixable row.
        creator("400", "d", { TikTok: "https://www.tiktok.com/@d/" }),
      ],
    });
    const buckets = issues.map((i) => i.bucket);
    expect(buckets.indexOf("auto-fixable")).toBeLessThan(
      buckets.lastIndexOf("duplicate-after-fix"),
    );
    expect(buckets.indexOf("duplicate-after-fix")).toBeLessThan(
      buckets.lastIndexOf("manual"),
    );
  });

  it("groupIssuesByBucket returns one array per bucket and preserves order", () => {
    const { issues } = classifyCreatorUrls({
      creators: [
        creator("200", "b", { Instagram: "https://instagram.com/foo/" }),
        creator("100", "a", { Instagram: "https://www.instagram.com/p/abc/" }),
      ],
    });
    const grouped = groupIssuesByBucket(issues);
    expect(grouped["auto-fixable"].map((i) => i.creatorId)).toEqual(["200"]);
    expect(grouped.manual.map((i) => i.creatorId)).toEqual(["100"]);
    expect(grouped["duplicate-after-fix"]).toEqual([]);
  });
});
