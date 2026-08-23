import { describe, it, expect } from "vitest";
import { chartEmptyStateMessage } from "@/app/dashboard/components/SecurityChart";

describe("chartEmptyStateMessage", () => {
  it("returns null when bars are visible in the selected window", () => {
    expect(
      chartEmptyStateMessage({
        visibleBarCount: 42,
        lastBarDate: "2026-04-28",
        rangeLabel: "3 months",
        symbol: "GLW",
      }),
    ).toBeNull();
  });

  it("explains a window-scoped gap when whole-history bars exist but none fall in range (deep-QA: GLW 1M/3M)", () => {
    expect(
      chartEmptyStateMessage({
        visibleBarCount: 0,
        lastBarDate: "2026-04-28",
        rangeLabel: "3 months",
        symbol: "GLW",
      }),
    ).toBe("No bars in the last 3 months — cached history ends 2026-04-28.");
  });

  it("keeps the original 'connect TWS' copy when there is genuinely no cached history", () => {
    expect(
      chartEmptyStateMessage({
        visibleBarCount: 0,
        lastBarDate: null,
        rangeLabel: "1 year",
        symbol: "TSLA",
      }),
    ).toBe("No cached price history for TSLA — connect TWS to load bars.");
  });
});
