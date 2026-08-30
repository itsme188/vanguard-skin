/**
 * Cash-Deploy card — equity-sleeve caption.
 *
 * QA finding `analysis-cash-deploy--fixed-income-gap-vs-equity-benchmark`:
 * with an all-equity benchmark the solver now measures sector gaps on the
 * equity sleeve. The table must SAY so and name the sleeve it dropped —
 * otherwise the weights silently stop summing to the portfolio.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { equitySleeveCaptionLead } from "@/lib/compute/cash-deploy";

describe("equitySleeveCaptionLead", () => {
  it("names the benchmark and what the sleeve excludes", () => {
    expect(equitySleeveCaptionLead("VTI")).toBe(
      "Sector gaps vs VTI are measured on the equity sleeve — VTI holds no fixed income or cash, so those are excluded from current weights, which are shares of the equity sleeve plus the cash being deployed:"
    );
  });

  it("carries whichever benchmark the scope resolved to", () => {
    expect(equitySleeveCaptionLead("QQQ")).toContain("vs QQQ");
    expect(equitySleeveCaptionLead("QQQ")).toContain("QQQ holds no fixed income");
  });
});

describe("CashDeployCard renders the caption", () => {
  const src = readFileSync(
    "app/dashboard/components/analysis/CashDeployCard.tsx",
    "utf8"
  );

  it("imports the copy helper rather than inlining the sentence", () => {
    expect(src).toContain("equitySleeveCaptionLead");
    expect(src).toContain("equitySleeveCaptionLead(result.benchmarkSymbol)");
  });

  it("gates the caption on excludedSleeve being non-null", () => {
    expect(src).toMatch(/result\.excludedSleeve\s*&&/);
  });

  it("renders the excluded-sleeve weights through <Pct> (portfolio-derived)", () => {
    expect(src).toContain("<Pct value={b.weightPct}");
    expect(src).toContain("value={result.excludedSleeve.totalPct}");
    expect(src).toMatch(/import \{[^}]*Pct[^}]*\} from "@\/lib\/privacy\/components"/);
  });

  it("keeps the gap table's current weight portfolio-masked too", () => {
    expect(src).toContain("<Pct value={g.currentWeight * 100}");
    // Benchmark target weight is public market data — plain, by convention.
    expect(src).toContain("{(g.targetWeight * 100).toFixed(1)}%");
  });
});

// Review finding: gap = current − target. currentWeight renders through
// <Pct> (masked in privacy mode) and targetWeight is public benchmark data
// left plain, but the gap itself rendered RAW — since target is public, a
// privacy-mode viewer could recover the exact masked current weight from the
// unmasked gap (current = target + gap). <Pct> has no "pp" style (it always
// appends "%"), so the fix keeps the "pp" unit and masks the whole string
// via <PrivateText> instead — same template-string masking idiom already
// used in TrustStripDrawer (e.g. factorCoverage's percentage line).
describe("CashDeployCard masks the sector gap (privacy leak fix)", () => {
  const src = readFileSync(
    "app/dashboard/components/analysis/CashDeployCard.tsx",
    "utf8"
  );

  it("imports PrivateText from the privacy components module", () => {
    expect(src).toMatch(/import \{[^}]*PrivateText[^}]*\} from "@\/lib\/privacy\/components"/);
  });

  it("wraps the gap string in <PrivateText> rather than rendering it bare", () => {
    expect(src).toContain(
      '<PrivateText>{`${g.gapPp >= 0 ? "+" : ""}${g.gapPp.toFixed(1)}pp`}</PrivateText>'
    );
  });

  it("no longer renders the gap as a bare, unwrapped JSX expression", () => {
    // Old shape: {g.gapPp >= 0 ? "+" : ""}{g.gapPp.toFixed(1)}pp directly in
    // the JSX tree, outside any masking wrapper — a privacy-mode leak.
    expect(src).not.toMatch(/>\s*\{g\.gapPp >= 0 \? "\+" : ""\}\{g\.gapPp\.toFixed\(1\)\}pp/);
  });

  it("does not render dollarGap raw either (it isn't shown in this card, so nothing to mask)", () => {
    expect(src).not.toContain("dollarGap");
  });
});
