/**
 * QA finding analysis-trade-reviews--lot-breakdown-renders-1-shares-singular-unit-fix-missed:
 * commit 8001f25b added lib/format/quantity-unit.ts::quantityUnitLabel and made
 * HoldingsTable.tsx singularise the unit at exactly 1 ("1 contract", "1 share"),
 * but app/dashboard/components/TradeReviewView.tsx still hand-rolled its own
 * two inline ternaries (trade summary row + Lot Breakdown row) that picked
 * "contracts"/"shares" and, on one of them, singularised "contract" but not
 * "share" — so a 1-share lot rendered "1 shares". The fix moved both sites to
 * the shared, singularising lib/format/quantity-unit.ts helper
 * (tests/lib/quantity-unit.test.ts covers its behavior). This is a
 * source-pin test (no DOM harness in this repo — see
 * tests/repo/holdings-table-quantity-unit-helper.test.ts precedent): it
 * asserts the component imports and calls the shared helper at both call
 * sites, and that the bare "contracts"/"shares" ternary literals the bug
 * traced back to are gone.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("TradeReviewView — quantity unit label uses the shared singularising helper", () => {
  const src = readFileSync("app/dashboard/components/TradeReviewView.tsx", "utf8");

  it("imports quantityUnitLabel from the shared helper module", () => {
    expect(src).toMatch(
      /import\s*\{\s*quantityUnitLabel\s*\}\s*from\s*["']@\/lib\/format\/quantity-unit["']/
    );
  });

  it("calls the helper with securityType and totalQuantity for the trade summary row", () => {
    expect(src).toMatch(
      /quantityUnitLabel\(trade\.securityType,\s*trade\.totalQuantity\)/
    );
  });

  it("calls the helper with securityType and exitQuantity for the Lot Breakdown row", () => {
    expect(src).toMatch(
      /quantityUnitLabel\(trade\.securityType,\s*lot\.exitQuantity\)/
    );
  });

  // The literal `/"contracts"/` / `/"shares"/` checks these two replaced
  // banned the string file-wide (comments included) but missed a partial
  // reversion written as bare JSX text next to the quantity, e.g.
  // `{" "}shares` or ` contracts` with no ternary at all. Two shapes now:
  // an inline ternary picking the plural, and a bare unit word sitting
  // right after the <Shares> element or a {…Quantity} expression.
  it("no longer picks the plural via an inline ternary (e.g. `? \"contracts\" : \"shares\"`)", () => {
    expect(src).not.toMatch(
      /\?\s*["'](?:contracts?|shares?)["']\s*:\s*["'](?:contracts?|shares?)["']/,
    );
  });

  it("no longer leaves a bare shares/contracts JSX text token next to the quantity", () => {
    expect(src).not.toMatch(
      /(?:<Shares\b[^<]*\/>|\{[^{}]*Quantity[^{}]*\})(?:\s|\{["']\s*["']\})*\b(?:contracts?|shares?)\b/i,
    );
  });
});
