import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "../helpers/source-anchor";

const src = readFileSync("app/dashboard/components/SignificantMovesCard.tsx", "utf8");

describe("SignificantMovesCard empty states and labels", () => {
  it("checks the trading-day pair before saying nothing moved", () => {
    expect(src).toMatch(/import\s*\{[^}]*computeAnomalies[^}]*resolveTradingDayPair[^}]*\}/);
    const pairUnavailable = anchorIndex(src, "Could not evaluate significant moves");
    const nothingMoved = anchorIndex(src, "No Vanguard holdings moved significantly");
    expect(pairUnavailable).toBeLessThan(nothingMoved);
  });

  // The quiet-day sentence moved from a hand-rolled <p> into quietState()
  // (rendered through <EmptySection>); its date is `dated`, which is
  // pair.latest plus an older-session label when the pair is stale. The
  // wording per coverage state is tested in significant-moves-card-states.test.ts.
  it("does not describe the no-movers state as today-only", () => {
    const start = anchorIndex(src, "No Vanguard holdings moved significantly");
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
    expect(src).toMatch(/<EmptySection title=\{TITLE\} reason=\{quiet\.reason\} hint=\{quiet\.hint\} \/>/);
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

  it("never prints coverage counts that cannot account for the visible flags", () => {
    const gate = anchorIndex(src, "coverageAccountsForFlags(coverage, flags.length) ?");
    expect(src.slice(gate, gate + 320)).toContain("Coverage unavailable.");
  });
});
