"use client";

import { useMemo, useState } from "react";
import { displaySecurityName, unrealizedGainRatio } from "@/lib/format";
import { SymbolLink } from "./SymbolLink";
import { ScrollFade } from "./ScrollFade";
import { SortableHeader } from "./SortableHeader";
import { Chip } from "./Chip";
import { Count, Money, Pct, QuantityUnit, Shares } from "@/lib/privacy/components";
import { compareValues, useSortParam } from "@/lib/hooks/useSortParam";
import { hasKnownBasis } from "@/lib/compute/known-basis";
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

// "Do we know this row's cost" is answered by hasKnownBasis
// (lib/compute/known-basis.ts): a stored 0 is unknown, like null. Every cell,
// total and sort key here goes through it, or a row can print an exact
// "$0.00" Cost Basis beside an unknown Gain cell.

// Same wording as HoldingsTable.tsx's per-account Cost Basis unknown-basis
// cell — this table's stored-zero-is-unknown em-dash needs the same
// guidance, not a silent dash with no explanation.
export const NO_COST_BASIS_TOOLTIP = "Import a Vanguard cost basis CSV to populate";

/**
 * The value a holdings row sorts by. An unknown figure must sort as unknown
 * (null goes last in both directions), whichever way it is stored: a cost
 * basis of 0 is unknown, and so is the gain of a row whose basis is unknown.
 * A gain of exactly 0 on a KNOWN basis is a real figure and sorts between
 * the losses and the gains.
 */
export function holdingsSortValue<Row extends { cost_basis: number | null }>(
  row: Row,
  field: string,
): unknown {
  if ((field === "cost_basis" || field === "unrealized_gain") && !hasKnownBasis(row)) {
    return null;
  }
  return row[field as keyof Row];
}

export interface StaleRowSummary {
  /** Newest as-of date in the reference set; null when there are no rows. */
  newestDate: string | null;
  /** Rows shown whose as-of date is older than newestDate. */
  staleCount: number;
  /** Oldest as-of date among those rows; null when none is stale. */
  oldestStaleDate: string | null;
}

/**
 * Which rows carry a quantity from an older snapshot than the newest one.
 * "Latest" holdings are keyed per (account, security), so a position that
 * only restates on the monthly statement keeps an older date beside rows
 * synced yesterday, at today's price. `rows` is what the table shows;
 * `reference` is the whole set the newest date is read from (the filter
 * narrows the rows, not what "newest" means). Dates are YYYY-MM-DD, so a
 * string compare orders them.
 */
export function summarizeStaleRows(
  rows: { as_of_date: string }[],
  reference: { as_of_date: string }[] = rows,
): StaleRowSummary {
  const newestDate = reference.reduce<string | null>(
    (latest, r) => (latest === null || r.as_of_date > latest ? r.as_of_date : latest),
    null,
  );
  const stale = rows.filter((r) => newestDate !== null && r.as_of_date < newestDate);
  return {
    newestDate,
    staleCount: stale.length,
    oldestStaleDate: stale.reduce<string | null>(
      (oldest, r) => (oldest === null || r.as_of_date < oldest ? r.as_of_date : oldest),
      null,
    ),
  };
}

/** The chip beside Qty on a row older than the newest snapshot ("as of
 *  MM-DD"). A date is public metadata, so it renders plain; the full date is
 *  in the title for a row carried across a year end. */
export function StaleAsOfChip({
  asOfDate,
  newestDate,
}: {
  asOfDate: string;
  newestDate: string | null;
}) {
  if (newestDate === null || asOfDate >= newestDate) return null;
  return (
    <Chip
      size="xs"
      title={`Quantity as of ${asOfDate}, older than the newest snapshot (${newestDate})`}
      className="ml-1.5 whitespace-nowrap"
    >
      as of {asOfDate.slice(5)}
    </Chip>
  );
}

export function GainCell({ value }: { value: number | null }) {
  if (value === null) return <span className="text-ink-faint">&mdash;</span>;
  const isPositive = value >= 0;
  const className = `font-mono tabular-nums ${
    value === 0 ? "text-ink-dim" : isPositive ? "text-up" : "text-down"
  }`;
  return <Money value={value} precise signed className={className} />;
}

