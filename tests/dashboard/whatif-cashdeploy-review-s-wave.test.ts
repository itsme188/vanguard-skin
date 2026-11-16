/**
 * Display side of the What-if and Cash-deploy review findings of 2026-11-15
 * (wave S). Synthetic figures.
 *  - A near market-neutral scope prints no ratio: the table keeps the Total
 *    Value row only and says why.
 *  - Options that entered the sector weights at market value (no Greeks)
 *    are counted on both cards, through <Count>.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildSections, ratiosMeaningful } from "@/app/dashboard/components/analysis/WhatIfCalculator";
import type { ExposureDelta, ExposureSnapshot } from "@/lib/compute/exposure-delta";
import { FACTOR_COLUMNS, type FactorColumn } from "@/lib/factors";
import { anchorIndex } from "../helpers/source-anchor";

const whatIf = readFileSync("app/dashboard/components/analysis/WhatIfCalculator.tsx", "utf8");
const cashDeploy = readFileSync("app/dashboard/components/analysis/CashDeployCard.tsx", "utf8");

function snap(over: Partial<ExposureSnapshot> = {}): ExposureSnapshot {
  return {
    totalValue: 100,
    beta: 21,
    factorTilts: Object.fromEntries(
      FACTOR_COLUMNS.map((f): [FactorColumn, Record<string, number>] => [f, { High: 50 }]),
    ) as Record<FactorColumn, Record<string, number>>,
    sectorWeights: { Technology: 100 },
    topConcentrations: [{ symbol: "ZZA", weightPct: 100 }],
    betaEstimatedWeight: 0,
    optionsAtMarketValue: 0,
    nearMarketNeutral: false,
    ...over,
  };
}

function delta(before: Partial<ExposureSnapshot>, after: Partial<ExposureSnapshot>): ExposureDelta {
  return {
    before: snap(before),
    after: snap({ sectorWeights: { Technology: 90 }, ...after }),
    beforeWeightBySymbol: { ZZA: 100 },
    flags: [],
    droppedLegs: [],
    leveragedFundsNotModelled: [],
  };
}

describe("near market-neutral scope", () => {
  it("prints only the Total Value row when either side is near market-neutral", () => {
    for (const d of [delta({ nearMarketNeutral: true }, {}), delta({}, { nearMarketNeutral: true })]) {
      expect(ratiosMeaningful(d)).toBe(false);
      const sections = buildSections(d);
      expect(sections.map((s) => s.title)).toEqual(["Headline"]);
      expect(sections[0].rows.map((r) => r.label)).toEqual(["Total Value (holdings only — excludes account cash)"]);
    }
  });

  it("an ordinary scope keeps every section", () => {
    const d = delta({}, {});
    expect(ratiosMeaningful(d)).toBe(true);
    expect(buildSections(d).map((s) => s.title)).toContain("Top 3 concentrations");
    expect(buildSections(d)[0].rows.map((r) => r.label)).toContain("Portfolio Beta");
  });

  it("the card says why the ratios are not shown", () => {
    const at = anchorIndex(whatIf, "!ratiosMeaningful(delta)");
    expect(whatIf.slice(at, at + 400)).toMatch(/close to market-neutral/);
  });
});

describe("options counted at market value", () => {
  it("the What-if names how many, through <Count>", () => {
    const at = anchorIndex(whatIf, "optionsAtMarketValue");
    expect(whatIf.slice(at, at + 500)).toContain("<Count value={");
  });

  it("Cash deploy names how many, through <Count>", () => {
    const at = anchorIndex(cashDeploy, "result.optionsAtMarketValue");
    expect(cashDeploy.slice(at, at + 400)).toContain("<Count value={result.optionsAtMarketValue}");
  });
});
