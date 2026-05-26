import { describe, expect, it } from "vitest";
import {
  extractCodeFromUrl,
  looksLikeCode,
  looksLikeUrl,
} from "@/lib/clip-code";

describe("looksLikeUrl", () => {
  it("detects URLs with scheme", () => {
    expect(looksLikeUrl("https://www.instagram.com/reel/ABC123/")).toBe(true);
  });

  it("detects domain-only inputs", () => {
    expect(looksLikeUrl("www.instagram.com/reel/ABC123/")).toBe(true);
    expect(looksLikeUrl("youtu.be/dQw4w9WgXcQ")).toBe(true);
  });

  it("rejects bare codes", () => {
    expect(looksLikeUrl("Cn3xyzAbc")).toBe(false);
    expect(looksLikeUrl("7234567890123456789")).toBe(false);
  });
});

describe("looksLikeCode", () => {
  it.each([
    "Cn3xyzAbc",
    "dQw4w9WgXcQ",
    "7234567890123456789",
    "BV1xx411c7mD",
    "Cn3-_xyzAbc",
  ])("accepts bare code %s", (code) => {
    expect(looksLikeCode(code)).toBe(true);
  });

  it("rejects URLs", () => {
    expect(looksLikeCode("https://www.instagram.com/reel/ABC123/")).toBe(false);
  });

  it("rejects too-short strings", () => {
    expect(looksLikeCode("abc12")).toBe(false);
  });

  it("rejects strings with spaces", () => {
    expect(looksLikeCode("abc 123")).toBe(false);
  });
});

describe("extractCodeFromUrl", () => {
  it("instagram reel", () => {
    expect(
      extractCodeFromUrl(
        "https://www.instagram.com/reel/Cn3xyzAbc/",
        "instagram",
      ),
    ).toBe("Cn3xyzAbc");
  });

  it("tiktok video", () => {
    expect(
      extractCodeFromUrl(
        "https://www.tiktok.com/@artist/video/7234567890123456789",
        "tiktok",
      ),
    ).toBe("7234567890123456789");
  });

  it("youtube shorts", () => {
    expect(
      extractCodeFromUrl(
        "https://www.youtube.com/shorts/dQw4w9WgXcQ",
        "youtube",
      ),
    ).toBe("dQw4w9WgXcQ");
  });

  it("youtube youtu.be", () => {
    expect(
      extractCodeFromUrl("https://youtu.be/dQw4w9WgXcQ", "youtube"),
    ).toBe("dQw4w9WgXcQ");
  });

  it("pinterest pin", () => {
    expect(
      extractCodeFromUrl(
        "https://www.pinterest.es/pin/1234567890123456789/",
        "pinterest",
      ),
    ).toBe("1234567890123456789");
  });

  it("bilibili", () => {
    expect(
      extractCodeFromUrl(
        "https://www.bilibili.com/video/BV1xx411c7mD/",
        "bilibili",
      ),
    ).toBe("BV1xx411c7mD");
  });

  it("douyin", () => {
    expect(
      extractCodeFromUrl(
        "https://www.douyin.com/video/7234567890123456789",
        "douyin",
      ),
    ).toBe("7234567890123456789");
  });

  it("returns null for unsupported networks", () => {
    expect(
      extractCodeFromUrl("https://example.com/foo", "other"),
    ).toBeNull();
  });
});