export function GainPercentCell({ value }: { value: number | null }) {
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
  /** Cost basis of the rows that are in Gain (known basis AND a price): the
   *  only honest base for Gain %. Equals totalCostBasis − noPriceCostBasis.
   *  Null when no row has a gain. */
  gainCostBasis: number | null;
  /** Rows with no cost basis (null or the stored-zero convention). They are
   *  in neither Cost Basis nor Gain. */
  noBasisCount: number;
  /** How many of those rows have a current price. Only these are in Value. */
  noBasisPricedCount: number;
  /** Combined market value of the PRICED no-basis rows (shorts net against
   *  longs). Says nothing about the unpriced ones: unknown is not zero. */
  noBasisValue: number;
  /** How many of those rows have no current price either. Their value is
   *  unknown and they are in none of the totals. */
  noBasisUnpricedCount: number;
  /** Rows with a known basis but no gain, which the query produces only
   *  when there is no current price. They are in Cost Basis, and in none of
   *  Value, Gain and Gain %. */
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
    gainCostBasis: withGain.length === 0 ? null : sum(withGain.map((h) => h.cost_basis!)),
    noBasisCount: noBasis.length,
    noBasisPricedCount: noBasis.filter((h) => h.current_value !== null).length,
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
  // Rows whose quantity comes from an older snapshot than the newest one in
  // the whole set (ruling 2026-09-02: a chip on those rows plus a caption).
  const stale = useMemo(() => summarizeStaleRows(filtered, holdings), [filtered, holdings]);

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
    // compareValues treats 0 as a real, sortable number and puts nulls last,
    // so an unknown-because-zero cost basis sorted first ascending while an
    // unknown-because-null one sorted last, though both cells render "—".
    // holdingsSortValue maps every unknown to null — and only an unknown: a
    // real $0.00 gain on a known basis keeps its place between the losses
    // and the gains.
    const sortValue = (row: (typeof enriched)[number]) => holdingsSortValue(row, field);
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
              {/* Symbol stays put while the money columns pan sideways, so a
                  row keeps its identity (desktop only: on a phone a pinned
                  option symbol would cover half the screen). */}
              <SortableHeader
                field="symbol"
                sort={sort}
                onSort={setSort}
                className="md:sticky md:left-0 md:z-10 md:bg-panel"
              >
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
                  <td className="px-4 py-3 font-mono font-medium text-ink md:sticky md:left-0 md:z-10 md:bg-canvas">
                    <SymbolLink securityId={h.security_id} symbol={h.symbol} />
                  </td>
                  <td
                    className="px-4 py-3 text-ink-dim text-xs max-w-[200px] truncate"
                    title={displaySecurityName(h.security_name)}
                  >
                    {displaySecurityName(h.security_name)}
                  </td>
                  <td className="px-4 py-3 text-ink-dim text-xs">{h.account_name}</td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-ink whitespace-nowrap">
                    <Shares value={h.quantity} digits={qtyDigits} />
                    <QuantityUnit
                      securityType={h.security_type}
                      quantity={h.quantity}
                      className="ml-1 text-xs text-ink-faint font-normal"
                    />
                    <StaleAsOfChip asOfDate={h.as_of_date} newestDate={stale.newestDate} />
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
                {filtered.length === 0 ? (
                  // A filter that matches nothing has no value to total: the
                  // same unknown dash as its Cost Basis and Gain siblings,
                  // never an exact "$0.00" over no rows.
                  <span className="text-ink-faint">&mdash;</span>
                ) : (
                  <Money value={totalValue} precise />
                )}
              </td>
              <td className="px-4 py-3 text-right">
                <GainCell value={footer.totalGain} />
              </td>
              <td className="px-4 py-3 text-right">
                {/* Over the cost basis of the rows that are IN Gain, not the
                    Cost Basis total: a percent whose two halves cover
                    different positions is not a figure. */}
                <GainPercentCell
                  value={unrealizedGainRatio(footer.totalGain, footer.gainCostBasis)}
                />
              </td>
              <td className="px-4 py-3 text-right font-mono tabular-nums text-ink-dim">
                {filtered.length > 0 && unfilteredTotal > 0 ? (
                  <Pct value={(totalValue / unfilteredTotal) * 100} digits={2} />
                ) : (
                  "—"
                )}
              </td>
            </tr>
          </tfoot>
        </table>
      </ScrollFade>
      <HoldingsFooterDisclosures footer={footer} stale={stale} />
    </div>
  );
}

/**
 * What the footer's columns leave out, and which rows are older than the
 * newest snapshot. Shared by the All Accounts table and the single-account
 * table (HoldingsTable.tsx), so the two say it in the same words.
 */
export function HoldingsFooterDisclosures({
  footer,
  stale,
}: {
  footer: HoldingsFooterSummary;
  stale: StaleRowSummary;
}) {
  if (footer.noBasisCount === 0 && footer.noPriceCount === 0 && stale.staleCount === 0) {
    return null;
  }
  return (
    // Said in words, under the table and OUTSIDE the horizontal scroller
    // so a phone reads it without scrolling sideways: the footer's money
    // columns cover different sets of positions, so Value − Cost Basis
    // is not Gain. The wording is the same for one position or many, so
    // Hide amounts cannot leak "exactly one" through the grammar.
    <div
      data-footer-disclosures
      className="border-t border-edge bg-panel/50 px-4 py-3 text-xs text-ink-dim space-y-1"
    >
      {footer.noBasisCount > 0 && (
        <p data-footer-disclosure="no-basis">
          Positions with no cost basis: <Count value={footer.noBasisCount} />
          {footer.noBasisUnpricedCount === 0 ? (
            <>
              , worth <Money value={footer.noBasisValue} precise />. They are counted in Value
              and left out of Cost Basis, Gain and Gain %.
            </>
          ) : footer.noBasisPricedCount === 0 ? (
            // Unknown is not zero: no figure at all.
            <>
              . None has a current price, so their value is unknown and they are in none of
              the totals.
            </>
          ) : (
            <>
              . With a current price: <Count value={footer.noBasisPricedCount} />, worth{" "}
              <Money value={footer.noBasisValue} precise />; they are counted in Value and
              left out of Cost Basis, Gain and Gain %. Without a current price:{" "}
              <Count value={footer.noBasisUnpricedCount} />; their value is unknown and they
              are in none of the totals.
            </>
          )}
        </p>
      )}
      {footer.noPriceCount > 0 && (
        <p data-footer-disclosure="no-price">
          Positions with a cost basis but no current price:{" "}
          <Count value={footer.noPriceCount} />, cost basis{" "}
          <Money value={footer.noPriceCostBasis} precise />. They are counted in Cost Basis
          and left out of Value, Gain and Gain %.
        </p>
      )}
      {stale.staleCount > 0 && (
        // Same grammar for one position or many, so Hide amounts cannot leak
        // "exactly one". The date is public metadata and renders plain.
        <p data-footer-disclosure="stale">
          Positions carried from a snapshot older than{" "}
          <span className="font-mono">{stale.newestDate}</span>:{" "}
          <Count value={stale.staleCount} />, the oldest as of{" "}
          <span className="font-mono">{stale.oldestStaleDate}</span>. Each is marked beside its
          quantity; its value and gain use the current price.
        </p>
      )}
    </div>
  );
}
