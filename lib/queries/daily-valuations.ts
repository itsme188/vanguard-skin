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
 * Get aggregated daily valuations across all accounts within a date range.
 * Returns one row per date with summed values.
 */
export function getDailyValuationsCombined(
  db: Database.Database,
  options?: {
    startDate?: string;
    endDate?: string;
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

  return db
    .prepare(
      `SELECT valuation_date, 0 AS account_id,
              SUM(cash_balance) AS cash_balance,
              SUM(holdings_value) AS holdings_value,
              SUM(total_value) AS total_value
       FROM daily_valuations
       ${where}
       GROUP BY valuation_date
       ORDER BY valuation_date ASC`
    )
    .all(...params) as DailyValuation[];
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
