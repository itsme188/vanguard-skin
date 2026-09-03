"use client";

import { useMemo } from "react";
import type { TransactionWithSecurity } from "@/lib/queries/transactions";
import { SymbolLink } from "@/app/dashboard/components/SymbolLink";
import { Money, Shares } from "@/lib/privacy/components";
import { displayCashEffect } from "@/lib/format/cash-effect";
import { ScrollFade } from "./ScrollFade";
import { SortableHeader } from "./SortableHeader";
import { compareValues, useSortParam } from "@/lib/hooks/useSortParam";

const TYPE_STYLES: Record<string, string> = {
  BUY: "bg-up/20 text-up",
  SELL: "bg-down/20 text-down",
  DIVIDEND: "bg-gold/20 text-gold-ink",
  INTEREST: "bg-blue/20 text-blue",
  FEE: "bg-down/20 text-down",
  COMMISSION: "bg-down/20 text-down",
  TRANSFER: "bg-blue/20 text-blue",
  TRANSFER_IN: "bg-blue/20 text-blue",
  TRANSFER_OUT: "bg-gold/20 text-gold-ink",
  DEPOSIT: "bg-up/20 text-up",
  WITHDRAWAL: "bg-down/20 text-down",
};

type Field = "trade_date" | "type" | "symbol" | "quantity" | "amount";

export function TransactionHistory({
  transactions,
}: {
  transactions: TransactionWithSecurity[];
}) {
  const { sort, setSort } = useSortParam<Field>("txns", "trade_date", "desc");

  const rows = useMemo(() => {
    if (!sort.field) return transactions;
    const field = sort.field;
    return [...transactions].sort((a, b) =>
      compareValues(
        a[field as keyof TransactionWithSecurity],
        b[field as keyof TransactionWithSecurity],
        sort.dir,
      ),
    );
  }, [transactions, sort]);

  if (transactions.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-edge bg-panel/50 p-8 text-center">
        <p className="text-ink-faint text-sm">
          No transactions yet. Import files to see transaction history.
        </p>
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-sm font-medium text-ink-dim mb-3">
        Recent Transactions
      </h3>
      <div className="rounded-xl border border-edge overflow-hidden">
        <ScrollFade>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-edge bg-panel">
              <SortableHeader field="trade_date" sort={sort} onSort={setSort}>
                Date
              </SortableHeader>
              <SortableHeader
                field="type"
                sort={sort}
                onSort={setSort}
                className="hidden md:table-cell"
              >
                Type
              </SortableHeader>
              <SortableHeader field="symbol" sort={sort} onSort={setSort}>
                Symbol
              </SortableHeader>
              <SortableHeader
                field="quantity"
                sort={sort}
                onSort={setSort}
                align="right"
                className="hidden md:table-cell"
              >
                Quantity
              </SortableHeader>
              <SortableHeader field="amount" sort={sort} onSort={setSort} align="right">
                Amount
              </SortableHeader>
            </tr>
          </thead>
          <tbody>
            {rows.map((txn) => (
              <tr
                key={txn.id}
                className="border-b border-edge last:border-0 hover:bg-panel/50 transition-colors"
              >
                <td className="px-4 py-3 font-mono text-xs text-ink-dim">
                  {txn.trade_date}
                </td>
                <td className="hidden md:table-cell px-4 py-3">
                  <span
                    className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                      TYPE_STYLES[txn.type] ?? "bg-raised text-ink-dim"
                    }`}
                  >
                    {txn.type}
                  </span>
                </td>
                <td className="px-4 py-3 font-mono text-ink">
                  <div>
                    {txn.security_id != null && txn.symbol ? (
                      <SymbolLink securityId={txn.security_id} symbol={txn.symbol} />
                    ) : (
                      txn.symbol ?? "\u2014"
                    )}
                  </div>
                  <span
                    className={`md:hidden mt-1 inline-block text-[10px] font-medium px-1.5 py-0.5 rounded ${
                      TYPE_STYLES[txn.type] ?? "bg-raised text-ink-dim"
                    }`}
                  >
                    {txn.type}
                  </span>
                </td>
                <td className="hidden md:table-cell px-4 py-3 text-right font-mono tabular-nums text-ink-dim">
                  <Shares value={txn.quantity} digits={4} />
                </td>
                <td className="px-4 py-3 text-right font-mono tabular-nums text-ink">
                  <Money value={displayCashEffect(txn.type, txn.amount)} precise />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </ScrollFade>
      </div>
    </div>
  );
}
