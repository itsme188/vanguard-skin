/**
 * QA finding security-detail-levels-panel--failed-fetch-renders-no-active-
 * levels-empty-state: LevelsPanel's refresh() wrapped its /api/levels fetch
 * in try/finally with no catch, and only called setLevels when
 * json.success was true. A rejected fetch (network error, timeout) or a
 * non-2xx / {success:false} response left `levels` at its initial [], which
 * rendered the ordinary "No active levels" empty state — a failed load was
 * indistinguishable from a genuinely empty one.
 *
 * LevelsPanel is "use client" with no jsdom/@testing-library/react harness
 * in this repo (see precedent note in tests/dashboard/narrative-block-
 * refresh.test.ts) — pinned with a source scan, same pattern as
 * tests/dashboard/tax-report-card-scope.test.ts's "source pin" section and
 * tests/dashboard/cmdk-hover-and-option-ranking.test.ts's CommandPalette
 * source-pin block.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "@/tests/helpers/source-anchor";

describe("LevelsPanel load-error handling (source pin)", () => {
  const src = readFileSync("app/dashboard/components/LevelsPanel.tsx", "utf8");

  it("declares a loadError state slot alongside the existing loading state", () => {
    expect(src).toMatch(/useState<string\s*\|\s*null>\(null\)/);
    expect(src).toMatch(/const\s*\[\s*loadError\s*,\s*setLoadError\s*\]/);
  });

  it("refresh() catches a thrown/rejected fetch and reports it via setLoadError", () => {
    const refreshMatch = src.match(
      /const refresh = useCallback\(async \(\) => \{[\s\S]*?\n {2}\}, \[securityId, showInactive\]\);/,
    );
    expect(refreshMatch).not.toBeNull();
    const refreshBody = refreshMatch![0];

    // Must have a real catch block (not an empty `catch {}`) that calls
    // setLoadError — a thrown fetch/timeout must not disappear silently.
    const catchMatch = refreshBody.match(/catch\s*(?:\([^)]*\))?\s*\{([\s\S]*?)\n {4}\}/);
    expect(catchMatch).not.toBeNull();
    const catchBody = catchMatch![1];
    expect(catchBody.trim().length).toBeGreaterThan(0);
    expect(catchBody).toMatch(/setLoadError\(/);

    // The success path must also treat !res.ok and a falsy `success` as
    // failure — not just an explicit {success:false}.
    expect(refreshBody).toMatch(/!res\.ok/);
    expect(refreshBody).toMatch(/!json\??\.success/);

    // A failed refetch must not clear rows already on screen — no
    // `setLevels([])` / `setLevels(null)` anywhere in the failure paths.
    expect(refreshBody).not.toMatch(/setLevels\(\s*(\[\]|null)\s*\)/);

    // Success clears any prior error.
    expect(refreshBody).toMatch(/setLoadError\(null\)/);
  });

  it('gates the "No active levels" empty-state copy on loadError being falsy', () => {
    // Search for the exact JSX string, not just any mention of the phrase —
    // an explanatory comment elsewhere in the file also references "No
    // active levels" in prose — so the guard-window check below anchors on
    // the real render branch.
    const copyIndex = anchorIndex(src, 
      "No active levels · accept a suggestion or add your own",
    );
    expect(copyIndex).toBeGreaterThan(-1);
    // Look back a reasonable window for the guard that gates this branch —
    // robust to exact formatting (ternary vs `&&`, whitespace, line breaks).
    const window = src.slice(Math.max(0, copyIndex - 800), copyIndex);
    expect(window).toMatch(/!loadError/);
  });

  it("provides a Retry control whose handler calls refresh", () => {
    expect(src).toMatch(/>\s*Retry\s*</);
    // The retry affordance is a real button (works on touch, no hover-only
    // interaction) wired to invoke refresh.
    expect(src).toMatch(/<button\s+type="button"\s+onClick=\{onRetry\}/);
    expect(src).toMatch(/onRetry=\{refresh\}/);
  });

  it("renders the load-error notice for both the embedded and compact variants", () => {
    expect(src).toMatch(/embedded\s*\n?\s*\/>/); // full-block embedded usage (no `inline`)
    expect(src).toMatch(/embedded=\{false\}/); // compact usage
    expect(src).toMatch(/inline/); // the above-list stale-list notice variant
  });

  it("tags the fix with the QA finding id", () => {
    expect(src).toMatch(
      /\[qa:security-detail-levels-panel--failed-fetch-renders-no-active-levels-empty-state\]/,
    );
  });
});
