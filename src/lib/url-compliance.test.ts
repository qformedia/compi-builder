import { describe, it, expect } from "vitest";
import { checkUrlCompliance, checkAllUrls } from "./url-compliance";
import type { ComplianceStatus } from "./url-compliance";

interface TestCase {
  name: string;
  url: string;
  expectedStatus: ComplianceStatus;
  expectedUrl: string;
  expectedIssues?: string[];
}

describe("Instagram", () => {
  const cases: TestCase[] = [
    { name: "valid reel", url: "https://www.instagram.com/reel/CpXAs44ICkH/", expectedStatus: "ok", expectedUrl: "https://www.instagram.com/reel/CpXAs44ICkH/" },
    { name: "valid tv", url: "https://www.instagram.com/tv/CpXAs44ICkH/", expectedStatus: "ok", expectedUrl: "https://www.instagram.com/tv/CpXAs44ICkH/" },
    { name: "/reels/ → /reel/", url: "https://www.instagram.com/reels/CpXAs44ICkH/", expectedStatus: "fixed", expectedUrl: "https://www.instagram.com/reel/CpXAs44ICkH/" },
    { name: "/p/ → /reel/", url: "https://www.instagram.com/p/CpXAs44ICkH/", expectedStatus: "fixed", expectedUrl: "https://www.instagram.com/reel/CpXAs44ICkH/" },
    { name: "strip username prefix", url: "https://www.instagram.com/username/reel/CpXAs44ICkH/", expectedStatus: "fixed", expectedUrl: "https://www.instagram.com/reel/CpXAs44ICkH/" },
    { name: "add trailing /", url: "https://www.instagram.com/reel/CpXAs44ICkH", expectedStatus: "fixed", expectedUrl: "https://www.instagram.com/reel/CpXAs44ICkH/" },
    { name: "strip params + add trailing /", url: "https://www.instagram.com/reel/CpXAs44ICkH?igsh=abc123", expectedStatus: "fixed", expectedUrl: "https://www.instagram.com/reel/CpXAs44ICkH/" },
    { name: "fix www.ww. typo", url: "https://www.ww.instagram.com/reel/CpXAs44ICkH/", expectedStatus: "fixed", expectedUrl: "https://www.instagram.com/reel/CpXAs44ICkH/" },
    { name: "/reels/ without trailing /", url: "https://www.instagram.com/reels/CpXAs44ICkH", expectedStatus: "fixed", expectedUrl: "https://www.instagram.com/reel/CpXAs44ICkH/" },
    { name: "/p/ without trailing /", url: "https://www.instagram.com/p/CpXAs44ICkH", expectedStatus: "fixed", expectedUrl: "https://www.instagram.com/reel/CpXAs44ICkH/" },
    { name: "profile url → invalid", url: "https://www.instagram.com/username", expectedStatus: "invalid", expectedUrl: "https://www.instagram.com/username" },
    { name: "stories → invalid", url: "https://www.instagram.com/stories/username/123456/", expectedStatus: "invalid", expectedUrl: "https://www.instagram.com/stories/username/123456/" },
    { name: "/reels/ profile tab → invalid", url: "https://www.instagram.com/username/reels/", expectedStatus: "invalid", expectedUrl: "https://www.instagram.com/username/reels/" },
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      const r = checkUrlCompliance(tc.url);
      expect(r.status).toBe(tc.expectedStatus);
      if (tc.expectedStatus !== "invalid") {
        expect(r.fixedUrl).toBe(tc.expectedUrl);
      }
      expect(r.network).toBe("instagram");
    });
  }
});

describe("TikTok", () => {
  const cases: TestCase[] = [
    { name: "valid video", url: "https://www.tiktok.com/@user/video/7184865632221924651", expectedStatus: "ok", expectedUrl: "https://www.tiktok.com/@user/video/7184865632221924651" },
    { name: "strip query params", url: "https://www.tiktok.com/@user/video/7184865632221924651?lang=en", expectedStatus: "fixed", expectedUrl: "https://www.tiktok.com/@user/video/7184865632221924651" },
    { name: "remove trailing /", url: "https://www.tiktok.com/@user/video/7184865632221924651/", expectedStatus: "fixed", expectedUrl: "https://www.tiktok.com/@user/video/7184865632221924651" },
    { name: "fix www.www. typo", url: "https://www.www.tiktok.com/@user/video/7184865632221924651", expectedStatus: "fixed", expectedUrl: "https://www.tiktok.com/@user/video/7184865632221924651" },
    { name: "add https://www.", url: "tiktok.com/@user/video/7184865632221924651", expectedStatus: "fixed", expectedUrl: "https://www.tiktok.com/@user/video/7184865632221924651" },
    { name: "photo post → invalid", url: "https://www.tiktok.com/@user/photo/7184865632221924651", expectedStatus: "invalid", expectedUrl: "" },
    { name: "profile → invalid", url: "https://www.tiktok.com/@username", expectedStatus: "invalid", expectedUrl: "" },
    { name: "two URLs → invalid", url: "https://www.tiktok.com/@user/video/123 https://www.tiktok.com/@user/video/456", expectedStatus: "invalid", expectedUrl: "" },
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      const r = checkUrlCompliance(tc.url);
      expect(r.status).toBe(tc.expectedStatus);
      if (tc.expectedStatus !== "invalid") {
        expect(r.fixedUrl).toBe(tc.expectedUrl);
      }
      expect(r.network).toBe("tiktok");
    });
  }
});

