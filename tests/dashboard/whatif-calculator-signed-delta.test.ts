import { describe, it, expect } from "vitest";
import { signed, signedPp, formatDeltaUsd } from "@/app/dashboard/components/analysis/WhatIfCalculator";

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

// The identical negative-zero bug remained in signedPp() — it drives every
// concentration/sector/factor row (the ones that were still showing
// "-0.0pp" after the Portfolio Beta row was fixed).
describe("signedPp (What-if concentration/sector/factor delta formatter)", () => {
  it("never renders a signed negative zero for -0", () => {
    expect(signedPp(-0)).toBe("0.0pp");
  });

  it("drops the sign for a negative fraction that rounds to zero at 1dp", () => {
    expect(signedPp(-0.0004)).toBe("0.0pp");
  });

  it("drops the sign for a positive fraction that rounds to zero at 1dp", () => {
    expect(signedPp(0.00004)).toBe("0.0pp");
  });

  it("keeps the sign once a real digit survives rounding (positive)", () => {
    expect(signedPp(0.004)).toBe("+0.4pp");
  });

  it("keeps the sign once a real digit survives rounding (negative)", () => {
    expect(signedPp(-0.004)).toBe("-0.4pp");
  });
});

// Same bug in formatDeltaUsd() — a sub-dollar negative delta (e.g. -$0.30)
// rounded to "$0" but kept its "-" sign.
describe("formatDeltaUsd (What-if headline dollar delta formatter)", () => {
  it("drops the sign for a negative delta that rounds to $0", () => {
    expect(formatDeltaUsd(-0.3)).toBe("$0");
  });

  it("drops the sign for a positive delta that rounds to $0", () => {
    expect(formatDeltaUsd(0.3)).toBe("$0");
  });

  it("keeps the sign once a real digit survives rounding (negative)", () => {
    expect(formatDeltaUsd(-12)).toBe("-$12");
  });

  it("keeps the sign once a real digit survives rounding (positive)", () => {
    expect(formatDeltaUsd(12)).toBe("+$12");
  });

  it("keeps the sign for a large negative delta in the K band", () => {
    expect(formatDeltaUsd(-2_500)).toBe("-$3K");
  });

  it("keeps the sign for a large positive delta in the M band", () => {
    expect(formatDeltaUsd(1_500_000)).toBe("+$1.5M");
  });
});
