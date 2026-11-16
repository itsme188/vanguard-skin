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
    gainAvoidedLongTermGain: 400,
    gainAvoidedLongTermLoss: 0,
    gainAvoidedShortTermGain: 0,
    gainAvoidedShortTermLoss: 0,
    gainAvoidedHoldingUnknown: 0,
    gainAvoidedOverAssigned: 0,
    hasLongTermShares: true,
    hasShortTermShares: false,
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
    gainAvoidedLongTermGain: 400,
    gainAvoidedLongTermLoss: 0,
    gainAvoidedShortTermGain: 0,
    gainAvoidedShortTermLoss: 0,
    gainAvoidedHoldingUnknown: 0,
    gainAvoidedOverAssigned: 0,
    gainAvoidedRowsWithShortTerm: 0,
    gainAvoidedRowsHoldingUnknown: 0,
    gainAvoidedRowsOverAssigned: 0,
    donations: [stockRow(1)],
    ...over,
  };
}

const render = (y: GivingYear) => renderToStaticMarkup(<GivingYearSection year={y} />);
const header = (html: string) => html.slice(html.indexOf("<header"), html.indexOf("</header>"));
const NOTE =
  "For shares held one year or less, the deduction is generally the lower of cost basis and fair value: a short-term gain adds nothing to the deduction, and a loss on shares given away is not deductible. Confirm with your tax preparer.";
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");

