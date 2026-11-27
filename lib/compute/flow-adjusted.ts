/**
 * External cash-flow adjustment for return-series math — shared by
 * computeRiskMetrics (drawdown/vol/Sharpe) and computeMarketRegression
 * (beta/alpha). Lives in its own module because risk.ts already imports from
 * factors.ts (normalizeAccountIds) — factors importing these back from
 * risk.ts would create an import cycle.
 *
 * Convention (see CLAUDE.md "risk metrics are flow-adjusted"): a deposit or
 * withdrawal changes account value without being a market move. Any metric
 * computed on raw daily_valuations values reads a $100k withdrawal as a
 * -19% "day" (the 2026-06-10 IBKR drawdown bug; the same mechanism drove the
 * degenerate beta-0.05 multi-account regression, 2026-07-26).
 */

import type Database from "better-sqlite3";
import { LIVE_SNAPSHOT_SOURCES } from "@/lib/db/live-sources";
import { transactionAmountUsdSql } from "@/lib/queries/transaction-amount-currency";
import { accountScopeAndSql } from "@/lib/queries/account-scope-sql";

export interface SeriesPoint {
  date: string;
  value: number;
}

/**
 * Signed external-flow amount expression. Security transfers store the
 * transfer-date market value as a positive magnitude — the TYPE carries the
 * direction (same convention as quantity-always-positive) — so TRANSFER_OUT
 * must be signed negative here or a paired internal journal (equal
 * TRANSFER_IN + TRANSFER_OUT legs) reads as double inflow and every
 * flow-consuming metric (TWR, XIRR, flow-adjusted index, attribution)
 * drifts. -ABS keeps an already-negative row negative.
 */
export const SIGNED_EXTERNAL_FLOW_SQL =
  "CASE WHEN type = 'TRANSFER_OUT' THEN -ABS(amount) ELSE amount END";

/**
 * In-kind transfer leg predicate — a security-transfer TRANSFER_IN/OUT leg
 * (as opposed to a cash TRANSFER, or a DEPOSIT/WITHDRAWAL). Donation
 * tracking (2026-08-17, spec §6) stamps these legs with the transfer-date
 * FMV as a positive `amount` (previously 0), so an unpaired in-kind leg now
 * carries real money-shaped value through every external-flow reader. Cash
 * stepping (daily-valuation.ts) must NOT treat that FMV as a cash movement
 * — a security left/entered the account, cash never moved — so it excludes
 * these rows via `fetchNetFlowsByDate`'s `excludeInKind` option below. Risk
 * metrics, TWR, and XIRR keep including them (a donation IS a real
 * portfolio-value flow for return math purposes).
 */
export const IN_KIND_LEG_SQL =
  "type IN ('TRANSFER_IN','TRANSFER_OUT') AND security_id IS NOT NULL";

/**
 * Net external flows (deposits positive, withdrawals negative) per trade_date
 * for the scoped accounts, bounded to (startDate, endDate]. Flows on/before
 * the first valuation date are already baked into the starting value; flows
 * after the last valuation date haven't hit the series yet.
 *
 * `opts.excludeInKind` (default false, every existing call site unchanged)
 * drops in-kind transfer legs (IN_KIND_LEG_SQL) from the WHERE clause —
 * used by the daily-valuation cash stepper, which must never step cash for
 * an in-kind FMV move. Readers that consume flows for return math (risk
 * index, TWR, XIRR) call this without the flag.
 *
 * Gracefully returns [] when the transactions table doesn't exist (minimal
 * in-memory test DBs) — same precedent as getRiskFreeRate's settings guard.
 */
