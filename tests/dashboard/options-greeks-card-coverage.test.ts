import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// This repo has no React component-rendering harness (no @testing-library/react,
// no jsdom environment in vitest.config.ts). Following the static-scan precedent
// in tests/dashboard/data-confidence-indicator-privacy.test.ts, this test scans
// the component source instead of rendering it.
//
// Finding (analysis-greeks-ibkr--delta-neutral-claim-over-unpriceable-only-position):
// at a scope whose ONLY option position couldn't be priced (no underlying
// price), the card still printed Net Delta 0.0 "Delta-neutral" / Net Gamma 0.0
// "Negligible convexity" / Daily Theta $0 "roughly a wash" / Net Vega $0
// "negligible" — turning absence of evidence (nothing was priced) into an
// affirmative risk statement. Root cause: totalDelta/Gamma/Theta/Vega stay at
// their 0 initialization when every position hits an early diagnostic
// `continue` in computePortfolioGreeks. The fix threads computedPositions /
// totalPositions through PortfolioGreeks and gates the card's interpretation
// calls + tile values on that coverage pair.

const COMPONENT_PATH = path.join(
  process.cwd(),
  "app/dashboard/components/OptionsGreeksCard.tsx",
);

describe("OptionsGreeksCard — coverage gating (no interpretation over unpriced Greeks)", () => {
  const source = fs.readFileSync(COMPONENT_PATH, "utf8");

  it("imports Count from the privacy components module (portfolio-derived position counts)", () => {
    expect(source).toMatch(/import\s*\{[^}]*Count[^}]*\}\s*from\s*["']@\/lib\/privacy\/components["']/);
  });

  it("derives a noCoverage flag for totalPositions > 0 && computedPositions === 0", () => {
    expect(source).toMatch(
      /noCoverage\s*=\s*data\.totalPositions\s*>\s*0\s*&&\s*data\.computedPositions\s*===\s*0/,
    );
  });

  it("derives a partialCoverage flag for 0 < computedPositions < totalPositions", () => {
    expect(source).toMatch(
      /partialCoverage\s*=\s*!noCoverage\s*&&\s*data\.computedPositions\s*<\s*data\.totalPositions/,
    );
  });

  it("renders the honest 'Greeks unavailable' line gated on noCoverage, with totalPositions rendered through <Count>", () => {
    expect(source).toMatch(/\{noCoverage\s*&&\s*\(/);
    expect(source).toMatch(/Greeks unavailable — 0 of <Count value=\{data\.totalPositions\} \/> positions could be priced/);
  });

  it("renders a 'Covers N of M positions' sublabel gated on partialCoverage, both counts through <Count>", () => {
    expect(source).toMatch(/\{partialCoverage\s*&&\s*\(/);
    expect(source).toMatch(
      /Covers <Count value=\{data\.computedPositions\} \/> of <Count value=\{data\.totalPositions\} \/> positions/,
    );
  });

  it("guards EVERY interpretation call (interpretDelta/Gamma/Theta/Vega) behind the noCoverage ternary — none run unconditionally", () => {
    // Each call site must be written as `noCoverage ? undefined : interpretX(...)`
    // so that when the only position(s) in scope couldn't be priced, no
    // affirmative "delta-neutral" / "negligible" / "wash" verdict is produced.
    for (const fn of ["interpretDelta", "interpretGamma", "interpretTheta", "interpretVega"]) {
      const guarded = new RegExp(`interp=\\{noCoverage \\? undefined : ${fn}\\(`);
      expect(source, `${fn} call site must be guarded by \`noCoverage ? undefined : ${fn}(...)\``).toMatch(guarded);

      // And there must be no OTHER call site of the same interpretation
      // function that isn't behind that exact guard (i.e. every occurrence of
      // `interpretX(` in the file is immediately preceded by the guard).
      const allCalls = source.match(new RegExp(`${fn}\\(`, "g")) ?? [];
      const guardedCalls = source.match(new RegExp(`noCoverage \\? undefined : ${fn}\\(`, "g")) ?? [];
      expect(allCalls.length, `${fn} must only ever be called from behind the noCoverage guard`).toBe(
        guardedCalls.length,
      );
    }
  });

  it("shows an em-dash placeholder value (not a numeric 0) for all four tiles when noCoverage", () => {
    // Each tile's `value` prop must fork on noCoverage to a literal em-dash
    // rather than formatting the raw (still-zero) total.
    const valueForks = source.match(/value=\{noCoverage \? <span[^>]*>—<\/span> : /g) ?? [];
    expect(valueForks.length).toBe(4);
  });
});
