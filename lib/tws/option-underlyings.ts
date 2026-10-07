/**
 * The underlyings of held, live options: the one definition the sync uses to
 * decide which NON-held securities it also resolves a contract id for and
 * prices (owner ruling 2026-10-07).
 *
 * A held option whose underlying is not itself held had no price for that
 * underlying, because the price snapshot priced holdings only; scenario
 * repricing then listed the option as "no price for the underlying".
 *
 *   - Held: the option's latest row per (account, security) is non-zero,
 *     shorts included (`latestHoldingsPredicate`).
 *   - Live: `liveOptionExpirationSql` on the run's ET date, never a
 *     hand-compared expiration string.
 *   - Underlying: the securities row whose symbol equals the option row's
 *     `underlying_symbol`, the same exact-symbol join the scenario engines
 *     use to read the underlying's price (`OPTION_PRICING_JOINS_SQL`), so a
 *     price written here is the price they find. No issuer-family widening:
 *     that join has none.
 *
 * These rows are only resolved and priced. Nothing here writes a holdings
 * row, and no caller may treat the result as a position.
 */

import type Database from "better-sqlite3";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { liveOptionExpirationSql } from "@/lib/compute/option-expiry";
import { OPTION_ROW_SQL } from "@/lib/compute/option-elasticity";

export interface OptionUnderlyingRow {
  id: number;
  symbol: string;
  security_type: string | null;
  name: string | null;
  ib_con_id: number | null;
  currency: string | null;
}

/**
 * Distinct underlying securities of held live options, by id. `today` is the
 * run's ET date (validated by `liveOptionExpirationSql`). Rows the broker
 * cannot be asked about by symbol are left out, with the same exclusions the
 * enrichment step applies to held rows: CUSIP-prefixed symbols, symbols with
 * a space, cash and money-market rows, and option rows.
 */
export function getLiveHeldOptionUnderlyings(db: Database.Database, today: string): OptionUnderlyingRow[] {
  return db
    .prepare(
      `SELECT DISTINCT u.id, u.symbol, u.security_type, u.name, u.ib_con_id, u.currency
         FROM holdings h
         JOIN securities s ON s.id = h.security_id
         JOIN securities u ON u.symbol = s.underlying_symbol
        WHERE ${latestHoldingsPredicate({})}
          AND ${OPTION_ROW_SQL}
          AND ${liveOptionExpirationSql("s", today)}
          AND u.id != s.id
          AND u.symbol NOT LIKE 'CUSIP:%'
          AND u.symbol NOT LIKE '% %'
          AND LOWER(TRIM(COALESCE(u.security_type, ''))) NOT IN ('cash', 'money_market', 'money market', 'option', 'call', 'put')
        ORDER BY u.id`,
    )
    .all() as OptionUnderlyingRow[];
}

/** How many of those underlyings still have no broker contract id. */
export function countUnenrichedLiveOptionUnderlyings(db: Database.Database, today: string): number {
  return getLiveHeldOptionUnderlyings(db, today).filter((u) => u.ib_con_id == null).length;
}
