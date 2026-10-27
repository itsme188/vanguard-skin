/**
 * A short lot's figure is short-sale proceeds (money received), never called
 * cost basis (owner ruling 2026-10-26, pending lots). Pure helpers are tested
 * directly; the components have no DOM harness, so wiring is source-pinned.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "@/tests/helpers/source-anchor";
import { lotFigureHeader, shortLotFigureNote } from "@/app/dashboard/components/pending-statement-copy";
import { computeUnknownBasisLotNotes } from "@/lib/queries/security-detail";

const page = readFileSync("app/dashboard/security/[id]/page.tsx", "utf8");
const tables = readFileSync("app/dashboard/components/TaxLotTables.tsx", "utf8");

describe("short lot figure words", () => {
  it("header", () => {
    expect(lotFigureHeader(false)).toBe("Cost Basis");
    expect(lotFigureHeader(true)).toBe("Cost Basis / Proceeds");
  });
  it("row label", () => {
    expect(shortLotFigureNote()).toBe("short-sale proceeds");
  });
});

describe("source pins", () => {
  it("hub open-lots header and cell", () => {
    const at = anchorIndex(page, "lotFigureHeader(openTaxLots.some");
    const cell = anchorIndex(page, "shortLotFigureNote()", at);
    expect(cell).toBeGreaterThan(at);
  });
  it("Tax Lots open-lots header and cell", () => {
    const at = anchorIndex(tables, 'field="adjusted_cost_basis"');
    const hdr = anchorIndex(tables, "lotFigureHeader(lots.some", at);
    anchorIndex(tables, "shortLotFigureNote()", hdr);
  });
  it("Closed Lots header keeps the literal", () => {
    const closed = anchorIndex(tables, 'field="cost_basis_allocated"');
    expect(tables.slice(closed, closed + 300)).toMatch(/>\s*Cost Basis\s*</);
  });
  it("hub note reads its words from figureKind", () => {
    const at = anchorIndex(page, "note.figureKind");
    expect(page.slice(at, at + 400)).toContain("short-sale proceeds");
  });
});

describe("computeUnknownBasisLotNotes figureKind", () => {
  const pos = (q: number) =>
    [{ account_id: 1, account_name: "Acct", quantity: q }] as unknown as Parameters<
      typeof computeUnknownBasisLotNotes
    >[0];
  const lot = (is_short: number) => ({
    account_id: 1,
    quantity_remaining: 100,
    is_short,
    adjusted_cost_basis: 10,
  });
  it("short lots", () => {
    expect(computeUnknownBasisLotNotes(pos(-100), [lot(1)])[0].figureKind).toBe("short_sale_proceeds");
  });
  it("long lots", () => {
    expect(computeUnknownBasisLotNotes(pos(100), [lot(0)])[0].figureKind).toBe("cost_basis");
  });
  it("mixed is reachable only when sides mix within the wanted side", () => {
    // Same-side filtering means a note is never mixed today; the kind is
    // derived from the lots anyway so the wording cannot lie.
    expect(computeUnknownBasisLotNotes(pos(-100), [lot(1), lot(0)])[0].figureKind).toBe("short_sale_proceeds");
  });
});
