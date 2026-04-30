"use client";

import { useMemo, useState } from "react";
import { SymbolLink } from "./SymbolLink";
import { ScrollFade } from "./ScrollFade";
import { SortableHeader } from "./SortableHeader";
import { Money, Pct, Shares } from "@/lib/privacy/components";
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
  // looking at a 3-row subset.
  const totalValue = useMemo(
    () => filtered.reduce((sum, h) => sum + (h.current_value ?? 0), 0),
    [filtered],
  );

  const rows = useMemo(() => {
    const enriched = filtered.map((h) => ({
      ...h,
      gain_pct:
        h.unrealized_gain !== null && h.cost_basis !== null && h.cost_basis !== 0
          ? h.unrealized_gain / h.cost_basis
          : null,
      alloc_pct:
        h.current_value !== null && totalValue > 0 ? h.current_value / totalValue : null,
    }));

    if (!sort.field) return enriched;
    const field = sort.field;
    return [...enriched].sort((a, b) =>
      compareValues(a[field as keyof typeof a], b[field as keyof typeof b], sort.dir),
    );
  }, [filtered, sort, totalValue]);

  const holdingsWithCost = filtered.filter((h) => h.cost_basis !== null);
  const totalCostBasis = holdingsWithCost.reduce((sum, h) => sum + h.cost_basis!, 0);
  const missingCostCount = filtered.length - holdingsWithCost.length;
  const totalGain = filtered.reduce((sum, h) => sum + (h.unrealized_gain ?? 0), 0);
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
                    {h.security_name ?? "\u2014"}
                  </td>
                  <td className="px-4 py-3 text-ink-dim text-xs">{h.account_name}</td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-ink">
                    <Shares value={h.quantity} digits={qtyDigits} />
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-ink-dim">
                    <Money value={h.cost_basis} precise />
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
                {missingCostCount > 0 ? (
                  <span
                    title={`${missingCostCount} position${missingCostCount > 1 ? "s" : ""} missing cost basis data`}
                    className="cursor-help"
                  >
                    ~<Money value={totalCostBasis} precise />
                  </span>
                ) : (
                  <Money value={totalCostBasis} precise />
                )}
              </td>
              <td className="px-4 py-3 text-right font-mono tabular-nums font-medium text-ink">
                <Money value={totalValue} precise />
              </td>
              <td className="px-4 py-3 text-right">
                <GainCell value={totalGain} />
              </td>
              <td className="px-4 py-3 text-right">
                <GainPercentCell
                  value={totalCostBasis !== 0 ? totalGain / totalCostBasis : null}
                />
              </td>
              <td className="px-4 py-3 text-right font-mono tabular-nums text-ink-dim">
                100.00%
              </td>
            </tr>
          </tfoot>
        </table>
      </ScrollFade>
    </div>
  );
}
