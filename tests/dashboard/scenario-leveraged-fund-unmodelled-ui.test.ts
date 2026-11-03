import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";
import { droppedLegMessage } from "@/app/dashboard/components/analysis/WhatIfCalculator";

const root = join(__dirname, "../..");
const card = readFileSync(join(root, "app/dashboard/components/ScenarioModeling.tsx"), "utf8");
const whatIf = readFileSync(join(root, "app/dashboard/components/analysis/WhatIfCalculator.tsx"), "utf8");

describe("scenario card: leveraged / inverse funds no scenario models", () => {
  const section = () =>
    sliceBetween(card, "{/* Leveraged / inverse funds no scenario models", "{/* Bonds the rate move could not price");

  it("shows a collapsed one-liner through the privacy component", () => {
    const at = anchorIndex(card, "{!isExpanded && result.leveragedFundsUnmodelled.count > 0 && (");
    const line = card.slice(at, anchorIndex(card, "</div>", at));
    anchorIndex(line, "<Count value={result.leveragedFundsUnmodelled.count} /> leveraged/inverse");
    anchorIndex(line, "not modelled");
  });

  it("names the funds in the expanded section", () => {
    const s = section();
    anchorIndex(s, "Leveraged / Inverse Funds Not Modelled");
    anchorIndex(s, "result.leveragedFundsUnmodelled.symbols.join");
    anchorIndex(s, "a daily-reset leveraged or inverse fund does not move as a linear multiple over a");
    anchorIndex(s, "multi-day shock, so no figure is shown; it is held out of the scenario total.");
  });

  it("prints the count through the privacy component", () => {
    const s = section();
    anchorIndex(s, "<Count value={result.leveragedFundsUnmodelled.count} />");
    expect(s).not.toMatch(/(?<!=)\{result\.leveragedFundsUnmodelled\.count\}/);
    expect(s).not.toMatch(/text-ink-(muted|ghost)/);
  });
});

describe("What-if: a leg on a leveraged / inverse fund is explained", () => {
  it("renders the dropped-leg reason", () => {
    expect(droppedLegMessage({ symbol: "ZZS", reason: "leveraged_or_inverse_fund" })).toContain(
      "leveraged or inverse fund: not modelled",
    );
  });

  it("names the funds left out of the buckets", () => {
    anchorIndex(whatIf, "delta.leveragedFundsNotModelled.join");
  });
});
