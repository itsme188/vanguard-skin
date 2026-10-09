"use client";

import { useMemo, useState } from "react";
import type { AccountHoldingRow, HoldingWithSecurity } from "@/lib/queries/holdings";
import { unrealizedGainRatio } from "@/lib/format";
import { ScrollFade } from "./ScrollFade";
import { SortableHeader } from "./SortableHeader";
import { SymbolLink } from "./SymbolLink";
import {
  GainCell,
  GainPercentCell,
  HoldingsFooterDisclosures,
  PricedOnlyMark,
  StaleAsOfChip,
  holdingDisplayName,
  holdingsSortValue,
  summarizeHoldingsFooter,
  summarizeStaleRows,
} from "./AllHoldingsTable";
import { Count, Money, Shares, QuantityUnit } from "@/lib/privacy/components";
import { compareValues, useSortParam } from "@/lib/hooks/useSortParam";
import { hasKnownBasis } from "@/lib/compute/known-basis";
import type { AccountCashLine } from "@/lib/queries/account-cash-line";

type Field =
  | "symbol"
  | "security_name"
  | "quantity"
  | "cost_basis"
  | "current_value"
  | "unrealized_gain"
  | "gain_pct";

function formatOptionDescription(holding: HoldingWithSecurity): string {
  if (holding.security_type?.toLowerCase() !== "option") return "";
  const underlying = holding.underlying_symbol ?? "";
  const strike = holding.strike_price != null ? `$${holding.strike_price}` : "";
  const type = holding.option_type ?? "";
  const expiry = holding.expiration_date
    ? (() => {
        const [y, m, d] = holding.expiration_date.split("-");
        return `${Number(m)}/${Number(d)}/${y.slice(-2)}`;
      })()
    : "";
  return [underlying, strike, type, expiry].filter(Boolean).join(" ");
}

/**
 * Positions, cash and the account total for one account, all read from the
 * account's latest daily valuation (lib/queries/account-cash-line.ts), so
 * positions plus cash is the account total by construction. Cash is a line
 * here, never a made-up holdings row.
 *
 * The sentences keep the same wording for one position or many, so Hide
 * amounts cannot leak "exactly one" through the grammar.
 */
