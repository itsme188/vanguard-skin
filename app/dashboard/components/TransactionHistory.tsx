"use client";

import { useMemo } from "react";
import type {
  TransactionSort,
  TransactionSortField,
  TransactionWithSecurity,
} from "@/lib/queries/transactions";
import { SymbolLink } from "@/app/dashboard/components/SymbolLink";
import { Count, Money, Shares } from "@/lib/privacy/components";
import { displayCashEffect } from "@/lib/format/cash-effect";
import { transactionTypeLabel } from "@/lib/chart/marker-label";
import { ScrollFade } from "./ScrollFade";
import { SortableHeader } from "./SortableHeader";
import {
  compareValues,
  useSortParam,
  type SortDir,
} from "@/lib/hooks/useSortParam";

// Chip text is 10-12px, so it needs 4.5:1. In the light theme the plain
// status colour on its own 20% tint measures 3.8:1 (up / down) and 4.2:1
// (gold-ink), so the light text is the same hue mixed 20% toward black
// (5.2:1 or better). The dark theme keeps the plain token, which already
// passes there. tests/dashboard/transaction-history-chip-contrast.test.ts
// computes the light ratios from the tokens in globals.css.
const UP_CHIP =
  "bg-up/20 text-[color:color-mix(in_srgb,var(--up)_80%,black)] [[data-theme=dark]_&]:text-up";
const DOWN_CHIP =
  "bg-down/20 text-[color:color-mix(in_srgb,var(--down)_80%,black)] [[data-theme=dark]_&]:text-down";
const GOLD_CHIP =
  "bg-gold/20 text-[color:color-mix(in_srgb,var(--gold-ink)_80%,black)] [[data-theme=dark]_&]:text-gold-ink";
const BLUE_CHIP = "bg-blue/20 text-blue";

// Option legs take the colour of the equity leg with the same cash
// direction (decision 2026-10-07): a buy pays cash out like BUY, a sell
// takes cash in like SELL, whether it opens or closes. Expired and
// Reinvestment stay neutral.
const TYPE_STYLES: Record<string, string> = {
  BUY: UP_CHIP,
  SELL: DOWN_CHIP,
  BUY_TO_OPEN: UP_CHIP,
  BUY_TO_CLOSE: UP_CHIP,
  SELL_TO_OPEN: DOWN_CHIP,
  SELL_TO_CLOSE: DOWN_CHIP,
  DIVIDEND: GOLD_CHIP,
  INTEREST: BLUE_CHIP,
  FEE: DOWN_CHIP,
  COMMISSION: DOWN_CHIP,
  TRANSFER: BLUE_CHIP,
  TRANSFER_IN: BLUE_CHIP,
  TRANSFER_OUT: GOLD_CHIP,
  DEPOSIT: UP_CHIP,
  WITHDRAWAL: DOWN_CHIP,
};

/** The Type chip's colour classes; a type with no colour of its own is neutral. */
export function transactionTypeChipClass(type: string): string {
  return TYPE_STYLES[type] ?? "bg-raised text-ink-dim";
}

type Field = TransactionSortField;

/**
 * Browser-side sort of the rows already loaded. The Amount column prints
 * displayCashEffect(type, amount), so it sorts on that printed figure (the
 * server sort in lib/queries/transactions.ts orders by the same value).
 */
export function sortLoadedTransactions(
  rows: TransactionWithSecurity[],
  field: Field | null,
  dir: SortDir,
): TransactionWithSecurity[] {
  if (!field) return rows;
  const valueOf = (t: TransactionWithSecurity): unknown =>
    field === "amount" ? displayCashEffect(t.type, t.amount) : t[field];
  return [...rows].sort((a, b) => compareValues(valueOf(a), valueOf(b), dir));
}

/**
 * What the list can honestly say about its own cap.
 *  - "none": every row is on screen (or the total is unknown).
 *  - "full-history": capped, but the rows arrived already sorted by the
 *    column the header shows, so the top row answers for the whole account.
 *  - "loaded-only": capped, and the sort on screen only re-orders the rows
 *    that were loaded.
 */
export function transactionCapState(
  shown: number,
  total: number | null | undefined,
  serverSort: TransactionSort | null | undefined,
  urlSort: { field: Field | null; dir: SortDir },
): "none" | "full-history" | "loaded-only" {
  if (total == null || !Number.isFinite(total) || total <= shown) return "none";
  const matches =
    serverSort != null &&
    serverSort.field === urlSort.field &&
    serverSort.dir === urlSort.dir;
  return matches ? "full-history" : "loaded-only";
}

export function TransactionHistory({
  transactions,
  total,
  serverSort,
}: {
  transactions: TransactionWithSecurity[];
  /** Every transaction the account has (getTransactionCount), so the cap
   *  can be stated. Omitted: no caption. */
  total?: number;
  /** The sort the server fetched `transactions` in, applied before the cap. */
  serverSort?: TransactionSort;
}) {
  const { sort, setSort } = useSortParam<Field>("txns", "trade_date", "desc");

  const capState = transactionCapState(
    transactions.length,
    total,
    serverSort,
    sort,
  );
  const serverSorted =
    serverSort != null &&
    serverSort.field === sort.field &&
    serverSort.dir === sort.dir;

  // Rows the server already sorted over the full history render as they
  // came. Otherwise (the header was just clicked and the new rows are still
  // on their way) sort what is loaded.
  const rows = useMemo(
    () =>
      serverSorted
        ? transactions
        : sortLoadedTransactions(transactions, sort.field, sort.dir),
    [transactions, sort, serverSorted],
  );

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
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm font-medium text-ink-dim">
          Recent Transactions
        </h3>
        {capState !== "none" && (
          <p className="text-xs text-ink-faint">
            Showing <Count value={transactions.length} /> of{" "}
            <Count value={total} />.{" "}
            {capState === "full-history"
              ? "Sorting a column sorts the full history, then shows the top rows."
              : "The sort covers only the rows shown."}
          </p>
        )}
      </div>
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
                      transactionTypeChipClass(txn.type)
                    }`}
                  >
                    {transactionTypeLabel(txn.type)}
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
                      transactionTypeChipClass(txn.type)
                    }`}
                  >
                    {transactionTypeLabel(txn.type)}
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
