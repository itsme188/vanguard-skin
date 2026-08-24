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
