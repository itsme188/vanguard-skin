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
 * Failed contract lookups for option underlyings, so a symbol the broker
 * cannot resolve as one contract (an index, an ambiguous ticker) is not asked
 * for again on every full sync. One JSON value in the `settings` table:
 * `{ "<security id>": { "failures": n, "lastTried": "YYYY-MM-DD" } }`.
 *
 * Rules (controller ruling 2026-10-07):
 *   - Only a DEFINITIVE broker answer counts: zero matches, or more than one.
 *     A thrown error, a timeout, a rate-limit wait or a disconnected client
 *     neither adds to the count nor clears it.
 *   - At MAX_UNDERLYING_LOOKUP_FAILURES the symbol is skipped, but not for
 *     good: once UNDERLYING_LOOKUP_RETRY_AFTER_DAYS have passed since its
 *     last try it is tried once more. Another definitive failure moves the
 *     last-tried date and it waits again; a success removes the entry.
 *   - An entry whose security is no longer the underlying of any held live
 *     option is pruned, so the map cannot grow without bound.
 */
export const UNDERLYING_LOOKUP_FAILURES_KEY = "tws_option_underlying_lookup_failures";
/** After this many definitive failed lookups an underlying is skipped. */
export const MAX_UNDERLYING_LOOKUP_FAILURES = 3;
/**
 * A skipped underlying is tried again once this many days have passed since
 * its last try: listings change (a new ticker gets listed, an ambiguity
 * clears), and one extra lookup a month costs nothing.
 */
export const UNDERLYING_LOOKUP_RETRY_AFTER_DAYS = 30;

interface FailureEntry {
  failures: number;
  lastTried: string;
}
type FailureLedger = Record<string, FailureEntry>;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function dayNumber(date: string): number | null {
  const m = ISO_DATE.exec(date);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : null;
}

function isoFromDayNumber(n: number): string {
  return new Date(n * 86_400_000).toISOString().slice(0, 10);
}

/** The first date a skipped entry is tried again; null when its last-tried date is unreadable. */
function retryDate(entry: FailureEntry): string | null {
  const last = dayNumber(entry.lastTried);
  return last == null ? null : isoFromDayNumber(last + UNDERLYING_LOOKUP_RETRY_AFTER_DAYS);
}

export type UnderlyingLookupState =
  /** Under the failure cap: looked up as usual. */
  | "eligible"
  /** At the cap and inside the cool-off: not looked up. */
  | "skipped"
  /** At the cap and past the cool-off: looked up once more. */
  | "retry-due";

function stateOf(entry: FailureEntry | undefined, today: string): UnderlyingLookupState {
  if (!entry || entry.failures < MAX_UNDERLYING_LOOKUP_FAILURES) return "eligible";
  const last = dayNumber(entry.lastTried);
  const now = dayNumber(today);
  // An unreadable date, or a last-tried date in the future (a clock that was
  // wrong once), can never justify a skip.
  if (last == null || now == null || last > now) return "retry-due";
  return now - last >= UNDERLYING_LOOKUP_RETRY_AFTER_DAYS ? "retry-due" : "skipped";
}

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

/** Definitive failed lookups recorded for one underlying (0 when none). */
export function getUnderlyingLookupFailures(db: Database.Database, securityId: number): number {
  return readFailureLedger(db)[String(securityId)]?.failures ?? 0;
}

/** Whether an underlying is looked up as usual, skipped, or due its one retry. */
export function getUnderlyingLookupState(db: Database.Database, securityId: number, today: string): UnderlyingLookupState {
  return stateOf(readFailureLedger(db)[String(securityId)], today);
}

/**
 * Count one DEFINITIVE failed lookup (zero matches, or more than one) and
 * stamp the try date. Never call this for a thrown error. Logs one line when
 * the symbol is now skipped, with the date it will be tried again. Returns
 * the new count.
 */
export function recordUnderlyingLookupFailure(
  db: Database.Database,
  securityId: number,
  today: string,
  symbol?: string,
): number {
  const ledger = readFailureLedger(db);
  const entry: FailureEntry = { failures: (ledger[String(securityId)]?.failures ?? 0) + 1, lastTried: today };
  ledger[String(securityId)] = entry;
  writeFailureLedger(db, ledger);
  if (entry.failures >= MAX_UNDERLYING_LOOKUP_FAILURES) {
    console.log(
      `[option-underlyings] Skipping contract lookup for ${symbol ?? `security ${securityId}`}: ` +
        `${entry.failures} failed lookups; next try on or after ${retryDate(entry) ?? "the next full sync"}`,
    );
  }
  return entry.failures;
}

/** A successful lookup removes the entry. Logs one line when there was one. */
export function clearUnderlyingLookupFailures(db: Database.Database, securityId: number, symbol?: string): void {
  const ledger = readFailureLedger(db);
  const entry = ledger[String(securityId)];
  if (!entry) return;
  delete ledger[String(securityId)];
  writeFailureLedger(db, ledger);
  console.log(
    `[option-underlyings] Contract lookup for ${symbol ?? `security ${securityId}`} succeeded; ` +
      `cleared ${entry.failures} recorded failure(s)`,
  );
}

/**
 * The underlyings the enrichment step should look up now: no contract id yet
 * and either under the failure cap or due their one retry after the cool-off.
 *
 * Also prunes the failure record: an entry whose security is no longer the
 * underlying of any held live option is dropped. This is the one place that
 * sees the full live set on every full sync, so the pruning lives here; it
 * writes only when something is actually dropped.
 */
export function getPendingOptionUnderlyings(db: Database.Database, today: string): OptionUnderlyingRow[] {
  const live = getLiveHeldOptionUnderlyings(db, today);
  const ledger = readFailureLedger(db);

  const liveIds = new Set(live.map((u) => String(u.id)));
  const stale = Object.keys(ledger).filter((id) => !liveIds.has(id));
  if (stale.length > 0) {
    for (const id of stale) delete ledger[id];
    writeFailureLedger(db, ledger);
  }

  return live.filter((u) => u.ib_con_id == null && stateOf(ledger[String(u.id)], today) !== "skipped");
}
