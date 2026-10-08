import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

// QA analysis-privacy--sharpe-hhi-inconsistent-masking-regression-3 (Market
// Regression part) and
// analysis-factor-narrative--asserts-market-beta-near-1-beside-beta-tile-0-43
// (client part). No DOM harness: source pins plus the pure caption helper.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import { narrativeBenchmarkNote } from "@/app/dashboard/components/FactorAnalysis";
import { getDefaultBenchmark } from "@/lib/analysis/benchmarks";

const src = readFileSync("app/dashboard/components/FactorAnalysis.tsx", "utf8");
const regression = sliceBetween(src, "Market Regression (vs {benchmark})", "Factor tilts");

describe("Market Regression tiles mask every portfolio regression output", () => {
  it("Beta and Correlation render inside PrivateText, like Alpha, R² and Tracking Error", () => {
    expect(regression).toContain("<PrivateText>{formatBeta(reg.beta)}</PrivateText>");
    expect(regression).toContain("<PrivateText>{reg.correlation.toFixed(2)}</PrivateText>");
    expect(regression).not.toMatch(/value=\{reg\.correlation\.toFixed\(2\)\}/);
  });

  it("the low-R² banner prints R² through Pct, not a bare number", () => {
    const banner = sliceBetween(regression, "Low explanatory power", "</p>");
    expect(banner).toContain("<Pct value={reg.rSquared * 100} digits={1} />");
    expect(banner).not.toContain("toFixed");
  });

  it("the four interpretation sentences mask with their tile; the observation count stays plain", () => {
    for (const hint of [
      "hint={betaInterp.text}",
      "hint={alphaInterp.text}",
      "hint={interpretR2(reg.rSquared).text}",
      "hint={interpretTrackingError(reg.trackingError).text}",
    ]) {
      const at = anchorIndex(regression, hint);
      expect(regression.slice(at + hint.length, at + hint.length + 40), hint).toMatch(/^\s*privateHint\s/);
    }
    const obs = anchorIndex(regression, "hint={`${reg.dataPoints} daily observations`}");
    expect(regression.slice(obs, obs + 120)).not.toContain("privateHint");
    const cell = src.slice(anchorIndex(src, "function MetricCell("));
    expect(cell).toContain("{privateHint ? <PrivateText>{hint}</PrivateText> : hint}");
  });
});

describe("narrativeBenchmarkNote", () => {
  it("is silent when the picker sits on the scope's default benchmark", () => {
    for (const scope of ["all", "vanguard", "ibkr", "roth"]) {
      expect(narrativeBenchmarkNote(scope, getDefaultBenchmark(scope))).toBeNull();
    }
    expect(narrativeBenchmarkNote(undefined, getDefaultBenchmark("all"))).toBeNull();
  });

  it("names both benchmarks when the picker moves off the default", () => {
    const note = narrativeBenchmarkNote("vanguard", "QQQ");
    expect(note).toContain("generated against VTI");
    expect(note).toContain("The tiles below use QQQ");
  });

  it("is rendered directly under the factor narrative", () => {
    const at = anchorIndex(src, 'surfaceKey="factor-analysis" />');
    expect(src.slice(at, at + 200)).toContain("{benchmarkNote && (");
    anchorIndex(src, "const benchmarkNote = narrativeBenchmarkNote(scope, benchmark);");
  });
});
