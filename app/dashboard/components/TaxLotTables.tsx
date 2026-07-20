"use client";

import { useMemo } from "react";
import type { TaxLotWithSecurity, TaxLotSaleWithDetails } from "@/lib/queries/tax-lots";
import { SymbolLink } from "@/app/dashboard/components/SymbolLink";
import { Money, Shares } from "@/lib/privacy/components";
import { ScrollFade } from "./ScrollFade";
import { SortableHeader } from "./SortableHeader";
import { compareValues, useSortParam } from "@/lib/hooks/useSortParam";

type OpenField =
  | "account_name"
  | "symbol"
  | "acquisition_date"
  | "quantity_remaining"
  | "acquisition_price"
  | "adjusted_cost_basis"
  | "current_value"
  | "unrealized_gain";

type ClosedField =
  | "account_name"
  | "symbol"
  | "sale_date"
  | "quantity_sold"
  | "proceeds"
  | "cost_basis_allocated"
  | "realized_gain_loss"
  | "is_long_term"
  | "holding_period_days";

function GainCell({ value }: { value: number | null }) {
  if (value === null) return <span className="text-ink-faint">&mdash;</span>;
  const isPositive = value >= 0;
  return (
    <Money
      value={value}
      precise
      signed
      className={`font-mono tabular-nums ${
        value === 0 ? "text-ink-dim" : isPositive ? "text-up" : "text-down"
      }`}
    />
  );
}

