/**
 * How old are the positions the Analysis tab counts as held? (2026-11-23)
 *
 * The Analysis readers count, per (account, security), the latest non-zero
 * holdings row (`latestHoldingsPredicate`). When a broker sync stops
 * reporting a position and the closed-position reconciler declines to write
 * its zero-quantity tombstone (the 50% shrink guard in
 * lib/mutations/closed-equity.ts), the position's row from an EARLIER sync
 * still reads as latest. A plain "last synced" time would say "today" and
 * hide that, so this reader reports the oldest counted live date and lists
 * those leftover rows by name. Owner ruling 2026-11-23: the guard stays; the
 * page says when the data it uses is from.
 *
 * Rows considered are exactly the rows the Analysis readers treat as held:
 * latest per (account, security), quantity != 0 (shorts included), live
 * options only, unmatured securities.
 *
 * Provenance comes from lib/db/holding-sources.ts (the one list of
 * source_key prefixes): statement rows (imported statements) are expected
 * for bonds and money-market funds on a Plaid-fed account, because Plaid
 * omits them; they are reported apart and are never "leftovers".
 *
 * Read-only.
 */
import type Database from "better-sqlite3";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { accountScopeAndSql } from "@/lib/queries/account-scope-sql";
import { liveOptionExpirationSql } from "@/lib/compute/option-expiry";
import { unmaturedSecuritySql } from "@/lib/db/eastern-day-sql";
import {
  classifyHoldingSourceKey,
  isPlaidSourcedHolding,
  isTwsSourcedHolding,
} from "@/lib/db/holding-sources";
import { holdingAgeDays } from "@/lib/queries/data-confidence";

export type PositionsFreshnessLevel = "good" | "warn" | "bad";

export interface PositionsFreshnessItem {
  symbol: string;
  asOfDate: string;
}

export interface AccountPositionsFreshness {
  accountId: number;
  accountName: string;
  /** Newest date among this account's counted live rows; null when it has none. */
  newestLiveDate: string | null;
  liveRowCount: number;
  /** Counted live rows dated BEFORE newestLiveDate: not in the latest sync,
   *  still counted as held. */
  leftover: {
    count: number;
    oldestDate: string | null;
    symbols: string[];
    items: PositionsFreshnessItem[];
  };
  /** Counted rows that come from an imported statement. */
  statementRows: {
    count: number;
    oldestDate: string | null;
    newestDate: string | null;
    symbols: string[];
    items: PositionsFreshnessItem[];
  };
  /** Short label for the newest live rows' writer: "broker sync" (TWS or the
   *  IBKR Web API, both stamp `tws-`), "Plaid", or "live sync" for any other
   *  live key. null when the account has no live rows. */
  liveSource: "broker sync" | "Plaid" | "live sync" | null;
  level: PositionsFreshnessLevel;
}

export interface PositionsFreshness {
  /** Accounts in scope that have at least one counted row, by account id. */
  accounts: AccountPositionsFreshness[];
  /** Newest date among all counted rows (live or statement). */
  newestDate: string | null;
  /** Oldest date among all counted LIVE rows. */
  oldestCountedLiveDate: string | null;
  leftoverCount: number;
  statementRowCount: number;
  /** bad: any leftover. warn: an account's newest live date is more than one
   *  trading day old (`holdingAgeDays` > 1), or the scope has statement rows
   *  and no live rows at all. Else good. */
  level: PositionsFreshnessLevel;
}

interface Row {
  account_id: number;
  account_name: string;
  symbol: string;
  as_of_date: string;
  source_key: string | null;
}

function liveSourceLabel(keys: (string | null)[]): AccountPositionsFreshness["liveSource"] {
  if (keys.length === 0) return null;
  if (keys.some((k) => isTwsSourcedHolding(k))) return "broker sync";
  if (keys.some((k) => isPlaidSourcedHolding(k))) return "Plaid";
  return "live sync";
}

const minDate = (dates: string[]): string | null =>
  dates.length === 0 ? null : dates.reduce((a, b) => (b < a ? b : a));
const maxDate = (dates: string[]): string | null =>
  dates.length === 0 ? null : dates.reduce((a, b) => (b > a ? b : a));

