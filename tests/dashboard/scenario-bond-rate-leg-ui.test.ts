import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";

const root = join(__dirname, "../..");
const card = readFileSync(join(root, "app/dashboard/components/ScenarioModeling.tsx"), "utf8");
const custom = readFileSync(join(root, "lib/compute/scenarios.ts"), "utf8");
const recipes = readFileSync(join(root, "lib/compute/scenario-recipes.ts"), "utf8");
const helper = readFileSync(join(root, "lib/compute/bond-duration.ts"), "utf8");

describe("scenario card: bonds the rate move could not price", () => {
  const section = () => sliceBetween(card, "{/* Bonds the rate move could not price", "{/* Fund duration note */}");

  it("lists them with a reason and a count line, the way unmodelled options are listed", () => {
    anchorIndex(card, "result.bondsUnmodelled.count > 0");
    const s = section();
    anchorIndex(s, "Bonds Not Modelled");
    anchorIndex(s, "pos.bondUnmodelledReason");
    anchorIndex(s, "BOND_UNMODELLED_REASON_LABEL[");
    anchorIndex(s, "No figure is estimated for them.");
    for (const reason of ["no-maturity", "matured", "no-coupon", "unusable-coupon", "no-price", "no-yield"]) {
      anchorIndex(card, `"${reason}":`);
    }
  });

  it("keeps the count and the share of bond value inside PrivateText", () => {
    const s = section();
    const open = anchorIndex(s, "<PrivateText>");
    const close = anchorIndex(s, "</PrivateText>", open);
    const masked = s.slice(open, close);
    anchorIndex(masked, "result.bondsUnmodelled.count");
    anchorIndex(masked, "result.bondsUnmodelled.valueShare");
    // Nothing outside the masked span prints either figure.
    const outside = s.slice(0, open) + s.slice(close);
    expect(outside).not.toContain("{result.bondsUnmodelled.count}");
    expect(outside).not.toContain("bondsUnmodelled.valueShare");
  });

  it("uses readable text colours and no caret glyph", () => {
    const s = section();
    expect(s).not.toMatch(/text-ink-(muted|ghost)/);
    expect(s).not.toMatch(/[▾▼▸▶⌄]/);
  });

  // D6 (2026-10-08): a fund refused the 5-year default is listed here too.
  it("shows the section for a left-out fund alone, counts it inside PrivateText and labels both fund reasons", () => {
    anchorIndex(card, "(result.bondsUnmodelled.count > 0 || result.bondsUnmodelled.fundCount > 0) && (");
    const s = section();
    const open = anchorIndex(s, "<PrivateText>");
    const close = anchorIndex(s, "</PrivateText>", open);
    anchorIndex(s.slice(open, close), "{result.bondsUnmodelled.fundCount}");
    expect(s.slice(0, open) + s.slice(close)).not.toContain("{result.bondsUnmodelled.fundCount}");
    anchorIndex(s, "no duration is assumed");
    // The labels key on the helper's own reason values, so neither can go dead.
    for (const reason of ["fund-equity-evidence", "fund-category-unconfirmed"]) {
      anchorIndex(card, `"${reason}":`);
      anchorIndex(helper, `| "${reason}"`);
    }
  });
});

describe("scenario card: fund duration note", () => {
  it("says fund durations default to 5 years when unknown, from the shared constant", () => {
    const note = sliceBetween(card, "{/* Fund duration note */}", "{result.positionImpacts.some((pos) => isOptionSecurityType");
    anchorIndex(note, 'pos.rateDurationSource === "fund-default"');
    anchorIndex(note, "FUND_DEFAULT_DURATION_YEARS");
    anchorIndex(note, "when unknown");
    anchorIndex(card, 'from "@/lib/compute/bond-duration"');
  });
});

describe("scenario card: where a bond's coupon came from", () => {
  const note = () => sliceBetween(card, "{/* Coupon source note */}", "{result.positionImpacts.some((pos) => isOptionSecurityType");

  it("the not-modelled reason names both sources that were tried", () => {
    anchorIndex(card, `"no-coupon": "no coupon from the broker, and none readable in the bond's name"`);
    expect(card).not.toContain("no coupon on file");
    // A coupon that IS stored but unusable is not described as "no coupon".
    anchorIndex(card, `"unusable-coupon": "the stored coupon is not a usable figure"`);
    anchorIndex(helper, 'return unmodelled("unusable-coupon")');
  });

  it("the caption says which coupon source a run used, keyed on the engine's own source values", () => {
    const s = note();
    anchorIndex(s, 'pos.rateDurationSource === "coupon-yield"');
    anchorIndex(s, 'pos.rateDurationSource === "coupon-yield-name"');
    anchorIndex(s, "Coupon from the broker");
    anchorIndex(s, "Coupon read from the bond’s name");
    // Both source values exist on the shared helper, so the caption cannot key on a dead string.
    anchorIndex(helper, '| "coupon-yield"');
    anchorIndex(helper, '| "coupon-yield-name"');
  });

  it("prints no portfolio figure, uses readable text and no caret glyph", () => {
    const s = note();
    expect(s).not.toMatch(/bondsUnmodelled|valueShare|currentValue|formatMoney|formatPct|\.length/);
    expect(s).not.toMatch(/text-ink-(muted|ghost)/);
    expect(s).not.toMatch(/[▾▼▸▶⌄]/);
  });
});

describe("both engines take the bond rate leg from the one shared helper", () => {
  for (const [file, src] of [
    ["lib/compute/scenarios.ts", custom],
    ["lib/compute/scenario-recipes.ts", recipes],
  ] as const) {
    it(`${file} calls estimateBondRateLeg and carries no duration default of its own`, () => {
      anchorIndex(src, "estimateBondRateLeg(");
      anchorIndex(src, "summarizeUnmodelledBonds(");
      expect(src).not.toMatch(/duration_years\s*\?\?\s*\d/);
      expect(src).not.toMatch(/durationYears\s*\?\?\s*\d/);
      expect(src).not.toMatch(/Math\.exp\(-\s*duration/);
    });
  }

  it("the 5-year figure lives once, and only on the fund path", () => {
    expect(helper.match(/FUND_DEFAULT_DURATION_YEARS\s*=\s*5\b/g)?.length).toBe(1);
    expect(helper).not.toMatch(/\?\?\s*5\b/);
  });

  it("the rate preset's methodology no longer describes the linear bond rule", () => {
    expect(recipes).not.toContain("duration × 25bp / 100");
    anchorIndex(recipes, "is left out of the rate move and counted");
  });
});
