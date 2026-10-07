/**
 * QA analysis-risk-table--largest-position-blank-risk-cells-no-explanation
 * QA analysis-position-risk--pairwise-correlation-matrix-unmasked-under-privacy
 * QA mobile-diagnostics--view-top-10-by-risk-link-125x16-tap-target-no-touch-extension
 *
 * Owner ruling (2026-08-31): a blank in the Position-Level Risk card always
 * says why it is blank. A cash-equivalent row reads "cash equivalent, no
 * market risk"; any other blank reads "insufficient data" with the cause.
 * Nothing is computed or defaulted to fill the gap.
 *
 * The reasons are pure functions, tested directly. The rendering is pinned by
 * reading the source (this repo has no DOM test harness).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  riskRowBlank,
  correlationBlank,
  riskContributionBlank,
  PAIR_BLANK,
} from "@/app/dashboard/components/PositionRisk";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";

const src = readFileSync("app/dashboard/components/PositionRisk.tsx", "utf8");

function row(over: Record<string, unknown> = {}) {
  return {
    securityId: 1,
    symbol: "AAA",
    securityName: "AAA Corp",
    marketValue: 1000,
    weight: 0.1,
    annualizedVol: 0.2,
    riskContribution: 0.05,
    correlationWithPortfolio: 0.6,
    dataPoints: 200,
    ...over,
  };
}

const blankRow = {
  annualizedVol: null,
  riskContribution: null,
  correlationWithPortfolio: null,
};

describe("riskRowBlank", () => {
  it("returns null for a fully computed row", () => {
    expect(riskRowBlank(row())).toBeNull();
  });

  it("labels a blank cash-equivalent row as cash, not as a data gap", () => {
    const blank = riskRowBlank(row({ ...blankRow, dataPoints: 0, cashEquivalent: true }));
    expect(blank?.kind).toBe("cash-equivalent");
    expect(blank?.label).toBe("cash equivalent, no market risk");
    expect(blank?.detail.length).toBeGreaterThan(0);
  });

  it("labels a cash-equivalent row as cash even when only some cells are blank", () => {
    // A constant-price fund WITH a daily price history computes a zero
    // volatility and no usable correlation; the row is still cash.
    const blank = riskRowBlank(
      row({ annualizedVol: 0, riskContribution: null, correlationWithPortfolio: null, cashEquivalent: true })
    );
    expect(blank?.kind).toBe("cash-equivalent");
  });

  it("keeps the figures of a cash-flagged row that has every figure", () => {
    expect(riskRowBlank(row({ cashEquivalent: true }))).toBeNull();
  });

  it("says insufficient data, with the return count, for a thin price history", () => {
    const blank = riskRowBlank(row({ ...blankRow, dataPoints: 3 }));
    expect(blank?.kind).toBe("insufficient-data");
    expect(blank?.label).toBe("insufficient data");
    expect(blank?.detail).toContain("3 usable daily returns");
  });

  it("uses the singular for one return and a plain sentence for none", () => {
    expect(riskRowBlank(row({ ...blankRow, dataPoints: 1 }))?.detail).toContain("1 usable daily return ");
    expect(riskRowBlank(row({ ...blankRow, dataPoints: 0 }))?.detail).toContain("no usable daily price history");
  });

  it("never treats a row without the cash flag as cash", () => {
    // The flag is the only cash signal: no symbol or name guessing here.
    const blank = riskRowBlank(row({ ...blankRow, symbol: "VMFXX", securityName: "Money Market Fund", dataPoints: 0 }));
    expect(blank?.kind).toBe("insufficient-data");
  });
});

describe("cell-level blanks on a row that has a volatility", () => {
  it("returns null when the figure exists", () => {
    expect(correlationBlank(row())).toBeNull();
    expect(riskContributionBlank(row(), 0.15)).toBeNull();
  });

  it("explains a missing correlation", () => {
    const blank = correlationBlank(row({ correlationWithPortfolio: null, riskContribution: null }));
    expect(blank?.label).toBe("insufficient data");
    expect(blank?.detail).toMatch(/in common with the top-10 basket/);
  });

  it("traces a missing risk contribution to the missing correlation first", () => {
    const pos = row({ correlationWithPortfolio: null, riskContribution: null });
    expect(riskContributionBlank(pos, 0.15)?.detail).toBe(correlationBlank(pos)?.detail);
  });

  it("names the basket volatility when the correlation exists but the contribution does not", () => {
    const pos = row({ riskContribution: null });
    for (const basketVol of [null, 0]) {
      const blank = riskContributionBlank(pos, basketVol);
      expect(blank?.label).toBe("insufficient data");
      expect(blank?.detail).toMatch(/basket volatility/);
    }
  });
});

describe("PositionRisk blanks: source pins", () => {
  it("renders no bare em-dash anywhere in the card", () => {
    // Every blank goes through <BlankMarker>; a literal dash cell is the bug.
    expect(src).not.toContain("\\u2014");
    expect(src).not.toMatch(/>\s*—\s*</);
    expect(src).not.toMatch(/["'`]—["'`]/);
  });

  it("shows the marker text itself, with the cause in a title", () => {
    const marker = sliceBetween(src, "function BlankMarker(", "// ─── Component");
    expect(marker).toContain("title={blank.detail}");
    expect(marker).toContain("{blank.label}");
  });

  it("guards the Volatility figure behind the whole-row blank", () => {
    const rowBlankAt = anchorIndex(src, "const rowBlank = riskRowBlank(pos)");
    const volAt = anchorIndex(src, "pos.annualizedVol != null ? pos.annualizedVol * 100 : null");
    expect(rowBlankAt).toBeLessThan(volAt);
    const between = src.slice(rowBlankAt, volAt);
    expect(between).toContain("colSpan={3}");
    expect(between).toContain("<BlankMarker blank={rowBlank}");
  });

  it("routes the blank correlation, contribution and pair cells through the marker", () => {
    expect(src).toContain("<BlankMarker blank={correlationBlank(pos)}");
    expect(src).toContain("<BlankMarker blank={riskContributionBlank(pos, data.portfolioVol)}");
    expect(src).toContain("<BlankMarker blank={PAIR_BLANK}");
    expect(PAIR_BLANK.label).toBe("insufficient data");
  });
});

describe("Pairwise Correlations under privacy", () => {
  const matrix = sliceBetween(src, "Pairwise Correlations", "P3 Slice C — drill-down panel for top-N risk");

  it("masks an off-diagonal cell and drops its magnitude colour and its title", () => {
    const privateAt = anchorIndex(matrix, "if (isPrivate) {");
    const clearAt = anchorIndex(matrix, "style={{ background: corrBg(corr) }}");
    expect(privateAt).toBeLessThan(clearAt);
    const privateBranch = matrix.slice(privateAt, clearAt);
    expect(privateBranch).toMatch(/<PrivateText>\s*\{null\}\s*<\/PrivateText>/);
    expect(privateBranch).not.toContain("corrBg(");
    expect(privateBranch).not.toContain("title=");
    expect(privateBranch).not.toContain("formatCorr(");
    expect(privateBranch).toContain("return (");
  });

  it("keeps the clear value for the non-private branch", () => {
    expect(matrix).toContain("{formatCorr(corr)}");
  });
});

describe("'View top 10 by risk' tap target", () => {
  it("carries a coarse-pointer touch extension", () => {
    const at = anchorIndex(src, 'aria-label="Open top 10 by risk in drill-down panel"');
    const button = src.slice(src.lastIndexOf("<button", at), at);
    expect(button).toContain("relative");
    expect(button).toContain("pointer-coarse:after:absolute");
    expect(button).toContain("pointer-coarse:after:content-['']");
    expect(button).toContain("pointer-coarse:after:-inset-y-3.5");
    expect(button).toContain("pointer-coarse:after:-inset-x-1");
  });
});
