import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Source pin for HoldingsTable.tsx's (per-account table) "a zero cost basis
 * is unknown" contract — the companion fix to
 * tests/dashboard/all-holdings-unknown-basis-source-pin.test.ts, which pins
 * the same convention on the all-accounts table.
 *
 * lib/queries/holdings.ts's getHoldingsByAccount reuses the same
 * scaledCostBasisFallbackSQL as getAllHoldings, so a stored 0 cost basis
 * reaches this table too. Before this fix the Cost Basis cell here checked
 * only `holding.cost_basis != null`, so a stored 0 printed an exact
 * "$0.00" on the per-account table while the same row's all-accounts row
 * (fixed first) printed "—" — two views of the identical holding
 * disagreeing about whether its basis is known.
 *
 * No jsdom/RTL harness exists in this repo (see
 * reference_no_dom_test_harness_source_pin) — render assertions would be
 * vacuous, so this pins the source text instead.
 */
describe("HoldingsTable treats a zero cost basis as unknown, matching AllHoldingsTable", () => {
  const src = () =>
    readFileSync("app/dashboard/components/HoldingsTable.tsx", "utf8");

  it("the Cost Basis cell condition excludes both null and exactly-zero", () => {
    const text = src();
    const cellMatch = text.match(
      /<td[^>]*>\s*\{holding\.cost_basis[\s\S]*?<\/td>/
    );
    expect(cellMatch).toBeTruthy();
    const block = cellMatch![0];
    expect(block).toMatch(
      /holding\.cost_basis\s*!=\s*null\s*&&\s*holding\.cost_basis\s*!==\s*0/
    );
    expect(block).toMatch(/Money value=\{holding\.cost_basis\}/);
  });

  it("keeps the existing unknown-basis tooltip (does not regress the working import hint)", () => {
    const text = src();
    expect(text).toContain(
      'title="Import a Vanguard cost basis CSV to populate"'
    );
  });
});
