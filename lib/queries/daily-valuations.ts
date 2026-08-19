import type Database from "better-sqlite3";

export interface DailyValuation {
  valuation_date: string;
  account_id: number;
  cash_balance: number;
  holdings_value: number;
  total_value: number;
}

/**
 * Get daily valuations for a specific account within a date range.
 */
export function getDailyValuationsByAccount(
  db: Database.Database,
  accountId: number,
  options?: {
    startDate?: string;
    endDate?: string;
  }
): DailyValuation[] {
  const conditions = ["account_id = ?"];
  const params: (string | number)[] = [accountId];

  if (options?.startDate) {
    conditions.push("valuation_date >= ?");
    params.push(options.startDate);
  }
  if (options?.endDate) {
    conditions.push("valuation_date <= ?");
    params.push(options.endDate);
  }

  return db
    .prepare(
      `SELECT valuation_date, account_id, cash_balance, holdings_value, total_value
       FROM daily_valuations
       WHERE ${conditions.join(" AND ")}
       ORDER BY valuation_date ASC`
    )
    .all(...params) as DailyValuation[];
}

/**
 * Coverage-jump guard shared by the two summed-series variants below.
 *
 * Account daily-valuation coverage windows differ (live DB: IBKR starts
 * 3/27, Vanguard + Roth 4/06) — a summed series "gains" an appearing
 * account's entire value as a fake return on its first covered date (+89%
 * phantom YTD alpha). With `fullCoverageOnly`, only dates where the MAX
 * number of simultaneously-covered accounts all have a row survive.
 * Max-coverage (not the requested account count) self-calibrates when a
 * scoped account has no data at all in the window. Omit, never mislead.
 */
function fullCoverageHaving(where: string): string {
  return `HAVING COUNT(DISTINCT account_id) = (
    SELECT MAX(n) FROM (
      SELECT COUNT(DISTINCT account_id) AS n
      FROM daily_valuations ${where}
      GROUP BY valuation_date
    )
  )`;
}

/**
 * Minimum distinct valuation dates an account must have to participate in
 * commonCoverageStart's floor computation.
 *
 * Guard against the new-account collapse hazard: a brand-new account (a
 * freshly-added IBKR sub-account, a newly Plaid-mapped account, anything with
 * just a few days of daily_valuations) would otherwise set MIN(valuation_date)
 * to its own first day, and since the floor is the MAX across all accounts'
 * per-account MIN, that single new account would drag the shared window down
 * to a handful of days for EVERY scope — not just its own. computeVolatility
 * nulls out below 30 points, but computeMaxDrawdown has no such floor and
 * would silently render a near-0% drawdown over a 3-day window instead of the
 * real multi-year figure.
 *
 * Chosen semantics: an account with fewer than MIN_FLOOR_HISTORY_DAYS distinct
 * dates simply doesn't constrain the shared window yet — it's excluded from
 * the MAX(first_date) aggregation entirely (not floored to today, not treated
 * as a hard error). fullCoverageOnly's per-window HAVING clause still governs
 * date-level coverage; this constant only decides who gets a vote in the
 * floor's own starting point.
 */
export const MIN_FLOOR_HISTORY_DAYS = 30;

/**
 * Sibling of fullCoverageHaving: the SCOPE-INVARIANT window floor.
 *
 * fullCoverageHaving self-calibrates PER SCOPE — it keeps the dates where the
 * *requested* account set is fully covered, so scope=ibkr starts at IBKR's own
 * first covered date (live DB: 2024-12-31), scope=vanguard at 2026-03-27 and
 * scope=all at 2026-04-06. Three different measurement windows behind one
 * card: the All-Accounts volatility rendered LOWER than every constituent
 * account's, which reads as mathematically impossible (a portfolio can sit
 * below its constituents by diversification, but not while each was measured
 * over a different period).
 *
 * This returns the earliest date from which ALL (sufficiently-established)
 * accounts have daily-valuation coverage — i.e. the LATEST of the per-account
 * coverage starts — so a caller can floor its window and have every scope
 * measure the same period. Accounts with no daily_valuations rows at all, or
 * with fewer than MIN_FLOOR_HISTORY_DAYS distinct valuation dates, are ignored
 * (they'd otherwise push the floor to nothing / collapse it — see that
 * constant's comment), matching fullCoverageHaving's self-calibration spirit.
 *
 * Returns null when there are no qualifying daily valuations (caller floors
 * nothing).
 */
