import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { anchorIndex } from "@/tests/helpers/source-anchor";

// Phone width (390px): the Income "By account" table was wider than its card
// (Total cut off, headers run together, a negative Fees value wrapped its
// minus sign, the page scrolled sideways). Both tables now sit in the app's
// <ScrollFade> scroller, numeric cells never wrap, and every right-aligned
// column has left padding so headers do not touch.
// "Top payers" CASH row: getIncomeSummary labels income with no security
// (broker credit interest on a cash balance) as COALESCE(symbol, 'CASH') with
// a NULL security name; the card names it "Cash interest".

const src = fs.readFileSync(
  path.resolve(__dirname, "../../app/dashboard/components/IncomeYieldSection.tsx"),
  "utf8",
);

function tableBlock(heading: string): string {
  const start = anchorIndex(src, heading);
  return src.slice(start, anchorIndex(src, "</table>", start) + "</table>".length + 40);
}

describe("IncomeYieldSection at phone width", () => {
  it("imports the shared ScrollFade", () => {
    expect(src).toContain('import { ScrollFade } from "./ScrollFade"');
  });

  for (const heading of ["Top payers", "By account"]) {
    it(`${heading}: the table is wrapped in ScrollFade and does not wrap cells`, () => {
      const block = tableBlock(heading);
      expect(anchorIndex(block, "<ScrollFade>")).toBeLessThan(anchorIndex(block, "<table"));
      expect(block).toContain("</ScrollFade>");
      expect(block).toMatch(/<table className="[^"]*whitespace-nowrap/);
      const rightHeads = block.match(/<th className="text-right[^"]*"/g) ?? [];
      expect(rightHeads.length).toBeGreaterThan(0);
      for (const th of rightHeads) expect(th).toContain("pl-");
    });
  }

  it("the card can shrink inside its parent", () => {
    expect(src).toMatch(/<section className="[^"]*min-w-0[^"]*space-y-4/);
  });

  it("the no-security group is labelled Cash interest, not CASH", () => {
    anchorIndex(src, "function payerLabel(");
    expect(src).toContain('"Cash interest"');
    expect(src).toContain("{payerLabel(p)}");
    expect(src).not.toContain("{p.symbol}</td>");
  });

  it("payer rows are keyed by symbol and name (two groups can share a symbol)", () => {
    expect(src).toContain("key={`${p.symbol}|${p.securityName ?? \"\"}`}");
  });
});
