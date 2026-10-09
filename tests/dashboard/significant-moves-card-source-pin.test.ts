import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "../helpers/source-anchor";

const src = readFileSync("app/dashboard/components/SignificantMovesCard.tsx", "utf8");

describe("SignificantMovesCard empty states and labels", () => {
  it("checks the trading-day pair before saying nothing moved", () => {
    expect(src).toMatch(/import\s*\{[^}]*computeAnomalies[^}]*resolveTradingDayPair[^}]*\}/);
    const pairUnavailable = anchorIndex(src, "Could not evaluate significant moves");
    const nothingMoved = anchorIndex(src, "No ${scope.plural} moved significantly");
    expect(pairUnavailable).toBeLessThan(nothingMoved);
  });

  // The quiet-day sentence moved from a hand-rolled <p> into quietState()
  // (rendered through <EmptySection>); its date is `dated`, which is
  // pair.latest plus an older-session label when the pair is stale. The
  // wording per coverage state is tested in significant-moves-card-states.test.ts.
  it("does not describe the no-movers state as today-only", () => {
    const start = anchorIndex(src, "No ${scope.plural} moved significantly");
    const nothingMoved = src.slice(start, anchorIndex(src, "`,", start));
    expect(nothingMoved).not.toContain("today");
    expect(nothingMoved).toMatch(/on \$\{dated\}/);
    expect(src).toMatch(/const dated = olderSession \? `\$\{pair\.latest\} \(\$\{OLDER_SESSION_LABEL\}\)` : pair\.latest;/);
  });

  it("gives truncated company names a title", () => {
    expect(src).toMatch(/title=\{f\.companyName\}/);
  });

  it("renders a privacy-aware coverage line for the evaluated universe", () => {
    expect(src).toMatch(/function CoverageLine/);
    expect(src).toMatch(/Evaluated <Count value=\{evaluated\} \/> of <Count value=\{total\} \/> holdings/);
    expect(src).toMatch(/latestHoldingsPredicate\(\{ includeShorts: false \}\)/);
  });

  it("renders the empty states through EmptySection with the threshold explanation visible, not in a hover title", () => {
    expect(src).toMatch(/<EmptySection title=\{scope\.title\} reason=\{quiet\.reason\} hint=\{quiet\.hint\} \/>/);
    // No hand-rolled copy of EmptySection's markup, no hover-only explanation.
    expect(src).not.toContain("cursor-help");
    expect(src).not.toContain("empty ⓘ");
    expect(src).not.toMatch(/title="A name is flagged/);
  });

  it("masks the flagged count", () => {
    expect(src).toMatch(/<Count value=\{flags\.length\} \/> flagged/);
    expect(src).not.toMatch(/\{flags\.length\} flagged/);
  });

  it("labels an older session next to the pair dates", () => {
    const dates = anchorIndex(src, "{pair.prior} to {pair.latest}");
    expect(src.slice(dates, dates + 120)).toContain("olderSession ? ` · ${OLDER_SESSION_LABEL}`");
  });

  // Owner ruling 2026-10-08: the card follows the scope selector and waits
  // for a completed session.
  it("follows the page's scope: no hard-coded Vanguard account filter or title", () => {
    expect(src).not.toMatch(/LIKE '%vanguard%'/);
    expect(src).not.toMatch(/const TITLE\b/);
    expect(src).toMatch(/h\.account_id IN \(\$\{placeholders\}\)/);
    expect(src).toMatch(/computeAnomalies\(db, \{ accountIds: ids, now \}\)/);
    expect(src).toMatch(/loadCoverage\(db, pair, ids\)/);
  });

  it("reads completed sessions only, with the rule single-sourced in the engine module", () => {
    expect(src).toMatch(/resolveTradingDayPair\(db, \{ completedOnly: true, now \}\)/);
    expect(src).not.toMatch(/function latestCompletedSession/);
    expect(src).not.toMatch(/nowET|todayET/);
  });

  it("the analysis page hands the card its resolved scope", () => {
    const page = readFileSync("app/dashboard/analysis/page.tsx", "utf8");
    expect(page).toMatch(/<SignificantMovesCard accountIds=\{accountIds\} scopeLabel=\{/);
  });

  it("never prints coverage counts that cannot account for the visible flags", () => {
    const gate = anchorIndex(src, "coverageAccountsForFlags(coverage, flags.length) ?");
    expect(src.slice(gate, gate + 320)).toContain("Coverage unavailable.");
  });
});
