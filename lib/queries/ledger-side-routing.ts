/**
 * LEDGER SIDE ROUTING — the one catalogue of "what role COULD the tax-lot
 * engine give this ledger row, on which side, and is that role certain".
 *
 * It mirrors the routing of `computeTaxLots` (lib/compute/tax-lots.ts)
 * exactly, and `tests/compute/ledger-side-routing-engine-parity.test.ts`
 * pins it to the engine by running the engine over a type x evidence x
 * price matrix. Plan: docs/superpowers/plans/2026-10-26-pending-lots-options-shorts-plan.md
 * §0 item 5 and rulings R2, R11, R13.
 *
 * What the engine does (checked against lib/compute/tax-lots.ts):
 *  - Opening loader (`buys`): BUY, REINVESTMENT, BUY_TO_OPEN, SELL_TO_OPEN,
 *    SHORT_SELL, TRANSFER_IN. Needs a non-null price AND quantity.
 *  - Closing loader (`sells`): SELL, SELL_TO_CLOSE, REDEMPTION, BUY_TO_COVER,
 *    EXPIRED, EXERCISED, ASSIGNED, BUY_TO_CLOSE. Needs a quantity, and a price
 *    unless the type is EXPIRED/EXERCISED/ASSIGNED, or a REDEMPTION carrying
 *    an amount.
 *  - Without direction evidence: the opening loader opens LONG, except
 *    SELL_TO_OPEN / SHORT_SELL which open SHORT; the closing loader closes
 *    LONG, except BUY_TO_CLOSE / BUY_TO_COVER which close SHORT, and
 *    EXPIRED / EXERCISED / ASSIGNED which close EITHER side.
 *  - With IBKR direction evidence (`readIbkrTradeDirection`) on a stock, ETF
 *    or option row, the evidence overrides the type. "Buy-like" is exactly
 *    BUY, BUY_TO_OPEN, BUY_TO_CLOSE, BUY_TO_COVER; every other loaded type
 *    (EXPIRED and TRANSFER_IN included) is "sell-like". Open-only evidence
 *    opens (buy-like long, sell-like short); close-only evidence closes
 *    (buy-like closes short, sell-like closes long; an evidence-tagged
 *    EXPIRED therefore closes LONG only, never either side); mixed evidence
 *    closes the existing side and opens only the residual, or warns and does
 *    nothing when it cannot split. A mixed row's outcome depends on what was
 *    open at replay time, so its certainty is `needs_replay`: only the
 *    engine's output says what it did (R11).
 *  - Anything else (TRANSFER_OUT, DIVIDEND, SPLIT, ...) is read by neither
 *    loader: role "none".
 *
 * Role versus loading: `role` is what the engine WOULD do with the row if it
 * read it; `engineLoads` says whether its loaders read the row at all. An
 * unloadable row (no price on a type that needs one, or no quantity) keeps
 * its role so a consumer can see what it could have done, and never creates
 * or consumes a lot. Every consumer that counts a row as evidence must
 * check BOTH `certainty === "certain"` and `engineLoads`.
 *
 * Pure: imports only the evidence reader. Nothing else re-derives routing.
 */
import { readIbkrTradeDirection } from "@/lib/import/ibkr-trade-direction";
import type { PendingSide } from "@/lib/queries/pending-statement-types";

export type LedgerRole = "open" | "close" | "close_either" | "mixed" | "none";
/** "needs_replay" = mixed evidence: the outcome depends on what was open. */
export type LedgerCertainty = "certain" | "needs_replay";

export interface LedgerRowInput {
  type: string;
  quantity: number | null;
  price_per_share: number | null;
  amount: number | null;
  notes: string | null;
  security_type: string;
}

export interface LedgerRoute {
  role: LedgerRole;
  /** The side of a pure "open" or "close"; null for close_either, mixed and none. */
  side: PendingSide | null;
  /** The side the row would close: set for "close" and "mixed". */
  closeSide: PendingSide | null;
  /** The side the row would open: set for "open" and "mixed" (the residual). */
  openSide: PendingSide | null;
  certainty: LedgerCertainty;
  engineLoads: boolean;
}

/** The engine's opening loader types (lower case). */
export const ENGINE_OPENING_TYPES = [
  "buy",
  "reinvestment",
  "buy_to_open",
  "sell_to_open",
  "short_sell",
  "transfer_in",
] as const;

/** The engine's closing loader types (lower case). */
export const ENGINE_CLOSING_TYPES = [
  "sell",
  "sell_to_close",
  "redemption",
  "buy_to_cover",
  "expired",
  "exercised",
  "assigned",
  "buy_to_close",
] as const;

