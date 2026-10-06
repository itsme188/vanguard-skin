import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";

const src = readFileSync(join(__dirname, "../../app/dashboard/components/ScenarioModeling.tsx"), "utf8");

describe("scenario card: option repricing surface", () => {
  it("has a volatility slider bound to the shared range and sends it", () => {
    const builder = sliceBetween(src, "{/* Volatility change */}", "{/* Sector overrides */}");
    anchorIndex(builder, "min={VOL_MOVE_MIN}");
    anchorIndex(builder, "max={VOL_MOVE_MAX}");
    anchorIndex(builder, "setCustomVolMove(Number(e.target.value))");
    anchorIndex(src, "volMove: customVolMove || undefined");
    // The compute callback must re-read the slider (stale-closure guard).
    anchorIndex(src, "[customMarketMove, customRateMove, customVolMove, customSectorOverrides, scope]");
  });

  it("names the held-fixed assumptions and the preset volatility rule", () => {
    anchorIndex(src, "Options are repriced at the shocked price of their underlying");
    anchorIndex(src, "option volatility held at today");
  });

  it("lists options it could not model, with a reason, and a count line", () => {
    anchorIndex(src, "result.optionsUnmodelled.count > 0");
    anchorIndex(src, "UNMODELLED_REASON_LABEL[");
    for (const reason of ["no-option-terms", "expired", "no-option-price", "no-underlying-price", "no-volatility"]) {
      anchorIndex(src, `"${reason}":`);
    }
  });

  it("an option row shows its volatility source and no beta", () => {
    anchorIndex(src, "IV_SOURCE_LABEL[");
    expect(src).not.toContain("option elasticity");
    expect(src).not.toContain("legacy beta heuristic");
  });
});
