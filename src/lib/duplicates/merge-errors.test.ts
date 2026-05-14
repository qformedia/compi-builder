import { describe, expect, it } from "vitest";
import {
  formatReassignmentSummary,
  isAssociationLimitError,
  totalReassignedRecords,
  type Reassignment,
} from "./merge-errors";

describe("isAssociationLimitError", () => {
  it("matches the real HubSpot 400 payload for capped pairs", () => {
    // Sampled verbatim from the failing merge in production. Keep this
    // test as the canonical contract — if HubSpot ever changes the
    // wording, the workaround silently breaks and we want a red test.
    const real = `HubSpot merge error (400 Bad Request): {"status":"error","message":"Association configuration limits are exceeded in portal 146859718 when merging 238292703419 into 238298166504 of object type 2-191972671","correlationId":"019e2559-bc5f-718a-85bc-1777f9178748","category":"VALIDATION_ERROR"}`;
    expect(isAssociationLimitError(real)).toBe(true);
  });

  it("rejects unrelated merge errors so we don't loop into the fallback", () => {
    expect(
      isAssociationLimitError(
        "HubSpot merge error (401 Unauthorized): missing scope crm.objects.custom.write",
      ),
    ).toBe(false);
    expect(
      isAssociationLimitError("HubSpot merge error (404): record not found"),
    ).toBe(false);
  });

  it("returns false for null / undefined / empty", () => {
    expect(isAssociationLimitError(null)).toBe(false);
    expect(isAssociationLimitError(undefined)).toBe(false);
    expect(isAssociationLimitError("")).toBe(false);
  });
});

describe("formatReassignmentSummary", () => {
  it("returns null when no records were moved", () => {
    expect(formatReassignmentSummary([])).toBeNull();
    // A peer was probed but had zero loser-side records — still nothing
    // to report to the user.
    expect(
      formatReassignmentSummary([
        {
          objectTypeId: "2-192287471",
          objectTypeLabel: "External Clips",
          count: 0,
        },
      ]),
    ).toBeNull();
  });

  it("renders a single peer without 'and'", () => {
    const result = formatReassignmentSummary([
      {
        objectTypeId: "2-192287471",
        objectTypeLabel: "External Clips",
        count: 47,
      },
    ]);
    expect(result).toBe("Reassigned 47 External Clips before merging.");
  });

  it("joins two peers with a single 'and'", () => {
    const summary = formatReassignmentSummary([
      {
        objectTypeId: "2-192287471",
        objectTypeLabel: "External Clips",
        count: 47,
      },
      { objectTypeId: "0-1", objectTypeLabel: "Contacts", count: 3 },
    ]);
    expect(summary).toBe(
      "Reassigned 47 External Clips and 3 Contacts before merging.",
    );
  });

  it("uses an Oxford comma for three or more peers", () => {
    const summary = formatReassignmentSummary([
      {
        objectTypeId: "2-192287471",
        objectTypeLabel: "External Clips",
        count: 47,
      },
      { objectTypeId: "0-1", objectTypeLabel: "Contacts", count: 3 },
      {
        objectTypeId: "2-192286893",
        objectTypeLabel: "Video Projects",
        count: 5,
      },
    ]);
    expect(summary).toBe(
      "Reassigned 47 External Clips, 3 Contacts, and 5 Video Projects before merging.",
    );
  });

  it("skips zero-count entries when other peers had non-zero counts", () => {
    const summary = formatReassignmentSummary([
      { objectTypeId: "0-1", objectTypeLabel: "Contacts", count: 0 },
      {
        objectTypeId: "2-192287471",
        objectTypeLabel: "External Clips",
        count: 4,
      },
    ]);
    expect(summary).toBe("Reassigned 4 External Clips before merging.");
  });
});

describe("totalReassignedRecords", () => {
  it("sums non-negative counts", () => {
    const total = totalReassignedRecords([
      { objectTypeId: "a", objectTypeLabel: "A", count: 4 },
      { objectTypeId: "b", objectTypeLabel: "B", count: 0 },
      { objectTypeId: "c", objectTypeLabel: "C", count: 7 },
    ]);
    expect(total).toBe(11);
  });

  it("clamps negative counts to zero so a malformed payload can't make the total go down", () => {
    // Defence-in-depth — HubSpot doesn't return negative counts, but our
    // total is later aggregated server-side by reads on the audit log,
    // and a single negative value would silently corrupt those rollups.
    const reassignments: Reassignment[] = [
      { objectTypeId: "a", objectTypeLabel: "A", count: 4 },
      { objectTypeId: "b", objectTypeLabel: "B", count: -3 },
    ];
    expect(totalReassignedRecords(reassignments)).toBe(4);
  });

  it("returns 0 for an empty list", () => {
    expect(totalReassignedRecords([])).toBe(0);
  });
});
