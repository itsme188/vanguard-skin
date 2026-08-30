import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("TWR surfaces disclose an independent Dietz cross-check, not a reconciled checkmark (2026-08-23 durable-fixes update)", () => {
  it("PerformanceView shows the Modified Dietz cross-check disclosure and drops all 'reconciled' language", () => {
    const src = readFileSync("app/dashboard/components/PerformanceView.tsx", "utf8");
    expect(src).toContain("Independently cross-checked (Modified Dietz) through");
    expect(src).toContain("bands shown per month in the trust drawer");
    expect(src).not.toMatch(/\breconciled\b/i);
  });

  it("PerformanceView's cross-checked claim is gated on band=consistent — a non-consistent month gets a band-neutral line, never the trust claim", () => {
    const src = readFileSync("app/dashboard/components/PerformanceView.tsx", "utf8");
    // The claim sentence must be conditioned on the month's own band, not
    // rendered unconditionally off monthEndDate.
    expect(src).toContain('reconciliation.band === "consistent"');
    // Both branches' copy must exist in source: the trust claim (consistent
    // months only) and the band-neutral fallback naming the actual band
    // (investigate / insufficient / not_comparable months).
    expect(src).toContain("Latest independent check for");
    // Same four band labels as the drawer chips, reused for the fallback line.
    expect(src).toContain("Consistent — method differences expected");
    expect(src).toContain("Investigate");
    expect(src).toContain("Not comparable");
    expect(src).toContain("Insufficient data");
  });

  it("TrustStripDrawer renders banded chip copy and drops all 'reconciled' language", () => {
    const src = readFileSync("app/dashboard/components/analysis/TrustStripDrawer.tsx", "utf8");
    expect(src).not.toMatch(/\breconciled\b/i);
    expect(src).toContain("Consistent — method differences expected");
    expect(src).toContain("Investigate");
    expect(src).toContain("Not comparable");
    expect(src).toContain("Insufficient data");
  });

  it("TrustStripDrawer titles the performance panel 'Performance Cross-Check' and derives the consistency threshold from DIETZ_CONSISTENT_BP (no hardcoded 125bp/1.25%)", () => {
    const src = readFileSync("app/dashboard/components/analysis/TrustStripDrawer.tsx", "utf8");
    expect(src).toContain('"Performance Cross-Check"');
    expect(src).not.toContain("Performance Reconciliation");
    expect(src).toContain("DIETZ_CONSISTENT_BP");
    expect(src).not.toContain("1.25%");
    expect(src).not.toContain("125bp)");
  });

  it("TrustStrip cell reads 'Cross-checked (Modified Dietz)', not the old 'Stmt TWR thru' or 'reconciled' language", () => {
    const src = readFileSync("app/dashboard/components/analysis/TrustStrip.tsx", "utf8");
    expect(src).toContain("Cross-checked (Modified Dietz)");
    expect(src).not.toContain("Stmt TWR thru");
    expect(src).not.toContain("Perf reconciled");
    expect(src).not.toMatch(/\breconciled\b/i);
  });
});

// Review findings on TrustStripDrawer's per-account and rollup copy — two
// distinct honesty gaps in the Performance Cross-Check drawer, both UI-only
// (no logic change to lib/queries/analysis-trust-state.ts; crossCheckedThru,
// chainBreak, and bandHistory are unchanged there).
describe("TrustStripDrawer copy is honest about what was actually cross-checked", () => {
  const src = readFileSync("app/dashboard/components/analysis/TrustStripDrawer.tsx", "utf8");

  it("distinguishes an account with only ONE statement month (never attempted) from a broken chain", () => {
    // walkAccountChain (lib/queries/analysis-trust-state.ts) returns
    // bandHistory: [], chainBreak: null when an account has fewer than 2
    // statement months — nothing was ever walked, so "no contiguous
    // consistent month yet" (which reads as "we checked and it failed") is
    // false for this case.
    expect(src).toContain("needs a second statement month before a cross-check can start");
    expect(src).toContain("row.bandHistory.length === 0 && row.chainBreak === null");
    // The old message must still exist for the genuinely-broken-chain case.
    expect(src).toContain("no contiguous consistent month yet");
  });

  it("imports PerAccountReconciliation (the type the not-comparable counter walks)", () => {
    expect(src).toMatch(
      /import\s+type\s*\{[^}]*PerAccountReconciliation[^}]*\}\s*from\s*["']@\/lib\/queries\/analysis-trust-state["']/
    );
  });

  it("derives a not-comparable-skipped count from bandHistory up to the rollup frontier", () => {
    expect(src).toContain("function countNotComparableThrough(");
    expect(src).toContain('entry.band === "not_comparable"');
    // Walked up to (and stopping past) `through` — the rollup crossCheckedThru.
    expect(src).toContain("entry.monthEndDate > through");
  });

  it("the rollup headline names skipped not-comparable months instead of silently implying every walked month was verified", () => {
    expect(src).toContain("skippedNotComparable > 0");
    expect(src).toContain("skipped along the way, not cross-checked");
    // The unconditional trust claim must still exist when nothing was skipped.
    expect(src).toContain(
      "the earliest month every account's contiguous chain of consistent months reaches"
    );
  });
});
