import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildHeadlineRows,
  droppedLegMessage,
} from "@/app/dashboard/components/analysis/WhatIfCalculator";
import type { ExposureDelta } from "@/lib/compute/exposure-delta";
import { FACTOR_COLUMNS, type FactorColumn } from "@/lib/factors";
import { anchorIndex } from "../helpers/source-anchor";

const src = readFileSync("app/dashboard/components/analysis/WhatIfCalculator.tsx", "utf8");
const emptyFactors = Object.fromEntries(
  FACTOR_COLUMNS.map((factor) => [factor, {}])
) as Record<FactorColumn, Record<string, number>>;

describe("WhatIfCalculator input and privacy behavior", () => {
  it("uses PrivateNumberInput for editable dollar figures", () => {
    expect(src).toContain("PrivateNumberInput");
    expect(src).not.toMatch(/<input[^>]+type="number"[^>]+dollarAmount/s);
  });

  it("submits from the dollar amount field on Enter", () => {
    const amountInput = src.slice(
      anchorIndex(src, 'placeholder="0"') - 700,
      anchorIndex(src, 'placeholder="0"') + 1000
    );
    expect(amountInput).toContain("onKeyDown");
    expect(amountInput).toContain("Enter");
    expect(amountInput).toContain("run()");
  });

  it("renders Total Value delta through Money instead of a raw formatted dollar string", () => {
    const rows = buildHeadlineRows({
      before: { totalValue: 100, beta: 1, factorTilts: emptyFactors, sectorWeights: {}, topConcentrations: [] },
      after: { totalValue: 125, beta: 1, factorTilts: emptyFactors, sectorWeights: {}, topConcentrations: [] },
      flags: [],
      droppedLegs: [],
    } as ExposureDelta);

    expect(typeof rows[0].diff).not.toBe("string");
  });

  it("computes Portfolio Beta delta from the rounded before/after figures displayed", () => {
    const rows = buildHeadlineRows({
      before: { totalValue: 100, beta: 1.1335, factorTilts: emptyFactors, sectorWeights: {}, topConcentrations: [] },
      after: { totalValue: 100, beta: 1.1359, factorTilts: emptyFactors, sectorWeights: {}, topConcentrations: [] },
      flags: [],
      droppedLegs: [],
    } as ExposureDelta);

    expect(rows[1]).toMatchObject({ before: "1.13", after: "1.14", diff: "+0.01" });
  });

  it("discloses clamped oversized sells with requested/applied dollars", () => {
    expect(droppedLegMessage({
      symbol: "AAA",
      reason: "clamped_sell",
      requestedDollars: 5000,
      appliedDollars: 1200,
    })).toContain("capped at the held position");
  });
});
