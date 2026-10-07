import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";

const src = readFileSync(join(__dirname, "../../app/dashboard/components/ScenarioModeling.tsx"), "utf8");

describe("ScenarioModeling QA pins", () => {
  it("uses plain factor labels in user-facing methodology copy", () => {
    anchorIndex(src, "rate sensitivity, AI exposure, tariff exposure");
    expect(src).not.toContain("interest_rate_sensitive, ai_exposure, tariff_exposure");
  });

  it("renders absolute portfolio values unsigned and keeps signs on deltas only", () => {
    anchorIndex(src, "formatMoney(currentValue, { signed: false })");
    anchorIndex(src, "formatMoney(result.estimatedPortfolioValue, { signed: false })");
    anchorIndex(src, "formatMoney(result.estimatedChange)");
  });

  it("adds the ruled non-GICS shockability note through Pct", () => {
    anchorIndex(src, "nonShockableBucket");
    anchorIndex(src, "<Pct value={notShockableShare} digits={0} />");
    anchorIndex(src, "fixed income, Treasury, diversified");
    anchorIndex(src, "is not shockable here");
  });

  it("prevents duplicate sector overrides and shows a visible warning if one reaches compute", () => {
    const builder = sliceBetween(src, "{/* Sector overrides */}", "{/* Compute button */}");
    anchorIndex(builder, "disabled={usedElsewhere}");
    anchorIndex(builder, "const nextSector = SECTORS.find((sector) => !used.has(sector))");
    anchorIndex(src, "Remove duplicate sector overrides before computing");
    anchorIndex(src, "duplicateSectors.size > 0");
  });

  it("gives the custom builder text controls a coarse-pointer hit extension", () => {
    anchorIndex(src, "pointer-coarse:after:-inset-2");
    const toggle = sliceBetween(src, "{/* ── Custom Scenario Builder ── */}", "{showBuilder && (");
    anchorIndex(toggle, "pointer-coarse:after:absolute");
    const sectorControls = sliceBetween(src, "{/* Sector overrides */}", "{customSectorOverrides.map");
    anchorIndex(sectorControls, "pointer-coarse:after:absolute");
  });

  it("marks short rows in the preset and custom impact lists", () => {
    expect(src.match(/pos\.currentValue < 0/g)?.length).toBeGreaterThanOrEqual(2);
    anchorIndex(src, "short");
  });

  it("puts full option labels in title attributes and leaves a gap before the percent columns", () => {
    expect(src.match(/title=\{formatCompactOptionSymbol\(pos\.symbol\)\}/g)?.length).toBeGreaterThanOrEqual(3);
    expect(src.match(/min-w-\[8rem\]/g)?.length).toBeGreaterThanOrEqual(3);
    anchorIndex(src, "shrink-0 ml-2");
  });

  it("shows an option-not-modelled count on collapsed cards through Count", () => {
    anchorIndex(src, "!isExpanded && result.optionsUnmodelled.count > 0");
    anchorIndex(src, "<Count value={result.optionsUnmodelled.count} />");
    anchorIndex(src, "options\"} not modelled");
  });
});
