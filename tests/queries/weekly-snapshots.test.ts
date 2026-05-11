import { describe, it, expect } from "vitest";
import { mondayOf, weekAgo } from "@/lib/queries/weekly-snapshots";

describe("mondayOf", () => {
  it("returns same date when input is already a Monday", () => {
    expect(mondayOf("2026-05-04")).toBe("2026-05-04"); // Mon
  });

  it("rolls back from Sunday to the prior Monday", () => {
    expect(mondayOf("2026-05-10")).toBe("2026-05-04"); // Sun → prior Mon
  });

  it("rolls back from Wednesday to Monday", () => {
    expect(mondayOf("2026-05-06")).toBe("2026-05-04"); // Wed
  });

  it("handles year boundaries", () => {
    expect(mondayOf("2026-01-01")).toBe("2025-12-29"); // Thu → prior Mon in prev year
  });
});

describe("weekAgo", () => {
  it("subtracts exactly 7 days", () => {
    expect(weekAgo("2026-05-10")).toBe("2026-05-03");
  });

  it("crosses month boundary correctly", () => {
    expect(weekAgo("2026-05-03")).toBe("2026-04-26");
  });
});
