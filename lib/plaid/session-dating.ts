import type Database from "better-sqlite3";
import { nowET, todayET } from "@/lib/calendar/date-utils";
import { isMarketClosed, previousTradingDay } from "@/lib/calendar/market-holidays";
import { isCashEquivalentSecurity } from "@/lib/compute/cash-equivalents";
import { accountScopeAndSql } from "@/lib/queries/account-scope-sql";

/**
 * Plaid session dating (plan v4, sections A, B and C).
 *
 * A Plaid read taken before the open on trading day D describes the close of
 * S = previousTradingDay(D). Every Plaid row written in the new format
 * (holdings, the snapshot, the source key, every Plaid price) is dated S.
 * Older ("legacy") rows were dated on the run day D, one session late.
 *
 * This module is the ONE reader and writer of the two settings keys that
 * record where the new format starts:
 *   - `plaid_dating_version`: absent, or "2" once the history is repaired
 *     (or the first write happened on a database with no legacy rows);
 *   - `plaid_dating_first_session`: JSON
 *     `{ accounts: { <localAccountId>: S0 }, securities: { <securityId>: S0 } }`,
 *     the first session written in the new format per account and per
 *     security. An entry is written once and never moved.
 * No other file may read or write these keys.
 */

const KEY_VERSION = "plaid_dating_version";
const KEY_FIRST_SESSION = "plaid_dating_first_session";
const REPAIRED_VERSION = "2";

/** Prefix of a new-format Plaid holdings key: `plaid:s:<acct>:<sec>:<S>`. */
export const NEW_FORMAT_PLAID_KEY_PREFIX = "plaid:s:";
const PLAID_KEY_PREFIX = "plaid:";
const RECON_KEY_PREFIX = "recon:closed-equity:";

/**
 * Start of the store window, Eastern wall clock (planner ruling 2026-11-26).
 * Every piece of evidence that a Plaid read describes the previous close
 * comes from the 07:30 scheduled job. A read taken earlier may come before
 * Vanguard/Plaid's overnight refresh, and because a stored read moves
 * `plaid_last_sync_at`, the 07:30 job would then answer "already synced
 * today" and never replace it. So nothing before 07:30 is stored.
 */
export const PLAID_STORE_WINDOW_START_ET = "07:30";
/** The regular open, Eastern wall clock. A read must finish before it. */
export const PLAID_STORE_WINDOW_END_ET = "09:30";
/**
 * The scheduled read runs in a 10-minute window from 07:30 Eastern on trading
 * days (launchd every 300 s, gated by `scripts/run-plaid-sync.sh`). From this
 * Eastern time on, today's scheduled read should be done.
 */
export const PLAID_SCHEDULE_DONE_ET = "07:40";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── Section A: session date and store window ─────────────────────────────

/** The session a pre-open read on `runDay` (YYYY-MM-DD, Eastern) describes. */
export function plaidSessionDate(runDay: string): string {
  return previousTradingDay(runDay);
}

/**
 * True when `instant` is on an Eastern trading day, at or after 07:30 and
 * before 09:30 Eastern. Uses the Eastern wall clock through Intl, so it is
 * right on both sides of a daylight-saving change. Minute precision is exact
 * here: every instant in 07:29:xx is before 07:30:00 and every instant in
 * 09:29:xx is before 09:30:00.
 */
export function isInStoreWindow(instant: Date): boolean {
  if (isMarketClosed(todayET(instant))) return false;
  const clock = nowET(instant);
  return clock >= PLAID_STORE_WINDOW_START_ET && clock < PLAID_STORE_WINDOW_END_ET;
}

/**
 * The run day of a read that may be stored, or null. A read is stored only
 * when the request start AND the response arrival are both in the store
 * window, on the same Eastern day (A1). The refresh calls this with the two
 * instants it measured.
 */
export function storeWindowRunDay(requestStart: Date, responseArrival: Date): string | null {
  if (!isInStoreWindow(requestStart) || !isInStoreWindow(responseArrival)) return null;
  const day = todayET(requestStart);
  return todayET(responseArrival) === day ? day : null;
}

/**
 * The newest session a healthy schedule should have stored by `now`.
 *
 * Rule: the scheduled read runs 07:30-07:40 Eastern on trading days only, and
 * a read on run day D stores previousTradingDay(D). So the newest stored
 * session is previousTradingDay(last run day whose window has ended):
 *   - trading day, at or after 07:40: the last run day is today, so the
 *     answer is previousTradingDay(today);
 *   - trading day before 07:40, or any closed day (weekend, holiday): today's
 *     read has not run (or never runs), so the last run day is the latest
 *     trading day before today, previousTradingDay(today), and the answer is
 *     previousTradingDay(previousTradingDay(today)).
 * Example: on a Saturday the last read was Friday's, which stored Thursday.
 */
