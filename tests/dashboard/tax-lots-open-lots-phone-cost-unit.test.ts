/**
 * On a phone the Open Lots table hides its Cost/Share column, so the unit
 * label that explains an option's or a bond's per-unit cost ("x 100 per
 * contract", "per 100 face") was never seen there. The Cost Basis cell, which
 * stays visible, now carries the per-unit cost and its unit below `md:`.
 *
 * Source pins: the table is a client component with URL-sort hooks and this
 * repo has no DOM harness.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const src = readFileSync("app/dashboard/components/TaxLotTables.tsx", "utf8");
const start = anchorIndex(src, "export function OpenLotsTable");
const table = src.slice(start, anchorIndex(src, "export function TaxLotCurrencyConversionTable", start));

describe("Open Lots table at phone width", () => {
  it("the Cost/Share column itself is still desktop-only", () => {
    expect(table).toMatch(/className="hidden md:table-cell"\s*>\s*Cost\/Share/);
  });

  it("the Cost Basis cell shows the per-unit cost and its unit below md:", () => {
    const cellStart = anchorIndex(table, "<Money value={lot.adjusted_cost_basis} precise />");
    const cell = table.slice(cellStart, anchorIndex(table, "</td>", cellStart));
    expect(cell).toMatch(/\{costUnit && \(\s*<span className="block md:hidden[^"]*">/);
    expect(cell).toContain("<Money value={lot.acquisition_price} precise />");
    expect(cell).toContain("{costUnit}");
  });

  it("the cell that carries it is not hidden on a phone", () => {
    const cellStart = anchorIndex(table, "<Money value={lot.adjusted_cost_basis} precise />");
    const opening = table.slice(table.lastIndexOf("<td", cellStart), cellStart);
    expect(opening).not.toContain("hidden");
  });

  it("the pending-statement chip stays in the Symbol cell, which a phone shows", () => {
    const chip = anchorIndex(table, '<Chip tone="neutral" size="xs" title={PENDING_STATEMENT_TITLE}>');
    const opening = table.slice(table.lastIndexOf("<td", chip), chip);
    expect(opening).toContain("<SymbolLink");
    expect(opening.slice(0, opening.indexOf(">"))).not.toContain("hidden");
  });
});
