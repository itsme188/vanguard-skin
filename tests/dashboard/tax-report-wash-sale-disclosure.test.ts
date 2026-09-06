import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SHORT_TERM_LABEL,
  LONG_TERM_LABEL,
  shouldShowWashSaleAddBack,
  washSalesCaption,
} from "@/app/dashboard/components/TaxReportCard";
import { TaxLotSummaryCards } from "@/app/dashboard/components/TaxLotSummary";
import { PrivacyProvider } from "@/lib/privacy/context";
import type { TaxLotSummary } from "@/lib/queries/tax-lots";

// Regression: qa:tax-lots--tax-report-short-term-contradicts-summary-wash-sale-addback-regression-1
//
// /dashboard/tax-lots showed two different "2026 short-term" totals with no
// explanation: the summary strip's economic realized figure (no wash-sale
// add-back) and the Tax Report card's taxable figure (WITH the add-back,
// via shortTermTotal.gainLoss from lib/compute/tax-report.ts sumRows()).
// Neither card named its basis. This pins the disclosure: TaxReportCard
// labels the taxable figure and breaks out the add-back amount as its own
// line; the summary strip labels its figure as the economic one; the wash
// sale sub-stat states the adjustment IS applied, not that it merely "may"
// apply.
//
// TaxReportCard itself is "use client" with fetch-in-useEffect (no jsdom /
// @testing-library/react in this repo — see the precedent note in
// tests/dashboard/narrative-block-refresh.test.ts) so its post-fetch markup
// can't be exercised by a single static render pass; the label/derivation
// logic is extracted into pure, directly-testable exports instead.
// TaxLotSummaryCards (the summary strip) has no hooks of its own, so it IS
// genuinely renderable server-side via renderToStaticMarkup.
//
// Follow-up (code review on bbb695f) found two defects in the disclosure
// itself, both fixed here:
//
// Defect 1 — washSalesCaption(true) asserted a ST add-back happened
// whenever ANY wash-sale warning existed, but detectWashSales flags losses
// regardless of term or currency while sumRows() only routes the add-back
// into shortTermTotal/longTermTotal for USD rows on their own term. A
// LT-only or non-USD-only wash sale showed a caption claiming a ST add-back
// that was provably zero. washSalesCaption is now keyed to where the
// add-back actually landed: the two totals' .adjustments fields, not the
// warning count.
//
// Defect 2 — the relabeled tile + broken-out add-back line was applied
// only to the Short-Term side, even though wash-sale rules are term-
// independent (detectWashSales never checks holding period). An LT wash
// sale flowed into longTermTotal.adjustments with no disclosure at all —
// the original contradiction recreated one cell to the right. The
// Long-Term tile now gets the identical treatment via LONG_TERM_LABEL +
// shouldShowWashSaleAddBack(longTermTotal.adjustments).

describe("TaxReportCard term disclosure (pure helpers)", () => {
  it("labels the card's short-term figure as the taxable, add-back-inclusive total", () => {
    expect(SHORT_TERM_LABEL).toBe("Taxable ST (After Wash-Sale Add-Back)");
  });

  it("labels the card's long-term figure the same way, term-symmetric", () => {
    expect(LONG_TERM_LABEL).toBe("Taxable LT (After Wash-Sale Add-Back)");
  });

  it("shows the add-back line only when the wash-sale adjustment is non-zero", () => {
    expect(shouldShowWashSaleAddBack(0)).toBe(false);
    expect(shouldShowWashSaleAddBack(842.5)).toBe(true);
    expect(shouldShowWashSaleAddBack(-1)).toBe(true); // never negative in practice, but the guard is a plain !== 0
  });

  describe("washSalesCaption(shortTermAdjustments, longTermAdjustments, warningCount)", () => {
    it("names Taxable ST when the add-back landed only in short-term", () => {
      const caption = washSalesCaption(842.5, 0, 1);
      expect(caption).toBe("Disallowed losses added back into Taxable ST");
      expect(caption.toLowerCase()).not.toContain("may be disallowed");
    });

    it("names Taxable LT when the add-back landed only in long-term", () => {
      // Regression case: a lot held > 1 year, sold at a loss, repurchased
      // within 30 days. detectWashSales flags it regardless of term; the
      // old caption would have falsely claimed a ST add-back here.
      const caption = washSalesCaption(0, 610, 1);
      expect(caption).toBe("Disallowed losses added back into Taxable LT");
      expect(caption).not.toContain("Taxable ST");
    });

    it("names both terms when both totals carry an add-back", () => {
      const caption = washSalesCaption(300, 610, 2);
      expect(caption).toBe("Disallowed losses added back into Taxable ST and Taxable LT");
    });

    it("discloses a non-USD wash sale as not reflected in the USD totals, never a phantom ST add-back", () => {
      // Regression case: the only wash-sale warning is on a non-USD sale.
      // sumRows() filters non-USD rows out of both totals entirely, so
      // shortTermTotal.adjustments and longTermTotal.adjustments are both
      // 0 even though washSaleWarnings.length > 0.
      const caption = washSalesCaption(0, 0, 1);
      expect(caption).toBe("Disallowed loss not reflected in USD totals (non-USD sale)");
      expect(caption).not.toContain("Taxable ST");
      expect(caption).not.toContain("Taxable LT");
    });

    it("keeps the no-wash-sale caption unchanged", () => {
      expect(washSalesCaption(0, 0, 0)).toBe("None detected");
    });
  });
});

describe("Tax-lots summary strip short-term stat (render test)", () => {
  const summary: TaxLotSummary = {
    totalOpenLots: 3,
    totalClosedSales: 5,
    totalUnrealizedGain: 1000,
    totalRealizedGain: 500,
    longTermGain: 200,
    shortTermGain: 300,
    excludedNonUsdSales: 0,
    // No engine-estimated (RECONCILE_CLOSE) closes here — that disclosure has
    // its own coverage in tests/dashboard/tax-lots-engine-estimated-disclosure.test.tsx.
    engineEstimatedSales: 0,
    engineEstimatedGain: 0,
    engineEstimatedLongTermSales: 0,
    engineEstimatedLongTermGain: 0,
    engineEstimatedShortTermSales: 0,
    engineEstimatedShortTermGain: 0,
  };

  function renderSummary(): string {
    return renderToStaticMarkup(
      createElement(
        PrivacyProvider,
        null,
        createElement(TaxLotSummaryCards, { summary, year: 2026 })
      )
    );
  }

  it("labels the short-term stat as the economic realized figure, calendar year", () => {
    const html = renderSummary();
    expect(html).toContain("economic realized");
    expect(html).toContain("calendar year");
  });

  it("no longer shows the bare 'calendar year' caption with no basis label", () => {
    const html = renderSummary();
    // The old caption was exactly "calendar year" with nothing before it —
    // the new one prefixes "economic realized · ".
    expect(html).not.toMatch(/>calendar year</);
  });

  it("still renders the 2026 Short-Term card label", () => {
    const html = renderSummary();
    expect(html).toContain("2026 Short-Term");
  });
});
