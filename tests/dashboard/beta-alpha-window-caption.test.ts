import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// QA finding `analysis-performance--beta-alpha-decomposition-ignores-period-
// selector-regression-1`: at a multi-account scope the beta/alpha card is
// computed over the full-coverage daily window, which is shorter than every
// selectable period, so YTD/3Y/5Y all read the same figures. Its two sibling
// blocks (Max drawdown & Sharpe, the equity curve) name their real window via
// dataWindowNotice; the beta/alpha card must carry the same caption, fed by
// the window the regression actually used (PeriodAttribution.betaWindow).
// No DOM harness in this repo — source-pin, browser proof separately.
describe("beta/alpha decomposition card names its computed-from window", () => {
  const section = readFileSync("app/dashboard/components/PeriodAttributionSection.tsx", "utf8");
  const view = readFileSync("app/dashboard/components/PerformanceView.tsx", "utf8");

  it("the card builds its caption with the shared dataWindowNotice helper", () => {
    expect(section).toContain('import { dataWindowNotice } from "@/lib/compute/data-window"');
    expect(section).toMatch(
      /dataWindowNotice\(\s*requestedStart,\s*attribution\.betaWindow\?\.start \?\? null,\s*attribution\.betaWindow\?\.end \?\? null,?\s*\)/,
    );
  });

  it("PerformanceView passes the SELECTED period start (undefined for All), not the 2000-01-01 fallback", () => {
    expect(view).toMatch(/<PeriodAttributionSection[\s\S]*?requestedStart=\{startDate\}/);
    expect(view).not.toMatch(/requestedStart=\{effectiveStart\}/);
  });
});
