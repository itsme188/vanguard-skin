export const dynamic = "force-dynamic";

import Link from "next/link";
import { db } from "@/lib/db";
import { todayET } from "@/lib/calendar/date-utils";
import {
  getOpenTaxLots,
  getClosedTaxLotSales,
  getTaxLotSummary,
  getTaxLotSummaryByAccount,
  getAvailableSaleYears,
  getTaxLotAccountNames,
  getExpiredOptionLotsAwaitingClose,
  isCurrencyConversionTaxLot,
} from "@/lib/queries/tax-lots";
import { getSecurityById } from "@/lib/queries/securities";
import {
  getTaxConventionState,
  describeTaxLotStaleness,
} from "@/lib/compute/tax-convention";
import {
  TaxLotSummaryCards,
  AccountSummaryCards,
  TaxLotStalenessNotice,
} from "../components/TaxLotSummary";
import { ClosedSalesTable, OpenLotsTable, TaxLotCurrencyConversionTable } from "../components/TaxLotTables";
import { RecomputeButton } from "../components/RecomputeButton";
import { YearSelector, AccountSelector } from "../components/YearSelector";
import { EmptyState } from "../components/EmptyState";
import { TaxReportCard } from "../components/TaxReportCard";
import { resolveSelectedYear } from "./select-year";
import { Count, PrivateText } from "@/lib/privacy/components";

