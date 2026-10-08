import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";

const root = join(__dirname, "../..");
const card = readFileSync(join(root, "app/dashboard/components/ScenarioModeling.tsx"), "utf8");
const engine = readFileSync(join(root, "lib/compute/scenarios.ts"), "utf8");

describe("scenario card: funds a sector shock could not look through", () => {
  const line = () =>
    sliceBetween(card, "{/* Funds a sector shock could not look through", "{!isExpanded && result.optionsUnmodelled.count > 0");

  it("names them in one plain line under the result, collapsed or expanded", () => {
    const s = line();
    anchorIndex(s, "result.fundsWithoutSectorWeights.length > 0");
    anchorIndex(s, 'result.fundsWithoutSectorWeights.join(", ")');
    anchorIndex(s, "no sector weights on file");
    anchorIndex(s, "applies only the market move to");
    expect(s).not.toContain("isExpanded");
  });

  it("prints no portfolio figure, wraps on a phone, and uses no caret glyph", () => {
    const s = line();
    expect(s).not.toMatch(/currentValue|estimatedChange|valueShare|formatMoney|formatPct/);
    // The only use of the list's length is the has/have and it/them wording.
    expect(s).not.toMatch(/\{result\.fundsWithoutSectorWeights\.length\}/);
    anchorIndex(s, "whitespace-normal break-words");
    expect(s).not.toMatch(/text-ink-(muted|ghost)/);
    expect(s).not.toMatch(/[▾▼▸▶⌄]/);
  });

  it("the engine builds the list after the figures are final", () => {
    const impactsEnd = anchorIndex(engine, "bondUnmodelledReason: bondLeg?.unmodelledReason,");
    const list = anchorIndex(engine, "const missingWeights = new Set<string>();");
    expect(list).toBeGreaterThan(impactsEnd);
    const block = sliceBetween(engine, "const missingWeights = new Set<string>();", "const estimatedChange = positionImpacts.reduce");
    expect(block).not.toMatch(/positionImpacts|market_value|changePercent/);
  });
});