export function commonCoverageStart(db: Database.Database): string | null {
  const row = db
    .prepare(
      `SELECT MAX(first_date) AS start FROM (
         SELECT MIN(valuation_date) AS first_date
         FROM daily_valuations
         GROUP BY account_id
         HAVING COUNT(DISTINCT valuation_date) >= ${MIN_FLOOR_HISTORY_DAYS}
       )`
    )
    .get() as { start: string | null } | undefined;
  return row?.start ?? null;
}

/**
 * Get aggregated daily valuations across all accounts within a date range.
 * Returns one row per date with summed values.
 */
export function getDailyValuationsCombined(
  db: Database.Database,
  options?: {
    startDate?: string;
    endDate?: string;
    fullCoverageOnly?: boolean;
  }
): DailyValuation[] {
  const conditions: string[] = [];
  const params: string[] = [];

  if (options?.startDate) {
    conditions.push("valuation_date >= ?");
    params.push(options.startDate);
  }
  if (options?.endDate) {
    conditions.push("valuation_date <= ?");
    params.push(options.endDate);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const having = options?.fullCoverageOnly ? fullCoverageHaving(where) : "";

  return db
    .prepare(
      `SELECT valuation_date, 0 AS account_id,
              SUM(cash_balance) AS cash_balance,
              SUM(holdings_value) AS holdings_value,
              SUM(total_value) AS total_value
       FROM daily_valuations
       ${where}
       GROUP BY valuation_date
       ${having}
       ORDER BY valuation_date ASC`
    )
    .all(...params, ...(options?.fullCoverageOnly ? params : [])) as DailyValuation[];
}

/**
 * Get aggregated daily valuations across a SUBSET of accounts within a date
 * range. Returns one row per date with summed values (account_id = 0, like the
 * combined variant). This is the correct way to build a portfolio time-series
 * for a multi-account scope: SUM across the account set FIRST, then any
 * volatility/drawdown/Sharpe math operates on the combined series — per-account
 * stats can't be averaged back into a portfolio figure (diversification).
 *
 * Empty/undefined `accountIds` falls through to the all-accounts combined view.
 */
export function getDailyValuationsForAccounts(
  db: Database.Database,
  accountIds: number[],
  options?: {
    startDate?: string;
    endDate?: string;
    fullCoverageOnly?: boolean;
  }
): DailyValuation[] {
  if (!accountIds || accountIds.length === 0) {
    return getDailyValuationsCombined(db, options);
  }

  const conditions: string[] = [
    `account_id IN (${accountIds.map(() => "?").join(",")})`,
  ];
  const params: (string | number)[] = [...accountIds];

  if (options?.startDate) {
    conditions.push("valuation_date >= ?");
    params.push(options.startDate);
  }
  if (options?.endDate) {
    conditions.push("valuation_date <= ?");
    params.push(options.endDate);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const having = options?.fullCoverageOnly ? fullCoverageHaving(where) : "";

  return db
    .prepare(
      `SELECT valuation_date, 0 AS account_id,
              SUM(cash_balance) AS cash_balance,
              SUM(holdings_value) AS holdings_value,
              SUM(total_value) AS total_value
       FROM daily_valuations
       ${where}
       GROUP BY valuation_date
       ${having}
       ORDER BY valuation_date ASC`
    )
    .all(...params, ...(options?.fullCoverageOnly ? params : [])) as DailyValuation[];
}

/**
 * Get daily valuations pivoted by account name — same shape as getPortfolioChartData().
 * Returns { date, "Vanguard Taxable": X, "IBKR": Y, ... } for use in CombinedPortfolioChart.
 */
export function getDailyValuationsPivoted(
  db: Database.Database
): { date: string; [accountName: string]: string | number }[] {
  const rows = db
    .prepare(
      `SELECT dv.valuation_date, a.name AS account_name, dv.total_value
       FROM daily_valuations dv
       JOIN accounts a ON a.id = dv.account_id
       ORDER BY dv.valuation_date`
    )
    .all() as {
    valuation_date: string;
    account_name: string;
    total_value: number;
  }[];

  const byDate = new Map<string, { date: string; [key: string]: string | number }>();
  for (const row of rows) {
    if (!byDate.has(row.valuation_date)) {
      byDate.set(row.valuation_date, { date: row.valuation_date });
    }
    byDate.get(row.valuation_date)![row.account_name] = row.total_value;
  }

  return Array.from(byDate.values());
}

/**
 * Check if daily valuations exist (at all).
 */
export function hasDailyValuations(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT COUNT(*) AS cnt FROM daily_valuations")
    .get() as { cnt: number };
  return row.cnt > 0;
}
