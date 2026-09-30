import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(
  join(process.cwd(), "app/dashboard/components/SecurityChart.tsx"),
  "utf8",
);

describe("SecurityChart overlays wait for the candle series", () => {
  it("flips seriesReady true right after the series ref is assigned", () => {
    expect(src).toMatch(
      /candleSeriesRef\.current = candleSeries;\s*\n\s*setSeriesReady\(true\);/,
    );
  });

  it("flips seriesReady false where the series ref is nulled", () => {
    expect(src).toMatch(
      /candleSeriesRef\.current = null;\s*\n\s*setSeriesReady\(false\);/,
    );
  });

  it("re-runs the active-levels effect when the series appears", () => {
    expect(src).toMatch(/\}, \[securityId, seriesReady\]\);\s*\n\s*\n\s*\/\/ Suggested support/);
  });

  it("re-runs the suggested-levels effect when the series appears", () => {
    expect(src).toMatch(/\}, \[securityId, showSuggested, seriesReady\]\);/);
  });
});