export function fetchNetFlowsByDate(
  db: Database.Database,
  accountIds: number[] | undefined,
  startDate: string,
  endDate: string,
  opts: { excludeInKind?: boolean } = {}
): { date: string; net: number }[] {
  const hasTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'transactions'")
    .get();
  if (!hasTable) return [];

  // `undefined` is every account; a defined empty list is NO accounts (it
  // must never widen to the whole book).
  if (accountIds && accountIds.length === 0) return [];
  const accountFilter = accountIds
    ? `AND account_id IN (${accountIds.map(() => "?").join(",")})`
    : "";

  const inKindFilter = opts.excludeInKind ? `AND NOT (${IN_KIND_LEG_SQL})` : "";

  return db
    .prepare(
      `SELECT trade_date AS date, SUM(${SIGNED_EXTERNAL_FLOW_SQL}) AS net
       FROM transactions
       WHERE is_external_flow = 1
         AND trade_date > ? AND trade_date <= ?
         ${accountFilter}
         ${inKindFilter}
       GROUP BY trade_date
       HAVING SUM(${SIGNED_EXTERNAL_FLOW_SQL}) != 0
       ORDER BY trade_date ASC`
    )
    .all(startDate, endDate, ...(accountIds ?? [])) as { date: string; net: number }[];
}

/**
 * fetchNetFlowsByDate in USD: the same rows (is_external_flow = 1), the same
 * (startDate, endDate] window, the same scope rule (`undefined` every
 * account, `[]` none) and the same sign rule (a TRANSFER_OUT is -ABS), with
 * each amount read through `transactionAmountUsdSql`, the one
 * transaction-currency rule: a USD-stored row as is, a native row (a
 * foreign security's in-kind leg) times its `fx_rates` rate.
 *
 * A native row with no rate on file is never summed (its native figure would
 * read as dollars); it is counted in `unconvertedCount` so the caller can
 * refuse a figure built without it.
 *
 * fetchNetFlowsByDate itself is unchanged: its readers (risk index, TWR,
 * XIRR, monthly performance, the cash stepper) keep their figures.
 */
export function fetchNetFlowsUsdByDate(
  db: Database.Database,
  accountIds: number[] | undefined,
  startDate: string,
  endDate: string
): { flows: { date: string; net: number }[]; unconvertedCount: number } {
  const hasTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'transactions'")
    .get();
  if (!hasTable) return { flows: [], unconvertedCount: 0 };

  if (accountIds && accountIds.length === 0) return { flows: [], unconvertedCount: 0 };
  const accountFilter = accountIds
    ? `AND t.account_id IN (${accountIds.map(() => "?").join(",")})`
    : "";

  const usd = transactionAmountUsdSql("t", "s", "fx");
  const signedUsd = `CASE WHEN t.type = 'TRANSFER_OUT' THEN -ABS(${usd}) ELSE ${usd} END`;
  const params = [startDate, endDate, ...(accountIds ?? [])];
  const from = `FROM transactions t
       LEFT JOIN securities s ON s.id = t.security_id
       LEFT JOIN fx_rates fx ON fx.currency = s.currency
       WHERE t.is_external_flow = 1
         AND t.trade_date > ? AND t.trade_date <= ?
         ${accountFilter}`;

  const flows = db
    .prepare(
      `SELECT t.trade_date AS date, SUM(${signedUsd}) AS net
       ${from}
       GROUP BY t.trade_date
       HAVING SUM(${signedUsd}) != 0
       ORDER BY t.trade_date ASC`
    )
    .all(...params) as { date: string; net: number }[];

  const { n } = db
    .prepare(
      `SELECT COUNT(*) AS n
       ${from}
         AND t.amount IS NOT NULL AND t.amount != 0
         AND ${usd} IS NULL`
    )
    .get(...params) as { n: number };

  return { flows, unconvertedCount: n };
}

/**
 * Net IN-KIND transfer flows (a security moving in/out; security_id set) per
 * trade_date for the scoped accounts, bounded to (startDate, endDate] — same
 * half-open convention and same missing-table guard as fetchNetFlowsByDate.
 * This is the "only in-kind" mirror of that function: WHERE is_external_flow
 * = 1 AND (IN_KIND_LEG_SQL), signed via SIGNED_EXTERNAL_FLOW_SQL, instead of
 * `excludeInKind`'s NOT (...). `accountIds`: `null` = every account, a
 * defined empty list = no accounts (returns []).
 *
 * Template for the shared Dietz primitives (Task 11) — mirrors
 * fetchNetFlowsByDate's shape exactly; only the WHERE predicate differs.
 */
