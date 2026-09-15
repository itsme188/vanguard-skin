/**
 * QA analysis-position-risk--privacy-leaves-bars-and-deltas-visible-regression-1
 * (badge half)
 *
 * app/dashboard/components/PositionRisk.tsx (fixed in commit 9f164e18)
 * masked the 7-day W-o-W delta badge at ONE call site by wrapping it in
 * `isPrivate ? <PrivateText>{null}</PrivateText> : <WeekOverWeekBadge .../>`.
 * That call-site wrapper has two defects: (1) it fabricates a "•••" delta
 * even when `computeWeekOverWeekDelta` returns null (no week-ago data) —
 * the badge's own null branch (an em-dash + "no week-ago data" title) never
 * runs under privacy; (2) RiskMetrics.tsx and FactorAnalysis.tsx render
 * <WeekOverWeekBadge> at seven more call sites with NO privacy wrapper at
 * all, so the same portfolio-derived delta leaks in the clear there.
 *
 * The fix moves privacy-awareness INTO WeekOverWeekBadge itself (it reads
 * `usePrivacy()` directly), so every call site is covered by one change.
 * This repo has no jsdom/RTL harness — pin the fix by reading the source
 * file as text, same pattern as
 * tests/dashboard/position-risk-privacy-source-pin.test.ts. Regexes use
 * `\s+`/`[\s\S]*?` (never a literal `\n`) so they tolerate both spaces and
 * newlines and don't false-negative on reformatted JSX.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(
  "app/dashboard/components/analysis/WeekOverWeekBadge.tsx",
  "utf8"
);

describe("WeekOverWeekBadge privacy masking", () => {
  it("reads the privacy flag via usePrivacy", () => {
    expect(src).toMatch(
      /import\s*\{\s*usePrivacy\s*\}\s*from\s*["']@\/lib\/privacy\/context["']/
    );
    expect(src).toMatch(/const\s*\{\s*isPrivate\s*\}\s*=\s*usePrivacy\(\)/);
  });

  it("checks value === null BEFORE the privacy branch, so 'no week-ago data' still renders as an em-dash under privacy (never fabricates a masked delta for missing data)", () => {
    const nullCheckIdx = src.search(/if\s*\(\s*value\s*===\s*null\s*\)/);
    const privateCheckIdx = src.search(/if\s*\(\s*isPrivate\s*\)/);
    expect(nullCheckIdx).toBeGreaterThan(-1);
    expect(privateCheckIdx).toBeGreaterThan(-1);
    expect(nullCheckIdx).toBeLessThan(privateCheckIdx);
  });

  it("still returns the em-dash / 'no week-ago data' title for value === null", () => {
    expect(src).toMatch(
      /if\s*\(\s*value\s*===\s*null\s*\)\s*\{[\s\S]{0,200}?title="no week-ago data"[\s\S]{0,60}?>\s*—\s*<\/span>/
    );
  });

  it("renders the mask glyph with no color/sign/arrow hint when private and value is non-null", () => {
    // The isPrivate branch must appear after the null check, and its JSX
    // must NOT reference colorClass, the directional arrow, or a signed
    // magnitude — only the flat mask string.
    const match = src.match(
      /if\s*\(\s*isPrivate\s*\)\s*\{([\s\S]{0,400}?)\n\s*\}/
    );
    expect(match).not.toBeNull();
    const body = match![1];
    expect(body).toMatch(/•••/);
    expect(body).not.toMatch(/colorClass/);
    expect(body).not.toMatch(/arrow/);
    expect(body).not.toMatch(/text-up|text-down/);
  });

  it("does not compute magnitude/arrow/color before deciding the private branch (order guard)", () => {
    // Scope to the component body only — `formatWeekOverWeekMagnitude(` also
    // appears earlier as the helper function's own declaration, which isn't
    // what this test is about.
    const bodyStart = src.search(/export const WeekOverWeekBadge = memo\(/);
    expect(bodyStart).toBeGreaterThan(-1);
    const body = src.slice(bodyStart);
    const privateCheckIdx = body.search(/if\s*\(\s*isPrivate\s*\)/);
    const magnitudeCallIdx = body.search(/=\s*formatWeekOverWeekMagnitude\(/);
    expect(privateCheckIdx).toBeGreaterThan(-1);
    expect(magnitudeCallIdx).toBeGreaterThan(-1);
    expect(privateCheckIdx).toBeLessThan(magnitudeCallIdx);
  });

  it("keeps the non-private zero/directional rendering intact", () => {
    expect(src).toMatch(/↔ 0\.00 \/ 7d/);
    expect(src).toMatch(/value > 0 \? "↑" : "↓"/);
  });
});
