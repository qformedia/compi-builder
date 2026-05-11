import { describe, it, expect } from "vitest";
import { cleanCreatorUrl } from "./creator-url-canonicalize";
import type { CreatorUrlNetwork, CreatorUrlStatus } from "./creator-url-canonicalize";

interface SpecCase {
  input: string;
  expectedFixed: string | null; // null = "(unchanged)" in the spec table
  expectedStatus: CreatorUrlStatus;
  expectedNetwork: CreatorUrlNetwork;
  expectedIssue?: string; // when set, must appear (substring match) in issues[]
}

function run(cases: SpecCase[]) {
  for (const tc of cases) {
    it(`${tc.input || "(empty)"} → ${tc.expectedStatus}`, () => {
      const result = cleanCreatorUrl(tc.input);
      const expected = tc.expectedFixed ?? tc.input.trim();
      expect(result.status, `status for ${JSON.stringify(tc.input)}`).toBe(tc.expectedStatus);
      expect(result.network, `network for ${JSON.stringify(tc.input)}`).toBe(tc.expectedNetwork);
      expect(result.fixedUrl, `fixedUrl for ${JSON.stringify(tc.input)}`).toBe(expected);
      if (tc.expectedIssue) {
        expect(
          result.issues.some((i) => i.includes(tc.expectedIssue!)),
          `issues for ${JSON.stringify(tc.input)} should include "${tc.expectedIssue}", got: ${JSON.stringify(result.issues)}`,
        ).toBe(true);
      }
    });
  }
}

// Mirrors the "Examples" table in
// ~/Documents/QforMedia/Tastic ExClips Clean Up/spec-for-compiflow/creator-url-rules.md
// — keep in sync.

describe("cleanCreatorUrl — Instagram", () => {
  run([
    {
      input: "https://www.instagram.com/foo/",
      expectedFixed: "https://www.instagram.com/foo/",
      expectedStatus: "ok",
      expectedNetwork: "instagram",
    },
    {
      input: "https://www.instagram.com/foo",
      expectedFixed: "https://www.instagram.com/foo/",
      expectedStatus: "fixed",
      expectedNetwork: "instagram",
      expectedIssue: "added trailing /",
    },
    {
      input: "https://instagram.com/foo/",
      expectedFixed: "https://www.instagram.com/foo/",
      expectedStatus: "fixed",
      expectedNetwork: "instagram",
      expectedIssue: "added www.",
    },
    {
      input: "http://www.instagram.com/foo/",
      expectedFixed: "https://www.instagram.com/foo/",
      expectedStatus: "fixed",
      expectedNetwork: "instagram",
      expectedIssue: "upgraded http → https",
    },
    {
      input: "https://www.instagram.com/Foo/",
      expectedFixed: "https://www.instagram.com/foo/",
      expectedStatus: "fixed",
      expectedNetwork: "instagram",
      expectedIssue: "lowercased handle",
    },
    {
      input: "https://www.instagram.com/foo/?hl=en",
      expectedFixed: "https://www.instagram.com/foo/",
      expectedStatus: "fixed",
      expectedNetwork: "instagram",
      expectedIssue: "stripped query params",
    },
    {
      input: "https://www.instagram.com/foo?igsh=ABC",
      expectedFixed: "https://www.instagram.com/foo/",
      expectedStatus: "fixed",
      expectedNetwork: "instagram",
    },
    {
      input: "https://www.instagram.com/willbakerillustrator/#/",
      expectedFixed: "https://www.instagram.com/willbakerillustrator/",
      expectedStatus: "fixed",
      expectedNetwork: "instagram",
    },
    {
      input: "https://www.instagram.com/reel/CN-cnz2HRTE/",
      expectedFixed: null,
      expectedStatus: "invalid",
      expectedNetwork: "instagram",
      expectedIssue: "post or non-profile URL in profile field",
    },
    {
      input: "https://www.instagram.com/p/foo/",
      expectedFixed: null,
      expectedStatus: "invalid",
      expectedNetwork: "instagram",
      expectedIssue: "post or non-profile URL in profile field",
    },
    {
      input: "https://www.instagram.com/stories/foo/123/",
      expectedFixed: null,
      expectedStatus: "invalid",
      expectedNetwork: "instagram",
      expectedIssue: "post or non-profile URL in profile field",
    },
    {
      input: "https://www.instagram.com/-/",
      expectedFixed: null,
      expectedStatus: "invalid",
      expectedNetwork: "instagram",
    },
  ]);

  it("(whitespace only) → empty/invalid", () => {
    const result = cleanCreatorUrl("   ");
    expect(result.status).toBe("invalid");
    expect(result.network).toBe("empty");
    expect(result.issues).toContain("empty URL");
  });

  it("multi-URL cell on a known network is rejected", () => {
    // Whitespace inside a recognized-network value is invalid. Networks are
    // detected by host substring, so the cell must contain `instagram.com`
    // (or another in-scope domain) for the multi-URL branch to fire — a
    // truly out-of-scope domain short-circuits to status "ok" up front.
    const result = cleanCreatorUrl("https://www.instagram.com/foo https://www.instagram.com/bar");
    expect(result.status).toBe("invalid");
    expect(result.issues.some((i) => i.includes("multiple URLs or free text"))).toBe(true);
  });
});

