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
 * Plaid-fed accounts (plan v4 for Plaid session dating, 2026-11-26): a
 * Plaid read before the open on day D describes the close of the previous
 * trading session. Such an account is judged against
 * `expectedPlaidSession(now)`, the newest session a healthy morning read
 * should have stored, and warns only when its newest COVERED session is
 * older. A session is covered by a Plaid book (a Plaid snapshot or `plaid:`
 * holdings rows) or by a statement holdings book on that date: the refresh
 * skips a session a statement already covers, on purpose, so the statement
 * counts as fresh. The same reader also gathers the facts for the trust
 * strip's Plaid lines (old dating, transition hold, repeat read); their
 * words live in lib/ui/positions-freshness-label.ts.
 *
 * Read-only. A damaged Plaid dating setting never throws from here: it is
 * reported as `datingState: "unreadable"`.
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
  statementSourcedHoldingSql,
} from "@/lib/db/holding-sources";
import { holdingAgeDays } from "@/lib/queries/data-confidence";
import {
  earliestFirstSession,
  expectedPlaidSession,
  getDatingBoundary,
  getDatingState,
  getPlaidRepeatReads,
  hasLegacyRowsAfter,
  type DatingState,
  type PlaidRepeatRead,
} from "@/lib/plaid/session-dating";
import { todayET } from "@/lib/calendar/date-utils";

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
  /** Set for an account fed by Plaid (it has a Plaid snapshot or a `plaid:`
   *  holdings row); null for every other account. When set, it decides the
   *  warn level instead of the one-trading-day rule. */
  plaid: AccountPlaidFreshness | null;
  level: PositionsFreshnessLevel;
}

export interface AccountPlaidFreshness {
  /** Newest session with a Plaid book or a statement holdings book. */
  newestCoveredSession: string | null;
  /** `expectedPlaidSession(now)`: the newest session the morning read
   *  should have stored. */
  expectedSession: string;
  /** newestCoveredSession is older than expectedSession (or missing). */
  stale: boolean;
}

/** An account whose next Plaid write is held back (plan v4, A6): it has no
 *  new-format entry yet and has old-format Plaid rows dated after the
 *  expected session, so the refresh skips it until the history repair runs.
 *  Derived from stored rows only; no read state is saved anywhere. */
export interface PlaidTransitionHold {
  accountId: number;
  accountName: string;
  /** The session that cannot be stored yet. */
  session: string;
}

/** Facts for the trust strip's Plaid lines. Empty for a scope with no
 *  Plaid-fed account (IBKR only, or no accounts): every line is silent. */
export interface PlaidScopeFacts {
  /** Plaid-fed accounts in scope, by id. */
  accountIds: number[];
  expectedSession: string;
  /** Section B state of the whole database, or "unreadable" when the dating
   *  setting is damaged (the reader throws; the strip says so). */
  datingState: DatingState | "unreadable";
  /** The reader's error message when unreadable; null otherwise. */
  datingError: string | null;
  /** Earliest first new-format session among accounts in scope (Mixed). */
  earliestFirstSession: string | null;
  /** Every Plaid-fed account in scope has a first new-format session.
   *  When false in the Mixed state, part of the scope is still wholly on the
   *  old dating, so the strip uses the Legacy wording. */
  everyAccountHasFirstSession: boolean;
  transitionHolds: PlaidTransitionHold[];
  repeatReads: PlaidRepeatRead[];
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
   *  trading day old (`holdingAgeDays` > 1); for a Plaid-fed account, its
   *  newest covered session is older than the expected session; or the scope
   *  has statement rows and no live rows at all and not every account is a
   *  covered Plaid-fed account. Else good. */
  level: PositionsFreshnessLevel;
  /** Facts for the trust strip's Plaid lines. */
  plaid: PlaidScopeFacts;
}

