/**
 * QA findings
 *   [qa:analysis-risk-drawer--top10-by-risk-ranked-by-value-vmfxx-first]
 *   [qa:analysis-diagnostics--four-different-spy-weights-one-page-regression-4]
 *
 * The "Top N by risk" drawer was titled by one metric and ordered by
 * another. Two independent defects produced that:
 *
 *   1. lib/queries/drill-down.ts ranked the risk branch with a hand-rolled
 *      `market_value * COALESCE(beta, 1)` proxy — an uncached beta counted
 *      as 1.0 — instead of the risk contribution computePositionRisk already
 *      computes for the Position-Level Risk card on the same page.
 *   2. DrillDownPanel.tsx defaulted EVERY drawer's sort to "marketValue",
 *      so even a correctly ranked payload was re-sorted by size in the
 *      browser and the money-market sweep landed first.
 *
 * Static source-pin, not a DOM test (this repo has no jsdom/RTL harness —
 * see docs/reference: "No DOM test harness"). The behavioural assertions
 * live in tests/queries/drill-down-risk-ranking.test.ts; this file guards
 * the two things a behavioural test cannot see: that the ranking is not
 * re-forked in SQL, and that the panel presents the metric it claims.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "..", "..");

function read(relPath: string): string {
  return fs.readFileSync(path.join(REPO, relPath), "utf-8");
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("risk drill-down ranking is single-sourced on computePositionRisk", () => {
  it("lib/queries/drill-down.ts calls computePositionRisk instead of a beta proxy", () => {
    const code = stripComments(read("lib/queries/drill-down.ts"));
    expect(code).toMatch(/computePositionRisk\(/);
    // The pre-fix proxy, in any spacing, must be gone from executable code.
    expect(code).not.toMatch(/market_value\s*\*\s*COALESCE\(\s*beta/i);
  });

  it("it excludes sub-epsilon-volatility rows through the shared cash-equivalent identity", () => {
    const code = stripComments(read("lib/queries/drill-down.ts"));
    expect(code).toMatch(/MIN_RANKED_ANNUALIZED_VOL/);
    expect(code).toMatch(/isCashEquivalentSecurity/);
    // Never a hand-rolled money-market ticker/type list (project rule:
    // identity is owned by lib/compute/cash-equivalents.ts).
    expect(code).not.toMatch(/["']money_market["']/);
    expect(code).not.toMatch(/VMFXX|VUSXX/);
  });
});

describe("DrillDownPanel presents the metric it ranks by", () => {
  const src = read("app/dashboard/components/analysis/DrillDownPanel.tsx");
  const code = stripComments(src);

  it("does not force every drawer to default-sort by market value", () => {
    // Pre-fix: useSortParam<SortField>("drill", "marketValue", "desc") for
    // every kind, which re-sorted the risk payload by size client-side.
    expect(code).not.toMatch(/useSortParam<SortField>\(\s*["']drill["']\s*,\s*["']marketValue["']/);
    expect(code).toMatch(/useSortParam<SortField>\([\s\S]{0,120}?["']risk["']/);
  });

  it("renders a risk-contribution column gated on the risk kind", () => {
    expect(code).toMatch(/riskContribution/);
    expect(code).toMatch(/isRisk/);
    expect(code).toMatch(/filter\?\.kind === ["']risk["']/);
  });

  it("renders the risk contribution through the privacy component, not raw", () => {
    // Portfolio-derived percentages go through <Pct> (lib/privacy/components).
    const idx = code.indexOf("riskContribution != null");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(code.slice(idx, idx + 220)).toMatch(/<Pct\b/);
    // No raw toFixed on the metric.
    expect(code).not.toMatch(/riskContribution[^\n]*toFixed/);
  });

  it("the title names risk contribution and carries the holdings count", () => {
    // Pre-fix title: `Top ${filter.topN ?? 10} by Risk` — a metric name the
    // list did not obey, and the only kind that hid its own holdings count.
    expect(code).not.toMatch(/Top \$\{filter\.topN \?\? 10\} by Risk`/);
    expect(code).toMatch(
      /Top \$\{filter\.topN \?\? 10\} by risk contribution \$\{suffix\}/
    );
  });

  it("places the Risk header right after Ticker, ahead of Weight, so it is visible without horizontal scroll", () => {
    // The table (641px) is wider than the panel's scroller (479px). The risk
    // drawer's ranking metric — the reason the drawer exists — sat last in
    // the column order (after Beta), off-screen until the user scrolled.
    const tickerHeaderIdx = code.indexOf('field="symbol"');
    const riskHeaderIdx = code.indexOf('field="risk"');
    const weightHeaderIdx = code.indexOf('field="weight"');
    expect(tickerHeaderIdx).toBeGreaterThanOrEqual(0);
    expect(riskHeaderIdx).toBeGreaterThanOrEqual(0);
    expect(weightHeaderIdx).toBeGreaterThanOrEqual(0);
    expect(riskHeaderIdx).toBeGreaterThan(tickerHeaderIdx);
    expect(riskHeaderIdx).toBeLessThan(weightHeaderIdx);
  });

  it("places the Risk cell right after the Ticker cell, ahead of the Weight cell", () => {
    const tickerCellIdx = code.indexOf("r.symbol");
    const riskCellIdx = code.indexOf("riskContribution != null");
    const weightCellIdx = code.indexOf("r.weight * 100");
    expect(tickerCellIdx).toBeGreaterThanOrEqual(0);
    expect(riskCellIdx).toBeGreaterThanOrEqual(0);
    expect(weightCellIdx).toBeGreaterThanOrEqual(0);
    expect(riskCellIdx).toBeGreaterThan(tickerCellIdx);
    expect(riskCellIdx).toBeLessThan(weightCellIdx);
  });
});
