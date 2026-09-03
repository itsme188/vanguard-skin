/**
 * The RECENT TRANSACTIONS Amount column (security detail) sorts on the RAW
 * stored `amount`, but the cell PRINTS displayCashEffect(t.type, t.amount)
 * (see transactions-section-amount-sign.test.ts). A legacy Vanguard BUY row
 * stores its principal unsigned (positive), so clicking the Amount header
 * ordered that row next to positive SELL/DIVIDEND rows even though it
 * visually reads as the most negative outflow on screen — sort order
 * disagreed with what the column showed. sortSecurityTransactions() fixes
 * this by comparing the DISPLAYED (sign-normalized) amount for the "amount"
 * field, leaving every other field's comparison untouched.
 */

import { describe, it, expect } from "vitest";
import { sortSecurityTransactions } from "@/app/dashboard/components/TransactionsSection";
import type { SecurityDetailTransaction } from "@/lib/queries/security-detail";

function makeRow(
  id: number,
  type: string,
  amount: number,
): SecurityDetailTransaction {
  return {
    id,
    account_id: 1,
    security_id: 1,
    import_batch_id: null,
    trade_date: "2024-05-07",
    settlement_date: null,
    type,
    quantity: 25,
    amount,
    price_per_share: 100,
    fees: 0,
    is_external_flow: 0,
    source_key: `test:${id}`,
    notes: null,
    symbol: "TEST",
    security_name: "Test Co",
    account_name: "Vanguard Taxable",
    security_type: "Stock",
    option_type: null,
    underlying_symbol: null,
    strike_price: null,
    expiration_date: null,
  };
}

describe("sortSecurityTransactions", () => {
  // Legacy Vanguard BUY (stored positive/unsigned) — reads NEGATIVE on screen.
  const legacyBuy = makeRow(1, "BUY", 4595);
  // IBKR-sourced BUY (already stored negative) — reads NEGATIVE on screen.
  const ibkrBuy = makeRow(2, "BUY", -9129);
  // SELL (stored positive) — reads POSITIVE on screen.
  const sell = makeRow(3, "SELL", 1500);

  it("sorts ascending by the DISPLAYED (sign-normalized) amount, not the raw stored value", () => {
    const rows = [ibkrBuy, legacyBuy, sell];
    const sorted = sortSecurityTransactions(rows, "amount", "asc");

    // Displayed values: ibkrBuy -> -9129, legacyBuy -> -4595, sell -> 1500.
    expect(sorted.map((r) => r.id)).toEqual([2, 1, 3]);
  });

  it("does NOT reproduce the pre-fix raw-amount sort order", () => {
    const rows = [ibkrBuy, legacyBuy, sell];
    const sorted = sortSecurityTransactions(rows, "amount", "asc");

    // Raw stored values ascending: ibkrBuy(-9129), sell(1500), legacyBuy(4595)
    // -> id order [2, 3, 1]. The fix must NOT produce this order.
    expect(sorted.map((r) => r.id)).not.toEqual([2, 3, 1]);
  });

  it("sorts descending by displayed amount too", () => {
    const rows = [ibkrBuy, legacyBuy, sell];
    const sorted = sortSecurityTransactions(rows, "amount", "desc");
    expect(sorted.map((r) => r.id)).toEqual([3, 1, 2]);
  });

  it("leaves non-amount fields sorting on the raw column value", () => {
    const rows = [ibkrBuy, legacyBuy, sell];
    const sorted = sortSecurityTransactions(rows, "quantity", "asc");
    // All quantities equal (25) -> stable order preserved (no reordering).
    expect(sorted.map((r) => r.id)).toEqual([2, 1, 3]);
  });

  it("returns the rows unchanged (same order) when field is null", () => {
    const rows = [ibkrBuy, legacyBuy, sell];
    const sorted = sortSecurityTransactions(rows, null, "asc");
    expect(sorted.map((r) => r.id)).toEqual([2, 1, 3]);
  });
});
