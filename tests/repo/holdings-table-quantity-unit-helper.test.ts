/**
 * QA finding accounts-holdings--quantity-unit-hardcoded-plural-1-contracts:
 * app/dashboard/components/HoldingsTable.tsx used to hand-roll its own
 * quantity-unit label ("contracts"/"face value"/"shares") with no
 * singular/plural branch, so a single-contract option row rendered
 * "1 contracts". The fix moved that logic to the shared, singularising
 * lib/format/quantity-unit.ts helper (tests/lib/quantity-unit.test.ts covers
 * its behavior). This is a source-pin test (no DOM harness in this repo —
 * see tests/dashboard/data-health-view-pluralization.test.ts precedent):
 * it asserts the component imports and calls the shared helper, and that
 * the bare "contracts" literal the bug traced back to is gone.
 *
 * app/dashboard/components/TradeReviewView.tsx has its own separate
 * "contracts" strings (~lines 989/1068) — out of scope for this finding,
 * deliberately left untouched, and not asserted against here.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("HoldingsTable — quantity unit label uses the shared singularising helper", () => {
  const src = readFileSync("app/dashboard/components/HoldingsTable.tsx", "utf8");

  it("imports quantityUnitLabel from the shared helper module", () => {
    expect(src).toMatch(
      /import\s*\{\s*quantityUnitLabel\s*\}\s*from\s*["']@\/lib\/format\/quantity-unit["']/
    );
  });

  it("calls the helper with security_type and quantity for the Quantity cell", () => {
    expect(src).toMatch(
      /quantityUnitLabel\(holding\.security_type,\s*holding\.quantity\)/
    );
  });

  it("no longer hardcodes a bare 'contracts' string literal", () => {
    expect(src).not.toMatch(/"contracts"/);
  });

  it("no longer hardcodes a bare 'shares' string literal", () => {
    expect(src).not.toMatch(/"shares"/);
  });
});