describe("YouTube", () => {
  const cases: TestCase[] = [
    { name: "valid shorts", url: "https://www.youtube.com/shorts/qaOWI6S900M", expectedStatus: "ok", expectedUrl: "https://www.youtube.com/shorts/qaOWI6S900M" },
    { name: "valid youtu.be", url: "https://youtu.be/qaOWI6S900M", expectedStatus: "ok", expectedUrl: "https://youtu.be/qaOWI6S900M" },
    { name: "watch?v= → youtu.be/", url: "https://www.youtube.com/watch?v=qaOWI6S900M", expectedStatus: "fixed", expectedUrl: "https://youtu.be/qaOWI6S900M" },
    { name: "strip www from youtu.be", url: "https://www.youtu.be/qaOWI6S900M", expectedStatus: "fixed", expectedUrl: "https://youtu.be/qaOWI6S900M" },
    { name: "strip params from youtu.be", url: "https://youtu.be/qaOWI6S900M?feature=share", expectedStatus: "fixed", expectedUrl: "https://youtu.be/qaOWI6S900M" },
    { name: "strip params from shorts", url: "https://www.youtube.com/shorts/qaOWI6S900M?feature=share", expectedStatus: "fixed", expectedUrl: "https://www.youtube.com/shorts/qaOWI6S900M" },
    { name: "remove trailing / from youtu.be", url: "https://youtu.be/qaOWI6S900M/", expectedStatus: "fixed", expectedUrl: "https://youtu.be/qaOWI6S900M" },
    { name: "remove trailing / from shorts", url: "https://www.youtube.com/shorts/qaOWI6S900M/", expectedStatus: "fixed", expectedUrl: "https://www.youtube.com/shorts/qaOWI6S900M" },
    { name: "@ channel → invalid", url: "https://www.youtube.com/@username", expectedStatus: "invalid", expectedUrl: "" },
    { name: "/c/ channel → invalid", url: "https://www.youtube.com/c/channelname", expectedStatus: "invalid", expectedUrl: "" },
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      const r = checkUrlCompliance(tc.url);
      expect(r.status).toBe(tc.expectedStatus);
      if (tc.expectedStatus !== "invalid") {
        expect(r.fixedUrl).toBe(tc.expectedUrl);
      }
      expect(r.network).toBe("youtube");
    });
  }
});

describe("Pinterest", () => {
  const cases: TestCase[] = [
    { name: "valid .es pin", url: "https://www.pinterest.es/pin/279152876879867692/", expectedStatus: "ok", expectedUrl: "https://www.pinterest.es/pin/279152876879867692/" },
    { name: ".com → .es", url: "https://www.pinterest.com/pin/279152876879867692/", expectedStatus: "fixed", expectedUrl: "https://www.pinterest.es/pin/279152876879867692/" },
    { name: "mx.pinterest.com → .es", url: "https://mx.pinterest.com/pin/279152876879867692/", expectedStatus: "fixed", expectedUrl: "https://www.pinterest.es/pin/279152876879867692/" },
    { name: ".co.uk → .es", url: "https://pinterest.co.uk/pin/279152876879867692/", expectedStatus: "fixed", expectedUrl: "https://www.pinterest.es/pin/279152876879867692/" },
    { name: "add trailing /", url: "https://www.pinterest.es/pin/279152876879867692", expectedStatus: "fixed", expectedUrl: "https://www.pinterest.es/pin/279152876879867692/" },
    { name: "encoded string ID", url: "https://www.pinterest.es/pin/AbIFR-3jXswjUd16/", expectedStatus: "ok", expectedUrl: "https://www.pinterest.es/pin/AbIFR-3jXswjUd16/" },
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      const r = checkUrlCompliance(tc.url);
      expect(r.status).toBe(tc.expectedStatus);
      expect(r.fixedUrl).toBe(tc.expectedUrl);
      expect(r.network).toBe("pinterest");
    });
  }
});

