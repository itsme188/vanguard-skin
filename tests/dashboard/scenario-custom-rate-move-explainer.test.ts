/**
 * Owner ruling 2026-11-15 (unit K3b): the custom form says in one line what a
 * rate move does, next to the rate input. Source pin (no DOM harness).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sliceBetween } from "../helpers/source-anchor";

const src = readFileSync(join(__dirname, "../../app/dashboard/components/ScenarioModeling.tsx"), "utf8");

describe("ScenarioModeling custom form: the rate move explains itself", () => {
  it("the rate input block names both legs: bonds by duration, equities by rate sensitivity", () => {
    const block = sliceBetween(src, "{/* Rate move */}", "{/* Volatility change */}");
    expect(block).toContain("Bonds move by their duration");
    expect(block).toContain("by their rate sensitivity");
    expect(block).toContain("Added to the market move.");
  });
});