const OPENING = new Set<string>(ENGINE_OPENING_TYPES);
const CLOSING = new Set<string>(ENGINE_CLOSING_TYPES);
const SHORT_OPENING = new Set(["sell_to_open", "short_sell"]);
const SHORT_CLOSING = new Set(["buy_to_close", "buy_to_cover"]);
const ZERO_PRICE_CLOSES = new Set(["expired", "exercised", "assigned"]);
/** `processTrade`'s isBuy list, verbatim. */
const BUY_LIKE = new Set(["buy", "buy_to_open", "buy_to_close", "buy_to_cover"]);
/** Security types whose rows the engine reads direction evidence on. */
const EVIDENCE_SECURITY_TYPES = new Set(["stock", "etf", "option"]);

function engineLoadsRow(type: string, row: LedgerRowInput): boolean {
  if (row.quantity == null) return false;
  if (OPENING.has(type)) return row.price_per_share != null;
  if (CLOSING.has(type)) {
    return (
      row.price_per_share != null ||
      ZERO_PRICE_CLOSES.has(type) ||
      (type === "redemption" && row.amount != null)
    );
  }
  return false;
}

function route(
  role: LedgerRole,
  side: PendingSide | null,
  closeSide: PendingSide | null,
  openSide: PendingSide | null,
  engineLoads: boolean,
): LedgerRoute {
  return {
    role,
    side,
    closeSide,
    openSide,
    certainty: role === "mixed" ? "needs_replay" : "certain",
    engineLoads,
  };
}

/**
 * The role the engine COULD give this row. For "mixed": closeSide = the side
 * it would close if anything is open, openSide = the side its residual would
 * open. Certainty is separate from role; engineLoads says whether the
 * loaders read it at all.
 */
export function routeLedgerRow(row: LedgerRowInput): LedgerRoute {
  const type = row.type.trim().toLowerCase();
  if (!OPENING.has(type) && !CLOSING.has(type)) return route("none", null, null, null, false);
  const loads = engineLoadsRow(type, row);

  const evidence = EVIDENCE_SECURITY_TYPES.has(row.security_type.trim().toLowerCase())
    ? readIbkrTradeDirection(row.notes)
    : null;
  if (evidence) {
    const buyLike = BUY_LIKE.has(type);
    const opens: PendingSide = buyLike ? "long" : "short";
    const closes: PendingSide = buyLike ? "short" : "long";
    if (!evidence.close) return route("open", opens, null, opens, loads);
    if (!evidence.open) return route("close", closes, closes, null, loads);
    return route("mixed", null, closes, opens, loads);
  }

  if (OPENING.has(type)) {
    const side: PendingSide = SHORT_OPENING.has(type) ? "short" : "long";
    return route("open", side, null, side, loads);
  }
  if (ZERO_PRICE_CLOSES.has(type)) return route("close_either", null, null, null, loads);
  const side: PendingSide = SHORT_CLOSING.has(type) ? "short" : "long";
  return route("close", side, side, null, loads);
}

/** True when the row is a certain, engine-loadable PURE opening on `side`. */
export function isCertainOpeningOn(row: LedgerRowInput, side: PendingSide): boolean {
  const r = routeLedgerRow(row);
  return r.role === "open" && r.side === side && r.certainty === "certain" && r.engineLoads;
}

/**
 * SQL PRESELECT over transactions alias `t` for "could be an engine-loadable
 * opening on this side". A SUPERSET by design: it keeps every plain opening
 * type of the side that carries a price and a quantity, plus every row that
 * carries direction evidence (evidence can turn any loaded type into an
 * opening on either side). The caller must confirm each row in JS with
 * `routeLedgerRow` / `isCertainOpeningOn` (which reads the evidence and the
 * security type); this fragment alone is never the answer.
 */
export function sideOpeningSql(side: PendingSide): string {
  const plain = side === "short"
    ? ENGINE_OPENING_TYPES.filter((t) => SHORT_OPENING.has(t))
    : ENGINE_OPENING_TYPES.filter((t) => !SHORT_OPENING.has(t));
  const list = plain.map((t) => `'${t}'`).join(", ");
  return `(t.security_id IS NOT NULL AND t.quantity IS NOT NULL
    AND ((LOWER(t.type) IN (${list}) AND t.price_per_share IS NOT NULL)
         OR COALESCE(t.notes, '') LIKE '%IBKR trade direction: %'))`;
}