describe("Bilibili", () => {
  const cases: TestCase[] = [
    { name: "valid BV url", url: "https://www.bilibili.com/video/BV1doQqB8EgM/", expectedStatus: "ok", expectedUrl: "https://www.bilibili.com/video/BV1doQqB8EgM/" },
    { name: "add trailing /", url: "https://www.bilibili.com/video/BV1doQqB8EgM", expectedStatus: "fixed", expectedUrl: "https://www.bilibili.com/video/BV1doQqB8EgM/" },
    { name: "strip params + add /", url: "https://www.bilibili.com/video/BV1doQqB8EgM?spm_id_from=333", expectedStatus: "fixed", expectedUrl: "https://www.bilibili.com/video/BV1doQqB8EgM/" },
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      const r = checkUrlCompliance(tc.url);
      expect(r.status).toBe(tc.expectedStatus);
      expect(r.fixedUrl).toBe(tc.expectedUrl);
      expect(r.network).toBe("bilibili");
    });
  }
});

describe("Douyin", () => {
  const cases: TestCase[] = [
    { name: "valid video", url: "https://www.douyin.com/video/7268613378711489832", expectedStatus: "ok", expectedUrl: "https://www.douyin.com/video/7268613378711489832" },
    { name: "iesdouyin → douyin", url: "https://www.iesdouyin.com/share/video/7268613378711489832/", expectedStatus: "fixed", expectedUrl: "https://www.douyin.com/video/7268613378711489832" },
    { name: "extract modal_id", url: "https://www.douyin.com/user/MS4wLjABAAAA?modal_id=7268613378711489832", expectedStatus: "fixed", expectedUrl: "https://www.douyin.com/video/7268613378711489832" },
    { name: "remove trailing /", url: "https://www.douyin.com/video/7268613378711489832/", expectedStatus: "fixed", expectedUrl: "https://www.douyin.com/video/7268613378711489832" },
    { name: "v.douyin.com → invalid", url: "https://v.douyin.com/iRNBph6n/", expectedStatus: "invalid", expectedUrl: "" },
    { name: "user profile → invalid", url: "https://www.douyin.com/user/MS4wLjABAAAAxyz", expectedStatus: "invalid", expectedUrl: "" },
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      const r = checkUrlCompliance(tc.url);
      expect(r.status).toBe(tc.expectedStatus);
      if (tc.expectedStatus !== "invalid") {
        expect(r.fixedUrl).toBe(tc.expectedUrl);
      }
      expect(r.network).toBe("douyin");
    });
  }
});

describe("Out-of-scope networks", () => {
  it("kuaishou passes through", () => {
    const r = checkUrlCompliance("https://www.kuaishou.com/short-video/anything");
    expect(r.status).toBe("ok");
    expect(r.fixedUrl).toBe("https://www.kuaishou.com/short-video/anything");
    expect(r.network).toBe("kuaishou");
  });

  it("xiaohongshu passes through", () => {
    const r = checkUrlCompliance("https://www.xiaohongshu.com/explore/anything");
    expect(r.status).toBe("ok");
    expect(r.fixedUrl).toBe("https://www.xiaohongshu.com/explore/anything");
    expect(r.network).toBe("xiaohongshu");
  });

  it("other sites pass through", () => {
    const r = checkUrlCompliance("https://some-random-site.com/clip/123");
    expect(r.status).toBe("ok");
    expect(r.fixedUrl).toBe("https://some-random-site.com/clip/123");
    expect(r.network).toBe("other");
  });
});

describe("Edge cases", () => {
  it("empty string → invalid", () => {
    const r = checkUrlCompliance("");
    expect(r.status).toBe("invalid");
    expect(r.network).toBe("other");
  });

  it("whitespace-only string → invalid", () => {
    const r = checkUrlCompliance("   ");
    expect(r.status).toBe("invalid");
    expect(r.network).toBe("other");
  });

  it("trims whitespace from valid url", () => {
    const r = checkUrlCompliance("   https://www.instagram.com/reel/CpXAs44ICkH/   ");
    expect(r.status).toBe("ok");
    expect(r.fixedUrl).toBe("https://www.instagram.com/reel/CpXAs44ICkH/");
  });
});

describe("checkAllUrls", () => {
  it("processes multiple urls", () => {
    const results = checkAllUrls([
      "https://www.instagram.com/reel/CpXAs44ICkH/",
      "https://www.tiktok.com/@user/video/7184865632221924651?lang=en",
      "",
    ]);
    expect(results).toHaveLength(3);
    expect(results[0].status).toBe("ok");
    expect(results[1].status).toBe("fixed");
    expect(results[2].status).toBe("invalid");
  });
});
