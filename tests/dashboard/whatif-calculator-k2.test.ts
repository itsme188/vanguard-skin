import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  BETA_ESTIMATED_MATERIAL_SHARE,
  buildHeadlineRows,
  droppedLegMessage,
  roundedPpDelta,
  signedPp,
  weightsLeaveZeroToHundred,
} from "@/app/dashboard/components/analysis/WhatIfCalculator";
import type { ExposureDelta, ExposureSnapshot } from "@/lib/compute/exposure-delta";
import { FACTOR_COLUMNS, type FactorColumn } from "@/lib/factors";
import { anchorIndex } from "../helpers/source-anchor";

// What-if owner rulings 2026-11-15 (unit K2), display side. Synthetic figures.
const src = readFileSync("app/dashboard/components/analysis/WhatIfCalculator.tsx", "utf8");
const emptyFactors = () =>
  Object.fromEntries(FACTOR_COLUMNS.map((f) => [f, {}])) as Record<FactorColumn, Record<string, number>>;

function snap(over: Partial<ExposureSnapshot> = {}): ExposureSnapshot {
  return {
    totalValue: 100,
    beta: 1,
    factorTilts: emptyFactors(),
    sectorWeights: {},
    topConcentrations: [],
    betaEstimatedWeight: 0,
    ...over,
  };
}

function delta(before: Partial<ExposureSnapshot>, after: Partial<ExposureSnapshot>): ExposureDelta {
  return {
    before: snap(before),
    after: snap(after),
    beforeWeightBySymbol: {},
    flags: [],
    droppedLegs: [],
    leveragedFundsNotModelled: [],
  };
}

describe("K2a: the Portfolio Beta row says when it rests on estimates", () => {
  it("carries an 'estimated' note when the estimated share is material", () => {
    const rows = buildHeadlineRows(delta({ betaEstimatedWeight: 0.4 }, { betaEstimatedWeight: 0.4 }));
    expect(rows[1].label).toBe("Portfolio Beta");
    expect(rows[1].note).toBeDefined();
  });

  it("carries no note when the estimated share is small", () => {
    const small = BETA_ESTIMATED_MATERIAL_SHARE / 2;
    const rows = buildHeadlineRows(delta({ betaEstimatedWeight: small }, { betaEstimatedWeight: small }));
    expect(rows[1].note).toBeUndefined();
  });

  it("prints the share through the privacy component and renders the note", () => {
    const head = src.slice(anchorIndex(src, "export function buildHeadlineRows("), anchorIndex(src, "function buildConcentrationRows("));
    expect(head).toContain("estimated");
    expect(head).toContain("delta.after.betaEstimatedWeight");
    expect(head).toContain("<Pct value={estimatedShare * 100} digits={0} />");
    const table = src.slice(anchorIndex(src, "function DeltaTable("));
    expect(table).toContain("r.note");
  });
});

describe("K2d: a known security with no price gets its own wording", () => {
  it("says the price is missing, not that the security is unknown", () => {
    const msg = droppedLegMessage({ symbol: "ZZZ", reason: "no_price" });
    expect(msg).toContain("ZZZ");
    expect(msg).toMatch(/no price/i);
    expect(msg).not.toMatch(/isn't a known security/);
  });
});

describe("K2e: a pp delta agrees with the rounded figures beside it", () => {
  it("36.8% -> 36.9% prints +0.1pp, not 0.0pp", () => {
    const before = 0.36849;
    const after = 0.36851;
    expect(signedPp(after - before)).toBe("0.0pp");
    expect(signedPp(roundedPpDelta(before, after))).toBe("+0.1pp");
  });

  it("every pp row prints the delta of its rounded figures", () => {
    const uses = src.match(/diff:\s*<PrivateText>\{signedPp\(roundedPpDelta\(/g) ?? [];
    expect(uses).toHaveLength(3);
  });

  it("a weight below 0% or above 100% is detected, so the table can state its basis", () => {
    expect(weightsLeaveZeroToHundred(delta({ sectorWeights: { Technology: 0.6, Energy: 0.4 } }, {}))).toBe(false);
    expect(weightsLeaveZeroToHundred(delta({ sectorWeights: { Technology: 1.1, Energy: -0.1 } }, {}))).toBe(true);
    const tilts = emptyFactors();
    tilts[FACTOR_COLUMNS[0]] = { Low: 1.2 };
    expect(weightsLeaveZeroToHundred(delta({}, { factorTilts: tilts }))).toBe(true);
    const table = src.slice(anchorIndex(src, "weightsLeaveZeroToHundred(delta) &&"));
    expect(table.slice(0, 600)).toMatch(/net value/);
  });
});
