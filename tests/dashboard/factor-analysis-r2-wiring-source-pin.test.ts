/**
 * Landing-review follow-up to commit 2ba771d7 ("the alpha reading respects
 * the Market Regression card's own R² tiers"): that commit hedged
 * `interpretAlpha`'s text at low R² but left two things unfixed in
 * app/dashboard/components/FactorAnalysis.tsx:
 *
 *  (a) `interpretBeta` was called without the regression's R², so beta was
 *      still narrated as fact ("Moves ~N% more...") directly under a banner
 *      that says "treat beta and alpha here as noise, not signal" — see
 *      lib/analysis/interpret.ts's `interpretBeta` r2 tiers.
 *  (b) the Alpha tile's paint color was hardcoded off the raw sign of
 *      `reg.alpha` (`reg.alpha >= 0 ? "up" : "down"`), so a card captioned
 *      "not interpretable at this R²" could still paint green/red as if the
 *      sign meant something.
 *
 * This repo has no jsdom/RTL harness (tests/dashboard/narrative-block-refresh.test.ts) —
 * pin the fix by reading the source file as text, same pattern as
 * tests/dashboard/position-risk-privacy-source-pin.test.ts. Regexes are
 * whitespace/newline-tolerant so reformatting the JSX doesn't make this a
 * false negative, and are not anchored to column 0 or a single className.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync("app/dashboard/components/FactorAnalysis.tsx", "utf8");

describe("FactorAnalysis R²-aware beta/alpha wiring", () => {
  it("threads reg.rSquared into interpretBeta alongside the benchmark", () => {
    expect(src).toMatch(
      /interpretBeta\(\s*reg\.beta\s*,\s*benchmark\s*,\s*reg\.rSquared\s*\)/,
    );
  });

  it("threads reg.rSquared into interpretAlpha", () => {
    expect(src).toMatch(
      /interpretAlpha\(\s*reg\.alpha\s*,\s*reg\.rSquared\s*\)/,
    );
  });

  it("the Beta tile's hint text comes from the R²-aware interpretation", () => {
    expect(src).toMatch(/hint=\{\s*betaInterp\.text\s*\}/);
  });

  it("the Alpha tile's hint text comes from the R²-aware interpretation", () => {
    expect(src).toMatch(/hint=\{\s*alphaInterp\.text\s*\}/);
  });

  // (b) — the alpha tile's color must be derived from the interpretation's
  // tone, never the raw sign of reg.alpha.
  it("derives the Alpha tile's color from the interpretation's tone", () => {
    expect(src).toMatch(
      /color=\{\s*toneToMetricColor\(\s*alphaInterp\.tone\s*\)\s*\}/,
    );
  });

  it("does not paint the Alpha tile off the raw sign of reg.alpha (regression guard)", () => {
    expect(src).not.toMatch(
      /color=\{\s*reg\.alpha\s*>=\s*0\s*\?\s*["']up["']\s*:\s*["']down["']\s*\}/,
    );
  });

  // toneToMetricColor itself must preserve the good/bad/neutral → up/down/neutral
  // mapping implied by toneClass in lib/analysis/interpret.ts — a card whose
  // reading is hedged to "neutral" must never still paint up/down.
  it("toneToMetricColor maps good/bad/neutral tones to up/down/neutral colors", () => {
    expect(src).toMatch(
      /function\s+toneToMetricColor\s*\([\s\S]{0,80}?\)[\s\S]{0,80}?\{\s*if\s*\(\s*tone\s*===\s*["']good["']\s*\)\s*return\s*["']up["'];\s*if\s*\(\s*tone\s*===\s*["']bad["']\s*\)\s*return\s*["']down["'];\s*return\s*["']neutral["'];\s*\}/,
    );
  });

  it("the low-R² warning banner comment no longer embeds a real-looking figure", () => {
    // Regression guard for the earlier "+63%" / "R² 0.1%" example figure —
    // any digit-percent pairing near the comment would suggest a live number.
    expect(src).not.toMatch(/\+?\d+(\.\d+)?%\s*["']?alpha["']?/i);
  });
});