export function fetchInKindFlowsByDate(
  db: Database.Database,
  accountIds: number[] | null,
  startDate: string,
  endDate: string
): { date: string; net: number }[] {
  const hasTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'transactions'")
    .get();
  if (!hasTable) return [];

  // `null` is every account; a defined empty list is NO accounts (it must
  // never widen to the whole book).
  if (accountIds && accountIds.length === 0) return [];
  const accountFilter = accountIds
    ? `AND account_id IN (${accountIds.map(() => "?").join(",")})`
    : "";

  return db
    .prepare(
      `SELECT trade_date AS date, SUM(${SIGNED_EXTERNAL_FLOW_SQL}) AS net
       FROM transactions
       WHERE is_external_flow = 1
         AND (${IN_KIND_LEG_SQL})
         AND trade_date > ? AND trade_date <= ?
         ${accountFilter}
       GROUP BY trade_date
       HAVING SUM(${SIGNED_EXTERNAL_FLOW_SQL}) != 0
       ORDER BY trade_date ASC`
    )
    .all(startDate, endDate, ...(accountIds ?? [])) as { date: string; net: number }[];
}

/**
 * Build a growth-of-$1 index from daily valuations with external flows
 * stripped out: r_t = (V_t − F_t) / V_{t−1}, where F_t is the net flow that
 * landed in (date_{t−1}, date_t] (end-of-day convention — a flow dated on a
 * valuation date adjusts that date's return, matching statement EOD values).
 * Drawdowns computed on this index reflect market movement only; the raw
 * series would read every withdrawal as a crash and every deposit as a rally.
 *
 * `seamDates` (sorted ascending — fetchAnchorSourceSeamDates output) marks
 * anchor-source transition days: a day whose interval (date_{t−1}, date_t]
 * contains a seam is a BRIDGED day — the value step mixes two measurement
 * bases (statement vs Plaid vs TWS), so it is zero information, not a
 * return. The index carries flat and no return observation is emitted (the
 * same skip shape as the non-positive guard, so every consumer already
 * tolerates it). Flows inside a bridged interval are consumed — the whole
 * step is discarded, flow component included — and never leak into the next
 * day's return, which divides by the raw series[t].value as always.
 *
 * `returns` carries each log return with the date it lands on (series[t]) so
 * consumers that pair returns with another series (the market regression's
 * benchmark alignment) can match by date; a skipped pair (non-positive prev
 * or adjusted value, or a bridged day) simply has no entry. `bridgedDays`
 * counts seam-bridged days for observability (PortfolioRiskMetrics.
 * seamDaysBridged; 0 when seamDates is empty).
 */
export function buildFlowAdjustedIndex(
  series: SeriesPoint[],
  flows: { date: string; net: number }[],
  seamDates: string[] = []
): {
  index: SeriesPoint[];
  returns: { date: string; logReturn: number }[];
  bridgedDays: number;
} {
  if (series.length === 0) return { index: [], returns: [], bridgedDays: 0 };

  const index: SeriesPoint[] = [{ date: series[0].date, value: 1 }];
  const returns: { date: string; logReturn: number }[] = [];
  let bridgedDays = 0;
  let fi = 0;
  while (fi < flows.length && flows[fi].date <= series[0].date) fi++;
  let si = 0;
  while (si < seamDates.length && seamDates[si] <= series[0].date) si++;

  for (let t = 1; t < series.length; t++) {
    let net = 0;
    while (fi < flows.length && flows[fi].date <= series[t].date) {
      net += flows[fi].net;
      fi++;
    }
    let bridged = false;
    while (si < seamDates.length && seamDates[si] <= series[t].date) {
      bridged = true;
      si++;
    }
    const prev = series[t - 1].value;
    const adjusted = series[t].value - net;
    let indexValue = index[t - 1].value;
    if (bridged) {
      bridgedDays++;
    } else if (prev > 0 && adjusted > 0) {
      const growth = adjusted / prev;
      returns.push({ date: series[t].date, logReturn: Math.log(growth) });
      indexValue = index[t - 1].value * growth;
    }
    index.push({ date: series[t].date, value: indexValue });
  }

  return { index, returns, bridgedDays };
}

