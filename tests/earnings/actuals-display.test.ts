import { describe, it, expect } from "vitest";
import { actualsAreImplausible } from "@/lib/earnings/actuals-display";

describe("actualsAreImplausible", () => {
  it("flags an implausible sign-flip actual when there is no manual stamp", () => {
    // GAAP loss vs a positive Street consensus — the B19 sign-flip branch.
    expect(actualsAreImplausible("EPS 1.74", "EPS -1.20")).toBe(true);
  });

  it("does not flag the same figures when manualActualsAt is set — manual override bypasses the guard", () => {
    expect(actualsAreImplausible("EPS 1.74", "EPS -1.20", "2026-08-28 12:00:00")).toBe(false);
  });

  it("returns false when actual is empty (pre-release row)", () => {
    expect(actualsAreImplausible("EPS 1.74", null)).toBe(false);
    expect(actualsAreImplausible("EPS 1.74", null, "2026-08-28 12:00:00")).toBe(false);
  });

  it("returns false for plausible figures", () => {
    expect(actualsAreImplausible("EPS 0.92", "EPS 1.18")).toBe(false);
  });
});