export function expectedPlaidSession(now: Date): string {
  const today = todayET(now);
  if (!isMarketClosed(today) && nowET(now) >= PLAID_SCHEDULE_DONE_ET) {
    return previousTradingDay(today);
  }
  return previousTradingDay(previousTradingDay(today));
}

// ── Section B: the dating boundary ───────────────────────────────────────

/** The stored boundary, parsed. */
export interface DatingBoundary {
  /** `plaid_dating_version` is "2": every Plaid row is new-format. */
  repaired: boolean;
  /** Local account id -> first new-format session S0. */
  accounts: ReadonlyMap<number, string>;
  /** Security id -> first new-format session S0 of its Plaid price. */
  securities: ReadonlyMap<number, string>;
}

/** "new" = dated on the session it describes; "legacy" = dated on the run day. */
export type PlaidRowFormat = "new" | "legacy";

/** Derived state of the whole database (section B). */
export type DatingState = "fresh" | "legacy" | "mixed" | "repaired";

function getSetting(db: Database.Database, key: string): string | null {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
  ).run(key, value);
}

function parseEntries(raw: unknown, label: string): Map<number, string> {
  const out = new Map<number, string>();
  if (raw === undefined) return out;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`[plaid] ${KEY_FIRST_SESSION}.${label} is not an object`);
  }
  for (const [k, v] of Object.entries(raw)) {
    const id = Number(k);
    if (!Number.isInteger(id) || id <= 0 || String(id) !== k) {
      throw new Error(`[plaid] ${KEY_FIRST_SESSION}.${label} has a bad id: ${k}`);
    }
    if (typeof v !== "string" || !DATE_RE.test(v)) {
      throw new Error(`[plaid] ${KEY_FIRST_SESSION}.${label}.${k} is not a YYYY-MM-DD date`);
    }
    out.set(id, v);
  }
  return out;
}

/**
 * Reads the boundary. A damaged value THROWS: the map is never guessed or
 * silently reset, because a lost entry would turn new-format rows into
 * legacy ones (and the repair would then move them a second time).
 */
export function getDatingBoundary(db: Database.Database): DatingBoundary {
  const version = getSetting(db, KEY_VERSION);
  if (version !== null && version !== REPAIRED_VERSION) {
    throw new Error(`[plaid] unknown ${KEY_VERSION}: ${version}`);
  }
  const raw = getSetting(db, KEY_FIRST_SESSION);
  let parsed: { accounts?: unknown; securities?: unknown } = {};
  if (raw !== null) {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error(`[plaid] ${KEY_FIRST_SESSION} is not valid JSON`);
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`[plaid] ${KEY_FIRST_SESSION} is not an object`);
    }
    parsed = value as { accounts?: unknown; securities?: unknown };
  }
  return {
    repaired: version === REPAIRED_VERSION,
    accounts: parseEntries(parsed.accounts, "accounts"),
    securities: parseEntries(parsed.securities, "securities"),
  };
}

/**
 * The two raw settings values, exactly as stored (null when absent). For the
 * repair manifest's binding only; everything else reads `getDatingBoundary`.
 */
export function getDatingSettingsRaw(db: Database.Database): {
  version: string | null;
  firstSession: string | null;
} {
  return { version: getSetting(db, KEY_VERSION), firstSession: getSetting(db, KEY_FIRST_SESSION) };
}

function writeBoundaryMap(
  db: Database.Database,
  accounts: ReadonlyMap<number, string>,
  securities: ReadonlyMap<number, string>,
): void {
  const json = {
    accounts: Object.fromEntries([...accounts].map(([id, s]) => [String(id), s])),
    securities: Object.fromEntries([...securities].map(([id, s]) => [String(id), s])),
  };
  setSetting(db, KEY_FIRST_SESSION, JSON.stringify(json));
}

/**
 * Records the first new-format session for an account and/or a security.
 * Writes an entry only when none exists; never moves one. Does nothing once
 * the version is "2" (the map is then not needed).
 *
 * Opens NO transaction: call it inside the writer's own per-account
 * transaction, so the entry and the first new-format rows commit or roll
 * back together. Returns which entries were added.
 */