/**
 * Largest gap (in the account's currency) between a statement's reported
 * opening value and the previous statement's closing total that still counts
 * as "the two statements join". Far below any basis change worth bridging,
 * tolerant of cent rounding between importers.
 */
const STATEMENT_JOIN_TOLERANCE = 1;

/**
 * Anchor-source seam dates for the scoped accounts, bounded to
 * (startDate, endDate] — the same half-open convention as
 * fetchNetFlowsByDate (a seam on/before the series' first date is already
 * inside the starting value).
 *
 * A seam is a day where the daily series hands off between two measurement
 * bases that are NOT reconciled by a statement on both sides. Phase 2 of
 * computeDailyValuations snaps total_value to each anchor's total on its
 * date; buildFlowAdjustedIndex bridges a seam day (no return, index flat).
 *
 * RULE (2026-11-15; replaces the 2026-08-13 "any source change" rule). Per
 * account, over its WHOLE anchor history (not only the query window, so the
 * answer for a past date never depends on where the window ends), with
 * anchors split into LIVE (`LIVE_SNAPSHOT_SOURCES`: tws, plaid) and
 * STATEMENT-GRADE (every other source, NULL included):
 *
 *   1. Live anchors that sit between two statement-grade anchors are never
 *      seams, and neither are the statement anchors around them. The
 *      statement on each side pins the series, so the daily index over that
 *      stretch telescopes to the statement-to-statement return whatever the
 *      live rows read; bridging any day inside it deletes a real market move
 *      and breaks that agreement. (Measured on the real book: with the old
 *      rule the monthly returns of the daily index missed the statement TWR
 *      by 85-550 bp in the live era; without these bridges they match to
 *      about 0 bp. The month-end round trips, and even the original
 *      07-11 / 04-06 go-lives once a later statement covered them, all made
 *      the month WORSE when bridged.)
 *   2. Statement-grade anchors are compared with each other only. When the
 *      source of consecutive statement anchors changes (NULL is its own
 *      value), the newer one is a seam UNLESS its reported `starting_value`
 *      joins the previous statement's `total_value` within
 *      STATEMENT_JOIN_TOLERANCE; the statement's own opening value is the
 *      direct evidence that the two readers measure on one basis (the real
 *      canonical -> ibkr-activity hand-off joins exactly). A NULL opening
 *      value cannot confirm the join, so it stays a seam (conservative).
 *   3. Unbracketed edges are real hand-offs: the FIRST live anchor after the
 *      account's last statement-grade anchor (the go-live tail, with no
 *      later statement to reconcile it), and the FIRST statement-grade
 *      anchor after live anchors that precede every statement (head).
 *
 * An account's first anchor is never a seam; a live-only account has none.
 * The tail seam moves forward when the next statement lands (the old tail
 * becomes bracketed), which is the same recompute-on-import staleness every
 * valuation consumer already has.
 *
 * Gracefully returns [] when monthly_snapshots doesn't exist (minimal
 * in-memory test DBs) — same precedent as fetchNetFlowsByDate; a table
 * without `starting_value` reads every opening value as NULL.
 */
export function fetchAnchorSourceSeamDates(
  db: Database.Database,
  accountIds: number[] | undefined,
  startDate: string,
  endDate: string
): string[] {
  const hasTable = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'monthly_snapshots'"
    )
    .get();
  if (!hasTable) return [];

  // `undefined` is every account; a defined empty list is NO accounts (it
  // must never widen to the whole book).
  if (accountIds && accountIds.length === 0) return [];
  const accountFilter = accountIds
    ? `AND account_id IN (${accountIds.map(() => "?").join(",")})`
    : "";

  const hasStartingValue = (
    db.prepare("PRAGMA table_info(monthly_snapshots)").all() as { name: string }[]
  ).some((c) => c.name === "starting_value");
  const startingValueCol = hasStartingValue ? "starting_value" : "NULL";

  const rows = db
    .prepare(
      `SELECT account_id, month_end_date, source, total_value,
              ${startingValueCol} AS starting_value
       FROM monthly_snapshots
       WHERE 1 = 1
         ${accountFilter}
       ORDER BY account_id ASC, month_end_date ASC`
    )
    .all(...(accountIds ?? [])) as AnchorRow[];

  const byAccount = new Map<number, AnchorRow[]>();
  for (const row of rows) {
    const list = byAccount.get(row.account_id);
    if (list) list.push(row);
    else byAccount.set(row.account_id, [row]);
  }

  const seams = new Set<string>();
  for (const anchors of byAccount.values()) {
    for (const date of accountSeamDates(anchors)) {
      if (date > startDate && date <= endDate) seams.add(date);
    }
  }

  return [...seams].sort();
}

