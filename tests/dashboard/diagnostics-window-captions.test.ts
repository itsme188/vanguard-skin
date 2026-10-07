import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { sliceBetween } from "../helpers/source-anchor";

// QA finding (HIGH, owner ruling 2026-10-06, Option 1): on Analysis ·
// Diagnostics the Risk Decomposition card is floored at the cross-account
// common coverage start (so scopes compare like for like) while the Market
// Regression card uses the scope's full history. No number changes; BOTH
// cards caption their window and observation count so the disagreement is
// explained rather than hidden. No DOM harness — source-pin, browser proof
// separately.
describe("Diagnostics risk and regression cards caption their windows", () => {
  const risk = readFileSync("app/dashboard/components/RiskMetrics.tsx", "utf8");
  const factor = readFileSync("app/dashboard/components/FactorAnalysis.tsx", "utf8");

  it("Risk Decomposition header names the common comparison window with its dates", () => {
    const header = sliceBetween(risk, "Risk Decomposition</h3>", "<NarrativeBlock");
    expect(header).toContain("{metrics.dataPoints} daily observations");
    expect(header).toContain("common comparison window");
    expect(header).toMatch(/formatDate\(metrics\.seriesStart\)[\s\S]*formatDate\(metrics\.seriesEnd\)/);
    expect(header).toContain("seam day");
  });

  it("Market Regression card captions its own window from the payload, not client-side dates", () => {
    const section = sliceBetween(factor, "Market Regression (vs {benchmark})", "Factor tilts");
    expect(section).toContain("{reg.dataPoints} daily observations");
    expect(section).toMatch(/formatDate\(reg\.windowStart\)[\s\S]*formatDate\(reg\.windowEnd\)/);
    expect(section).toContain("this scope's full history");
    // The caption sits under the section heading, in the muted caption style.
    expect(section).toMatch(/<p className="text-xs text-ink-faint[^"]*"[^>]*>\s*\{reg\.dataPoints\} daily observations/);
  });

  it("the regression payload type carries the window dates", () => {
    const lib = readFileSync("lib/compute/factors.ts", "utf8");
    const iface = sliceBetween(lib, "export interface MarketRegression {", "}");
    expect(iface).toMatch(/windowStart: string;/);
    expect(iface).toMatch(/windowEnd: string;/);
  });
});