describe("cleanCreatorUrl — TikTok", () => {
  run([
    {
      input: "https://www.tiktok.com/@foo",
      expectedFixed: "https://www.tiktok.com/@foo",
      expectedStatus: "ok",
      expectedNetwork: "tiktok",
    },
    {
      input: "https://www.tiktok.com/@foo/",
      expectedFixed: "https://www.tiktok.com/@foo",
      expectedStatus: "fixed",
      expectedNetwork: "tiktok",
      expectedIssue: "removed trailing /",
    },
    {
      input: "https://tiktok.com/@foo",
      expectedFixed: "https://www.tiktok.com/@foo",
      expectedStatus: "fixed",
      expectedNetwork: "tiktok",
      expectedIssue: "added www.",
    },
    {
      input: "https://www.tiktok.com/@Foo",
      expectedFixed: "https://www.tiktok.com/@foo",
      expectedStatus: "fixed",
      expectedNetwork: "tiktok",
      expectedIssue: "lowercased handle",
    },
    {
      input: "https://www.tiktok.com/@foo?_t=ABC&_r=1",
      expectedFixed: "https://www.tiktok.com/@foo",
      expectedStatus: "fixed",
      expectedNetwork: "tiktok",
      expectedIssue: "stripped query params",
    },
    {
      input: "https://www.tiktok.com/@foo/video/7123456789012345678",
      expectedFixed: null,
      expectedStatus: "invalid",
      expectedNetwork: "tiktok",
      expectedIssue: "post or non-profile URL in profile field",
    },
    {
      input: "https://www.tiktok.com/@foo/photo/7123",
      expectedFixed: null,
      expectedStatus: "invalid",
      expectedNetwork: "tiktok",
      expectedIssue: "post or non-profile URL in profile field",
    },
    {
      input: "https://www.tiktok.com/discover",
      expectedFixed: null,
      expectedStatus: "invalid",
      expectedNetwork: "tiktok",
      expectedIssue: "non-profile URL — manual review",
    },
  ]);

  it("bare @handle promotes to TikTok canonical", () => {
    const result = cleanCreatorUrl("@morg_tt");
    expect(result.status).toBe("fixed");
    expect(result.network).toBe("tiktok");
    expect(result.fixedUrl).toBe("https://www.tiktok.com/@morg_tt");
    expect(result.issues.some((i) => i.includes("promoted bare handle"))).toBe(true);
  });
});