export function recordFirstNewFormatWrite(
  db: Database.Database,
  entry: { accountId?: number; securityId?: number; session: string },
): { accountAdded: boolean; securityAdded: boolean } {
  if (!DATE_RE.test(entry.session)) {
    throw new Error(`[plaid] recordFirstNewFormatWrite: bad session ${entry.session}`);
  }
  const boundary = getDatingBoundary(db);
  if (boundary.repaired) return { accountAdded: false, securityAdded: false };
  const accounts = new Map(boundary.accounts);
  const securities = new Map(boundary.securities);
  let accountAdded = false;
  let securityAdded = false;
  if (entry.accountId !== undefined && !accounts.has(entry.accountId)) {
    accounts.set(entry.accountId, entry.session);
    accountAdded = true;
  }
  if (entry.securityId !== undefined && !securities.has(entry.securityId)) {
    securities.set(entry.securityId, entry.session);
    securityAdded = true;
  }
  if (accountAdded || securityAdded) writeBoundaryMap(db, accounts, securities);
  return { accountAdded, securityAdded };
}

/**
 * Marks the history repaired: version "2", map deleted. For the repair
 * script's apply transaction (D6 step 5). Opens no transaction.
 */
export function setDatingRepaired(db: Database.Database): void {
  setSetting(db, KEY_VERSION, REPAIRED_VERSION);
  db.prepare(`DELETE FROM settings WHERE key = ?`).run(KEY_FIRST_SESSION);
}

/**
 * For the writer, after its new-format rows are written (inside its
 * transaction): when the version is absent and NO legacy row exists (a
 * database that never had old-format Plaid rows), sets version "2" and
 * deletes the map, since there is nothing to repair. Returns the state after
 * the call. Opens no transaction.
 */
export function settleFreshDatingVersion(db: Database.Database): DatingState {
  const state = getDatingState(db);
  if (state === "fresh") {
    setDatingRepaired(db);
    return "repaired";
  }
  return state;
}

/** The new-format holdings key for (account, security, session). */
export function newFormatHoldingSourceKey(
  accountId: number,
  securityId: number,
  session: string,
): string {
  return `${NEW_FORMAT_PLAID_KEY_PREFIX}${accountId}:${securityId}:${session}`;
}

/** True for a new-format Plaid holdings key (`plaid:s:`). */
export function isNewFormatPlaidHoldingKey(key: string | null): boolean {
  return key?.startsWith(NEW_FORMAT_PLAID_KEY_PREFIX) ?? false;
}

function onOrAfterBoundary(
  map: ReadonlyMap<number, string>,
  id: number,
  date: string,
): boolean {
  const s0 = map.get(id);
  return s0 !== undefined && date >= s0;
}

/**
 * Classifies a holdings row (section B table):
 *   - a `plaid:` row by its key: `plaid:s:` is new, any other `plaid:` key is
 *     legacy (the key, not the date, decides; the repair rewrites keys);
 *   - a recon tombstone (`recon:closed-equity:`) by its date against the
 *     account's S0: on or after S0 is new; before S0, or no entry, is legacy.
 *     The caller passes only tombstones on Plaid-mapped accounts;
 *   - any other row (statement, TWS): null, not a Plaid-dated row.
 * Once repaired, every tombstone is new.
 */
export function classifyPlaidHoldingRow(
  row: { accountId: number; asOfDate: string; sourceKey: string | null },
  boundary: DatingBoundary,
): PlaidRowFormat | null {
  const key = row.sourceKey ?? "";
  if (key.startsWith(PLAID_KEY_PREFIX)) {
    return isNewFormatPlaidHoldingKey(key) ? "new" : "legacy";
  }
  if (key.startsWith(RECON_KEY_PREFIX)) {
    if (boundary.repaired) return "new";
    return onOrAfterBoundary(boundary.accounts, row.accountId, row.asOfDate) ? "new" : "legacy";
  }
  return null;
}

/** Classifies a `monthly_snapshots` row of source `plaid` (section B). */
export function classifyPlaidSnapshot(
  accountId: number,
  date: string,
  boundary: DatingBoundary,
): PlaidRowFormat {
  if (boundary.repaired) return "new";
  return onOrAfterBoundary(boundary.accounts, accountId, date) ? "new" : "legacy";
}

/**
 * Classifies a `prices` row of source `plaid` (section B), by the security's
 * S0. It does NOT apply the repair's P3 exception (stock/ETF rows the 11-24
 * build already dated on the session read as legacy here); that exception is
 * the repair script's concern.
 */
export function classifyPlaidPrice(
  securityId: number,
  date: string,
  boundary: DatingBoundary,
): PlaidRowFormat {
  if (boundary.repaired) return "new";
  return onOrAfterBoundary(boundary.securities, securityId, date) ? "new" : "legacy";
}

