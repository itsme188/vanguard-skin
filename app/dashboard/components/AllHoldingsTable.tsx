"use client";

import { useMemo, useState } from "react";
import { displaySecurityName, unrealizedGainRatio } from "@/lib/format";
import { SymbolLink } from "./SymbolLink";
import { ScrollFade } from "./ScrollFade";
import { SortableHeader } from "./SortableHeader";
import { Count, Money, Pct, Shares } from "@/lib/privacy/components";
import { compareValues, useSortParam } from "@/lib/hooks/useSortParam";
import type { AllHoldingsRow } from "@/lib/queries/holdings";

export type { AllHoldingsRow };

type Field =
  | "symbol"
  | "security_name"
  | "account_name"
  | "quantity"
  | "cost_basis"
  | "current_value"
  | "unrealized_gain"
  | "gain_pct"
  | "alloc_pct";

// A stored cost basis of exactly 0 means "unknown," not "free" — mirrors
// lib/queries/holdings.ts's NULLIF(costBasisExpr, 0) IS NOT NULL convention,
// which already nulls unrealized_gain for a zero basis. Every place that
// decides "do we know this row's cost" must agree with that, or a row can
// print an exact "$0.00" Cost Basis beside an unknown Gain cell.
const hasKnownBasis = (h: { cost_basis: number | null }): boolean =>
  h.cost_basis !== null && h.cost_basis !== 0;

// Same wording as HoldingsTable.tsx's per-account Cost Basis unknown-basis
// cell — this table's stored-zero-is-unknown em-dash needs the same
// guidance, not a silent dash with no explanation.
const NO_COST_BASIS_TOOLTIP = "Import a Vanguard cost basis CSV to populate";

function GainCell({ value }: { value: number | null }) {
  if (value === null) return <span className="text-ink-faint">&mdash;</span>;
  const isPositive = value >= 0;
  const className = `font-mono tabular-nums ${
    value === 0 ? "text-ink-dim" : isPositive ? "text-up" : "text-down"
  }`;
  return <Money value={value} precise signed className={className} />;
}

function GainPercentCell({ value }: { value: number | null }) {
  if (value === null) return <span className="text-ink-faint">&mdash;</span>;
  const isPositive = value >= 0;
  const className = `font-mono tabular-nums ${
    value === 0 ? "text-ink-dim" : isPositive ? "text-up" : "text-down"
  }`;
  return <Pct value={value * 100} digits={2} signed className={className} />;
}

export interface HoldingsFooterSummary {
  /** Market value of every priced row. Never narrowed to make the columns
   *  subtract: it is what the positions are worth. */
  totalValue: number;
  /** Cost basis of the rows whose basis is known; null when none is. */
  totalCostBasis: number | null;
  /** Gain of the rows that have one (known basis AND a price); null when
   *  none does. */
  totalGain: number | null;
  /** Rows with no cost basis (null or the stored-zero convention). They are
   *  in Value, and in neither Cost Basis nor Gain. */
  noBasisCount: number;
  /** Combined market value of those rows (shorts net against longs). */
  noBasisValue: number;
  /** How many of those rows have no current price either, so they add
   *  nothing to `noBasisValue`. */
  noBasisUnpricedCount: number;
  /** Rows with a known basis but no gain, which the query produces only
   *  when there is no current price. They are in Cost Basis, and in neither
   *  Value nor Gain. */
  noPriceCount: number;
  /** Combined cost basis of those rows. */
  noPriceCostBasis: number;
}

/**
 * The footer's three money columns are summed over three different sets of
 * rows by necessity: a gain cannot be stated without a basis, and real
 * market value must not be dropped from a portfolio total to make a
 * subtraction look neat. This returns the three totals AND the two
 * populations that make them differ, so the footer can say so in words:
 *
 *   Value − Cost Basis − Gain = noBasisValue − noPriceCostBasis
 *
 * tests/dashboard/all-holdings-footer-disclosure.test.tsx pins that identity.
 */