describe("cleanCreatorUrl — YouTube", () => {
  run([
    {
      input: "https://www.youtube.com/channel/UCWrF0oN6unbXrWsTN7RctTw",
      expectedFixed: "https://www.youtube.com/channel/UCWrF0oN6unbXrWsTN7RctTw",
      expectedStatus: "ok",
      expectedNetwork: "youtube",
    },
    {
      input: "https://www.youtube.com/channel/UCWrF0oN6unbXrWsTN7RctTw/",
      expectedFixed: "https://www.youtube.com/channel/UCWrF0oN6unbXrWsTN7RctTw",
      expectedStatus: "fixed",
      expectedNetwork: "youtube",
      expectedIssue: "removed trailing /",
    },
    {
      input: "https://www.youtube.com/channel/UCWrF0oN6unbXrWsTN7RctTw/featured",
      expectedFixed: "https://www.youtube.com/channel/UCWrF0oN6unbXrWsTN7RctTw",
      expectedStatus: "fixed",
      expectedNetwork: "youtube",
      expectedIssue: "stripped /featured suffix",
    },
    {
      input: "https://www.youtube.com/channel/UCWrF0oN6unbXrWsTN7RctTw?app=desktop",
      expectedFixed: "https://www.youtube.com/channel/UCWrF0oN6unbXrWsTN7RctTw",
      expectedStatus: "fixed",
      expectedNetwork: "youtube",
      expectedIssue: "stripped query params",
    },
    {
      input: "https://youtube.com/channel/UCWrF0oN6unbXrWsTN7RctTw",
      expectedFixed: "https://www.youtube.com/channel/UCWrF0oN6unbXrWsTN7RctTw",
      expectedStatus: "fixed",
      expectedNetwork: "youtube",
      expectedIssue: "added www.",
    },
    {
      input: "http://www.youtube.com/channel/UCWrF0oN6unbXrWsTN7RctTw",
      expectedFixed: "https://www.youtube.com/channel/UCWrF0oN6unbXrWsTN7RctTw",
      expectedStatus: "fixed",
      expectedNetwork: "youtube",
      expectedIssue: "upgraded http → https",
    },
    {
      input: "https://www.youtube.com/channel/UcWrF0oN6unbXrWsTN7RctTw",
      expectedFixed: "https://www.youtube.com/channel/UCWrF0oN6unbXrWsTN7RctTw",
      expectedStatus: "fixed",
      expectedNetwork: "youtube",
      expectedIssue: "fixed channel-ID prefix casing",
    },
    {
      input: "https://www.youtube.com/@Sketchy90",
      expectedFixed: null,
      expectedStatus: "invalid",
      expectedNetwork: "youtube",
      expectedIssue: "@handle URL",
    },
    {
      input: "https://www.youtube.com/c/SammydemmyDIYIdeen",
      expectedFixed: null,
      expectedStatus: "invalid",
      expectedNetwork: "youtube",
      expectedIssue: "legacy /c/ URL",
    },
    {
      input: "https://www.youtube.com/user/cirquedusoleil",
      expectedFixed: null,
      expectedStatus: "invalid",
      expectedNetwork: "youtube",
      expectedIssue: "legacy /user/ URL",
    },
    {
      input: "https://www.youtube.com/dimissauro",
      expectedFixed: null,
      expectedStatus: "invalid",
      expectedNetwork: "youtube",
      expectedIssue: "vanity URL",
    },
    {
      input: "https://www.youtube.com/shorts/PhHIrBvVoqI",
      expectedFixed: null,
      expectedStatus: "invalid",
      expectedNetwork: "youtube",
      expectedIssue: "video/post URL in profile field",
    },
    {
      input: "https://youtu.be/abc12345678",
      expectedFixed: null,
      expectedStatus: "invalid",
      expectedNetwork: "youtube",
      expectedIssue: "youtu.be is a video URL",
    },
  ]);
});

describe("cleanCreatorUrl — out-of-scope (other)", () => {
  run([
    {
      input: "https://www.facebook.com/foo/",
      expectedFixed: "https://www.facebook.com/foo/",
      expectedStatus: "ok",
      expectedNetwork: "other",
    },
    {
      input: "https://x.com/foo",
      expectedFixed: "https://x.com/foo",
      expectedStatus: "ok",
      expectedNetwork: "other",
    },
    {
      input: "https://space.bilibili.com/12345",
      expectedFixed: "https://space.bilibili.com/12345",
      expectedStatus: "ok",
      expectedNetwork: "other",
    },
    {
      input: "https://www.xiaohongshu.com/user/profile/abc",
      expectedFixed: "https://www.xiaohongshu.com/user/profile/abc",
      expectedStatus: "ok",
      expectedNetwork: "other",
    },
  ]);
});