function AccountValueLines({ cashLine }: { cashLine: AccountCashLine | null }) {
  if (!cashLine) {
    return (
      <p data-account-value="none" className="px-4 py-3 text-xs text-ink-dim">
        No daily valuation exists for this account yet, so there is no market-value total or
        cash balance to show here.
      </p>
    );
  }

  const asOf = <span className="font-mono">as of {cashLine.valuationDate}</span>;
  const sweepSymbols = cashLine.cashEquivalentSymbols;
  const hasUnpriced =
    cashLine.holdingsCount !== null &&
    cashLine.pricedCount !== null &&
    cashLine.pricedCount < cashLine.holdingsCount;
  // Cash and the total are stated only when a snapshot on or before this
  // date owns the cash. Otherwise the stored figure is the valuation
  // engine's placeholder zero or a value back-stepped from a later
  // snapshot, and the query returns null for both.
  const showCash =
    cashLine.cashAnchored && cashLine.cashBalance !== null && cashLine.totalValue !== null;
  // On the snapshot's own day cash is the snapshot total minus PRICED
  // positions, so an unpriced position's value is inside Cash and the total
  // is the snapshot's. On a later day the cash is carried forward, and a
  // position that had a price on the snapshot day but has none now is
  // missing from the total instead; the note must not promise either.
  const onSnapshotDay = cashLine.anchorDate === cashLine.valuationDate;

  return (
    <div data-account-value="lines" className="px-4 py-3 space-y-2 text-sm">
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-ink-dim">
            Positions at market value <span className="text-xs">({asOf})</span>
          </span>
          <span className="font-mono tabular-nums text-ink">
            <Money value={cashLine.holdingsValue} precise />
          </span>
        </div>
        {hasUnpriced && (
          <p data-account-value="unpriced-note" className="mt-0.5 text-xs text-ink-dim">
            Positions with a price that day: <Count value={cashLine.pricedCount} /> of{" "}
            <Count value={cashLine.holdingsCount} />. The rest are not in the Positions figure.
            {showCash &&
              (onSnapshotDay
                ? " Their value sits inside the Cash figure instead, so the split between Positions and Cash is off by it. The Account total is the broker snapshot's total and is not affected."
                : " Their value is either inside the Cash figure or missing from the Account total, so those two figures may be off by it.")}
          </p>
        )}
        {!showCash && sweepSymbols.length > 0 && (
          <p data-account-value="sweep-note" className="mt-0.5 text-xs text-ink-dim">
            Money-market funds listed above (
            <span className="font-mono">{sweepSymbols.join(", ")}</span>) are treated as cash,
            so they are not in Positions.
          </p>
        )}
      </div>
      {!showCash && (
        <p data-account-value="unanchored-note" className="text-xs text-ink-dim">
          No broker snapshot anchors cash for{" "}
          <span className="font-mono">{cashLine.valuationDate}</span> yet, so cash and the
          account total are not shown.
        </p>
      )}
      {showCash && (
        <div data-account-value="cash">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-ink-dim">
              Cash <span className="text-xs">({asOf})</span>
            </span>
            <span className="font-mono tabular-nums text-ink">
              <Money value={cashLine.cashBalance} precise />
            </span>
          </div>
          {cashLine.liveSourceCaption && (
            <p data-account-value="live-note" className="mt-0.5 text-xs text-ink-dim">
              {cashLine.liveSourceCaption}
            </p>
          )}
          {sweepSymbols.length > 0 && cashLine.isLiveSource && (
            // A live-anchor day's Cash is the broker's intraday total minus
            // priced positions, so it does not contain the statement fund rows
            // listed above; saying it "counts" them would contradict the
            // figures (copy-only ruling, D9b).
            <p data-account-value="sweep-note" className="mt-0.5 text-xs text-ink-dim">
              The Cash figure is the account total minus positions. The money-market fund rows
              listed above (<span className="font-mono">{sweepSymbols.join(", ")}</span>) are from
              the last statement and are not in Positions.
            </p>
          )}
          {sweepSymbols.length > 0 && !cashLine.isLiveSource && (
            <p data-account-value="sweep-note" className="mt-0.5 text-xs text-ink-dim">
              Money-market funds listed above (
              <span className="font-mono">{sweepSymbols.join(", ")}</span>) are counted in Cash,
              not in Positions. Do not add them to the Cash figure again.
            </p>
          )}
        </div>
      )}
      {showCash && (
        <div
          data-account-value="total"
          className="flex items-baseline justify-between gap-3 border-t border-edge pt-2"
        >
          <span className="font-medium text-ink">
            Account total <span className="text-xs font-normal text-ink-dim">({asOf})</span>
          </span>
          <span className="font-mono tabular-nums font-medium text-ink">
            <Money value={cashLine.totalValue} precise />
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * One account's holdings (ruling 2026-08-30): the same priced rows, columns,
 * filter, sort and total row as the All Accounts table, without the Account
 * column (there is one account) and without Alloc % (a share of the whole
 * portfolio would read as a share of this account). The footer totals come
 * from the same summarizeHoldingsFooter, over the rows shown.
 */
export function HoldingsTable({
  holdings,
  cashLine = null,
}: {
  holdings: AccountHoldingRow[];
  cashLine?: AccountCashLine | null;
}) {
  const { sort, setSort } = useSortParam<Field>("holdings", "current_value", "desc");
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return holdings;
    return holdings.filter((h) =>
      [h.symbol, h.security_name, holdingDisplayName(h), h.underlying_symbol].some((v) =>
        v?.toLowerCase().includes(q),
      ),
    );
  }, [holdings, filter]);

  // Totals restate the rows shown, so a filtered footer is the filtered
  // rows' own sum.
  const footer = useMemo(() => summarizeHoldingsFooter(filtered), [filtered]);
  const stale = useMemo(() => summarizeStaleRows(filtered, holdings), [filtered, holdings]);

  const rows = useMemo(() => {
    const enriched = filtered.map((h) => ({
      ...h,
      gain_pct: unrealizedGainRatio(h.unrealized_gain, h.cost_basis),
    }));
    if (!sort.field) return enriched;
    const field = sort.field;
    return [...enriched].sort((a, b) =>
      compareValues(holdingsSortValue(a, field), holdingsSortValue(b, field), sort.dir),
    );
  }, [filtered, sort]);

  if (holdings.length === 0) {
    return (
      <div className="space-y-3">
        <div className="rounded-xl border border-dashed border-edge bg-panel/50 p-8 text-center">
          <p className="text-ink-faint text-sm">
            No holdings data. Import files to see holdings.
          </p>
        </div>
        {cashLine && (
          <div className="rounded-xl border border-edge overflow-hidden bg-panel/50">
            <AccountValueLines cashLine={cashLine} />
          </div>
        )}
      </div>
    );
  }

  const isFiltered = filter.trim().length > 0;

  return (
    <div>
      <h3 className="text-sm font-medium text-ink-dim mb-3">Holdings</h3>
      <div className="rounded-xl border border-edge overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-2 border-b border-edge bg-panel/40">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by symbol or name…"
            aria-label="Filter holdings by symbol or name"
            className="flex-1 bg-transparent text-xs text-ink placeholder:text-ink-faint outline-none"
            spellCheck={false}
            autoComplete="off"
          />
          {isFiltered && (
            <>
              <span className="text-[11px] text-ink-dim font-mono">
                <Count value={filtered.length} /> of <Count value={holdings.length} />
              </span>
              <button
                type="button"
                onClick={() => setFilter("")}
                className="text-[11px] text-ink-dim hover:text-ink transition-colors"
                title="Clear filter"
                aria-label="Clear filter"
              >
                ×
              </button>
            </>
          )}
        </div>
        <ScrollFade>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-edge bg-panel">
              <SortableHeader
                field="symbol"
                sort={sort}
                onSort={setSort}
                className="md:sticky md:left-0 md:z-10 md:bg-panel"
              >
                Symbol
              </SortableHeader>
              <SortableHeader
                field="security_name"
                sort={sort}
                onSort={setSort}
                className="hidden md:table-cell"
              >
                Name
              </SortableHeader>
              <SortableHeader field="quantity" sort={sort} onSort={setSort} align="right">
                Quantity
              </SortableHeader>
              <SortableHeader field="cost_basis" sort={sort} onSort={setSort} align="right">
                Cost Basis
              </SortableHeader>
              <SortableHeader field="current_value" sort={sort} onSort={setSort} align="right">
                Value
              </SortableHeader>
              <SortableHeader field="unrealized_gain" sort={sort} onSort={setSort} align="right">
                Gain
              </SortableHeader>
              <SortableHeader field="gain_pct" sort={sort} onSort={setSort} align="right">
                Gain %
              </SortableHeader>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && isFiltered && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-xs text-ink-dim">
                  No positions match &ldquo;{filter.trim()}&rdquo;. Clear the filter to see every
                  position in this account.
                </td>
              </tr>
            )}
            {rows.map((holding) => {
              const qtyDigits = Number.isInteger(holding.quantity) ? 0 : 4;
              return (
                <tr
                  key={holding.id}
                  className="border-b border-edge last:border-0 hover:bg-panel/50 transition-colors"
                >
                  <td className="px-4 py-3 font-mono font-medium text-ink md:sticky md:left-0 md:z-10 md:bg-canvas">
                    {holding.security_type?.toLowerCase() === "option" ? (
                      <>
                        <SymbolLink
                          securityId={holding.security_id}
                          symbol={holding.underlying_symbol ?? holding.symbol}
                        />
                        <span className="ml-1.5 text-xs text-ink-faint font-normal">
                          {formatOptionDescription(holding)}
                        </span>
                      </>
                    ) : (
                      <SymbolLink
                        securityId={holding.security_id}
                        symbol={holding.symbol}
                      />
                    )}
                  </td>
                  <td
                    className="hidden md:table-cell px-4 py-3 text-ink-dim truncate max-w-[200px]"
                    title={holdingDisplayName(holding)}
                  >
                    {holdingDisplayName(holding)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-ink whitespace-nowrap">
                    <Shares value={holding.quantity} digits={qtyDigits} />
                    <QuantityUnit
                      securityType={holding.security_type}
                      quantity={holding.quantity}
                      className="ml-1 text-xs text-ink-faint font-normal"
                    />
                    <StaleAsOfChip asOfDate={holding.as_of_date} newestDate={stale.newestDate} />
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-ink-dim">
                    {hasKnownBasis(holding) ? (
                      <Money value={holding.cost_basis} precise />
                    ) : (
                      <span title="Import a Vanguard cost basis CSV to populate" className="cursor-help">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-ink">
                    <Money value={holding.current_value} precise />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <GainCell value={holding.unrealized_gain} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <GainPercentCell value={holding.gain_pct} />
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-edge bg-panel/50">
              <td className="px-4 py-3 font-medium text-ink text-xs whitespace-nowrap md:sticky md:left-0 md:z-10 md:bg-panel">
                {/* Same wording for one position or many, so Hide amounts
                    cannot leak "exactly one" through the grammar. */}
                {isFiltered ? "Filtered" : "Total"} (positions: <Count value={filtered.length} />)
              </td>
              <td className="hidden md:table-cell" />
              <td />
              <td className="px-4 py-3 text-right font-mono tabular-nums font-medium text-ink-dim">
                {footer.totalCostBasis === null ? (
                  // No row shown knows its basis: unknown, never "$0.00".
                  <span>&mdash;</span>
                ) : (
                  <Money value={footer.totalCostBasis} precise />
                )}
              </td>
              <td className="px-4 py-3 text-right font-mono tabular-nums font-medium text-ink">
                {footer.pricedCount === 0 ? (
                  // No row to total, or no row shown has a price: unknown,
                  // never an exact "$0.00".
                  <span>&mdash;</span>
                ) : (
                  <>
                    <Money value={footer.totalValue} precise />
                    {footer.unpricedCount > 0 && <PricedOnlyMark />}
                  </>
                )}
              </td>
              <td className="px-4 py-3 text-right">
                <GainCell value={footer.totalGain} />
              </td>
              <td className="px-4 py-3 text-right">
                {/* Over the cost basis of the rows that are IN Gain — the
                    same base the All Accounts footer uses. */}
                <GainPercentCell
                  value={unrealizedGainRatio(footer.totalGain, footer.gainCostBasis)}
                />
              </td>
            </tr>
          </tfoot>
        </table>
        </ScrollFade>
        <HoldingsFooterDisclosures footer={footer} stale={stale} />
        <div className="border-t-2 border-edge bg-panel/50">
          <AccountValueLines cashLine={cashLine} />
        </div>
      </div>
    </div>
  );
}