/**
 * Writer-identity anchor transitions: the month_end_date of every
 * monthly_snapshots anchor whose `source` differs from the SAME account's
 * previous anchor (NULL is its own value; an account's first anchor never
 * counts), bounded to (startDate, endDate]. This is the pre-2026-11-15
 * fetchAnchorSourceSeamDates rule, kept verbatim for CASH-residual auditing:
 * on a live -> statement or statement -> live step the cash column changes
 * meaning (a live day's cash is a plug, a statement day's is literal cash),
 * so every such day is a measurement artifact for cash even though it is a
 * real market day for the return series. Return-series readers use
 * fetchAnchorSourceSeamDates, never this.
 */
export function fetchAnchorSourceTransitionDates(
  db: Database.Database,
  accountIds: number[] | undefined,
  startDate: string,
  endDate: string
): string[] {
  const hasTable = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'monthly_snapshots'"
    )
    .get();
  if (!hasTable) return [];
  if (accountIds && accountIds.length === 0) return [];
  const accountFilter = accountIds
    ? `AND account_id IN (${accountIds.map(() => "?").join(",")})`
    : "";

  const rows = db
    .prepare(
      `SELECT account_id, month_end_date, source
       FROM monthly_snapshots
       WHERE month_end_date <= ?
         ${accountFilter}
       ORDER BY account_id ASC, month_end_date ASC`
    )
    .all(endDate, ...(accountIds ?? [])) as {
    account_id: number;
    month_end_date: string;
    source: string | null;
  }[];

  const out = new Set<string>();
  let prevAccount: number | null = null;
  let prevSource: string | null | undefined;
  for (const row of rows) {
    if (row.account_id === prevAccount && row.source !== prevSource && row.month_end_date > startDate) {
      out.add(row.month_end_date);
    }
    prevAccount = row.account_id;
    prevSource = row.source;
  }
  return [...out].sort();
}

interface AnchorRow {
  account_id: number;
  month_end_date: string;
  source: string | null;
  total_value: number;
  starting_value: number | null;
}

const LIVE_SOURCE_SET: ReadonlySet<string> = new Set(LIVE_SNAPSHOT_SOURCES);

function isLiveAnchor(row: AnchorRow): boolean {
  return row.source !== null && LIVE_SOURCE_SET.has(row.source);
}

/** One account's seam dates (rules 2 and 3 of fetchAnchorSourceSeamDates). */
function accountSeamDates(anchors: AnchorRow[]): string[] {
  const out: string[] = [];
  const statements = anchors.filter((a) => !isLiveAnchor(a));
  if (statements.length === 0) return out; // live-only: one basis throughout

  // Rule 2: consecutive statement-grade anchors, live rows ignored.
  for (let i = 1; i < statements.length; i++) {
    const prev = statements[i - 1];
    const cur = statements[i];
    if (cur.source === prev.source) continue;
    const joins =
      cur.starting_value !== null &&
      Math.abs(cur.starting_value - prev.total_value) <= STATEMENT_JOIN_TOLERANCE;
    if (!joins) out.push(cur.month_end_date);
  }

  // Rule 3, head: live anchors before the first statement hand off to it.
  const firstStatement = statements[0];
  if (anchors[0] !== firstStatement) out.push(firstStatement.month_end_date);

  // Rule 3, tail: the first live anchor after the last statement.
  const lastStatement = statements[statements.length - 1];
  const tail = anchors.find(
    (a) => isLiveAnchor(a) && a.month_end_date > lastStatement.month_end_date
  );
  if (tail) out.push(tail.month_end_date);

  return out;
}

