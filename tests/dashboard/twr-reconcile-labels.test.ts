import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { countNotComparableThrough } from "@/app/dashboard/components/analysis/TrustStripDrawer";
import type { PerAccountReconciliation } from "@/lib/queries/analysis-trust-state";

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
      "the latest month reached by every account's contiguous chain of consistent months"
    );
  });
});

// Codex finding: countNotComparableThrough summed account-month observations,
// not distinct months — one seam month straddling three accounts read as "3
// not-comparable months skipped" even though it was a single calendar month.
// It must dedupe by monthEndDate across accounts, and the count that reaches
// the DOM must go through <Count> (privacy invariant — every user-facing
// count renders through lib/privacy/components.tsx).
describe("countNotComparableThrough counts DISTINCT not-comparable months, not per-account observations", () => {
  const src = readFileSync("app/dashboard/components/analysis/TrustStripDrawer.tsx", "utf8");

  function row(
    accountId: number,
    bandHistory: PerAccountReconciliation["bandHistory"]
  ): PerAccountReconciliation {
    return {
      accountId,
      accountName: `Account ${accountId}`,
      monthEndDate: null,
      statementTwr: null,
      dietzReturn: null,
      divergenceBp: null,
      band: null,
      bandHistory,
      crossCheckedThru: null,
      chainBreak: null,
    };
  }

  it("three accounts sharing one not-comparable month count as 1, not 3", () => {
    const shared = [{ monthEndDate: "2026-05-31", band: "not_comparable" as const, divergenceBp: null }];
    const accounts = [row(1, shared), row(2, shared), row(3, shared)];
    expect(countNotComparableThrough(accounts, "2026-12-31")).toBe(1);
  });

  it("two distinct not-comparable months (even split across accounts) count as 2", () => {
    const accounts = [
      row(1, [{ monthEndDate: "2026-04-30", band: "not_comparable" as const, divergenceBp: null }]),
      row(2, [{ monthEndDate: "2026-05-31", band: "not_comparable" as const, divergenceBp: null }]),
    ];
    expect(countNotComparableThrough(accounts, "2026-12-31")).toBe(2);
  });

  it("stops counting past the `through` frontier and ignores non-not_comparable bands", () => {
    const accounts = [
      row(1, [
        { monthEndDate: "2026-04-30", band: "not_comparable" as const, divergenceBp: null },
        { monthEndDate: "2026-05-31", band: "consistent" as const, divergenceBp: 10 },
        { monthEndDate: "2026-06-30", band: "not_comparable" as const, divergenceBp: null },
      ]),
    ];
    expect(countNotComparableThrough(accounts, "2026-05-31")).toBe(1);
  });

  it("TrustStripDrawer renders the not-comparable-skipped count through <Count>, not a raw string interpolation", () => {
    expect(src).toContain("<Count");
    // The Count import must be pulled from the shared privacy primitives.
    expect(src).toMatch(
      /import\s*\{[^}]*\bCount\b[^}]*\}\s*from\s*["']@\/lib\/privacy\/components["']/
    );
  });
});
