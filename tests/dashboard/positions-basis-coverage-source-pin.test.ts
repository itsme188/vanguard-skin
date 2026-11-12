// tests/dashboard/positions-basis-coverage-source-pin.test.ts
//
// Shares added since the statement carry no known cost (owner decision
// 2026-11-01, option A). The hub POSITIONS row says what its basis covers,
// through the privacy components, and the Accounts tables explain a partly
// covered basis in a words-only title (a title cannot go through them).
// Source pins: the repo has no DOM harness for server pages.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "@/tests/helpers/source-anchor";
import { basisCoversPartOnly } from "@/lib/compute/known-basis";
import { PARTIAL_COST_BASIS_TOOLTIP } from "@/app/dashboard/components/AllHoldingsTable";

describe("hub POSITIONS row: 'basis covers N of M'", () => {
  const src = readFileSync("app/dashboard/security/[id]/page.tsx", "utf8");
  const rowStart = anchorIndex(src, "{positions.map((p) => {");
  const rowEnd = anchorIndex(src, "</tr>", rowStart);
  const row = src.slice(rowStart, rowEnd);

  it("renders the note in the account cell only for a partly covered row", () => {
    const at = anchorIndex(row, "{isPartlyCovered(p) && (");
    const note = row.slice(at, anchorIndex(row, "</span>", at));
    expect(note).toContain("basis covers");
    expect(note).toContain("<Shares value={Math.abs(p.basis_covered_quantity!)} />");
    expect(note).toContain("<Shares value={Math.abs(p.quantity)} />");
    expect(note).toContain("<QuantityUnit securityType={security.security_type}");
  });

  it("prints no raw share count in the note", () => {
    const at = anchorIndex(row, "{isPartlyCovered(p) && (");
    const note = row.slice(at, anchorIndex(row, "</span>", at));
    expect(note).not.toMatch(/\{p\.(quantity|basis_covered_quantity)\}/);
  });

  it("marks the total partial when a row is partly covered", () => {
    const at = anchorIndex(src, "const totalIsPartial =");
    const decl = src.slice(at, anchorIndex(src, ";", at));
    expect(decl).toContain("positionsPartlyCovered.length > 0");
  });
});

describe("Accounts tables: words-only title on a partly covered basis", () => {
  for (const file of [
    "app/dashboard/components/AllHoldingsTable.tsx",
    "app/dashboard/components/HoldingsTable.tsx",
  ]) {
    it(`${file} wraps the basis in the partial-basis title`, () => {
      const src = readFileSync(file, "utf8");
      const at = anchorIndex(src, "basisCoversPartOnly(");
      const cell = src.slice(at, anchorIndex(src, ") : (", at));
      expect(cell).toContain("title={PARTIAL_COST_BASIS_TOOLTIP}");
      expect(cell).toContain("<Money value=");
    });
  }

  it("the title carries no figure", () => {
    expect(PARTIAL_COST_BASIS_TOOLTIP).not.toMatch(/\d/);
  });
});

describe("basisCoversPartOnly", () => {
  it("is true only for a known basis covering fewer shares than held", () => {
    expect(basisCoversPartOnly({ cost_basis: 1000, quantity: 110, basis_covered_quantity: 100 })).toBe(true);
    expect(basisCoversPartOnly({ cost_basis: -500, quantity: -80, basis_covered_quantity: -50 })).toBe(true);
    expect(basisCoversPartOnly({ cost_basis: 1000, quantity: 100, basis_covered_quantity: 100 })).toBe(false);
    expect(basisCoversPartOnly({ cost_basis: 1000, quantity: 100 })).toBe(false);
    expect(basisCoversPartOnly({ cost_basis: null, quantity: 100, basis_covered_quantity: null })).toBe(false);
  });
});
