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

/**
 * Failed contract lookups for option underlyings, so a symbol the broker can
 * never resolve as one contract (an index, an ambiguous ticker) is not asked
 * for again on every full sync. One JSON value in the `settings` table:
 * `{ "<security id>": { "failures": n, "lastTried": "YYYY-MM-DD" } }`.
 * A success removes the entry. To retry a skipped symbol by hand, delete its
 * entry (or the whole key).
 */
export const UNDERLYING_LOOKUP_FAILURES_KEY = "tws_option_underlying_lookup_failures";
/** After this many failed lookups an underlying is no longer requested. */
export const MAX_UNDERLYING_LOOKUP_FAILURES = 3;

type FailureLedger = Record<string, { failures: number; lastTried: string }>;

function readFailureLedger(db: Database.Database): FailureLedger {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(UNDERLYING_LOOKUP_FAILURES_KEY) as
    | { value: string }
    | undefined;
  if (!row) return {};
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const ledger: FailureLedger = {};
    for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
      const e = entry as { failures?: unknown; lastTried?: unknown } | null;
      if (e && typeof e.failures === "number" && Number.isFinite(e.failures) && e.failures > 0) {
        ledger[id] = { failures: Math.floor(e.failures), lastTried: typeof e.lastTried === "string" ? e.lastTried : "" };
      }
    }
    return ledger;
  } catch {
    // An unreadable value is treated as "no failures recorded": the cost is a
    // few extra lookups, never a skipped symbol.
    return {};
  }
}

function writeFailureLedger(db: Database.Database, ledger: FailureLedger): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(UNDERLYING_LOOKUP_FAILURES_KEY, JSON.stringify(ledger));
}

/** Failed lookups recorded for one underlying (0 when none). */
export function getUnderlyingLookupFailures(db: Database.Database, securityId: number): number {
  return readFailureLedger(db)[String(securityId)]?.failures ?? 0;
}

/** Count one failed lookup. Returns the new count. */
export function recordUnderlyingLookupFailure(db: Database.Database, securityId: number, today: string): number {
  const ledger = readFailureLedger(db);
  const failures = (ledger[String(securityId)]?.failures ?? 0) + 1;
  ledger[String(securityId)] = { failures, lastTried: today };
  writeFailureLedger(db, ledger);
  return failures;
}

/** A successful lookup clears the count. */
export function clearUnderlyingLookupFailures(db: Database.Database, securityId: number): void {
  const ledger = readFailureLedger(db);
  if (!(String(securityId) in ledger)) return;
  delete ledger[String(securityId)];
  writeFailureLedger(db, ledger);
}

/**
 * The underlyings the enrichment step should look up now: no contract id yet
 * and fewer than MAX_UNDERLYING_LOOKUP_FAILURES failed lookups. Logs one line
 * per symbol left out for repeated failures.
 */
export function getPendingOptionUnderlyings(db: Database.Database, today: string): OptionUnderlyingRow[] {
  const ledger = readFailureLedger(db);
  const pending: OptionUnderlyingRow[] = [];
  for (const u of getLiveHeldOptionUnderlyings(db, today)) {
    if (u.ib_con_id != null) continue;
    const failures = ledger[String(u.id)]?.failures ?? 0;
    if (failures >= MAX_UNDERLYING_LOOKUP_FAILURES) {
      console.log(
        `[option-underlyings] Skipping contract lookup for ${u.symbol}: ${failures} failed lookups ` +
          `(clear "${UNDERLYING_LOOKUP_FAILURES_KEY}" in settings to retry)`,
      );
      continue;
    }
    pending.push(u);
  }
  return pending;
}
