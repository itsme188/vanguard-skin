/**
 * Security page, Open Tax Lots and Recent Sales sections:
 *  - expired lots awaiting a closing entry are counted as CONTRACTS, with a
 *    noun that does not switch with a masked count;
 *  - the pending-statement chip is reachable on a phone (it sat in the
 *    Unrealized column, off-screen at phone width);
 *  - the Recent Sales link carries the sale year (the Tax Lots page shows one
 *    year at a time, and without a year it opens on the current one).
 *
 * Pure helpers are tested directly; the page is a server component with no
 * DOM harness, so its wiring is source-pinned.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "@/tests/helpers/source-anchor";
import {
  expiredContractQuantity,
  recentSalesTaxLotsLink,
} from "@/app/dashboard/security/[id]/tax-lot-wording";
import { resolveSelectedYear } from "@/app/dashboard/tax-lots/select-year";

const page = readFileSync("app/dashboard/security/[id]/page.tsx", "utf8");

describe("expiredContractQuantity", () => {
  it("adds up the contracts still open across the expired lots", () => {
    // Two lots, five contracts: the line must say five, not two.
    expect(expiredContractQuantity([{ quantity_remaining: 2 }, { quantity_remaining: 3 }])).toBe(5);
  });

  it("a short lot stores a positive quantity and counts the same", () => {
    expect(expiredContractQuantity([{ quantity_remaining: 1 }, { quantity_remaining: 4 }])).toBe(5);
    expect(expiredContractQuantity([{ quantity_remaining: -4 }])).toBe(4);
  });

  it("no lots is zero", () => {
    expect(expiredContractQuantity([])).toBe(0);
  });
});

describe("recentSalesTaxLotsLink", () => {
  it("carries the year of the newest sale shown", () => {
    const link = recentSalesTaxLotsLink(42, [
      { sale_date: "2024-11-05" },
      { sale_date: "2024-03-01" },
      { sale_date: "2023-06-30" },
    ]);
    expect(link.href).toBe("/dashboard/tax-lots?security=42&year=2024");
    expect(link.label).toBe("Open 2024 sales in Tax Lots →");
  });

  it("does not depend on the order the sales arrive in", () => {
    const link = recentSalesTaxLotsLink(7, [{ sale_date: "2022-01-10" }, { sale_date: "2025-02-03" }]);
    expect(link.href).toBe("/dashboard/tax-lots?security=7&year=2025");
  });

  it("lands on a year that has this security's sales, where the bare link does not", () => {
    // Other securities sold in 2026; this one last sold in 2024.
    const availableYears = [2026, 2025, 2024];
    const bare = resolveSelectedYear(undefined, availableYears, 2026);
    expect(bare).toBe(2026);
    const link = recentSalesTaxLotsLink(42, [{ sale_date: "2024-11-05" }]);
    const year = new URL(link.href, "http://test").searchParams.get("year") ?? undefined;
    expect(resolveSelectedYear(year, availableYears, 2026)).toBe(2024);
  });

  it("falls back to the plain link when no sale date can be read", () => {
    expect(recentSalesTaxLotsLink(42, [])).toEqual({
      href: "/dashboard/tax-lots?security=42",
      label: "Open in Tax Lots →",
    });
    expect(recentSalesTaxLotsLink(42, [{ sale_date: "" }]).href).toBe("/dashboard/tax-lots?security=42");
  });
});

describe("security page wiring (source pins)", () => {
  it("the expired line counts contracts through <Shares> + <QuantityUnit>, with no lot/lots switch", () => {
    const start = anchorIndex(page, "{expiredOptionLotsAwaitingClose.length > 0 && (");
    const block = page.slice(start, anchorIndex(page, "{openTaxLots.length === 0 ? (", start));
    expect(page).toContain("const expiredContracts = expiredContractQuantity(expiredOptionLotsAwaitingClose);");
    expect(block).toContain("<Shares value={expiredContracts} />");
    expect(block).toContain("<QuantityUnit");
    expect(block).toContain("awaiting a closing entry");
    expect(block).not.toContain("<Count value={expiredOptionLotsAwaitingClose.length} />");
    expect(block).not.toMatch(/"lot is"|"lots are"/);
  });

  it("the pending-statement chip also sits in the first column at phone width", () => {
    const start = anchorIndex(page, "{openTaxLots.map((lot) => {");
    const row = page.slice(start, anchorIndex(page, "</tbody>", start));
    const firstCell = row.slice(0, anchorIndex(row, "<td className={TD_CLASS}>{lot.account_name}</td>"));
    expect(firstCell).toContain("lot.acquisition_date");
    expect(firstCell).toMatch(
      /\{lot\.pending_statement && \(\s*<span className="block md:hidden[^"]*">\s*<Chip tone="neutral" size="xs" title=\{PENDING_STATEMENT_TITLE\}>\s*\{PENDING_STATEMENT_CHIP_LABEL\}/
    );
    // The Unrealized column keeps its own copy in place of the figure
    // (pinned in tests/dashboard/tax-lots-pending-statement.test.tsx).
    const rest = row.slice(firstCell.length);
    expect(rest).toContain("{lot.pending_statement ? (");
  });

  it("the Recent Sales link is built by the helper, not a bare year-less href", () => {
    const start = anchorIndex(page, "{/* Closed Sales */}");
    const block = page.slice(start, anchorIndex(page, "<ScrollFade>", start));
    expect(block).toContain("recentSalesLink.href");
    expect(block).toContain("recentSalesLink.label");
    expect(block).not.toContain("`/dashboard/tax-lots?security=${securityId}`");
    expect(page).toContain("recentSalesTaxLotsLink(securityId, closedSales)");
  });
});