export function OpenLotsTable({
  lots,
  showAccount = true,
}: {
  lots: TaxLotWithSecurity[];
  showAccount?: boolean;
}) {
  const { sort, setSort } = useSortParam<OpenField>("openLots", null, "desc");

  const rows = useMemo(() => {
    if (!sort.field) return lots;
    const field = sort.field;
    return [...lots].sort((a, b) =>
      compareValues(
        a[field as keyof TaxLotWithSecurity],
        b[field as keyof TaxLotWithSecurity],
        sort.dir,
      ),
    );
  }, [lots, sort]);

  if (lots.length === 0) {
    return null;
  }

  return (
    <div>
      <h4 className="text-xs font-medium text-ink-faint mb-2">
        Open Lots
        <span className="ml-1.5 text-ink-faint/60">({lots.length})</span>
      </h4>
      <div className="rounded-xl border border-edge overflow-hidden">
        <ScrollFade>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-edge bg-panel">
                {showAccount && (
                  <SortableHeader field="account_name" sort={sort} onSort={setSort}>
                    Account
                  </SortableHeader>
                )}
                <SortableHeader field="symbol" sort={sort} onSort={setSort}>
                  Symbol
                </SortableHeader>
                <SortableHeader
                  field="acquisition_date"
                  sort={sort}
                  onSort={setSort}
                  className="hidden md:table-cell"
                >
                  Acquired
                </SortableHeader>
                <SortableHeader field="quantity_remaining" sort={sort} onSort={setSort} align="right">
                  Qty
                </SortableHeader>
                <SortableHeader
                  field="acquisition_price"
                  sort={sort}
                  onSort={setSort}
                  align="right"
                  className="hidden md:table-cell"
                >
                  Cost/Share
                </SortableHeader>
                <SortableHeader field="adjusted_cost_basis" sort={sort} onSort={setSort} align="right">
                  Cost Basis
                </SortableHeader>
                <SortableHeader
                  field="current_value"
                  sort={sort}
                  onSort={setSort}
                  align="right"
                  className="hidden md:table-cell"
                >
                  Mkt Value
                </SortableHeader>
                <SortableHeader field="unrealized_gain" sort={sort} onSort={setSort} align="right">
                  Unrealized
                </SortableHeader>
              </tr>
            </thead>
            <tbody>
              {rows.map((lot) => {
                const qtyDigits = Number.isInteger(lot.quantity_remaining) ? 0 : 4;
                return (
                  <tr
                    key={lot.id}
                    className="border-b border-edge last:border-0 hover:bg-panel/50 transition-colors"
                  >
                    {showAccount && (
                      <td className="px-4 py-3 text-ink-dim text-xs">{lot.account_name}</td>
                    )}
                    <td className="px-4 py-3 font-mono font-medium text-ink">
                      <SymbolLink securityId={lot.security_id} symbol={lot.symbol} />
                    </td>
                    <td className="hidden md:table-cell px-4 py-3 text-ink-faint font-mono text-xs">{lot.acquisition_date}</td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-ink">
                      <Shares value={lot.quantity_remaining} digits={qtyDigits} />
                    </td>
                    <td className="hidden md:table-cell px-4 py-3 text-right font-mono tabular-nums text-ink-dim">
                      <Money value={lot.acquisition_price} precise />
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-ink-dim">
                      <Money value={lot.adjusted_cost_basis} precise />
                    </td>
                    <td className="hidden md:table-cell px-4 py-3 text-right font-mono tabular-nums text-ink">
                      <Money value={lot.current_value} precise />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <GainCell value={lot.unrealized_gain} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollFade>
      </div>
    </div>
  );
}

export function ClosedSalesTable({
  sales,
  showAccount = true,
}: {
  sales: TaxLotSaleWithDetails[];
  showAccount?: boolean;
}) {
  const { sort, setSort } = useSortParam<ClosedField>("closedLots", null, "desc");

  const rows = useMemo(() => {
    if (!sort.field) return sales;
    const field = sort.field;
    return [...sales].sort((a, b) =>
      compareValues(
        a[field as keyof TaxLotSaleWithDetails],
        b[field as keyof TaxLotSaleWithDetails],
        sort.dir,
      ),
    );
  }, [sales, sort]);

  if (sales.length === 0) {
    return null;
  }

  return (
    <div>
      <h4 className="text-xs font-medium text-ink-faint mb-2">
        Closed Sales
        <span className="ml-1.5 text-ink-faint/60">({sales.length})</span>
      </h4>
      <div className="rounded-xl border border-edge overflow-hidden">
        <ScrollFade>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-edge bg-panel">
                {showAccount && (
                  <SortableHeader field="account_name" sort={sort} onSort={setSort}>
                    Account
                  </SortableHeader>
                )}
                <SortableHeader field="symbol" sort={sort} onSort={setSort}>
                  Symbol
                </SortableHeader>
                <SortableHeader
                  field="sale_date"
                  sort={sort}
                  onSort={setSort}
                  className="hidden md:table-cell"
                >
                  Sold
                </SortableHeader>
                <SortableHeader
                  field="quantity_sold"
                  sort={sort}
                  onSort={setSort}
                  align="right"
                  className="hidden md:table-cell"
                >
                  Qty
                </SortableHeader>
                <SortableHeader
                  field="proceeds"
                  sort={sort}
                  onSort={setSort}
                  align="right"
                  className="hidden md:table-cell"
                >
                  Proceeds
                </SortableHeader>
                <SortableHeader
                  field="cost_basis_allocated"
                  sort={sort}
                  onSort={setSort}
                  align="right"
                  className="hidden md:table-cell"
                >
                  Cost Basis
                </SortableHeader>
                <SortableHeader field="realized_gain_loss" sort={sort} onSort={setSort} align="right">
                  Gain/Loss
                </SortableHeader>
                <SortableHeader field="is_long_term" sort={sort} onSort={setSort}>
                  Term
                </SortableHeader>
                <SortableHeader
                  field="holding_period_days"
                  sort={sort}
                  onSort={setSort}
                  align="right"
                  className="hidden md:table-cell"
                >
                  Days
                </SortableHeader>
              </tr>
            </thead>
            <tbody>
              {rows.map((sale) => {
                const qtyDigits = Number.isInteger(sale.quantity_sold) ? 0 : 4;
                return (
                  <tr
                    key={sale.id}
                    className="border-b border-edge last:border-0 hover:bg-panel/50 transition-colors"
                  >
                    {showAccount && (
                      <td className="px-4 py-3 text-ink-dim text-xs">{sale.account_name}</td>
                    )}
                    <td className="px-4 py-3 font-mono font-medium text-ink">
                      <SymbolLink securityId={sale.security_id} symbol={sale.symbol} />
                    </td>
                    <td className="hidden md:table-cell px-4 py-3 text-ink-faint font-mono text-xs">{sale.sale_date}</td>
                    <td className="hidden md:table-cell px-4 py-3 text-right font-mono tabular-nums text-ink">
                      <Shares value={sale.quantity_sold} digits={qtyDigits} />
                    </td>
                    <td className="hidden md:table-cell px-4 py-3 text-right font-mono tabular-nums text-ink">
                      <Money value={sale.proceeds} precise />
                    </td>
                    <td className="hidden md:table-cell px-4 py-3 text-right font-mono tabular-nums text-ink-dim">
                      <Money value={sale.cost_basis_allocated} precise />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <GainCell value={sale.realized_gain_loss} />
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`text-xs px-2 py-0.5 rounded font-medium ${
                          sale.is_long_term
                            ? "bg-blue/20 text-blue"
                            : "bg-gold/20 text-gold-ink"
                        }`}
                      >
                        {sale.is_long_term ? "Long" : "Short"}
                      </span>
                    </td>
                    <td className="hidden md:table-cell px-4 py-3 text-right font-mono tabular-nums text-ink-faint text-xs">
                      {sale.holding_period_days}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollFade>
      </div>
    </div>
  );
}
