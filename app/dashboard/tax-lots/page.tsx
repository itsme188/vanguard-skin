export const dynamic = "force-dynamic";

import Link from "next/link";
import { db } from "@/lib/db";
import {
  getOpenTaxLots,
  getClosedTaxLotSales,
  getTaxLotSummary,
  getTaxLotSummaryByAccount,
  getAvailableSaleYears,
  getTaxLotAccountNames,
} from "@/lib/queries/tax-lots";
import { getSecurityById } from "@/lib/queries/securities";
import { TaxLotSummaryCards, AccountSummaryCards } from "../components/TaxLotSummary";
import { OpenLotsTable, ClosedSalesTable } from "../components/TaxLotTables";
import { RecomputeButton } from "../components/RecomputeButton";
import { YearSelector, AccountSelector } from "../components/YearSelector";
import { EmptyState } from "../components/EmptyState";
import { TaxReportCard } from "../components/TaxReportCard";
import { resolveSelectedYear } from "./select-year";

export default async function TaxLotsPage(props: {
  searchParams: Promise<{ year?: string; account?: string; security?: string }>;
}) {
  const searchParams = await props.searchParams;

  let availableYears, accountNames, summary, accountSummaries, allOpenLots, allClosedSales;
  try {
    availableYears = getAvailableSaleYears(db);
    accountNames = getTaxLotAccountNames(db);
  } catch {
    throw new Error("Failed to load tax lot data. The database may be unavailable.");
  }

  const currentCalendarYear = new Date().getFullYear();

  // ?year= is user-supplied: a non-numeric or out-of-range value (`?year=all`)
  // used to flow NaN into the tiles ("NAN REALIZED") and the report card
  // (`/api/tax-report?year=NaN` -> 400). resolveSelectedYear validates it
  // against the API's own [2000, 2100] window and otherwise falls back exactly
  // like an absent param.
  const selectedYear = resolveSelectedYear(searchParams.year, availableYears, currentCalendarYear);

  const selectedAccount = searchParams.account ?? "";

  // ?security=<id> arrives from the security detail page's "Open Tax Lots"
  // View-all link (mirrors the Notes panel's ?security= pattern on the same
  // page) so the symbol context survives the hop instead of dropping the
  // user into the unfiltered 2000+ row table. Filter by id, never by a
  // hand-rolled symbol match — an unresolvable id (deleted/bad param) is
  // treated as no filter rather than showing a broken empty view.
  const parsedSecurityId = searchParams.security ? parseInt(searchParams.security, 10) : NaN;
  const filterSecurity =
    !isNaN(parsedSecurityId) ? getSecurityById(db, parsedSecurityId) : null;
  const filterSecurityId = filterSecurity?.id ?? null;

  try {
    summary = getTaxLotSummary(db, selectedYear);
    accountSummaries = getTaxLotSummaryByAccount(db, selectedYear);
    allOpenLots = getOpenTaxLots(db);
    allClosedSales = getClosedTaxLotSales(db, selectedYear);
  } catch {
    throw new Error("Failed to load tax lot data. The database may be unavailable.");
  }

  // Filter by account and/or security if selected. Both narrow the same
  // already-loaded rows (no query change needed — TaxLotWithSecurity /
  // TaxLotSaleWithDetails already carry security_id).
  let openLots = allOpenLots;
  let closedSales = allClosedSales;
  if (selectedAccount) {
    openLots = openLots.filter((l) => l.account_name === selectedAccount);
    closedSales = closedSales.filter((s) => s.account_name === selectedAccount);
  }
  if (filterSecurityId != null) {
    openLots = openLots.filter((l) => l.security_id === filterSecurityId);
    closedSales = closedSales.filter((s) => s.security_id === filterSecurityId);
  }

  const isNarrowed = Boolean(selectedAccount) || filterSecurityId != null;

  // accountSummaries is account-wide (security-blind) — only trust it as
  // the tiles' data source when the account is the ONLY active filter. The
  // moment a security filter is also active, the tiles must derive from
  // the already-filtered openLots/closedSales below (QA:
  // tax-lots--account-pill-drops-security-filter-from-realized-tiles-filtered-chip-stays) —
  // otherwise an account pill silently drops the security filter from the
  // REALIZED/LONG-TERM/SHORT-TERM tiles while the "Filtered: <symbol>" chip
  // stays on screen.
  const activeSummary =
    selectedAccount && filterSecurityId == null
      ? accountSummaries.find((a) => a.account_name === selectedAccount)
      : null;

  // Clear-filter link preserves year/account, drops only ?security=.
  const clearFilterParams = new URLSearchParams();
  if (searchParams.year) clearFilterParams.set("year", searchParams.year);
  if (searchParams.account) clearFilterParams.set("account", searchParams.account);
  const clearFilterQuery = clearFilterParams.toString();
  const clearFilterHref = `/dashboard/tax-lots${clearFilterQuery ? `?${clearFilterQuery}` : ""}`;

  const hasData = summary.totalOpenLots > 0 || summary.totalClosedSales > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium text-ink">Tax Lots</h2>
          <p className="text-sm text-ink-faint mt-0.5">
            FIFO cost basis &mdash; {selectedYear}
            {selectedAccount ? ` · ${selectedAccount}` : " · all accounts"}
            {filterSecurity ? ` · ${filterSecurity.symbol}` : ""}
          </p>
        </div>
        <RecomputeButton endpoint="/api/compute/tax-lots" label="Recompute" />
      </div>

      <div className="flex flex-wrap items-center gap-4">
        {availableYears.length > 0 && (
          <YearSelector years={availableYears} currentYear={selectedYear} />
        )}
        {accountNames.length > 1 && (
          <>
            <div className="w-px h-5 bg-edge" />
            <AccountSelector accounts={accountNames} currentAccount={selectedAccount} />
          </>
        )}
        {filterSecurity && (
          <>
            <div className="w-px h-5 bg-edge" />
            <Link
              href={clearFilterHref}
              className="inline-flex items-center gap-1.5 rounded-full bg-gold/20 text-gold-ink px-3 py-1.5 text-sm font-medium hover:brightness-110 transition-colors"
              aria-label={`Clear filter — showing only ${filterSecurity.symbol}`}
              title="Clear filter"
            >
              Filtered: {filterSecurity.symbol}
              <span aria-hidden="true">✕</span>
            </Link>
          </>
        )}
      </div>

      {hasData ? (
        <>
          {isNarrowed ? (
            <TaxLotSummaryCards
              summary={{
                totalOpenLots: openLots.length,
                totalClosedSales: activeSummary?.totalClosedSales ?? closedSales.length,
                totalUnrealizedGain: openLots.reduce((sum, l) => sum + (l.unrealized_gain ?? 0), 0),
                // USD totals only — non-USD sales are native figures (excluded + disclosed)
                totalRealizedGain: activeSummary?.totalRealizedGain ?? closedSales.reduce((sum, s) => sum + (s.currency === "USD" ? s.realized_gain_loss : 0), 0),
                longTermGain: activeSummary?.longTermGain ?? closedSales.filter(s => s.is_long_term && s.currency === "USD").reduce((sum, s) => sum + s.realized_gain_loss, 0),
                shortTermGain: activeSummary?.shortTermGain ?? closedSales.filter(s => !s.is_long_term && s.currency === "USD").reduce((sum, s) => sum + s.realized_gain_loss, 0),
                excludedNonUsdSales: activeSummary?.excludedNonUsdSales ?? closedSales.filter(s => s.currency !== "USD").length,
              }}
              year={selectedYear}
            />
          ) : (
            <>
              <TaxLotSummaryCards summary={summary} year={selectedYear} />
              {accountSummaries.length > 1 && (
                <AccountSummaryCards accounts={accountSummaries} year={selectedYear} />
              )}
            </>
          )}

          {/* The card + its CSV/TXF downloads honor the SAME ?account=
              filter as the tables above (QA:
              tax-lots--account-filter-ignored-by-tax-report-card-and-exports);
              the ?security= narrowing is display-only and never scopes an
              8949 export. */}
          <TaxReportCard year={selectedYear} accountName={selectedAccount || undefined} />
          <OpenLotsTable lots={openLots} showAccount={!selectedAccount} />
          <ClosedSalesTable sales={closedSales} showAccount={!selectedAccount} />
        </>
      ) : (
        <EmptyState
          icon={<span className="text-xl font-mono">FIFO</span>}
          title="No tax lots computed"
          description="Import your transaction data, then click &ldquo;Recompute&rdquo; to generate tax lots using FIFO cost basis matching."
          action={{ label: "Import Files", href: "/dashboard/import" }}
        />
      )}
    </div>
  );
}
