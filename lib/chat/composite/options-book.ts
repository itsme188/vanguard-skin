/**
 * query_options_book: option contracts expiring soon from `getExpiringOptions`
 * (the engine behind the Expirations card, `app/api/compute/options-expirations/route.ts`:
 * `{ accountIds, daysWindow }` plus the Eastern `today`; the chat's default
 * window is 30 days, the card's 90), and the
 * book's delta-adjusted exposure from `getPortfolioExposureSummary(db,
 * accountIds, today)` (as the Analysis page calls it). Both read live
 * contracts only; expired contracts are left out of both and named in
 * `excluded.expired_contracts` (identity only, never valued).
 */
import type Database from "better-sqlite3";
import { getExpiringOptions } from "@/lib/compute/options-expirations";
import { getPortfolioExposureSummary } from "@/lib/compute/exposure";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { accountScopeAndSql } from "@/lib/queries/account-scope-sql";
import { liveOptionExpirationSql, normalizeOptionExpiration } from "@/lib/compute/option-expiry";
import {
  expiredContractsBlock,
  optionSide,
  type ExpiredOptionContract,
} from "@/lib/chat/expired-option-contracts";
import {
  ACCOUNT_NAME_FIELD,
  NO_ACCOUNT_IN_SCOPE,
  readCount,
  scopeBlock,
  takeList,
  type CompositeContext,
  type CompositeTool,
} from "./shared";

export const QUERY_OPTIONS_BOOK_NAME = "query_options_book";

const DAYS_DEFAULT = 30;
const DAYS_MAX = 120;
const ROWS_DEFAULT = 20;
const ROWS_MAX = 25;

const definition: CompositeTool["definition"] = {
  name: QUERY_OPTIONS_BOOK_NAME,
  description:
    `Option contracts expiring within a window (default the next ${DAYS_DEFAULT} days, at most ${DAYS_MAX}; the Expirations card's own default is 90): per contract the symbol, underlying, call or put, strike, expiration, days to expiry, signed quantity (negative = short, the side that can be assigned) and account, soonest first; plus the scope's delta-adjusted exposure (net and gross, in USD and as a ratio of market value, stocks and options together). Live contracts only: options past expiration are left out of contracts and exposure; excluded.expired_contracts names them (symbol, underlying, account, expiration, long or short side; most recently expired first, at most 10, total counts all) with no value, because each awaits the broker's closing entry (expired worthless, exercised or assigned is not known yet). Use it for 'did any option expire', 'what happened to my expired options'. Moneyness and greeks are not in this engine: use query_options_greeks for delta, gamma, theta, vega and whether a contract is in the money. Use for 'what expires in the next N days', 'which short options could be assigned'. Do NOT use for option P&L or tax lots (use query_tax_lots) or for every holding (use query_holdings).`,
  input_schema: {
    type: "object" as const,
    properties: {
      account_name: ACCOUNT_NAME_FIELD,
      days: {
        type: "integer",
        description: `Expiry window in calendar days from today (Eastern), inclusive: a whole number from 1 to ${DAYS_MAX}, default ${DAYS_DEFAULT}. Anything else is an error.`,
      },
      limit: {
        type: "integer",
        description: `Maximum contracts to list: an integer, default ${ROWS_DEFAULT}, max ${ROWS_MAX}. list_info says whether more matched.`,
      },
    },
  },
};

/**
 * Option rows in scope (latest row per account and security) whose expiration
 * has passed: identity only (no quantity, price or value), expiry dashed.
 */
function readExpiredOptionRows(
  db: Database.Database,
  accountIds: number[] | undefined,
  today: string,
): ExpiredOptionContract[] {
  const scope = accountScopeAndSql(accountIds, "h.account_id");
  const rows = db
    .prepare(
      `SELECT s.symbol, s.underlying_symbol, s.expiration_date, h.quantity, a.name AS account_name
       FROM holdings h
       JOIN securities s ON s.id = h.security_id
       JOIN accounts a ON a.id = h.account_id
       WHERE LOWER(s.security_type) = 'option'
         AND s.expiration_date IS NOT NULL
         AND NOT ${liveOptionExpirationSql("s", today)}
         AND ${latestHoldingsPredicate({ accountFilter: scope.sql })}`,
    )
    .all(...scope.params) as {
    symbol: string;
    underlying_symbol: string | null;
    expiration_date: string;
    quantity: number;
    account_name: string;
  }[];
  return rows.map((r) => ({
    symbol: r.symbol,
    underlying: r.underlying_symbol,
    account: r.account_name,
    expiration: normalizeOptionExpiration(r.expiration_date),
    side: optionSide(r.quantity),
  }));
}

function run(db: Database.Database, input: Record<string, unknown>, ctx: CompositeContext): unknown {
  const accountIds = ctx.accountIds;
  if (accountIds !== undefined && accountIds.length === 0) return NO_ACCOUNT_IN_SCOPE;
  const rawDays = input.days;
  if (rawDays !== undefined && rawDays !== null && !(typeof rawDays === "number" && Number.isInteger(rawDays) && rawDays >= 1 && rawDays <= DAYS_MAX)) {
    return { error: `days must be a whole number of days from 1 to ${DAYS_MAX} (default ${DAYS_DEFAULT}).` };
  }
  const daysWindow = typeof rawDays === "number" ? rawDays : DAYS_DEFAULT;
  const limit = readCount(input.limit, ROWS_DEFAULT, ROWS_MAX);
  const today = ctx.today;

  const expiring = getExpiringOptions(db, { accountIds, daysWindow, today });
  const exposure = getPortfolioExposureSummary(db, accountIds, today);
  const listed = takeList(expiring, limit, ROWS_MAX);
  const expired = expiredContractsBlock(readExpiredOptionRows(db, accountIds, today));

  return {
    as_of: today,
    scope: scopeBlock(db, accountIds),
    window: { from: today, days: daysWindow },
    contracts: listed.rows.map((o) => ({
      symbol: o.symbol,
      underlying: o.underlying,
      type: o.optionType,
      strike: o.strike,
      expiration: o.expiration,
      days_to_expiry: o.daysToExpiry,
      quantity: o.quantity,
      account: o.accountName,
    })),
    list_info: listed.info,
    totals_in_window: {
      positions: expiring.length,
      short_positions: expiring.filter((o) => o.quantity < 0).length,
      long_positions: expiring.filter((o) => o.quantity > 0).length,
    },
    moneyness: "Not in this engine: see query_options_greeks.",
    exposure: {
      total_market_value_usd: exposure.total_market_value,
      net_exposure_usd: exposure.net_exposure,
      gross_exposure_usd: exposure.gross_exposure,
      net_ratio: exposure.net_ratio,
      gross_ratio: exposure.gross_ratio,
      note: "Whole scope, stocks and funds at signed market value, options at delta x underlying price x multiplier x contracts (an option with no greeks takes +/-2.5 x its market value). A ratio is null when market value is zero.",
    },
    excluded: {
      expired_option_positions: expired.total,
      expired_contracts: expired,
      note: "Options past their expiration are not live: they are not in contracts, totals_in_window or exposure. expired_contracts names them (symbol, account, expiration, side) without any value.",
    },
    units: {
      strike: "price per share of the underlying, in the underlying's own currency",
      quantity: "contracts, signed (negative = short)",
      days_to_expiry: "calendar days from as_of",
      exposure_usd: "USD",
      ratios: "exposure / total market value (1.0 = fully invested, unlevered)",
    },
    currency: "USD",
  };
}

export const queryOptionsBookTool: CompositeTool = { definition, run, acceptsScopeList: true };