function mapJson(map: ReadonlyMap<number, string>): string {
  return JSON.stringify(Object.fromEntries([...map].map(([id, s]) => [String(id), s])));
}

/**
 * LIMIT 1 probe: does any legacy Plaid row exist? Looks at `plaid:` holdings
 * keys, Plaid snapshots and Plaid prices. Recon tombstones are not probed: a
 * live-origin tombstone only exists next to a Plaid book, and statement
 * tombstones on the same accounts are not Plaid rows at all, so probing them
 * would keep a database with imported statements from ever reading Fresh.
 */
function hasAnyLegacyRow(db: Database.Database, boundary: DatingBoundary): boolean {
  const holding = db
    .prepare(
      `SELECT 1 FROM holdings
        WHERE source_key LIKE '${PLAID_KEY_PREFIX}%'
          AND source_key NOT LIKE '${NEW_FORMAT_PLAID_KEY_PREFIX}%'
        LIMIT 1`,
    )
    .get();
  if (holding) return true;
  const snapshot = db
    .prepare(
      `SELECT 1 FROM monthly_snapshots ms
        WHERE ms.source = 'plaid'
          AND NOT EXISTS (
            SELECT 1 FROM json_each(?) j
             WHERE CAST(j.key AS INTEGER) = ms.account_id AND ms.month_end_date >= j.value)
        LIMIT 1`,
    )
    .get(mapJson(boundary.accounts));
  if (snapshot) return true;
  const price = db
    .prepare(
      `SELECT 1 FROM prices p
        WHERE p.source = 'plaid'
          AND NOT EXISTS (
            SELECT 1 FROM json_each(?) j
             WHERE CAST(j.key AS INTEGER) = p.security_id AND p.date >= j.value)
        LIMIT 1`,
    )
    .get(mapJson(boundary.securities));
  return price !== undefined;
}

/**
 * Derived state (section B):
 *   - repaired: version "2" (no probe);
 *   - legacy: legacy rows exist and the map is empty;
 *   - mixed: legacy rows exist and the map has entries;
 *   - fresh: no legacy rows (version absent).
 */
export function getDatingState(db: Database.Database): DatingState {
  const boundary = getDatingBoundary(db);
  if (boundary.repaired) return "repaired";
  if (!hasAnyLegacyRow(db, boundary)) return "fresh";
  return boundary.accounts.size === 0 && boundary.securities.size === 0 ? "legacy" : "mixed";
}

/**
 * A6 for an account: a legacy Plaid holdings row, or a legacy Plaid snapshot,
 * dated after `session`. Writing S while such a row exists would leave the
 * legacy book "latest" above the new one. False once repaired (no probe).
 */
export function hasLegacyRowsAfter(
  db: Database.Database,
  accountId: number,
  session: string,
  boundary: DatingBoundary = getDatingBoundary(db),
): boolean {
  if (boundary.repaired) return false;
  const holding = db
    .prepare(
      `SELECT 1 FROM holdings
        WHERE account_id = ? AND as_of_date > ?
          AND source_key LIKE '${PLAID_KEY_PREFIX}%'
          AND source_key NOT LIKE '${NEW_FORMAT_PLAID_KEY_PREFIX}%'
        LIMIT 1`,
    )
    .get(accountId, session);
  if (holding) return true;
  const s0 = boundary.accounts.get(accountId);
  const snapshot = db
    .prepare(
      `SELECT 1 FROM monthly_snapshots
        WHERE account_id = ? AND source = 'plaid' AND month_end_date > ?
          AND (? IS NULL OR month_end_date < ?)
        LIMIT 1`,
    )
    .get(accountId, session, s0 ?? null, s0 ?? null);
  return snapshot !== undefined;
}

/**
 * A6 for a security's Plaid price: a legacy Plaid price dated after
 * `session`. False once repaired (no probe).
 */
export function hasLegacyPriceAfter(
  db: Database.Database,
  securityId: number,
  session: string,
  boundary: DatingBoundary = getDatingBoundary(db),
): boolean {
  if (boundary.repaired) return false;
  const s0 = boundary.securities.get(securityId);
  const row = db
    .prepare(
      `SELECT 1 FROM prices
        WHERE security_id = ? AND source = 'plaid' AND date > ?
          AND (? IS NULL OR date < ?)
        LIMIT 1`,
    )
    .get(securityId, session, s0 ?? null, s0 ?? null);
  return row !== undefined;
}

