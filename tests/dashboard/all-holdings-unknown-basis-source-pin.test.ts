import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Source pin for AllHoldingsTable.tsx's "a zero cost basis is unknown"
 * contract. lib/queries/holdings.ts already gates unrealized_gain on
 * NULLIF(costBasisExpr, 0) IS NOT NULL, so a stored 0 basis comes back as
 * cost_basis: 0, unrealized_gain: null. Before this fix the component
 * disagreed: `cost_basis !== null` counted a 0 as known, so the Cost Basis
 * cell printed an exact "$0.00" beside an unknown Gain cell, the
 * missing-basis tooltip undercounted, and the footer Gain asserted "$0.00"
 * for a row whose own cell said unknown.
 *
 * QA findings pinned here:
 * accounts-holdings--zero-cost-basis-known-in-cost-unknown-in-gain-regression-1
 * accounts-holdings-footer--asserts-zero-gain-unknown-costs-total-mismatch-regression-1
 *
 * No jsdom/RTL harness exists in this repo (see reference_no_dom_test_harness_source_pin)
 * — render assertions would be vacuous, so this pins the source text
 * instead. Pattern precedent: tests/dashboard/equity-curve-tooltip-precision.test.ts.
 */
describe("AllHoldingsTable treats a zero cost basis as unknown everywhere", () => {
  const src = () =>
    readFileSync("app/dashboard/components/AllHoldingsTable.tsx", "utf8");

  it("defines exactly one hasKnownBasis predicate that excludes both null and zero", () => {
    const text = src();
    const matches = text.match(/const hasKnownBasis\s*=/g) ?? [];
    expect(matches.length).toBe(1);
    // Mirrors the query's NULLIF(costBasisExpr, 0) convention — both null
    // and exactly-zero are "unknown."
    expect(text).toMatch(
      /hasKnownBasis\s*=\s*\([^)]*\)[^=]*=>\s*[\s\S]*?cost_basis\s*!==\s*null\s*&&\s*[\s\S]*?cost_basis\s*!==\s*0/
    );
  });

  it("the Cost Basis cell renders the unknown placeholder when hasKnownBasis is false", () => {
    const text = src();
    const cellIdx = text.indexOf("Cost Basis");
    expect(cellIdx).toBeGreaterThan(-1);
    // Find the <td> block that renders h.cost_basis (skip the header cell).
    const bodyCellMatch = text.match(
      /<td[^>]*>\s*\{?\s*hasKnownBasis\(h\)[\s\S]*?<\/td>/
    );
    expect(bodyCellMatch).toBeTruthy();
    const block = bodyCellMatch![0];
    expect(block).toContain("hasKnownBasis(h)");
    expect(block).toMatch(/Money value=\{h\.cost_basis\}/);
    expect(block).toMatch(/&mdash;|\\u2014|—/);
  });

  it("holdingsWithCost filters through hasKnownBasis", () => {
    expect(src()).toMatch(/holdingsWithCost\s*=\s*filtered\.filter\(hasKnownBasis\)/);
  });

  it("missingCostCount is derived from holdingsWithCost (no separate cost_basis !== null check)", () => {
    const text = src();
    expect(text).toMatch(/missingCostCount\s*=\s*filtered\.length\s*-\s*holdingsWithCost\.length/);
    // Guard against a second, disagreeing predicate reappearing nearby.
    expect(text).not.toMatch(/filtered\.filter\(\(h\) => h\.cost_basis !== null\)/);
  });

  it("the footer gain path checks unrealized_gain !== null before asserting a total", () => {
    const text = src();
    expect(text).toMatch(/knownGainRows\s*=\s*filtered\.filter\(\(h\)\s*=>\s*h\.unrealized_gain\s*!==\s*null\)/);
  });

  it("the footer cost cell is unknown when no filtered row has a known basis (never ~$0.00 over nothing)", () => {
    const text = src();
    const footerIdx = text.indexOf("<tfoot>");
    expect(footerIdx).toBeGreaterThan(-1);
    const footer = text.slice(footerIdx);
    expect(footer).toContain("holdingsWithCost.length === 0");
    // The all-unknown branch must come BEFORE the "~" partial-sum branch.
    expect(footer.indexOf("holdingsWithCost.length === 0")).toBeLessThan(footer.indexOf("missingCostCount > 0"));
  });

  it("the footer gain cell distinguishes zero known rows, partial coverage, and full coverage", () => {
    const text = src();
    const footerIdx = text.indexOf("<tfoot>");
    expect(footerIdx).toBeGreaterThan(-1);
    const footer = text.slice(footerIdx);
    expect(footer).toContain("knownGainRows.length === 0");
    expect(footer).toMatch(/knownGainRows\.length\s*<\s*filtered\.length/);
  });
});
