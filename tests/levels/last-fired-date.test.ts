import { describe, it, expect } from "vitest";
import { lastFiredDateET } from "@/lib/levels/last-fired-date";

describe("lastFiredDateET", () => {
  it("a fire at 00:30 UTC belongs to the previous Eastern date", () => {
    // 00:30 UTC on Jan 16 is 7:30pm Eastern on Jan 15 (winter, UTC-5).
    expect(lastFiredDateET("2026-01-16T00:30:00.000Z")).toBe("2026-01-15");
    // Summer (UTC-4): 00:30 UTC on Jul 16 is 8:30pm Eastern on Jul 15.
    expect(lastFiredDateET("2026-07-16T00:30:00.000Z")).toBe("2026-07-15");
  });

  it("a midday fire keeps its date", () => {
    expect(lastFiredDateET("2026-01-15T17:00:00.000Z")).toBe("2026-01-15");
  });

  it("reads a zone-less stored stamp as UTC", () => {
    expect(lastFiredDateET("2026-01-16 00:30:00")).toBe("2026-01-15");
  });

  it("returns null for a missing or unparseable value instead of throwing", () => {
    expect(lastFiredDateET(null)).toBeNull();
    expect(lastFiredDateET("")).toBeNull();
    expect(lastFiredDateET("not a date")).toBeNull();
  });
});
