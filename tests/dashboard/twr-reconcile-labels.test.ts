import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("TWR surfaces disclose non-independence (2026-08-21 audit)", () => {
  it("PerformanceView drops 'within tolerance' + success styling on the statement branch", () => {
    const src = readFileSync("app/dashboard/components/PerformanceView.tsx", "utf8");
    expect(src).toContain("statement-reported — not independently verified");
    expect(src).not.toMatch(/bp\b[^}]*within tolerance/s);
  });

  it("TrustStripDrawer discloses on the summary line and the bp caption", () => {
    const src = readFileSync("app/dashboard/components/analysis/TrustStripDrawer.tsx", "utf8");
    expect(src).toContain("not independently verified");
    expect(src).toContain("not an independent recomputation");
  });

  it("TrustStrip cell stops saying 'Perf reconciled'", () => {
    const src = readFileSync("app/dashboard/components/analysis/TrustStrip.tsx", "utf8");
    expect(src).not.toContain("Perf reconciled");
    expect(src).toContain("Stmt TWR thru");
  });
});