/**
 * Go-live dates of the live sources on each account (ruling E2, 2026-11-15/16).
 *
 * The day a live source (`LIVE_SNAPSHOT_SOURCES`: tws, plaid) starts on an
 * account, the daily series steps from statement-anchored values to a live
 * broker total. That step is a one-off change of measurement, not a market
 * move, so volatility, Sharpe and beta leave out the return interval that
 * holds it. The flow-adjusted index, drawdown, cumulative return and the
 * equity curve keep it: a later statement pins the series on both sides, so
 * the index still telescopes to the statement return (see
 * fetchAnchorSourceSeamDates, rule 1).
 *
 * RULE. For each account and each live source, the go-live date is the date
 * of that source's FIRST monthly_snapshots anchor on the account, but only
 * when the account has an EARLIER anchor of any other source (a statement
 * source, NULL, or the other live source). An account that starts on a live
 * source has no go-live jump.
 *
 * Derived from stored anchors on every call, never stored and never a fixed
 * list, so it stays right when a repair moves the first live anchor (for
 * example from a Saturday onto the Friday before it). The date is the
 * anchor's own date, which can be a closed day; callers test it against
 * return INTERVALS (see intervalContainsAnyDate), so a closed-day go-live
 * still hits the session it folds into.
 *
 * Scope: `undefined` is every account; a defined empty list is no account
 * (an empty map). Returns an empty map when monthly_snapshots does not exist
 * (minimal in-memory test databases), as the readers above do.
 */
export function fetchLiveSourceGoLiveDates(
  db: Database.Database,
  accountIds: readonly number[] | undefined
): Map<number, string[]> {
  const out = new Map<number, string[]>();
  const hasTable = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'monthly_snapshots'"
    )
    .get();
  if (!hasTable) return out;

  const scope = accountScopeAndSql(accountIds, "account_id");
  const rows = db
    .prepare(
      `SELECT account_id, month_end_date, source
       FROM monthly_snapshots
       WHERE 1 = 1
         ${scope.sql}
       ORDER BY account_id ASC, month_end_date ASC`
    )
    .all(...scope.params) as { account_id: number; month_end_date: string; source: string | null }[];

  const byAccount = new Map<number, { date: string; source: string | null }[]>();
  for (const row of rows) {
    const list = byAccount.get(row.account_id);
    const anchor = { date: row.month_end_date, source: row.source };
    if (list) list.push(anchor);
    else byAccount.set(row.account_id, [anchor]);
  }

  for (const [accountId, anchors] of byAccount) {
    const dates = new Set<string>();
    for (const live of LIVE_SNAPSHOT_SOURCES) {
      const first = anchors.find((a) => a.source === live);
      if (!first) continue;
      const hasEarlierOther = anchors.some(
        (a) => a.date < first.date && a.source !== live
      );
      if (hasEarlierOther) dates.add(first.date);
    }
    if (dates.size > 0) out.set(accountId, [...dates].sort());
  }
  return out;
}

/**
 * Every go-live date of the accounts in scope, one sorted list. A return
 * series summed over several accounts carries each account's go-live step,
 * so the summed series leaves out an interval holding ANY of them.
 */
export function fetchGoLiveDatesForScope(
  db: Database.Database,
  accountIds: readonly number[] | undefined
): string[] {
  const all = new Set<string>();
  for (const dates of fetchLiveSourceGoLiveDates(db, accountIds).values()) {
    for (const d of dates) all.add(d);
  }
  return [...all].sort();
}

/**
 * Does the return interval (startExclusive, endInclusive] hold any of
 * `dates`? The same half-open convention as flows and seams: a date equal to
 * the interval's start is already inside the starting value.
 *
 * A null start means the interval's lower end is unknown; it is then read as
 * open below (any date on or before the end counts), which leaves an
 * observation out rather than risk keeping a go-live step.
 */
export function intervalContainsAnyDate(
  startExclusive: string | null,
  endInclusive: string,
  dates: readonly string[]
): boolean {
  for (const d of dates) {
    if (d <= endInclusive && (startExclusive === null || d > startExclusive)) return true;
  }
  return false;
}
