import { describe, it, expect } from "vitest";
import { buildFlaggedPair, findDuplicatePairs } from "./find-pairs";
import type { CreatorRowFull } from "@/lib/data-integrity/creator-csv";

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

describe("findDuplicatePairs — Pattern 1 (canonical collision)", () => {
  it("detects a trailing-slash collision across two records", () => {
    const pairs = findDuplicatePairs([
      creator("100", "alice", { Instagram: "https://www.instagram.com/foo" }),
      creator("200", "bob", { Instagram: "https://www.instagram.com/foo/" }),
    ]);
    expect(pairs).toHaveLength(1);
    const p = pairs[0];
    expect(p.network).toBe("instagram");
    expect(p.canonicalUrl).toBe("https://www.instagram.com/foo/");
    expect(p.source).toEqual(["canonical_collision"]);
    expect(p.pairKey).toBe("100:200");
    expect(p.a.rid).toBe("100");
    expect(p.b.rid).toBe("200");
    expect(p.a.columns).toEqual(["Instagram"]);
    expect(p.b.columns).toEqual(["Instagram"]);
  });

  it("flags column-cross collision: A.Instagram == B.Secondary Instagram", () => {
    const pairs = findDuplicatePairs([
      creator("300", "carol", { Instagram: "https://www.instagram.com/shared/" }),
      creator("400", "dave", { "Secondary Instagram": "https://www.instagram.com/shared/" }),
    ]);
    expect(pairs).toHaveLength(1);
    const p = pairs[0];
    expect(p.a.columns).toEqual(["Instagram"]);
    expect(p.b.columns).toEqual(["Secondary Instagram"]);
  });

  it("does NOT emit a pair for a within-record duplicate (same canonical in primary + secondary on the same record)", () => {
    const pairs = findDuplicatePairs([
      creator("500", "eve", {
        Instagram: "https://www.instagram.com/dup/",
        "Secondary Instagram": "https://www.instagram.com/dup",
      }),
    ]);
    expect(pairs).toEqual([]);
  });

  it("does NOT emit a pair for invalid values (IG /p/ post in profile field)", () => {
    const pairs = findDuplicatePairs([
      creator("600", "frank", { Instagram: "https://www.instagram.com/p/CN-cnz2HRTE/" }),
      creator("700", "grace", { Instagram: "https://www.instagram.com/p/CN-cnz2HRTE/" }),
    ]);
    expect(pairs).toEqual([]);
  });

  it("collapses cosmetic differences (case, www., http)", () => {
    const pairs = findDuplicatePairs([
      creator("800", "henry", { Instagram: "http://instagram.com/HelloWorld" }),
      creator("900", "iris", { Instagram: "https://www.instagram.com/helloworld/" }),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].canonicalUrl).toBe("https://www.instagram.com/helloworld/");
  });

  it("emits C(n,2) pairs for an n-way bucket", () => {
    const pairs = findDuplicatePairs([
      creator("100", "a", { Instagram: "https://www.instagram.com/triple/" }),
      creator("200", "b", { Instagram: "https://www.instagram.com/triple/" }),
      creator("300", "c", { Instagram: "https://www.instagram.com/triple/" }),
    ]);
    expect(pairs).toHaveLength(3);
    expect(pairs.map((p) => p.pairKey).sort()).toEqual(["100:200", "100:300", "200:300"]);
  });
});

describe("findDuplicatePairs — Pattern 3 (multi-URL cell collision)", () => {
  it("detects a collision when one side has two URLs glued together", () => {
    const pairs = findDuplicatePairs([
      creator("1000", "jack", {
        // Multi-URL cell: cleanCreatorUrl rejects this as invalid (whitespace),
        // but Pattern 3 splits and re-canonicalizes each token.
        Instagram: "https://www.instagram.com/foo/ https://www.instagram.com/bar/",
      }),
      creator("2000", "kate", { Instagram: "https://www.instagram.com/bar/" }),
    ]);
    expect(pairs).toHaveLength(1);
    const p = pairs[0];
    expect(p.canonicalUrl).toBe("https://www.instagram.com/bar/");
    expect(p.source).toContain("multi_url_collision");
    // Direction rule: the broken side (multi-URL cell) is A, canonical-holder is B.
    expect(p.a.rid).toBe("1000");
    expect(p.a.fromMultiUrlCell).toBe(true);
    expect(p.b.rid).toBe("2000");
    expect(p.b.fromMultiUrlCell).toBeUndefined();
  });
});

