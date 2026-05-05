import { describe, expect, it } from "vitest";
import { parseHashtagList, suggestEcTagsForForeignTag, type TagOption } from "./tags";

const EC_OPTIONS: TagOption[] = [
  { label: "Cute", value: "Cute" },
  { label: "Art", value: "Art" },
  { label: "Cakes", value: "Cakes" },
  { label: "Fashion Show", value: "fashion_show" },
];

describe("parseHashtagList", () => {
  it("parses semicolon-separated social tags", () => {
    expect(parseHashtagList("ChristmasInJuly;HallmarkKeepsake;VintageChristmas")).toEqual([
      "ChristmasInJuly",
      "HallmarkKeepsake",
      "VintageChristmas",
    ]);
  });

  it("parses legacy comma-separated social tags", () => {
    expect(parseHashtagList("ChristmasInJuly, HallmarkKeepsake, VintageChristmas")).toEqual([
      "ChristmasInJuly",
      "HallmarkKeepsake",
      "VintageChristmas",
    ]);
  });

  it("cleans hashes, blanks, and duplicate tags", () => {
    expect(parseHashtagList("#miniatures, grandmagetsreal; #miniatures; ")).toEqual([
      "miniatures",
      "grandmagetsreal",
    ]);
  });
});

describe("suggestEcTagsForForeignTag", () => {
  it("returns the canonical EC value on an exact match (case-insensitive)", () => {
    expect(suggestEcTagsForForeignTag("cakes", EC_OPTIONS)).toEqual(["Cakes"]);
    expect(suggestEcTagsForForeignTag("Cakes", EC_OPTIONS)).toEqual(["Cakes"]);
  });

  it("matches a label that differs from the value (e.g. 'Fashion Show' label vs 'fashion_show' value)", () => {
    expect(suggestEcTagsForForeignTag("Fashion Show", EC_OPTIONS)).toEqual(["fashion_show"]);
  });

  it("splits a compound foreign tag into multiple EC values when all parts resolve", () => {
    expect(suggestEcTagsForForeignTag("Cute Art", EC_OPTIONS)).toEqual(["Cute", "Art"]);
  });

  it("returns an empty list when only some parts of a compound tag resolve", () => {
    expect(suggestEcTagsForForeignTag("Cute Mystery", EC_OPTIONS)).toEqual([]);
  });

  it("returns an empty list when no part resolves", () => {
    expect(suggestEcTagsForForeignTag("Sports", EC_OPTIONS)).toEqual([]);
  });

  it("ignores empty input", () => {
    expect(suggestEcTagsForForeignTag("", EC_OPTIONS)).toEqual([]);
    expect(suggestEcTagsForForeignTag("   ", EC_OPTIONS)).toEqual([]);
  });

  it("dedupes when the same EC value would be matched twice from different parts", () => {
    expect(suggestEcTagsForForeignTag("Cute_Cute", EC_OPTIONS)).toEqual(["Cute"]);
  });
});
