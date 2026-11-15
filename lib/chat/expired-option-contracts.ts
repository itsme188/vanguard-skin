/**
 * The block the chat option tools return for the expired contracts they leave
 * out (QA: "did any of my options expire yesterday?" could only be answered
 * with a count).
 *
 * Each row is identity only: symbol, underlying, account, dashed expiry and
 * side. No quantity, price, value, cost or gain: an expired contract carries
 * no value or gain on any surface (pending lots rule R1), and its result is
 * unknown until the broker's closing entry is imported. The caller reads its
 * rows through the same predicate as the count it reports, so `total` is
 * that count.
 */

export interface ExpiredOptionContract {
  symbol: string;
  underlying: string | null;
  account: string;
  /** YYYY-MM-DD (a legacy compact stored form already normalized by the reader). */
  expiration: string;
  side: "long" | "short";
}

/** Most recently expired contracts listed; older ones are counted in `total`. */
export const EXPIRED_CONTRACTS_LIST_MAX = 10;

export const EXPIRED_CONTRACTS_NOTE =
  "Each listed contract is past its expiration date: it is no longer counted in holdings, exposure or any total, and carries no value or gain here. Whether it expired worthless, was exercised or was assigned is not known until the broker's closing entry (on the statement) is imported. Most recently expired first; total counts every one, listed or not.";

export interface ExpiredContractsBlock {
  total: number;
  truncated: boolean;
  contracts: ExpiredOptionContract[];
  note: string;
}

/** Sorted most recently expired first (then symbol, then account), capped. */
export function expiredContractsBlock(rows: readonly ExpiredOptionContract[]): ExpiredContractsBlock {
  const sorted = [...rows].sort(
    (a, b) =>
      b.expiration.localeCompare(a.expiration) ||
      a.symbol.localeCompare(b.symbol) ||
      a.account.localeCompare(b.account),
  );
  return {
    total: sorted.length,
    truncated: sorted.length > EXPIRED_CONTRACTS_LIST_MAX,
    contracts: sorted.slice(0, EXPIRED_CONTRACTS_LIST_MAX),
    note: EXPIRED_CONTRACTS_NOTE,
  };
}

/** Side of a signed holdings quantity (latest holdings never carry a zero). */
export function optionSide(quantity: number): "long" | "short" {
  return quantity < 0 ? "short" : "long";
}
