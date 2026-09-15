/**
 * QA analysis-position-risk--privacy-leaves-bars-and-deltas-visible-regression-1
 *
 * The Position-Level Risk table (app/dashboard/components/PositionRisk.tsx)
 * already masked the Weight / Volatility / Risk Contrib numbers to "•••"
 * through <Pct>, but under privacy mode three portfolio-derived signals
 * still leaked the same information in a different form:
 *
 *  (a) each row's risk-contribution bar still drew at its REAL width
 *      (`width: ${Math.abs(pos.riskContribution) * 100}%`), reproducing the
 *      hidden ranking exactly via bar length alone;
 *  (b) the 7-day delta badge next to the masked value (e.g. "↓ 2.3% / 7d")
 *      still printed the real change in the clear;
 *  (c) the "Corr w/ Port" column (a correlation of this holder's OWN
 *      position against their OWN portfolio — portfolio-derived) wasn't
 *      masked at all, including its magnitude-coded background color.
 *
 * (b) is now fixed INSIDE <WeekOverWeekBadge> itself (it reads
 * `usePrivacy()` directly — see week-over-week-badge-privacy-source-pin.test.ts),
 * not by a call-site wrapper here: a call-site `isPrivate ? <PrivateText/> :
 * <WeekOverWeekBadge/>` wrapper fabricated a "•••" delta even when
 * `computeWeekOverWeekDelta` returns null (no week-ago data), since the
 * badge's own null branch never ran. The badge is now rendered directly,
 * unwrapped, at this call site.
 *
 * This repo has no jsdom/RTL harness (see the precedent note in
 * tests/dashboard/narrative-block-refresh.test.ts) — pin the fix by reading
 * the source file as text, same pattern as
 * tests/dashboard/options-strategies-privacy-source-pin.test.ts and
 * tests/repo/notes-view-privacy-pin.test.ts. The regexes are
 * whitespace/newline-tolerant (never a literal `\n`, never order-sensitive
 * on import names) so reformatting the JSX doesn't make this a false
 * negative.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync("app/dashboard/components/PositionRisk.tsx", "utf8");

describe("PositionRisk privacy masking", () => {
  it("reads the privacy flag via usePrivacy", () => {
    expect(src).toMatch(
      /import\s*\{\s*usePrivacy\s*\}\s*from\s*["']@\/lib\/privacy\/context["']/
    );
    expect(src).toMatch(/const\s*\{\s*isPrivate\s*\}\s*=\s*usePrivacy\(\)/);
  });

  it("imports PrivateText alongside Pct from the shared privacy components", () => {
    // Order-independent and trailing-comma-tolerant: assert both names
    // appear inside the same `import { ... } from ".../privacy/components"`
    // clause, not a fixed "Pct, PrivateText" token order.
    const importMatch = src.match(
      /import\s*\{([\s\S]*?)\}\s*from\s*["']@\/lib\/privacy\/components["']/
    );
    expect(importMatch).not.toBeNull();
    const names = importMatch![1];
    expect(names).toMatch(/\bPct\b/);
    expect(names).toMatch(/\bPrivateText\b/);
  });

  // (a) risk-contribution bar width must not encode the real ranking when
  // privacy is on — it collapses to a constant width, same pattern as
  // app/dashboard/components/CoverageBar.tsx.
  it("collapses the risk-contribution bar to a constant width under privacy", () => {
    expect(src).toMatch(/width:\s*isPrivate\s*\?\s*["']100%["']/);
    // The real per-row width expression must still exist for the
    // non-private branch.
    expect(src).toMatch(
      /\$\{Math\.min\(Math\.abs\(pos\.riskContribution\)\s*\*\s*100,\s*100\)\}%/
    );
  });

  it("dims the bar fill under privacy so a constant-width bar still reads as masked", () => {
    expect(src).toMatch(/isPrivate\s*\?\s*["']\s*opacity-30["']/);
  });

  // (b) the 7-day delta badge is portfolio-derived (change in risk
  // contribution). Masking now lives INSIDE <WeekOverWeekBadge> itself
  // (see week-over-week-badge-privacy-source-pin.test.ts) — a call-site
  // `isPrivate ? <PrivateText/> : <WeekOverWeekBadge/>` wrapper would
  // fabricate a masked delta even when there's no week-ago data at all
  // (the badge's own null branch never ran), so this call site must
  // render the badge directly, unwrapped by any isPrivate ternary.
  it("renders WeekOverWeekBadge directly, not gated by a call-site isPrivate ternary", () => {
    expect(src).toMatch(
      /<WeekOverWeekBadge\s+value=\{computeWeekOverWeekDelta\(pos,\s*weekAgoPosns\)\}[\s\S]{0,300}?\/>/
    );
  });

  it("does not wrap the W-o-W badge call site in an isPrivate ternary (regression guard)", () => {
    // Look at the risk-contribution cell specifically: the badge call must
    // not be preceded by "isPrivate ? (" within the immediately enclosing
    // JSX (i.e. no call-site branch gating it like the old regression).
    const cellMatch = src.match(
      /pos\.riskContribution\s*!=\s*null\s*\?\s*\(([\s\S]*?)\)\s*:\s*\(\s*<span className="text-ink-faint">/
    );
    expect(cellMatch).not.toBeNull();
    const cellBody = cellMatch![1];
    expect(cellBody).toMatch(/<WeekOverWeekBadge/);
    expect(cellBody).not.toMatch(/isPrivate\s*\?\s*\(/);
    expect(cellBody).not.toMatch(/<PrivateText/);
  });

  // (c) Corr w/ Port is a correlation of the holder's own position against
  // their own portfolio — portfolio-derived, must mask like the rest of
  // the row, including the magnitude-coded background/text color.
  //
  // Anchored on `pos.correlationWithPortfolio != null ? ( isPrivate ? ...`
  // specifically (not a bare "isPrivate ? ( ... <PrivateText>" anywhere in
  // the file) so this fails if ONLY the correlation masking is reverted
  // while some unrelated isPrivate/PrivateText pairing elsewhere survives.
  it("masks the Corr w/ Port cell through PrivateText when private", () => {
    expect(src).toMatch(
      /pos\.correlationWithPortfolio\s*!=\s*null\s*\?\s*\(\s*isPrivate\s*\?[\s\S]{0,600}?<PrivateText[\s\S]{0,200}?>\s*\{null\}\s*<\/PrivateText>/
    );
  });

  it("still renders the real correlation value + corrColor styling in the non-private branch", () => {
    expect(src).toMatch(
      /className=\{`font-mono tabular-nums text-xs px-1\.5 py-0\.5 rounded \$\{corrColor\(pos\.correlationWithPortfolio\)\}`\}/
    );
    expect(src).toMatch(/\{formatCorr\(pos\.correlationWithPortfolio\)\}/);
  });

  it("does not wrap Weight or Volatility in anything other than the existing <Pct> masking (regression guard)", () => {
    expect(src).toMatch(
      /<Pct value=\{pos\.weight != null \? pos\.weight \* 100 : null\} digits=\{1\} \/>/
    );
    expect(src).toMatch(
      /<Pct value=\{pos\.annualizedVol != null \? pos\.annualizedVol \* 100 : null\} digits=\{1\} \/>/
    );
  });
});
