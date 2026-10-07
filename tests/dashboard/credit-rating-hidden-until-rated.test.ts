import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { hasRatedBond } from "@/app/dashboard/components/FixedIncomeCard";
import { visibleDimensionPills } from "@/app/dashboard/components/AnalysisView";
import { anchorIndex } from "../helpers/source-anchor";

// [qa:analysis-credit-rating--single-unrated-bucket-treasuries-unrated-regression-1]
// [qa:analysis-credit-rating--treasuries-render-100pct-unrated-regression-1]
// Owner ruling, option 3: hide the Credit Rating pill and the Fixed Income
// CREDIT QUALITY readout while no security carries a rating. Nothing here
// derives or assigns a rating.

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

describe("hasRatedBond", () => {
  it("is false when every bond's rating is missing", () => {
    expect(hasRatedBond([{ creditRating: null }, { creditRating: null }])).toBe(false);
    expect(hasRatedBond([])).toBe(false);
  });
  it("treats a blank rating as missing", () => {
    expect(hasRatedBond([{ creditRating: "" }, { creditRating: "  " }])).toBe(false);
  });
  it("is true as soon as one bond carries a rating", () => {
    expect(hasRatedBond([{ creditRating: null }, { creditRating: "AA" }])).toBe(true);
  });
});

describe("visibleDimensionPills", () => {
  const pills = ["fund_category", "sector", "credit_rating", "account"] as const;
  it("drops Credit Rating while no rating is available", () => {
    expect(visibleDimensionPills(pills, false)).toEqual(["fund_category", "sector", "account"]);
  });
  it("keeps every pill, in order, once a rating exists", () => {
    expect(visibleDimensionPills(pills, true)).toEqual([...pills]);
  });
});

describe("wiring (source pins)", () => {
  it("FixedIncomeCard gates the Credit Quality block on hasRatedBond", () => {
    const src = read("app/dashboard/components/FixedIncomeCard.tsx");
    const heading = anchorIndex(src, "Credit Quality\n");
    const gate = src.lastIndexOf("{hasRatedBond(data.bonds) &&", heading);
    expect(gate).toBeGreaterThan(-1);
    // No other conditional opens between the gate and the heading.
    expect(src.slice(gate, heading)).not.toContain(")}");
  });

  it("AnalysisView builds the classification pills through visibleDimensionPills", () => {
    const src = read("app/dashboard/components/AnalysisView.tsx");
    expect(src).toContain(
      "visibleDimensionPills(CLASSIFICATION_ORDER, creditRatingAvailable)",
    );
    const map = anchorIndex(src, "{dimensionPills.map((dim) => (");
    expect(src.slice(0, map)).not.toMatch(/dimensionPills = isFactorMode \? FACTOR_ORDER : CLASSIFICATION_ORDER/);
  });

  it("the page decides availability from rated holdings in scope and never renders the hidden dimension", () => {
    const src = read("app/dashboard/analysis/page.tsx");
    expect(src).toContain("creditRatingAvailable={creditRatingAvailable}");
    const start = anchorIndex(src, "const creditRows =");
    const block = src.slice(start, anchorIndex(src, "<AnalysisView", start));
    expect(block).toContain('getAllocationByDimension(db, "credit_rating", accountIds)');
    // "Rated" = any bucket other than the query's no-rating label; no ticker
    // list, no vendor string bucketed here.
    expect(block).toContain("creditRows.some((r) => r.group_name !== UNRATED_BUCKET)");
    expect(block).toMatch(/requested === "credit_rating" && !creditRatingAvailable/);
    // The hidden dimension is never the one rendered.
    expect(block).toContain("modeDimensions.includes(requested) && !hiddenCreditRating");
  });
});