export function summarizeHoldingsFooter(
  rows: Pick<AllHoldingsRow, "cost_basis" | "current_value" | "unrealized_gain">[],
): HoldingsFooterSummary {
  const sum = (values: number[]) => values.reduce((total, v) => total + v, 0);

  const withBasis = rows.filter(hasKnownBasis);
  const noBasis = rows.filter((h) => !hasKnownBasis(h));
  const withGain = rows.filter((h) => h.unrealized_gain !== null);
  const noPrice = withBasis.filter((h) => h.unrealized_gain === null);

  return {
    totalValue: sum(rows.map((h) => h.current_value ?? 0)),
    totalCostBasis: withBasis.length === 0 ? null : sum(withBasis.map((h) => h.cost_basis!)),
    totalGain: withGain.length === 0 ? null : sum(withGain.map((h) => h.unrealized_gain!)),
    noBasisCount: noBasis.length,
    noBasisValue: sum(noBasis.map((h) => h.current_value ?? 0)),
    noBasisUnpricedCount: noBasis.filter((h) => h.current_value === null).length,
    noPriceCount: noPrice.length,
    noPriceCostBasis: sum(noPrice.map((h) => h.cost_basis!)),
  };
}

export function AllHoldingsTable({ holdings }: { holdings: AllHoldingsRow[] }) {
  const { sort, setSort } = useSortParam<Field>("holdings", "current_value", "desc");
  const [filter, setFilter] = useState("");

  // Filter on symbol, security_name, or account_name — three fields a user
  // might type when scanning a 100+-position list. Normalize to lowercase
  // so "HOOD" and "hood" both match.
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return holdings;
    return holdings.filter((h) =>
      [h.symbol, h.security_name, h.account_name]
        .some((v) => v?.toLowerCase().includes(q))
    );
  }, [holdings, filter]);

  // Totals reflect the filtered view so the footer stays honest when a
  // filter is applied — otherwise "$2.1M total" is misleading when you're
  // looking at a 3-row subset. The same summary also names the rows each
  // column leaves out (see summarizeHoldingsFooter).
  const footer = useMemo(() => summarizeHoldingsFooter(filtered), [filtered]);
  const totalValue = footer.totalValue;

  // Alloc % denominator stays anchored to the UNFILTERED set — the filter
  // narrows which rows show, not what the portfolio is (pre-fix a 1.22%
  // position read as 77% of its own two-row subset). The footer's Alloc %
  // becomes the filtered subset's true share of the whole, not a hardcoded
  // 100.00%.
  const unfilteredTotal = useMemo(
    () => holdings.reduce((sum, h) => sum + (h.current_value ?? 0), 0),
    [holdings],
  );

  const rows = useMemo(() => {
    const enriched = filtered.map((h) => ({
      ...h,
      gain_pct: unrealizedGainRatio(h.unrealized_gain, h.cost_basis),
      alloc_pct:
        h.current_value !== null && unfilteredTotal > 0
          ? h.current_value / unfilteredTotal
          : null,
    }));

    if (!sort.field) return enriched;
    const field = sort.field;
    // A stored 0 means "unknown" for cost_basis and unrealized_gain (see
    // hasKnownBasis above), but compareValues treats 0 as a real, sortable
    // number and puts nulls last — so an unknown-because-zero row sorted
    // first ascending while an unknown-because-null row sorted last, even
    // though both cells render the same "—". Map 0 to null for these two
    // fields before comparing so every unknown row groups together the same
    // way regardless of which flavor of "unknown" it is.
    const sortValue = (row: (typeof enriched)[number]) => {
      const v = row[field as keyof typeof row];
      if ((field === "cost_basis" || field === "unrealized_gain") && v === 0) {
        return null;
      }
      return v;
    };
    return [...enriched].sort((a, b) => compareValues(sortValue(a), sortValue(b), sort.dir));
  }, [filtered, sort, unfilteredTotal]);

  const isFiltered = filter.trim().length > 0;

  return (
    <div className="rounded-xl border border-edge overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-2 border-b border-edge bg-panel/40">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by symbol, name, or account…"
          className="flex-1 bg-transparent text-xs text-ink placeholder:text-ink-faint outline-none"
          spellCheck={false}
          autoComplete="off"
        />
        {isFiltered && (
          <>
            <span className="text-[11px] text-ink-faint font-mono">
              {filtered.length} of {holdings.length}
            </span>
            <button
              onClick={() => setFilter("")}
              className="text-[11px] text-ink-faint hover:text-ink transition-colors"
              title="Clear filter"
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
              <SortableHeader field="symbol" sort={sort} onSort={setSort}>
                Symbol
              </SortableHeader>
              <SortableHeader field="security_name" sort={sort} onSort={setSort}>
                Name
              </SortableHeader>
              <SortableHeader field="account_name" sort={sort} onSort={setSort}>
                Account
              </SortableHeader>
              <SortableHeader field="quantity" sort={sort} onSort={setSort} align="right">
                Qty
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
              <SortableHeader field="alloc_pct" sort={sort} onSort={setSort} align="right">
                Alloc %
              </SortableHeader>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && isFiltered && (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-xs text-ink-faint">
                  No positions match &ldquo;{filter.trim()}&rdquo; &mdash; clear the
                  filter to see all {holdings.length}.
                </td>
              </tr>
            )}
            {rows.map((h) => {
              const qtyDigits = Number.isInteger(h.quantity) ? 0 : 4;
              return (
                <tr
                  key={`${h.account_id}-${h.security_id}`}
                  className="border-b border-edge last:border-0 hover:bg-panel/50 transition-colors"
                >
                  <td className="px-4 py-3 font-mono font-medium text-ink">
                    <SymbolLink securityId={h.security_id} symbol={h.symbol} />
                  </td>
                  <td className="px-4 py-3 text-ink-dim text-xs max-w-[200px] truncate">
                    {displaySecurityName(h.security_name)}
                  </td>
                  <td className="px-4 py-3 text-ink-dim text-xs">{h.account_name}</td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-ink">
                    <Shares value={h.quantity} digits={qtyDigits} />
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-ink-dim">
                    {hasKnownBasis(h) ? (
                      <Money value={h.cost_basis} precise />
                    ) : (
                      <span
                        title={NO_COST_BASIS_TOOLTIP}
                        className="text-ink-faint cursor-help"
                      >
                        &mdash;
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-ink">
                    <Money value={h.current_value} precise />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <GainCell value={h.unrealized_gain} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <GainPercentCell value={h.gain_pct} />
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-ink-dim">
                    {h.alloc_pct !== null ? (
                      <Pct value={h.alloc_pct * 100} digits={2} />
                    ) : (
                      "\u2014"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-edge bg-panel/50">
              <td className="px-4 py-3 font-medium text-ink text-xs" colSpan={4}>
                {isFiltered
                  ? `Filtered (${filtered.length} position${filtered.length === 1 ? "" : "s"})`
                  : `Total (${holdings.length} positions)`}
              </td>
              <td className="px-4 py-3 text-right font-mono tabular-nums font-medium text-ink-dim">
                {footer.totalCostBasis === null ? (
                  // No filtered row knows its basis: the footer restates the
                  // rows, so it is unknown too — never a "$0.00" over nothing.
                  <span className="text-ink-faint">&mdash;</span>
                ) : (
                  <Money value={footer.totalCostBasis} precise />
                )}
              </td>
              <td className="px-4 py-3 text-right font-mono tabular-nums font-medium text-ink">
                <Money value={totalValue} precise />
              </td>
              <td className="px-4 py-3 text-right">
                <GainCell value={footer.totalGain} />
              </td>
              <td className="px-4 py-3 text-right">
                <GainPercentCell
                  value={unrealizedGainRatio(footer.totalGain, footer.totalCostBasis)}
                />
              </td>
              <td className="px-4 py-3 text-right font-mono tabular-nums text-ink-dim">
                {unfilteredTotal > 0 ? (
                  <Pct value={(totalValue / unfilteredTotal) * 100} digits={2} />
                ) : (
                  "—"
                )}
              </td>
            </tr>
            {(footer.noBasisCount > 0 || footer.noPriceCount > 0) && (
              // Said in the row, in words: the three money columns cover
              // different sets of positions, so Value − Cost Basis is not
              // Gain. Wording is the same for one position or many, so Hide
              // amounts cannot leak "exactly one" through the grammar.
              <tr className="bg-panel/50">
                <td colSpan={9} className="px-4 pb-3 text-xs text-ink-dim space-y-1">
                  {footer.noBasisCount > 0 && (
                    <p data-footer-disclosure="no-basis">
                      Positions with no cost basis: <Count value={footer.noBasisCount} />, worth{" "}
                      <Money value={footer.noBasisValue} precise />. They are counted in Value and
                      left out of Cost Basis and Gain.
                      {footer.noBasisUnpricedCount > 0 && (
                        <>
                          {" "}
                          Of those, positions with no current price either, which add nothing to that
                          figure:{" "}
                          <Count value={footer.noBasisUnpricedCount} />.
                        </>
                      )}
                    </p>
                  )}
                  {footer.noPriceCount > 0 && (
                    <p data-footer-disclosure="no-price">
                      Positions with a cost basis but no current price:{" "}
                      <Count value={footer.noPriceCount} />, cost basis{" "}
                      <Money value={footer.noPriceCostBasis} precise />. They are counted in Cost
                      Basis (and so in the Gain % base) and left out of Value and Gain.
                    </p>
                  )}
                </td>
              </tr>
            )}
          </tfoot>
        </table>
      </ScrollFade>
    </div>
  );
}