describe("Giving: gain avoided by holding period (ruling 14)", () => {
  it("a long-term-only year shows the long-term figure and no short-term figure or note", () => {
    const html = render(year({}));
    const h = header(html);
    expect(h).toContain("held over 1 year");
    expect(h).toContain("$400");
    expect(h).not.toContain("short-term");
    expect(h).not.toContain("holding period unknown");
    expect(text(html)).not.toContain(NOTE);
    // The row: an LT part, no ST part.
    expect(html).toContain(">LT gain </span>");
    expect(html).not.toContain(">ST gain </span>");
  });

  it("a year with short-term shares shows both figures apart, plus the note", () => {
    const html = render(
      year({
        gainAvoided: 500,
        gainAvoidedLongTermGain: 300,
        gainAvoidedShortTermGain: 200,
        gainAvoidedRowsWithShortTerm: 1,
        donations: [
          stockRow(1, {
            gainAvoided: 500,
            gainAvoidedLongTermGain: 300,
            gainAvoidedShortTermGain: 200,
            longTermQuantity: 6,
            shortTermQuantity: 4,
            hasShortTermShares: true,
          }),
        ],
      })
    );
    const h = header(html);
    expect(h).toContain("$300");
    expect(text(h)).toContain("Short-term, held 1 year or less: gain $200");
    expect(text(h)).not.toContain(", loss");
    expect(text(h)).not.toContain("given at a loss:");
    expect(text(h)).toContain(NOTE);
    expect(html).toContain(">ST gain </span>");
  });

  it("an unknown holding period is shown and counted, never folded into long-term", () => {
    const html = render(
      year({
        gainAvoided: 700,
        gainAvoidedLongTermGain: 300,
        gainAvoidedHoldingUnknown: 400,
        gainAvoidedRowsHoldingUnknown: 1,
        donations: [
          stockRow(1, { gainAvoided: 700, gainAvoidedLongTermGain: 300, gainAvoidedHoldingUnknown: 400 }),
        ],
      })
    );
    const h = header(html);
    expect(h).toContain("holding period unknown");
    expect(h).toContain("$400");
    expect(html).toContain("Holding period unknown </span>");
  });

  it("pending and not-shown years keep their words and show no split", () => {
    const pending = header(render(year({ gainAvoided: null, gainAvoidedLongTermGain: null })));
    expect(pending).toContain("pending lot assignment");
    expect(pending).not.toContain("held over 1 year");
    const notShown = header(
      render(year({ gainAvoided: 0, gainAvoidedRowsCounted: 0, gainAvoidedRowsLeftOut: 1 }))
    );
    expect(notShown).toContain("not shown");
    expect(notShown).not.toContain("held over 1 year");
  });

  it("loss parts print apart and as losses: never a negative number labelled gain", () => {
    const html = render(
      year({
        gainAvoided: 50,
        gainAvoidedLongTermGain: 200,
        gainAvoidedLongTermLoss: -100,
        gainAvoidedShortTermGain: 40,
        gainAvoidedShortTermLoss: -90,
        gainAvoidedRowsWithShortTerm: 1,
        donations: [
          stockRow(1, {
            gainAvoided: 50,
            gainAvoidedLongTermGain: 200,
            gainAvoidedLongTermLoss: -100,
            gainAvoidedShortTermGain: 40,
            gainAvoidedShortTermLoss: -90,
            longTermQuantity: 6,
            shortTermQuantity: 4,
            hasShortTermShares: true,
          }),
        ],
      })
    );
    const h = text(header(html));
    expect(h).toContain("Gain avoided, held over 1 year $200");
    expect(h).toContain("Short-term, held 1 year or less: gain $40, loss $90");
    expect(h).toContain("Long-term lots given at a loss: $100 (a loss on gifted shares is not deductible)");
    expect(h).toContain(NOTE);
    const all = text(html);
    expect(all).toContain("LT gain $200");
    expect(all).toContain("LT loss $100");
    expect(all).toContain("ST gain $40");
    expect(all).toContain("ST loss $90");
    // No minus sign anywhere next to the word gain.
    expect(all).not.toMatch(/gain \$?[−-]/i);
    expect(all).not.toMatch(/[−-]\$/);
  });

  it("an all-short-term row prints no LT line (no 'LT $0.00'); an all-loss ST row prints only its loss", () => {
    const html = render(
      year({
        gainAvoided: -100,
        gainAvoidedLongTermGain: 0,
        gainAvoidedShortTermLoss: -100,
        gainAvoidedRowsWithShortTerm: 1,
        donations: [
          stockRow(1, {
            gainAvoided: -100,
            gainAvoidedLongTermGain: 0,
            gainAvoidedShortTermLoss: -100,
            longTermQuantity: 0,
            shortTermQuantity: 5,
            hasLongTermShares: false,
            hasShortTermShares: true,
          }),
        ],
      })
    );
    const all = text(html);
    // (The quantity column's "LT 0 / ST 5" is a share count, not a gain line.)
    expect(all).not.toContain("LT gain");
    expect(all).not.toContain("LT loss");
    expect(all).not.toContain("$0.00");
    expect(all).toContain("ST loss $100");
    expect(all).not.toContain("ST gain");
  });

  it("the row shows its short-term part by the row flag (the year's threshold), not by a raw quantity", () => {
    const html = render(
      year({
        donations: [stockRow(1, { shortTermQuantity: 1e-12, hasShortTermShares: false })],
      })
    );
    expect(html).not.toContain(">ST gain </span>");
    const src = readFileSync("app/dashboard/components/giving/GivingYearSection.tsx", "utf8");
    expect(src).not.toContain("gd.shortTermQuantity ?? 0) > 0");
    expect(src).toContain("{gd.hasShortTermShares && (");
    expect(src).toContain("{gd.hasLongTermShares && (");
  });

  it("an over-assigned gift prints its excess as a warning, never as a negative unknown part", () => {
    const html = render(
      year({
        gainAvoided: 220,
        gainAvoidedLongTermGain: 420,
        gainAvoidedOverAssigned: 200,
        gainAvoidedRowsOverAssigned: 1,
        donations: [
          stockRow(1, {
            gainAvoided: 220,
            gainAvoidedLongTermGain: 420,
            gainAvoidedOverAssigned: 200,
          }),
        ],
      })
    );
    const h = text(header(html));
    expect(h).toContain("gifts with more shares assigned than given: 1 (lot figures overstate by $200)");
    expect(h).not.toContain("holding period unknown");
    expect(text(html)).toContain("More shares assigned than given; lots overstate by $200");
    expect(text(html)).not.toMatch(/[−-]\$/);
  });

  it("every split figure goes through <Money>, and no deduction-value column exists", () => {
    const src = readFileSync("app/dashboard/components/giving/GivingYearSection.tsx", "utf8");
    for (const f of [
      "year.gainAvoidedLongTermGain",
      "lossSize(year.gainAvoidedLongTermLoss)",
      "year.gainAvoidedShortTermGain",
      "lossSize(year.gainAvoidedShortTermLoss)",
      "year.gainAvoidedHoldingUnknown",
      "year.gainAvoidedOverAssigned",
      "gd.gainAvoidedHoldingUnknown",
      "gd.gainAvoidedOverAssigned",
      "gain",
      "lossSize(loss)",
    ]) {
      expect(src).toContain(`<Money value={${f}}`);
    }
    expect(src).toContain('gain={gd.gainAvoidedLongTermGain} loss={gd.gainAvoidedLongTermLoss}');
    expect(src).toContain('gain={gd.gainAvoidedShortTermGain} loss={gd.gainAvoidedShortTermLoss}');
    expect(src.toLowerCase()).not.toContain("deduction value");
  });
});
