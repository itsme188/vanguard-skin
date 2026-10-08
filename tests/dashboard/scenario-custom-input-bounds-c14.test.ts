/**
 * C14 — the custom scenario form refuses an out-of-range shock.
 *
 * A mistyped rate move or sector override used to be posted as typed and came
 * back as a result card. The form now names the offending input and does not
 * send it. Nothing is clamped or replaced: a scenario input is never defaulted.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";
import {
  CUSTOM_RATE_MOVE_LIMIT_BP,
  CUSTOM_SECTOR_MOVE_LIMIT_PCT,
  customScenarioInputProblems,
} from "@/app/dashboard/components/ScenarioModeling";

const src = readFileSync("app/dashboard/components/ScenarioModeling.tsx", "utf8");

describe("customScenarioInputProblems", () => {
  it("the bounds are the ruled ones: 1000 bp and 50%", () => {
    expect(CUSTOM_RATE_MOVE_LIMIT_BP).toBe(1000);
    expect(CUSTOM_SECTOR_MOVE_LIMIT_PCT).toBe(50);
  });

  it("accepts inputs inside the bounds, edges included", () => {
    expect(customScenarioInputProblems(0, [])).toEqual([]);
    expect(customScenarioInputProblems(1000, [{ sector: "Energy", move: -50 }])).toEqual([]);
    expect(customScenarioInputProblems(-1000, [{ sector: "Energy", move: 50 }])).toEqual([]);
  });

  it("names a rate move outside the bound, either sign", () => {
    expect(customScenarioInputProblems(100000, [])).toEqual([
      "Rate move must be between -1000 and +1000 basis points.",
    ]);
    expect(customScenarioInputProblems(-1001, [])).toHaveLength(1);
  });

  it("names each sector override outside the bound", () => {
    expect(
      customScenarioInputProblems(0, [
        { sector: "Technology", move: 99999 },
        { sector: "Energy", move: -10 },
        { sector: "Utilities", move: -51 },
      ]),
    ).toEqual([
      "Technology override must be between -50% and +50%.",
      "Utilities override must be between -50% and +50%.",
    ]);
  });

  it("a value that is not a number is a problem, never a silent zero", () => {
    expect(customScenarioInputProblems(Number.NaN, [])).toHaveLength(1);
    expect(customScenarioInputProblems(0, [{ sector: "Energy", move: Number.NaN }])).toHaveLength(1);
    expect(customScenarioInputProblems(Number.POSITIVE_INFINITY, [])).toHaveLength(1);
  });

  it("ignores an override row with no sector chosen (it is never sent)", () => {
    expect(customScenarioInputProblems(0, [{ sector: "", move: 99999 }])).toEqual([]);
  });
});

describe("the form uses it", () => {
  it("the handler stops before the request", () => {
    const handler = sliceBetween(src, "const handleComputeCustom = useCallback(", 'apiFetch("/api/compute/scenarios"');
    anchorIndex(handler, "customScenarioInputProblems(customRateMove, customSectorOverrides)");
    anchorIndex(handler, "return;");
  });

  it("the warning is on screen while the input is out of range and the button says why it is off", () => {
    const builder = sliceBetween(src, "{/* Compute button */}", "{customError && (");
    anchorIndex(builder, "customInputProblems.map(");
    anchorIndex(builder, "disabled={customLoading || customInputProblems.length > 0}");
  });

  it("the number inputs carry matching min and max", () => {
    anchorIndex(src, "min={-CUSTOM_RATE_MOVE_LIMIT_BP}");
    anchorIndex(src, "max={CUSTOM_RATE_MOVE_LIMIT_BP}");
    anchorIndex(src, "min={-CUSTOM_SECTOR_MOVE_LIMIT_PCT}");
    anchorIndex(src, "max={CUSTOM_SECTOR_MOVE_LIMIT_PCT}");
  });
});
