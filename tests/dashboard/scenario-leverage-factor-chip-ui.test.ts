import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";
import { leverageFactorLabel } from "@/lib/compute/leveraged-fund";

/**
 * QA finding dashboard-analysis-view-diagnostics-scope-ibkr-build-custom-scenario-
 * result-card-custom-scenario-prints-udow-…: the row's beta chip now carries
 * the leverage factor that produced the move ("β1.0 · 3x").
 */
const root = join(__dirname, "../..");
const card = readFileSync(join(root, "app/dashboard/components/ScenarioModeling.tsx"), "utf8");

describe("leverageFactorLabel", () => {
  it("prints the signed multiple", () => {
    expect(leverageFactorLabel(3)).toBe("3x");
    expect(leverageFactorLabel(-3)).toBe("-3x");
    expect(leverageFactorLabel(2)).toBe("2x");
    expect(leverageFactorLabel(-1)).toBe("-1x");
    expect(leverageFactorLabel(1.5)).toBe("1.5x");
  });
});

describe("scenario card: the beta chip names the leverage factor", () => {
  const losers = () => sliceBetween(card, "Most Impacted", "{/* Biggest winners");
  const winners = () => sliceBetween(card, "Least Impacted / Positive", "{/* Options the scenario could not reprice");

  it("both impact lists print the factor beside the beta, through the shared label", () => {
    for (const s of [losers(), winners()]) {
      const at = anchorIndex(s, '{"β"}{pos.beta.toFixed(1)}');
      const chip = s.slice(at, anchorIndex(s, "</span>", at));
      anchorIndex(chip, "leverageFactorLabel(pos.leverageFactor)");
    }
  });

  it("the chip's title explains the multiple", () => {
    anchorIndex(card, "LEVERAGE_FACTOR_TITLE");
    anchorIndex(card, "times the move of the index it tracks");
  });
});