export interface PositionsFreshnessOptions {
  /** The instant the expected Plaid session is judged at. Default: now when
   *  its Eastern day is `today`; otherwise midday of `today` (after the
   *  morning read), so a caller that passes only a day gets that day's rule. */
  now?: Date;
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

function defaultNow(today: string): Date {
  const now = new Date();
  if (todayET(now) === today) return now;
  // 17:00 UTC is 12:00 or 13:00 Eastern: the same Eastern day, after 07:40.
  return new Date(`${today}T17:00:00Z`);
}

/** Plaid-fed accounts in scope with their newest covered session. */
function plaidCoverage(
  db: Database.Database,
  accountIds: number[] | undefined,
): Map<number, { name: string; newestCoveredSession: string | null }> {
  const scope = accountScopeAndSql(accountIds, "a.id");
  const rows = db
    .prepare(
      `SELECT a.id, a.name,
              (SELECT MAX(ms.month_end_date) FROM monthly_snapshots ms
                WHERE ms.account_id = a.id AND ms.source = 'plaid') AS plaid_snapshot,
              (SELECT MAX(h.as_of_date) FROM holdings h
                WHERE h.account_id = a.id AND h.source_key LIKE 'plaid:%') AS plaid_holding,
              (SELECT MAX(h.as_of_date) FROM holdings h
                WHERE h.account_id = a.id AND ${statementSourcedHoldingSql("h.source_key")}) AS statement_holding
         FROM accounts a
        WHERE (EXISTS (SELECT 1 FROM monthly_snapshots ms
                        WHERE ms.account_id = a.id AND ms.source = 'plaid')
               OR EXISTS (SELECT 1 FROM holdings h
                           WHERE h.account_id = a.id AND h.source_key LIKE 'plaid:%'))
          ${scope.sql}
        ORDER BY a.id`,
    )
    .all(...scope.params) as {
    id: number;
    name: string;
    plaid_snapshot: string | null;
    plaid_holding: string | null;
    statement_holding: string | null;
  }[];
  const out = new Map<number, { name: string; newestCoveredSession: string | null }>();
  for (const r of rows) {
    const dates = [r.plaid_snapshot, r.plaid_holding, r.statement_holding].filter(
      (d): d is string => d !== null,
    );
    out.set(r.id, { name: r.name, newestCoveredSession: maxDate(dates) });
  }
  return out;
}

function plaidScopeFacts(
  db: Database.Database,
  accountIds: number[] | undefined,
  coverage: Map<number, { name: string; newestCoveredSession: string | null }>,
  expectedSession: string,
): PlaidScopeFacts {
  const ids = [...coverage.keys()];
  const facts: PlaidScopeFacts = {
    accountIds: ids,
    expectedSession,
    datingState: "fresh",
    datingError: null,
    earliestFirstSession: null,
    everyAccountHasFirstSession: true,
    transitionHolds: [],
    repeatReads: [],
  };
  if (ids.length === 0) return facts;

  // The repeat-read check reads stored books only; it does not need the
  // dating setting, so it still runs when that setting is damaged.
  facts.repeatReads = getPlaidRepeatReads(db, accountIds);

  try {
    const boundary = getDatingBoundary(db);
    facts.datingState = getDatingState(db);
    if (facts.datingState === "legacy" || facts.datingState === "mixed") {
      facts.earliestFirstSession = earliestFirstSession(db, ids);
      facts.everyAccountHasFirstSession = ids.every((id) => boundary.accounts.has(id));
      for (const id of ids) {
        // A6: no entry yet and old-format rows dated after the session the
        // morning read should have stored. The refresh's own rule.
        if (boundary.accounts.has(id)) continue;
        if (hasLegacyRowsAfter(db, id, expectedSession, boundary)) {
          facts.transitionHolds.push({
            accountId: id,
            accountName: coverage.get(id)?.name ?? "",
            session: expectedSession,
          });
        }
      }
    }
  } catch (error) {
    facts.datingState = "unreadable";
    facts.datingError = error instanceof Error ? error.message : String(error);
    facts.earliestFirstSession = null;
    facts.everyAccountHasFirstSession = true;
    facts.transitionHolds = [];
  }
  return facts;
}

export function getPositionsFreshness(
  db: Database.Database,
  accountIds: number[] | undefined,
  today: string,
  options: PositionsFreshnessOptions = {},
): PositionsFreshness {
  // `undefined` is every account; a defined empty list is NO accounts.
  const { sql: accountFilter, params } = accountScopeAndSql(accountIds);
  const expectedSession = expectedPlaidSession(options.now ?? defaultNow(today));
  const coverage = plaidCoverage(db, accountIds);

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

    const liveSource = liveSourceLabel(newestLiveRows.map((r) => r.source_key));
    const covered = coverage.get(accountId);
    // A Plaid-fed account is judged by the Plaid rule unless its newest live
    // rows come from the broker sync.
    const plaid: AccountPlaidFreshness | null =
      covered && liveSource !== "broker sync"
        ? {
            newestCoveredSession: covered.newestCoveredSession,
            expectedSession,
            stale:
              covered.newestCoveredSession === null ||
              covered.newestCoveredSession < expectedSession,
          }
        : null;

    let level: PositionsFreshnessLevel = "good";
    if (leftoverItems.length > 0) level = "bad";
    else if (plaid) {
      if (plaid.stale) level = "warn";
    } else if (newestLiveDate !== null && holdingAgeDays(newestLiveDate, today) > 1) level = "warn";

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
      liveSource,
      plaid,
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
  else if (
    liveRowCount === 0 &&
    statementRowCount > 0 &&
    // A Plaid-fed account whose statement covers the expected session is
    // fresh: the refresh skips that session on purpose.
    !accounts.every((a) => a.plaid !== null && !a.plaid.stale)
  )
    level = "warn";

  return {
    accounts,
    newestDate: maxDate(rows.map((r) => r.as_of_date)),
    oldestCountedLiveDate: minDate(liveDates),
    leftoverCount,
    statementRowCount,
    level,
    plaid: plaidScopeFacts(db, accountIds, coverage, expectedSession),
  };
}
