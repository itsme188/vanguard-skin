import { describe, it, expect } from "vitest";
import { actualsAreImplausible } from "@/app/dashboard/today/EarningsHub";

describe("actualsAreImplausible", () => {
  it("returns false when actual is null (pre-release row)", () => {
    expect(actualsAreImplausible("EPS 0.70 · Rev 4305870107", null)).toBe(false);
  });

  it("returns false when actual is a legitimate beat (PWR-style +28% EPS beat)", () => {
    // Public PWR Q1 2026 print: cons 0.92, actual 1.18 (+28%). Real, not bogus.
    expect(actualsAreImplausible("EPS 0.92", "EPS 1.18")).toBe(false);
  });

  it("returns true for the GOOGL Q1 2026 scrape failure (cons 2.70 vs actual 5.11)", () => {
    expect(actualsAreImplausible("EPS 2.70 · Rev 109770000000", "EPS 5.11 · Rev 109900000000")).toBe(true);
  });

  it("returns true for a >40% revenue beat (structurally implausible)", () => {
    expect(actualsAreImplausible("EPS 1.00 · Rev 1000000000", "EPS 1.05 · Rev 1500000000")).toBe(true);
  });

  it("returns false when consensus is missing — no signal to compare against", () => {
    // No consensus published, but actual landed. Without a baseline we can't flag — let it through.
    expect(actualsAreImplausible(null, "EPS 1.18")).toBe(false);
  });
});
