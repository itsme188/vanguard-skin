/**
 * The Giving year header reads `gainAvoidedRowsUnsupported` (review round 2,
 * 2026-11-15). Before, a year whose only stock gift was of a non-USD security
 * printed "Gain avoided $0" in green, and a mixed year hid that a gift had
 * been left out of the total.
 *
 * Also: a row whose lots are assigned but whose split units cannot be
 * established (`basisUnestablished`) reads "needs review", not a dash.
 *
 * Everything is synthetic: ZZ* tickers and round invented numbers.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { sliceBetween } from "../helpers/source-anchor";

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
    basis: null,
    gainAvoided: null,
    gainAvoidedLongTermGain: null,
    gainAvoidedLongTermLoss: null,
    gainAvoidedShortTermGain: null,
    gainAvoidedShortTermLoss: null,
    gainAvoidedHoldingUnknown: null,
    gainAvoidedOverAssigned: null,
    hasLongTermShares: false,
    hasShortTermShares: false,
    basisImplausible: false,
    basisUnestablished: false,
    flaggedLots: [],
    longTermQuantity: null,
    shortTermQuantity: null,
    status: "received",
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
    gainAvoided: 0,
    gainAvoidedRowsLeftOut: 0,
    gainAvoidedRowsCounted: 0,
    gainAvoidedRowsUnsupported: 0,
    gainAvoidedLongTermGain: 0,
    gainAvoidedLongTermLoss: 0,
    gainAvoidedShortTermGain: 0,
    gainAvoidedShortTermLoss: 0,
    gainAvoidedHoldingUnknown: 0,
    gainAvoidedOverAssigned: 0,
    gainAvoidedRowsWithShortTerm: 0,
    gainAvoidedRowsHoldingUnknown: 0,
    gainAvoidedRowsOverAssigned: 0,
    donations: [],
    ...over,
  };
}

const header = (y: GivingYear) => {
  const html = renderToStaticMarkup(<GivingYearSection year={y} />);
  return html.slice(html.indexOf("<header"), html.indexOf("</header>"));
};

describe("Giving header: non-USD gifts left out", () => {
  it("a year whose only stock gift is non-USD shows 'not shown', never a green $0", () => {
    const h = header(
      year({ gainAvoided: 0, gainAvoidedRowsUnsupported: 1, donations: [stockRow(1, { status: "unsupported" })] })
    );
    expect(h).toContain("not shown");
    expect(h).not.toContain("$0");
    expect(h).toContain("left out (non-USD):");
    expect(h).toMatch(/left out \(non-USD\):[^<]*<span[^>]*>1<\/span>/);
  });

  it("a mixed year prints the counted total and says one gift was left out", () => {
    const h = header(
      year({
        gainAvoided: 500,
        gainAvoidedLongTermGain: 500,
        gainAvoidedRowsCounted: 1,
        gainAvoidedRowsUnsupported: 1,
        donations: [stockRow(1, { basis: 500, gainAvoided: 500 }), stockRow(2, { status: "unsupported" })],
      })
    );
    expect(h).toContain("$500");
    expect(h).not.toContain("not shown");
    expect(h).toContain("left out (non-USD):");
  });

  it("a year with no non-USD gift draws no such note", () => {
    const h = header(year({ gainAvoided: 500, gainAvoidedRowsCounted: 1 }));
    expect(h).not.toContain("non-USD");
  });

  it("the note goes through <Count>, like the implausible-basis note", () => {
    const src = readFileSync("app/dashboard/components/giving/GivingYearSection.tsx", "utf8");
    const note = sliceBetween(src, "{year.gainAvoidedRowsUnsupported > 0 && (", "</span>\n            )}");
    expect(note).toContain("<Count value={year.gainAvoidedRowsUnsupported}");
  });
});

describe("Giving row: lots whose split units cannot be established", () => {
  it("reads 'needs review' in Basis and Gain avoided, and offers Edit lots", () => {
    const html = renderToStaticMarkup(
      <GivingYearSection
        year={year({
          gainAvoidedRowsLeftOut: 1,
          donations: [
            stockRow(1, {
              basisUnestablished: true,
              basisImplausible: true,
              longTermQuantity: 10,
              shortTermQuantity: 0,
            }),
          ],
        })}
      />
    );
    expect(html.match(/needs review/g)?.length).toBe(2);
    expect(html).toContain("Edit lots");
    expect(html).not.toContain("Assign lots");
  });
});
