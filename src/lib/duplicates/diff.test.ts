import { describe, it, expect } from "vitest";
import {
  ASSOCIATION_ROLLUP_KEYS,
  predictMergedAssociationRollup,
  predictMergedAssociationRollups,
  predictMergedProperties,
  sortPropertiesForDiff,
} from "./diff";

describe("predictMergedProperties — native-merge defaults", () => {
  it("keeps the winner's value when both sides differ", () => {
    const merged = predictMergedProperties(
      { name: "Winner Name", notes: "winner notes" },
      { name: "Loser Name", notes: "loser notes" },
    );
    expect(merged.name).toBe("Winner Name");
    expect(merged.notes).toBe("winner notes");
  });

  it("fills empty winner fields from the loser", () => {
    const merged = predictMergedProperties(
      { name: "Winner Name", notes: "" },
      { name: "", notes: "loser notes" },
    );
    expect(merged.name).toBe("Winner Name");
    expect(merged.notes).toBe("loser notes");
  });

  it("treats whitespace-only winner values as empty", () => {
    const merged = predictMergedProperties(
      { instagram: "   " },
      { instagram: "https://instagram.com/foo" },
    );
    expect(merged.instagram).toBe("https://instagram.com/foo");
  });

  it("includes keys present only on one side", () => {
    const merged = predictMergedProperties(
      { name: "Winner", only_winner: "wval" },
      { name: "Loser", only_loser: "lval" },
    );
    expect(merged.only_winner).toBe("wval");
    expect(merged.only_loser).toBe("lval");
  });

  it("returns trimmed values to stay consistent with the diff buckets", () => {
    const merged = predictMergedProperties(
      { name: "  Winner  " },
      { name: "  Loser  " },
    );
    expect(merged.name).toBe("Winner");
  });

  it("matches the existing diff renderer's view of equality", () => {
    // The bucketing in `sortPropertiesForDiff` is what the UI uses. The
    // merged preview should be considered equal to the winner whenever the
    // bucket would say "winner wins on conflict" — i.e. for the mismatch
    // bucket the predicted merged value is exactly the winner's value.
    const winner = { name: "Winner", notes: "win" };
    const loser = { name: "Loser", notes: "lose" };
    const merged = predictMergedProperties(winner, loser);
    const diff = sortPropertiesForDiff(winner, loser);
    for (const row of diff) {
      if (row.bucket === "mismatch" || row.bucket === "only_a") {
        expect(merged[row.key]).toBe(row.valueA);
      } else if (row.bucket === "only_b") {
        expect(merged[row.key]).toBe(row.valueB);
      }
    }
  });
});

describe("predictMergedAssociationRollup", () => {
  it("sums two numeric strings", () => {
    expect(predictMergedAssociationRollup("3", "1")).toBe("4");
    expect(predictMergedAssociationRollup("0", "5")).toBe("5");
  });

  it("treats empty / undefined as zero", () => {
    expect(predictMergedAssociationRollup(undefined, undefined)).toBe("0");
    expect(predictMergedAssociationRollup("", "")).toBe("0");
    expect(predictMergedAssociationRollup("   ", "2")).toBe("2");
  });

  it("returns zero when either side is non-numeric", () => {
    // HubSpot rollups should always be numeric strings, but defensive
    // parsing keeps the preview from rendering "NaN" if the API ever
    // returns garbage.
    expect(predictMergedAssociationRollup("oops", "1")).toBe("1");
    expect(predictMergedAssociationRollup("1", "oops")).toBe("1");
  });
});

describe("predictMergedAssociationRollups", () => {
  it("predicts every key in ASSOCIATION_ROLLUP_KEYS", () => {
    const winner: Record<string, string> = {
      num_of_contacts: "1",
      num_of_external_clips: "3",
      num_of_public_video_projects: "0",
      num_of_send_link_actions: "2",
      num_of_social_interactions: "1",
      num_of_video_projects: "0",
    };
    const loser: Record<string, string> = {
      num_of_contacts: "0",
      num_of_external_clips: "1",
      num_of_public_video_projects: "0",
      num_of_send_link_actions: "0",
      num_of_social_interactions: "0",
      num_of_video_projects: "1",
    };
    const out = predictMergedAssociationRollups(winner, loser);
    expect(out.num_of_contacts).toBe("1");
    expect(out.num_of_external_clips).toBe("4");
    expect(out.num_of_public_video_projects).toBe("0");
    expect(out.num_of_send_link_actions).toBe("2");
    expect(out.num_of_social_interactions).toBe("1");
    expect(out.num_of_video_projects).toBe("1");
    // Sanity: no surprise keys.
    expect(Object.keys(out).sort()).toEqual([...ASSOCIATION_ROLLUP_KEYS].sort());
  });

  it("defaults missing keys to 0+0=0", () => {
    const out = predictMergedAssociationRollups({}, {});
    for (const key of ASSOCIATION_ROLLUP_KEYS) {
      expect(out[key]).toBe("0");
    }
  });
});
