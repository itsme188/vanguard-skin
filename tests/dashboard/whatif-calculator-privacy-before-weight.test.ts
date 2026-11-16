import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "../helpers/source-anchor";

// Analysis tab fix wave 2026-11-15, unit A (A2, A4). Source pins: there is no
// DOM harness (tests/helpers/source-anchor.ts pattern).
const src = readFileSync("app/dashboard/components/analysis/WhatIfCalculator.tsx", "utf8");

function body(anchor: string, length = 1400): string {
  const at = anchorIndex(src, anchor);
  return src.slice(at, at + length);
}

describe("What-if top-3 before weight (A2)", () => {
  it("reads the before weight from beforeWeightBySymbol, not the cut-to-10 before list", () => {
    const rows = body("function buildConcentrationRows(");
    expect(rows).toContain("delta.beforeWeightBySymbol");
    expect(rows).not.toContain("delta.before.topConcentrations");
  });
});

describe("What-if percentage-point deltas and flag weights are masked (A4)", () => {
  it("no signed pp delta renders as plain text", () => {
    const raw = src.match(/diff:\s*signedPp\(/g) ?? [];
    expect(raw).toEqual([]);
    const wrapped = src.match(/diff:\s*<PrivateText>\{signedPp\(/g) ?? [];
    expect(wrapped).toHaveLength(3);
  });

  it("a flag message renders through FlagMessage, which masks its weight with <Pct>", () => {
    expect(src).not.toContain("⚠ {flag.message}");
    expect(src).toContain("<FlagMessage flag={flag} />");
    const fm = body("function FlagMessage(");
    expect(fm).toContain("<Pct value={flag.weightPct * 100} digits={1} />");
    expect(fm).toContain("<PrivateText>{flag.message}</PrivateText>");
  });
});