/**
 * The earliest S0 among the accounts in scope (`undefined` = every account,
 * `[]` = none), or null when no account in scope has an entry. For the trust
 * strip's Mixed line. Null once repaired (the map is deleted).
 */
export function earliestFirstSession(
  db: Database.Database,
  accountIds?: readonly number[],
): string | null {
  const boundary = getDatingBoundary(db);
  if (boundary.repaired) return null;
  let earliest: string | null = null;
  for (const [id, s0] of boundary.accounts) {
    if (accountIds !== undefined && !accountIds.includes(id)) continue;
    if (earliest === null || s0 < earliest) earliest = s0;
  }
  return earliest;
}

// ── Section C: repeat-read check ─────────────────────────────────────────

/** An account whose two newest Plaid books are identical. */
export interface PlaidRepeatRead {
  accountId: number;
  accountName: string;
  /** The newer book's session. */
  session: string;
  /** The older book's session. */
  previousSession: string;
}

function cents(v: number | null): number | null {
  return v === null ? null : Math.round(v * 100);
}

/**
 * Accounts whose two newest Plaid books are the same read (section C). Pure
 * read of stored rows; follows the scope rule (`undefined` = every account,
 * `[]` = none).
 *
 * "Plaid-mapped account" here means an account with at least one Plaid
 * snapshot (`monthly_snapshots.source = 'plaid'`), not the Plaid account map
 * in settings: the check compares stored books, so it is derived from the
 * same rows, works the same on a sandbox copy with no Plaid token, and does
 * not change when the Link flow rewrites the map. An IBKR-only scope has no
 * Plaid snapshot, so it returns nothing.
 *
 * A book is the Plaid snapshot on a date plus the `plaid:` holdings rows on
 * that date. The account is flagged when the two newest books have different
 * sessions, equal total cents, equal cash cents (both missing counts as
 * equal), the same set of (security, quantity rounded to 1e-6) over non-zero
 * rows (a zero row is not a position), and the newer book holds at least one
 * position that is not a cash equivalent.
 */
export function getPlaidRepeatReads(
  db: Database.Database,
  accountIds?: readonly number[],
): PlaidRepeatRead[] {
  const scope = accountScopeAndSql(accountIds, "a.id");
  const accounts = db
    .prepare(
      `SELECT a.id, a.name FROM accounts a
        WHERE EXISTS (SELECT 1 FROM monthly_snapshots ms
                       WHERE ms.account_id = a.id AND ms.source = 'plaid')
          ${scope.sql}
        ORDER BY a.id`,
    )
    .all(...scope.params) as { id: number; name: string }[];

  const newestBooks = db.prepare(
    `SELECT month_end_date AS date, total_value AS total, cash_value AS cash
       FROM monthly_snapshots
      WHERE account_id = ? AND source = 'plaid'
      ORDER BY month_end_date DESC
      LIMIT 2`,
  );
  const bookRows = db.prepare(
    `SELECT h.security_id, h.quantity, s.security_type, s.fund_category
       FROM holdings h
       JOIN securities s ON s.id = h.security_id
      WHERE h.account_id = ? AND h.as_of_date = ?
        AND h.source_key LIKE '${PLAID_KEY_PREFIX}%'
        AND h.quantity != 0`,
  );

  type BookRow = {
    security_id: number;
    quantity: number;
    security_type: string | null;
    fund_category: string | null;
  };
  const positionSet = (rows: BookRow[]): Set<string> =>
    new Set(rows.map((r) => `${r.security_id}:${Math.round(r.quantity * 1e6)}`));

  const out: PlaidRepeatRead[] = [];
  for (const account of accounts) {
    const books = newestBooks.all(account.id) as {
      date: string;
      total: number;
      cash: number | null;
    }[];
    if (books.length < 2) continue;
    const [newer, older] = books;
    if (newer.date === older.date) continue;
    if (cents(newer.total) !== cents(older.total)) continue;
    if (cents(newer.cash) !== cents(older.cash)) continue;

    const newerRows = bookRows.all(account.id, newer.date) as BookRow[];
    const olderRows = bookRows.all(account.id, older.date) as BookRow[];
    if (!newerRows.some((r) => !isCashEquivalentSecurity(r))) continue;
    const a = positionSet(newerRows);
    const b = positionSet(olderRows);
    if (a.size !== b.size || [...a].some((k) => !b.has(k))) continue;

    out.push({
      accountId: account.id,
      accountName: account.name,
      session: newer.date,
      previousSession: older.date,
    });
  }
  return out;
}
