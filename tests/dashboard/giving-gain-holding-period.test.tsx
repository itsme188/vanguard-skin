/**
 * Owner ruling 14 (2026-11-16): the Giving year header and each gift row
 * show "Gain avoided" split by holding period. The short-term figure and its
 * note appear only when the year has short-term shares; a "holding period
 * unknown" part appears only when there is one. No deduction-value column.
 *
 * Everything is synthetic: ZZ* tickers and round invented numbers.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

vi.mock("@/lib/db", () => ({ db: null }));
vi.mock("@/lib/privacy/context", () => ({
  usePrivacy: () => ({ isPrivate: false, setPrivate: () => {}, toggle: () => {} }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
}));

import { GivingYearSection } from "@/app/dashboard/components/giving/GivingYearSection";
import type { GivingDonation, GivingYear } from "@/lib/queries/giving-view";

function stockRow(id: number, over: Partial<GivingDonation> = {}): GivingDonation {
  return {
    donation: {
      id,
      source_key: `d${id}`,
      import_batch_id: null,
      kind: "stock",
      security_id: 100 + id,
      symbol_raw: `ZZ${id}`,
      quantity: 10,
      fmv_usd: 1000,
      unit_valuation: null,
      created_date: null,
      received_date: "2026-03-02",
      completed_date: null,
      reversed_date: null,
      notes: null,
    },
    accountName: "Test Taxable",
    basis: 600,
    gainAvoided: 400,
    gainAvoidedLongTerm: 400,
    gainAvoidedShortTerm: 0,
    gainAvoidedHoldingUnknown: 0,
    basisImplausible: false,
    basisUnestablished: false,
    flaggedLots: [],
    longTermQuantity: 10,
    shortTermQuantity: 0,
    status: "completed",
    needsLots: false,
    linked: true,
    symbolResolved: true,
    ...over,
  };
}

function year(over: Partial<GivingYear>): GivingYear {
  return {
    year: "2026",
    totalGiven: 1000,
    stockGiven: 1000,
    cashGiven: 0,
    gainAvoided: 400,
    gainAvoidedRowsLeftOut: 0,
    gainAvoidedRowsCounted: 1,
    gainAvoidedRowsUnsupported: 0,
    gainAvoidedLongTerm: 400,
    gainAvoidedShortTerm: 0,
    gainAvoidedHoldingUnknown: 0,
    gainAvoidedRowsWithShortTerm: 0,
    gainAvoidedRowsHoldingUnknown: 0,
    donations: [stockRow(1)],
    ...over,
  };
}

const render = (y: GivingYear) => renderToStaticMarkup(<GivingYearSection year={y} />);
const header = (html: string) => html.slice(html.indexOf("<header"), html.indexOf("</header>"));
const NOTE = "the charitable deduction may be limited to cost basis";

describe("Giving: gain avoided by holding period (ruling 14)", () => {
  it("a long-term-only year shows the long-term figure and no short-term figure or note", () => {
    const html = render(year({}));
    const h = header(html);
    expect(h).toContain("held over 1 year");
    expect(h).toContain("$400");
    expect(h).not.toContain("short-term");
    expect(h).not.toContain("holding period unknown");
    expect(html).not.toContain(NOTE);
    // The row: an LT part, no ST part.
    expect(html).toContain(">LT </span>");
    expect(html).not.toContain(">ST </span>");
  });

  it("a year with short-term shares shows both figures apart, plus the note", () => {
    const html = render(
      year({
        gainAvoided: 500,
        gainAvoidedLongTerm: 300,
        gainAvoidedShortTerm: 200,
        gainAvoidedRowsWithShortTerm: 1,
        donations: [
          stockRow(1, {
            gainAvoided: 500,
            gainAvoidedLongTerm: 300,
            gainAvoidedShortTerm: 200,
            longTermQuantity: 6,
            shortTermQuantity: 4,
          }),
        ],
      })
    );
    const h = header(html);
    expect(h).toContain("$300");
    expect(h).toContain("short-term gain, held 1 year or less");
    expect(h).toContain("$200");
    expect(h).toContain(NOTE);
    expect(html).toContain(">ST </span>");
  });

  it("an unknown holding period is shown and counted, never folded into long-term", () => {
    const html = render(
      year({
        gainAvoided: 700,
        gainAvoidedLongTerm: 300,
        gainAvoidedHoldingUnknown: 400,
        gainAvoidedRowsHoldingUnknown: 1,
        donations: [
          stockRow(1, { gainAvoided: 700, gainAvoidedLongTerm: 300, gainAvoidedHoldingUnknown: 400 }),
        ],
      })
    );
    const h = header(html);
    expect(h).toContain("holding period unknown");
    expect(h).toContain("$400");
    expect(html).toContain("Holding period unknown </span>");
  });

  it("pending and not-shown years keep their words and show no split", () => {
    const pending = header(render(year({ gainAvoided: null, gainAvoidedLongTerm: null })));
    expect(pending).toContain("pending lot assignment");
    expect(pending).not.toContain("held over 1 year");
    const notShown = header(
      render(year({ gainAvoided: 0, gainAvoidedRowsCounted: 0, gainAvoidedRowsLeftOut: 1 }))
    );
    expect(notShown).toContain("not shown");
    expect(notShown).not.toContain("held over 1 year");
  });

  it("every split figure goes through <Money>, and no deduction-value column exists", () => {
    const src = readFileSync("app/dashboard/components/giving/GivingYearSection.tsx", "utf8");
    for (const f of [
      "year.gainAvoidedLongTerm",
      "year.gainAvoidedShortTerm",
      "year.gainAvoidedHoldingUnknown",
      "gd.gainAvoidedLongTerm",
      "gd.gainAvoidedShortTerm",
      "gd.gainAvoidedHoldingUnknown",
    ]) {
      expect(src).toContain(`<Money value={${f}}`);
    }
    expect(src.toLowerCase()).not.toContain("deduction value");
  });
});
