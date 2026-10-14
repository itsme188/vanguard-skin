import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";

const root = join(__dirname, "../..");
const card = readFileSync(join(root, "app/dashboard/components/ScenarioModeling.tsx"), "utf8");

describe("scenario card: rate hedge funds the rate move does not model", () => {
  const section = () =>
    sliceBetween(card, "{/* Rate hedge funds a rate move does not model", "{/* Bonds the rate move could not price");

  it("reads rateHedgesUnmodelled and names the funds", () => {
    anchorIndex(card, "result.rateHedgesUnmodelled.count > 0");
    const s = section();
    anchorIndex(s, "result.rateHedgesUnmodelled.symbols.join");
    anchorIndex(s, "not modelled");
    anchorIndex(s, "a rate hedge’s move is not a linear rate leg, so no figure is shown.");
  });

  it("prints the count through the privacy component", () => {
    const s = section();
    anchorIndex(s, "<Count value={result.rateHedgesUnmodelled.count} />");
    // No bare JSX child prints the count (the Count prop is `value={...}`).
    expect(s).not.toMatch(/(?<!=)\{result\.rateHedgesUnmodelled\.count\}/);
    expect(s).not.toMatch(/text-ink-(muted|ghost)/);
  });
});
