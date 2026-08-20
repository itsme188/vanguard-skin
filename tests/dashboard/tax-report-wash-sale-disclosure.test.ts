import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SHORT_TERM_LABEL,
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

describe("TaxReportCard short-term disclosure (pure helpers)", () => {
  it("labels the card's short-term figure as the taxable, add-back-inclusive total", () => {
    expect(SHORT_TERM_LABEL).toBe("Taxable ST (After Wash-Sale Add-Back)");
  });

  it("shows the add-back line only when the wash-sale adjustment is non-zero", () => {
    expect(shouldShowWashSaleAddBack(0)).toBe(false);
    expect(shouldShowWashSaleAddBack(842.5)).toBe(true);
    expect(shouldShowWashSaleAddBack(-1)).toBe(true); // never negative in practice, but the guard is a plain !== 0
  });

  it("states the wash-sale adjustment IS applied, not that it merely might be", () => {
    const caption = washSalesCaption(true);
    expect(caption).toBe("Disallowed losses added back into Taxable ST");
    expect(caption.toLowerCase()).not.toContain("may be disallowed");
  });

  it("keeps the no-wash-sale caption unchanged", () => {
    expect(washSalesCaption(false)).toBe("None detected");
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
