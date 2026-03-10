import { describe, it, expect } from "vitest";
import { encodeEditingNotes, decodeEditingNotes } from "@/components/ArrangeTab";
import type { ProjectClip } from "@/types";

function clip(id: string, notes?: string): ProjectClip {
  return {
    hubspotId: id,
    link: "",
    creatorName: "",
    tags: [],
    downloadStatus: "pending",
    order: 0,
    editingNotes: notes,
  };
}

describe("encodeEditingNotes", () => {
  it("encodes clips with notes as a JSON map", () => {
    const clips = [clip("a", "trim intro"), clip("b", "add logo"), clip("c")];
    const result = JSON.parse(encodeEditingNotes(clips));
    expect(result).toEqual({ a: "trim intro", b: "add logo" });
  });

  it("omits clips with empty or whitespace-only notes", () => {
    const clips = [clip("a", ""), clip("b", "   "), clip("c", "keep")];
    const result = JSON.parse(encodeEditingNotes(clips));
    expect(result).toEqual({ c: "keep" });
  });

  it("returns empty JSON object when no clips have notes", () => {
    expect(encodeEditingNotes([clip("a"), clip("b")])).toBe("{}");
  });

  it("preserves multiline notes", () => {
    const clips = [clip("a", "line 1\nline 2\nline 3")];
    const result = JSON.parse(encodeEditingNotes(clips));
    expect(result.a).toBe("line 1\nline 2\nline 3");
  });

  it("preserves special characters in notes", () => {
    const clips = [clip("a", 'has "quotes" and colons: here')];
    const result = JSON.parse(encodeEditingNotes(clips));
    expect(result.a).toBe('has "quotes" and colons: here');
  });
});

describe("decodeEditingNotes", () => {
  it("decodes a valid JSON map", () => {
    const result = decodeEditingNotes('{"a":"note 1","b":"note 2"}');
    expect(result).toEqual({ a: "note 1", b: "note 2" });
  });

  it("returns empty object for invalid JSON", () => {
    expect(decodeEditingNotes("not json")).toEqual({});
  });

  it("returns empty object for empty string", () => {
    expect(decodeEditingNotes("")).toEqual({});
  });

  it("returns empty object for null-ish JSON", () => {
    expect(decodeEditingNotes("null")).toEqual({});
  });

  it("round-trips with encodeEditingNotes", () => {
    const clips = [clip("x", "multiline\nnote"), clip("y", 'has "quotes"'), clip("z")];
    const encoded = encodeEditingNotes(clips);
    const decoded = decodeEditingNotes(encoded);
    expect(decoded).toEqual({ x: "multiline\nnote", y: 'has "quotes"' });
  });
});
