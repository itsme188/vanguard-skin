import { describe, it, expect } from "vitest";
import { signed } from "@/app/dashboard/components/analysis/WhatIfCalculator";

// qa:analysis-whatif--portfolio-beta-delta-renders-negative-zero
// The What-if result table showed "Portfolio Beta | Before 1.21 | After 1.20
// | Δ -0.00" — the raw delta (e.g. -0.0004) rounds to zero at 2 digits but
// `toFixed` keeps the sign, so the "no-change" row printed a signed negative
// zero. A value that reads as zero after rounding must render "0.00" with
// no sign at all (positive or negative) — only a delta that survives
// rounding keeps its +/- sign.
describe("signed (What-if delta formatter)", () => {
  it("never renders a signed negative zero for -0", () => {
    expect(signed(-0, 2)).toBe("0.00");
  });

  it("drops the sign for a negative value that rounds to zero", () => {
    expect(signed(-0.0004, 2)).toBe("0.00");
  });

  it("drops the sign for a positive value that rounds to zero", () => {
    expect(signed(0.0004, 2)).toBe("0.00");
  });

  it("keeps the sign once a real digit survives rounding (negative)", () => {
    expect(signed(-0.006, 2)).toBe("-0.01");
  });

  it("keeps the sign once a real digit survives rounding (positive)", () => {
    expect(signed(0.01, 2)).toBe("+0.01");
  });
});