describe("findDuplicatePairs — Pattern 5 (bare-handle promotion)", () => {
  it("detects a collision when one record holds @handle (no domain) and another has the canonical TikTok URL", () => {
    const pairs = findDuplicatePairs([
      creator("3000", "lou", { TikTok: "@morg_tt" }),
      creator("4000", "mia", { TikTok: "https://www.tiktok.com/@morg_tt" }),
    ]);
    expect(pairs).toHaveLength(1);
    const p = pairs[0];
    expect(p.network).toBe("tiktok");
    expect(p.canonicalUrl).toBe("https://www.tiktok.com/@morg_tt");
    expect(p.source).toContain("bare_handle_promotion");
    // The bare-handle side is the broken one and becomes A.
    expect(p.a.rid).toBe("3000");
    expect(p.a.fromBareHandlePromotion).toBe(true);
  });
});

describe("findDuplicatePairs — output sort order", () => {
  it("sorts by network → canonical URL → pairKey", () => {
    const pairs = findDuplicatePairs([
      creator("100", "a", { Instagram: "https://www.instagram.com/zzz/" }),
      creator("200", "b", { Instagram: "https://www.instagram.com/zzz/" }),
      creator("300", "c", { TikTok: "https://www.tiktok.com/@aaa" }),
      creator("400", "d", { TikTok: "https://www.tiktok.com/@aaa" }),
      creator("500", "e", { Instagram: "https://www.instagram.com/aaa/" }),
      creator("600", "f", { Instagram: "https://www.instagram.com/aaa/" }),
    ]);
    expect(pairs.map((p) => `${p.network}|${p.canonicalUrl}`)).toEqual([
      "instagram|https://www.instagram.com/aaa/",
      "instagram|https://www.instagram.com/zzz/",
      "tiktok|https://www.tiktok.com/@aaa",
    ]);
  });
});

describe("buildFlaggedPair", () => {
  it("builds a synthetic pair with kind='flagged' and null network/canonicalUrl", () => {
    const nameByRecordId = new Map([
      ["100", "alice"],
      ["200", "bob"],
    ]);
    const flaggedAt = new Date("2026-05-19T09:00:00Z");
    const pair = buildFlaggedPair({
      pairKey: "100:200",
      recordIdA: "100",
      recordIdB: "200",
      flaggedSource: "external-script:cleanup",
      flaggedAt,
      nameByRecordId,
    });
    expect(pair.kind).toBe("flagged");
    expect(pair.network).toBeNull();
    expect(pair.canonicalUrl).toBeNull();
    expect(pair.source).toEqual([]);
    expect(pair.flaggedSource).toBe("external-script:cleanup");
    expect(pair.flaggedAt).toBe(flaggedAt);
    expect(pair.a.rid).toBe("100");
    expect(pair.a.name).toBe("alice");
    expect(pair.b.rid).toBe("200");
    expect(pair.b.name).toBe("bob");
    expect(pair.a.columns).toEqual([]);
    expect(pair.b.columns).toEqual([]);
  });

  it("falls back to bare record id when the creator is missing from the index", () => {
    // Realistic when an external script flagged a record that has since
    // been merged or archived in HubSpot — the export no longer has a
    // row for it. The UI should still render the pair so the user can
    // dismiss it.
    const nameByRecordId = new Map([["100", "alice"]]);
    const pair = buildFlaggedPair({
      pairKey: "100:9999",
      recordIdA: "100",
      recordIdB: "9999",
      flaggedSource: "integrity-mark",
      flaggedAt: null,
      nameByRecordId,
    });
    expect(pair.a.name).toBe("alice");
    expect(pair.b.name).toBe("9999");
  });

  it("uses the bare record id when no nameByRecordId map is provided", () => {
    const pair = buildFlaggedPair({
      pairKey: "100:200",
      recordIdA: "100",
      recordIdB: "200",
      flaggedSource: null,
      flaggedAt: null,
    });
    expect(pair.a.name).toBe("100");
    expect(pair.b.name).toBe("200");
    expect(pair.flaggedSource).toBeNull();
  });
});
