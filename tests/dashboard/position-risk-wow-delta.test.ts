import { describe, it, expect } from "vitest";
import { computeWeekOverWeekDelta } from "@/app/dashboard/components/PositionRisk";

describe("computeWeekOverWeekDelta", () => {
  it("returns the per-symbol delta when both current and prior rows exist", () => {
    const past = [
      { symbol: "NVDA", riskContribution: 0.14 },
      { symbol: "AAPL", riskContribution: 0.08 },
    ];
    const current_nvda = { symbol: "NVDA", riskContribution: 0.18 };
    const current_aapl = { symbol: "AAPL", riskContribution: 0.06 };
    expect(computeWeekOverWeekDelta(current_nvda, past)).toBeCloseTo(0.04, 5);
    expect(computeWeekOverWeekDelta(current_aapl, past)).toBeCloseTo(-0.02, 5);
  });

  it("returns null when the prior week has no matching symbol", () => {
    const current = { symbol: "NEW_TICKER", riskContribution: 0.05 };
    const past = [{ symbol: "OLD", riskContribution: 0.10 }];
    expect(computeWeekOverWeekDelta(current, past)).toBeNull();
  });

  it("returns null when prior week is null or empty", () => {
    const current = { symbol: "NVDA", riskContribution: 0.18 };
    expect(computeWeekOverWeekDelta(current, null)).toBeNull();
    expect(computeWeekOverWeekDelta(current, [])).toBeNull();
  });
});