const byDateThenSymbol = (a: PositionsFreshnessItem, b: PositionsFreshnessItem) =>
  a.asOfDate === b.asOfDate ? a.symbol.localeCompare(b.symbol) : a.asOfDate < b.asOfDate ? -1 : 1;

export function getPositionsFreshness(
  db: Database.Database,
  accountIds: number[] | undefined,
  today: string,
): PositionsFreshness {
  // `undefined` is every account; a defined empty list is NO accounts.
  const { sql: accountFilter, params } = accountScopeAndSql(accountIds);

  const rows = db
    .prepare(
      `SELECT h.account_id, a.name AS account_name, s.symbol, h.as_of_date, h.source_key
       FROM holdings h
       JOIN securities s ON s.id = h.security_id
       JOIN accounts a ON a.id = h.account_id
       WHERE ${latestHoldingsPredicate({ includeShorts: true, accountFilter })}
         AND ${liveOptionExpirationSql("s", today)}
         AND ${unmaturedSecuritySql("s", today)}
       ORDER BY h.account_id, s.symbol`,
    )
    .all(...params) as Row[];

  const byAccount = new Map<number, Row[]>();
  for (const r of rows) {
    const list = byAccount.get(r.account_id) ?? [];
    list.push(r);
    byAccount.set(r.account_id, list);
  }

  const accounts: AccountPositionsFreshness[] = [];
  for (const [accountId, list] of byAccount) {
    const live = list.filter((r) => classifyHoldingSourceKey(r.source_key) === "live");
    const stmt = list.filter((r) => classifyHoldingSourceKey(r.source_key) === "statement");
    const newestLiveDate = maxDate(live.map((r) => r.as_of_date));

    const leftoverItems = live
      .filter((r) => newestLiveDate !== null && r.as_of_date < newestLiveDate)
      .map((r) => ({ symbol: r.symbol, asOfDate: r.as_of_date }))
      .sort(byDateThenSymbol);
    const statementItems = stmt
      .map((r) => ({ symbol: r.symbol, asOfDate: r.as_of_date }))
      .sort(byDateThenSymbol);

    const newestLiveRows = live.filter((r) => r.as_of_date === newestLiveDate);

    let level: PositionsFreshnessLevel = "good";
    if (leftoverItems.length > 0) level = "bad";
    else if (newestLiveDate !== null && holdingAgeDays(newestLiveDate, today) > 1) level = "warn";

    accounts.push({
      accountId,
      accountName: list[0].account_name,
      newestLiveDate,
      liveRowCount: live.length,
      leftover: {
        count: leftoverItems.length,
        oldestDate: minDate(leftoverItems.map((i) => i.asOfDate)),
        symbols: leftoverItems.map((i) => i.symbol),
        items: leftoverItems,
      },
      statementRows: {
        count: statementItems.length,
        oldestDate: minDate(statementItems.map((i) => i.asOfDate)),
        newestDate: maxDate(statementItems.map((i) => i.asOfDate)),
        symbols: statementItems.map((i) => i.symbol),
        items: statementItems,
      },
      liveSource: liveSourceLabel(newestLiveRows.map((r) => r.source_key)),
      level,
    });
  }
  accounts.sort((a, b) => a.accountId - b.accountId);

  const leftoverCount = accounts.reduce((n, a) => n + a.leftover.count, 0);
  const statementRowCount = accounts.reduce((n, a) => n + a.statementRows.count, 0);
  const liveRowCount = accounts.reduce((n, a) => n + a.liveRowCount, 0);
  const liveDates = rows
    .filter((r) => classifyHoldingSourceKey(r.source_key) === "live")
    .map((r) => r.as_of_date);

  let level: PositionsFreshnessLevel = "good";
  if (leftoverCount > 0) level = "bad";
  else if (accounts.some((a) => a.level === "warn")) level = "warn";
  else if (liveRowCount === 0 && statementRowCount > 0) level = "warn";

  return {
    accounts,
    newestDate: maxDate(rows.map((r) => r.as_of_date)),
    oldestCountedLiveDate: minDate(liveDates),
    leftoverCount,
    statementRowCount,
    level,
  };
}