export default async function TaxLotsPage(props: {
  searchParams: Promise<{ year?: string; account?: string; security?: string }>;
}) {
  const searchParams = await props.searchParams;

  let availableYears, accountNames, summary, accountSummaries, allOpenLots, allClosedSales, allExpiredOptionLotsAwaitingClose;
  try {
    availableYears = getAvailableSaleYears(db);
    accountNames = getTaxLotAccountNames(db);
  } catch {
    throw new Error("Failed to load tax lot data. The database may be unavailable.");
  }

  const currentCalendarYear = Number(todayET().slice(0, 4));

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
    allExpiredOptionLotsAwaitingClose = getExpiredOptionLotsAwaitingClose(db);
    allClosedSales = getClosedTaxLotSales(db, selectedYear);
  } catch {
    throw new Error("Failed to load tax lot data. The database may be unavailable.");
  }

  // Filter by account and/or security if selected. Both narrow the same
  // already-loaded rows (no query change needed — TaxLotWithSecurity /
  // TaxLotSaleWithDetails already carry security_id).
  let openLots = allOpenLots;
  let expiredOptionLotsAwaitingClose = allExpiredOptionLotsAwaitingClose;
  let closedSales = allClosedSales;
  if (selectedAccount) {
    openLots = openLots.filter((l) => l.account_name === selectedAccount);
    expiredOptionLotsAwaitingClose = expiredOptionLotsAwaitingClose.filter((l) => l.account_name === selectedAccount);
    closedSales = closedSales.filter((s) => s.account_name === selectedAccount);
  }
  if (filterSecurityId != null) {
    openLots = openLots.filter((l) => l.security_id === filterSecurityId);
    expiredOptionLotsAwaitingClose = expiredOptionLotsAwaitingClose.filter((l) => l.security_id === filterSecurityId);
    closedSales = closedSales.filter((s) => s.security_id === filterSecurityId);
  }
  const currencyConversionOpenLots = openLots.filter(isCurrencyConversionTaxLot);
  const currencyConversionClosedSales = closedSales.filter(isCurrencyConversionTaxLot);
  const capitalOpenLots = openLots.filter((l) => !isCurrencyConversionTaxLot(l));
  const capitalClosedSales = closedSales.filter((s) => !isCurrencyConversionTaxLot(s));
  const expiredOptionSymbols = [...new Set(expiredOptionLotsAwaitingClose.map((l) => l.symbol))];
  const expiredOptionContractCount = expiredOptionSymbols.length;

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

  // Engine-synthesized RECONCILE_CLOSE rows inside the narrowed view, for the
  // tiles' "(incl. M engine-estimated closes, +$Y)" disclosure when the
  // account-wide activeSummary can't be used.
  const engineEstimatedRows = capitalClosedSales.filter((s) => s.is_synthetic_close);

  // Pending-statement lots inside the narrowed view: positions closed per
  // live data, awaiting the broker statement. The flag comes from the shared
  // read model (lib/queries/pending-statement.ts via getOpenTaxLots) — never
  // re-derived here. They leave the Unrealized tile and get their own line.
  const pendingStatementRows = capitalOpenLots.filter((l) => l.pending_statement);
  const heldOpenLots = capitalOpenLots.filter((l) => !l.pending_statement);
  const sumUsd = (rows: typeof closedSales) =>
    rows.reduce((sum, s) => sum + (s.currency === "USD" ? s.realized_gain_loss : 0), 0);

  // Clear-filter link preserves year/account, drops only ?security=. Forward
  // the RESOLVED year, not the raw param — from `?year=all` (or any invalid
  // value) that would otherwise re-carry the same invalid string onto the
  // cleared URL (QA follow-up).
  const clearFilterParams = new URLSearchParams();
  if (searchParams.year) clearFilterParams.set("year", String(selectedYear));
  if (searchParams.account) clearFilterParams.set("account", searchParams.account);
  const clearFilterQuery = clearFilterParams.toString();
  const clearFilterHref = `/dashboard/tax-lots${clearFilterQuery ? `?${clearFilterQuery}` : ""}`;

  const hasData =
    summary.totalOpenLots > 0 ||
    summary.totalClosedSales > 0 ||
    currencyConversionOpenLots.length > 0 ||
    currencyConversionClosedSales.length > 0 ||
    expiredOptionLotsAwaitingClose.length > 0;

  // The tiles below read STORED tax_lots / tax_lot_sales rows, which only
  // move when someone presses Recompute (QA:
  // tax-lots--headline-tiles-stale-until-recompute-no-marker). Compare the
  // engine's own stamp against the tax-input generation counter and SAY when
  // the figures are behind. Read-only: the page never recomputes on load.
  const staleness = describeTaxLotStaleness(getTaxConventionState(db));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium text-ink">Tax Lots</h2>
          <p className="text-sm text-ink-faint mt-0.5">
            FIFO cost basis &mdash; {selectedYear}
            {selectedAccount ? ` · ${selectedAccount}` : " · all accounts"}
            {filterSecurity ? ` · ${filterSecurity.symbol}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          {/* Adjacent to the button it names, so the fix is one click away
              from the sentence that asks for it. */}
          {hasData && staleness.stale && (
            <TaxLotStalenessNotice marker={staleness} className="max-w-md" />
          )}
          <RecomputeButton
            endpoint="/api/compute/tax-lots"
            label="Recompute"
            completionEventName="tax-lots:recomputed"
          />
        </div>
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
                totalOpenLots: capitalOpenLots.length,
                totalClosedSales: activeSummary?.totalClosedSales ?? capitalClosedSales.length,
                totalUnrealizedGain: heldOpenLots.reduce((sum, l) => sum + (l.unrealized_gain ?? 0), 0),
                pendingStatementPositions: new Set(
                  pendingStatementRows.map((l) => `${l.account_id}:${l.security_id}`)
                ).size,
                pendingStatementLots: pendingStatementRows.length,
                pendingStatementBasis: pendingStatementRows.reduce((sum, l) => sum + l.adjusted_cost_basis, 0),
                // USD totals only — non-USD sales are native figures (excluded + disclosed)
                totalRealizedGain: activeSummary?.totalRealizedGain ?? capitalClosedSales.reduce((sum, s) => sum + (s.currency === "USD" ? s.realized_gain_loss : 0), 0),
                longTermGain: activeSummary?.longTermGain ?? capitalClosedSales.filter(s => s.is_long_term && s.currency === "USD").reduce((sum, s) => sum + s.realized_gain_loss, 0),
                shortTermGain: activeSummary?.shortTermGain ?? capitalClosedSales.filter(s => !s.is_long_term && s.currency === "USD").reduce((sum, s) => sum + s.realized_gain_loss, 0),
                excludedNonUsdSales: activeSummary?.excludedNonUsdSales ?? capitalClosedSales.filter(s => s.currency !== "USD").length,
                currencyConversionOpenLots: currencyConversionOpenLots.length,
                expiredOptionLotsAwaitingClose: expiredOptionLotsAwaitingClose.length,
                // "Disclose, never exclude" (QA:
                // tax-lots--headline-tiles-include-reconcile-close-engine-rows):
                // the filtered tiles keep their engine-estimated closes AND
                // say how many/how much, same as the unfiltered ones. Counts
                // cover every currency (like totalClosedSales); gains are
                // USD-only (like the totals above).
                engineEstimatedSales: activeSummary?.engineEstimatedSales ?? engineEstimatedRows.length,
                engineEstimatedGain: activeSummary?.engineEstimatedGain ?? sumUsd(engineEstimatedRows),
                engineEstimatedLongTermSales: activeSummary?.engineEstimatedLongTermSales ?? engineEstimatedRows.filter(s => s.is_long_term).length,
                engineEstimatedLongTermGain: activeSummary?.engineEstimatedLongTermGain ?? sumUsd(engineEstimatedRows.filter(s => s.is_long_term)),
                engineEstimatedShortTermSales: activeSummary?.engineEstimatedShortTermSales ?? engineEstimatedRows.filter(s => !s.is_long_term).length,
                engineEstimatedShortTermGain: activeSummary?.engineEstimatedShortTermGain ?? sumUsd(engineEstimatedRows.filter(s => !s.is_long_term)),
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
          {expiredOptionContractCount > 0 && (
            <p className="text-sm text-ink-dim">
              <Count value={expiredOptionContractCount} /> expired{" "}
              {expiredOptionContractCount === 1 ? "contract" : "contracts"} awaiting a closing entry:{" "}
              <PrivateText>{expiredOptionSymbols.join(", ")}</PrivateText>
            </p>
          )}
          <TaxReportCard
            year={selectedYear}
            accountName={selectedAccount || undefined}
            refreshEventName="tax-lots:recomputed"
          />
          <section aria-label="Currency conversions (Section 988, ordinary income)">
            <TaxLotCurrencyConversionTable
              lots={currencyConversionOpenLots}
              sales={currencyConversionClosedSales}
              showAccount={!selectedAccount}
            />
          </section>
          <OpenLotsTable lots={capitalOpenLots} showAccount={!selectedAccount} />
          <ClosedSalesTable sales={capitalClosedSales} showAccount={!selectedAccount} />
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
