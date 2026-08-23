import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("TWR surfaces disclose an independent Dietz cross-check, not a reconciled checkmark (2026-08-23 durable-fixes update)", () => {
  it("PerformanceView shows the Modified Dietz cross-check disclosure and drops all 'reconciled' language", () => {
    const src = readFileSync("app/dashboard/components/PerformanceView.tsx", "utf8");
    expect(src).toContain("Independently cross-checked (Modified Dietz) through");
    expect(src).toContain("bands shown per month in the trust drawer");
    expect(src).not.toMatch(/\breconciled\b/i);
  });

  it("TrustStripDrawer renders banded chip copy and drops all 'reconciled' language", () => {
    const src = readFileSync("app/dashboard/components/analysis/TrustStripDrawer.tsx", "utf8");
    expect(src).not.toMatch(/\breconciled\b/i);
    expect(src).toContain("Consistent — method differences expected");
    expect(src).toContain("Investigate");
    expect(src).toContain("Not comparable");
    expect(src).toContain("Insufficient data");
  });

  it("TrustStrip cell reads 'Cross-checked (Modified Dietz)', not the old 'Stmt TWR thru' or 'reconciled' language", () => {
    const src = readFileSync("app/dashboard/components/analysis/TrustStrip.tsx", "utf8");
    expect(src).toContain("Cross-checked (Modified Dietz)");
    expect(src).not.toContain("Stmt TWR thru");
    expect(src).not.toContain("Perf reconciled");
    expect(src).not.toMatch(/\breconciled\b/i);
  });
});
