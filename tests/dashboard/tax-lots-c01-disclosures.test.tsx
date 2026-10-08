/**
 * Unit C01 (Tax Lots page), three owner-approved decisions plus one privacy
 * item. No jsdom in this repo: hook-free components get a real
 * renderToStaticMarkup pass with the privacy context mocked; the client card
 * is covered through its pure helpers and source pins located with
 * `anchorIndex` (a vanished anchor fails loudly).
 *
 * 1. tax-lots--account-filter-ignored-by-tax-report-card-and-exports-regression-1
 *    (option 2): the security filter is NOT applied to the Tax Report card or
 *    its exports, and the card, its banner and the filter chip say so.
 * 2. tax-lots-open-lots--qty-times-cost-share-never-equals-cost-basis-options-100x-treasuries-1-100
 *    (option 2): a per-row unit label on option and bond rows. Label only.
 * 3. mobile-tax-lots-pending-statement--explanation-hover-only-banner-names-no-positions
 *    (option 2): the explanation is visible text and the line offers a
 *    "show pending only" filter.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AccountSummaryCards,
  PendingStatementLine,
  TaxLotSummaryCards,
} from "@/app/dashboard/components/TaxLotSummary";
import { costPerShareUnitLabel } from "@/app/dashboard/components/TaxLotTables";
import { filingBannerHeading } from "@/app/dashboard/components/TaxReportCard";
import {
  PENDING_STATEMENT_EXPLANATION,
  PENDING_STATEMENT_FILTER_OFF_LABEL,
  PENDING_STATEMENT_FILTER_ON_LABEL,
} from "@/app/dashboard/components/pending-statement-copy";
import {
  SECURITY_FILTER_CHIP_CAPTION,
  securityFilterNotAppliedCopy,
} from "@/lib/compute/tax-report";
import type { AccountTaxSummary, TaxLotSummary } from "@/lib/queries/tax-lots";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const privacyState = vi.hoisted(() => ({ isPrivate: false }));
vi.mock("@/lib/privacy/context", () => ({
  usePrivacy: () => ({
    isPrivate: privacyState.isPrivate,
    setPrivate: () => {},
    toggle: () => {},
  }),
  PrivacyProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const MASK = "•••"; // lib/privacy/components.tsx MASK

beforeEach(() => {
  privacyState.isPrivate = false;
});

function summary(over: Partial<TaxLotSummary> = {}): TaxLotSummary {
  return {
    totalOpenLots: 7,
    totalClosedSales: 4,
    totalUnrealizedGain: 100,
    totalRealizedGain: 0,
    longTermGain: 0,
    shortTermGain: 0,
    excludedNonUsdSales: 0,
    engineEstimatedSales: 0,
    engineEstimatedGain: 0,
    engineEstimatedLongTermSales: 0,
    engineEstimatedLongTermGain: 0,
    engineEstimatedShortTermSales: 0,
    engineEstimatedShortTermGain: 0,
    pendingStatementPositions: 0,
    pendingStatementLots: 0,
    pendingStatementBasis: 0,
    ...over,
  };
}

function account(over: Partial<AccountTaxSummary> = {}): AccountTaxSummary {
  return {
    account_id: 1,
    account_name: "Test Brokerage",
    totalClosedSales: 4,
    totalRealizedGain: 0,
    longTermGain: 0,
    shortTermGain: 0,
    excludedNonUsdSales: 0,
    engineEstimatedSales: 0,
    engineEstimatedGain: 0,
    engineEstimatedLongTermSales: 0,
    engineEstimatedLongTermGain: 0,
    engineEstimatedShortTermSales: 0,
    engineEstimatedShortTermGain: 0,
    ...over,
  };
}

describe("security filter is disclosed as not applied to the Tax Report", () => {
  it("the card line names the symbol and the scope the report really covers", () => {
    expect(securityFilterNotAppliedCopy("AAA", "Test Brokerage")).toBe(
      "Security filter AAA is not applied here — this report and its CSV/TXF exports cover every security in Test Brokerage."
    );
    expect(securityFilterNotAppliedCopy("AAA")).toBe(
      "Security filter AAA is not applied here — this report and its CSV/TXF exports cover every security in all accounts."
    );
    expect(securityFilterNotAppliedCopy("AAA", null)).toContain("all accounts");
  });

  it("the not-ready banner names the second dimension beside the account narrowing", () => {
    expect(filingBannerHeading("Test Brokerage", "AAA")).toBe(
      "Export not ready for filing — PARTIAL EXPORT: Test Brokerage only — security filter AAA not applied"
    );
    expect(filingBannerHeading(null, "AAA")).toBe(
      "Export not ready for filing — security filter AAA not applied"
    );
  });

  it("with no security filter the banner is exactly what it was", () => {
    expect(filingBannerHeading("Test Brokerage")).toBe(
      "Export not ready for filing — PARTIAL EXPORT: Test Brokerage only"
    );
    expect(filingBannerHeading(null)).toBe("Export not ready for filing");
    expect(filingBannerHeading("Test Brokerage", null)).toBe(filingBannerHeading("Test Brokerage"));
  });

  it("the card shows the line outside the filing banner, so a filing-ready scope still discloses it", () => {
    const card = readFileSync("app/dashboard/components/TaxReportCard.tsx", "utf8");
    const line = anchorIndex(
      card,
      "{securityFilterNotAppliedCopy(unappliedSecuritySymbol, scopeAccountName)}"
    );
    const banner = anchorIndex(card, "{!report.filingReady && (");
    expect(line).toBeLessThan(banner);
    anchorIndex(card, "filingBannerHeading(scopeAccountName, unappliedSecuritySymbol)");
  });

  it("the security filter never reaches the report request or either download", () => {
    const card = readFileSync("app/dashboard/components/TaxReportCard.tsx", "utf8");
    const fetches = card.match(/fetch\(\s*`[^`]*`/g) ?? [];
    expect(fetches.length).toBe(2);
    for (const f of fetches) expect(f).not.toMatch(/security/i);
  });

  it("the page passes the filtered symbol to the card and captions the chip", () => {
    const page = readFileSync("app/dashboard/tax-lots/page.tsx", "utf8");
    anchorIndex(page, "unappliedSecuritySymbol={filterSecurity?.symbol}");
    const chip = anchorIndex(page, "Filtered: {filterSecurity.symbol}");
    const caption = anchorIndex(page, "{SECURITY_FILTER_CHIP_CAPTION}");
    expect(caption).toBeGreaterThan(chip);
    expect(SECURITY_FILTER_CHIP_CAPTION).toMatch(/Tax Report and its exports are not filtered by security/);
  });
});

describe("open-lot Cost/Share unit label", () => {
  it("an option row names the contract multiplier", () => {
    expect(costPerShareUnitLabel({ security_type: "Option", multiplier: 100 })).toBe("× 100 per contract");
    expect(costPerShareUnitLabel({ security_type: "option", multiplier: 10 })).toBe("× 10 per contract");
  });

  it("an option row with no usable multiplier states the unit without inventing 100", () => {
    expect(costPerShareUnitLabel({ security_type: "Option", multiplier: 1 })).toBe("per underlying share");
    expect(costPerShareUnitLabel({ security_type: "Option" })).toBe("per underlying share");
  });

  it("a bond row is per 100 of face, whatever case the type is stored in", () => {
    expect(costPerShareUnitLabel({ security_type: "Bond", multiplier: 1 })).toBe("per 100 face");
    expect(costPerShareUnitLabel({ security_type: "bond" })).toBe("per 100 face");
  });

  it("stock, ETF, fund and untyped rows carry no label", () => {
    for (const type of ["Stock", "ETF", "Mutual Fund", "", null]) {
      expect(costPerShareUnitLabel({ security_type: type, multiplier: 1 })).toBeNull();
    }
  });

  it("the table prints the label under the figure and leaves the figure alone", () => {
    const src = readFileSync("app/dashboard/components/TaxLotTables.tsx", "utf8");
    const money = anchorIndex(src, "<Money value={lot.acquisition_price} precise />");
    const label = anchorIndex(src, "{costUnit}");
    expect(label).toBeGreaterThan(money);
    expect(label - money).toBeLessThan(400);
  });
});

describe("pending-statement line: visible explanation and filter", () => {
  it("carries the explanation as text, not as a title attribute", () => {
    const html = renderToStaticMarkup(<PendingStatementLine positions={2} basis={1100} />);
    expect(html).toContain("The closing trade is not imported yet.");
    expect(html).toContain("add nothing to Realized");
    expect(html).not.toContain("title=");
    expect(PENDING_STATEMENT_EXPLANATION).toMatch(/Open Lots/);
  });

  it("no filter link unless the page supplies one", () => {
    const html = renderToStaticMarkup(<PendingStatementLine positions={2} basis={1100} />);
    expect(html).not.toContain("<a ");
  });

  it("offers 'Show pending only', and the way back once it is on", () => {
    const off = renderToStaticMarkup(
      <PendingStatementLine
        positions={2}
        basis={1100}
        filter={{ href: "/dashboard/tax-lots?pending=1", active: false }}
      />
    );
    expect(off).toContain('href="/dashboard/tax-lots?pending=1"');
    expect(off).toContain(PENDING_STATEMENT_FILTER_ON_LABEL);
    expect(off).toContain("min-h-11");

    const on = renderToStaticMarkup(
      <PendingStatementLine positions={2} basis={1100} filter={{ href: "/dashboard/tax-lots", active: true }} />
    );
    expect(on).toContain('href="/dashboard/tax-lots"');
    expect(on).toContain(PENDING_STATEMENT_FILTER_OFF_LABEL);
  });

  it("TaxLotSummaryCards hands the filter through", () => {
    const html = renderToStaticMarkup(
      <TaxLotSummaryCards
        summary={summary({ pendingStatementPositions: 3, pendingStatementLots: 4, pendingStatementBasis: 900 })}
        year={2026}
        pendingFilter={{ href: "/dashboard/tax-lots?pending=1", active: false }}
      />
    );
    expect(html).toContain(PENDING_STATEMENT_FILTER_ON_LABEL);
  });
});

describe("privacy: counts on the summary mask, and the noun does not give the count away", () => {
  it("open-lot count: one and many read with the same noun", () => {
    const one = renderToStaticMarkup(<TaxLotSummaryCards summary={summary({ totalOpenLots: 1 })} year={2026} />);
    const many = renderToStaticMarkup(<TaxLotSummaryCards summary={summary({ totalOpenLots: 7 })} year={2026} />);
    expect(one).toContain("Open lots: <span>1</span>");
    expect(many).toContain("Open lots: <span>7</span>");
    privacyState.isPrivate = true;
    const maskedOne = renderToStaticMarkup(<TaxLotSummaryCards summary={summary({ totalOpenLots: 1 })} year={2026} />);
    const maskedMany = renderToStaticMarkup(<TaxLotSummaryCards summary={summary({ totalOpenLots: 7 })} year={2026} />);
    expect(maskedOne).toContain(`Open lots: <span>${MASK}</span>`);
    expect(maskedOne).toBe(maskedMany);
  });

  it("excluded non-USD sales: masked, and identical for one and many", () => {
    const shown = renderToStaticMarkup(
      <TaxLotSummaryCards summary={summary({ excludedNonUsdSales: 3 })} year={2026} />
    );
    expect(shown).toContain("USD totals exclude non-USD sales: <span>3</span>");
    privacyState.isPrivate = true;
    const one = renderToStaticMarkup(<TaxLotSummaryCards summary={summary({ excludedNonUsdSales: 1 })} year={2026} />);
    const many = renderToStaticMarkup(<TaxLotSummaryCards summary={summary({ excludedNonUsdSales: 3 })} year={2026} />);
    expect(one).toContain(`USD totals exclude non-USD sales: <span>${MASK}</span>`);
    expect(one).toBe(many);
  });

  it("per-account card masks its excluded non-USD count", () => {
    const shown = renderToStaticMarkup(
      <AccountSummaryCards accounts={[account({ excludedNonUsdSales: 2 })]} year={2026} />
    );
    expect(shown).toContain("excludes <span>2</span> non-USD");
    privacyState.isPrivate = true;
    const masked = renderToStaticMarkup(
      <AccountSummaryCards accounts={[account({ excludedNonUsdSales: 2 })]} year={2026} />
    );
    expect(masked).toContain(`excludes <span>${MASK}</span> non-USD`);
    expect(masked).not.toContain("excludes 2");
  });

  it("the Tax Report card's excluded non-USD count goes through <Count>", () => {
    const card = readFileSync("app/dashboard/components/TaxReportCard.tsx", "utf8");
    anchorIndex(card, "USD totals exclude non-USD sales: <Count value={report.excludedNonUsdSales} />");
    expect(card).not.toMatch(/[^=]\{report\.excludedNonUsdSales\}/);
  });
});
