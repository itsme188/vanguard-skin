import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "@/tests/helpers/source-anchor";

/**
 * Source pin for AllHoldingsTable.tsx's "a zero cost basis is unknown"
 * contract. lib/queries/holdings.ts already gates unrealized_gain on
 * NULLIF(costBasisExpr, 0) IS NOT NULL, so a stored 0 basis comes back as
 * cost_basis: null, unrealized_gain: null when no nonzero fallback exists. Before this fix the component
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
    const cellIdx = anchorIndex(text, "Cost Basis");
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

  // The footer totals moved into summarizeHoldingsFooter (2026-10-07, the
  // inline-disclosure ruling). Its arithmetic is tested with real rows in
  // tests/dashboard/all-holdings-footer-disclosure.test.tsx; these pins keep
  // the "unknown, never zero" contract visible in the source.
  it("the footer totals come from summarizeHoldingsFooter, which filters through hasKnownBasis", () => {
    const text = src();
    const summary = text.slice(
      anchorIndex(text, "export function summarizeHoldingsFooter"),
      anchorIndex(text, "export function AllHoldingsTable"),
    );
    expect(summary).toMatch(/withBasis\s*=\s*rows\.filter\(hasKnownBasis\)/);
    expect(summary).toMatch(/noBasis\s*=\s*rows\.filter\(\(h\)\s*=>\s*!hasKnownBasis\(h\)\)/);
    // Guard against a second, disagreeing predicate reappearing.
    expect(text).not.toMatch(/filter\(\(h\) => h\.cost_basis !== null\)/);
  });

  it("a total with no contributing row is null (unknown), never a zero", () => {
    const text = src();
    expect(text).toMatch(/totalCostBasis:\s*withBasis\.length === 0 \? null/);
    expect(text).toMatch(/withGain\s*=\s*rows\.filter\(\(h\)\s*=>\s*h\.unrealized_gain\s*!==\s*null\)/);
    expect(text).toMatch(/totalGain:\s*withGain\.length === 0 \? null/);
  });

  it("the footer cost cell renders the unknown placeholder for a null total", () => {
    const text = src();
    const footer = text.slice(anchorIndex(text, "<tfoot>"));
    expect(footer).toContain("footer.totalCostBasis === null");
    expect(footer).toContain("<GainCell value={footer.totalGain} />");
  });

  /**
   * Landing-review findings on top of the zero-basis fix (2026-09-15):
   * 1. the footer excluded-count tooltip only ever said "cost basis
   *    unknown," but unrealized_gain is ALSO null when the PRICE is missing
   *    (holdings.ts gates unrealized_gain on p.close_price IS NOT NULL, not
   *    only on a known cost basis) — a no-price row was misreported.
   * 2. the per-row Cost Basis em-dash carried no tooltip, unlike
   *    HoldingsTable.tsx's per-account em-dash.
   * 3. the sort key was raw cost_basis/unrealized_gain, so a
   *    stored-zero-basis row and a null-basis row (both rendering "—")
   *    sorted to opposite ends of the column.
   * 4. the footer Gain % divided totalGain/totalCostBasis raw (sign flips on
   *    a net-negative basis, and rows use the abs-denominator
   *    unrealizedGainRatio helper instead) and never got the "~" partial
   *    disclosure the Gain $ cell next to it gets.
   */
  it("splits the rows a column leaves out into no-basis and no-price causes", () => {
    const text = src();
    // A known basis with no gain is the no-price case (holdings.ts nulls
    // unrealized_gain whenever the price is missing).
    expect(text).toMatch(
      /noPrice\s*=\s*withBasis\.filter\(\(h\)\s*=>\s*h\.unrealized_gain\s*===\s*null\)/
    );
    expect(text).toContain("noBasisCount: noBasis.length");
    expect(text).toContain("noPriceCount: noPrice.length");
  });

  it("names each cause inline in the footer, not in a hover title", () => {
    const text = src();
    const footer = text.slice(anchorIndex(text, "<tfoot>"));
    expect(footer).toContain("Positions with no cost basis");
    expect(footer).toContain("Positions with a cost basis but no current price");
    expect(footer).not.toContain("title=");
    expect(text).not.toContain("missingGainTooltip");
  });

  it("the per-row Cost Basis em-dash carries the same tooltip HoldingsTable.tsx uses", () => {
    const text = src();
    expect(text).toMatch(
      /const NO_COST_BASIS_TOOLTIP\s*=\s*"Import a Vanguard cost basis CSV to populate"/
    );
    const bodyCellMatch = text.match(
      /<td[^>]*>\s*\{?\s*hasKnownBasis\(h\)[\s\S]*?<\/td>/
    );
    expect(bodyCellMatch).toBeTruthy();
    expect(bodyCellMatch![0]).toContain("title={NO_COST_BASIS_TOOLTIP}");
  });

  it("the sort key maps a stored 0 to null for cost_basis and unrealized_gain only", () => {
    const text = src();
    expect(text).toMatch(
      /field === "cost_basis" \|\| field === "unrealized_gain"[\s\S]{0,40}v === 0/
    );
    expect(text).toMatch(/compareValues\(sortValue\(a\),\s*sortValue\(b\),\s*sort\.dir\)/);
    // The old raw-field compare must be gone — otherwise the mapped
    // sortValue helper is dead code and the bug persists.
    expect(text).not.toMatch(
      /compareValues\(a\[field as keyof typeof a\],\s*b\[field as keyof typeof b\]/
    );
  });

  it("the footer Gain % uses the abs-denominator ratio helper, not a raw divide", () => {
    const text = src();
    const footer = text.slice(anchorIndex(text, "<tfoot>"));
    expect(footer).not.toMatch(/totalGain\s*\/\s*(footer\.)?totalCostBasis/);
    expect(footer).toMatch(
      /unrealizedGainRatio\(footer\.totalGain,\s*footer\.totalCostBasis\)/
    );
  });
});
