import { describe, expect, it } from "vitest";
import { parseHashtagList } from "./tags";

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
