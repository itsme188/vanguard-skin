import type Database from "better-sqlite3";

export interface AccountSummary {
  id: number;
  name: string;
  latestValue: number | null;
  previousValue: number | null;
  latestDate: string | null;
  monthlyChange: number | null;
  monthlyChangePercent: number | null;
  twr: number | null;
}

interface AccountSummaryRow {
  id: number;
  name: string;
  latestValue: number | null;
  latestDate: string | null;
  twr: number | null;
  previousValue: number | null;
}

export function getAccountSummaries(db: Database.Database): AccountSummary[] {
  const rows = db
    .prepare(
      `WITH ranked_monthly AS (
        SELECT
          ms.account_id,
          ms.month_end_date,
          ms.total_value,
          ms.twr,
          ROW_NUMBER() OVER (PARTITION BY ms.account_id ORDER BY ms.month_end_date DESC) AS rn
        FROM monthly_snapshots ms
        WHERE ms.source != 'tws'
      ),
      latest_daily AS (
        SELECT
          dv.account_id,
          dv.valuation_date,
          dv.total_value,
          ROW_NUMBER() OVER (PARTITION BY dv.account_id ORDER BY dv.valuation_date DESC) AS rn
        FROM daily_valuations dv
      )
      SELECT
        a.id, a.name,
        CASE WHEN COALESCE(d.valuation_date, '') > COALESCE(curr.month_end_date, '')
          THEN d.total_value ELSE curr.total_value END AS latestValue,
        CASE WHEN COALESCE(d.valuation_date, '') > COALESCE(curr.month_end_date, '')
          THEN d.valuation_date ELSE curr.month_end_date END AS latestDate,
        curr.twr,
        -- Previous: most recent non-TWS monthly snapshot strictly before the latest date
        (SELECT ms2.total_value FROM monthly_snapshots ms2
         WHERE ms2.account_id = a.id
           AND ms2.source != 'tws'
           AND ms2.month_end_date < CASE
             WHEN COALESCE(d.valuation_date, '') > COALESCE(curr.month_end_date, '')
             THEN d.valuation_date ELSE curr.month_end_date END
         ORDER BY ms2.month_end_date DESC LIMIT 1) AS previousValue
      FROM accounts a
      LEFT JOIN ranked_monthly curr ON curr.account_id = a.id AND curr.rn = 1
      LEFT JOIN latest_daily d ON d.account_id = a.id AND d.rn = 1
      ORDER BY a.id`
    )
    .all() as AccountSummaryRow[];

  return rows.map((row) => {
    const monthlyChange =
      row.latestValue !== null && row.previousValue !== null
        ? row.latestValue - row.previousValue
        : null;
    const monthlyChangePercent =
      monthlyChange !== null && row.previousValue !== null && row.previousValue !== 0
        ? (monthlyChange / row.previousValue) * 100
        : null;

    return {
      id: row.id,
      name: row.name,
      latestValue: row.latestValue,
      previousValue: row.previousValue,
      latestDate: row.latestDate,
      monthlyChange,
      monthlyChangePercent,
      twr: row.twr ?? null,
    };
  });
}

export interface PortfolioChartPoint {
  date: string;
  [accountName: string]: string | number;
}

export function getPortfolioChartData(
  db: Database.Database
): PortfolioChartPoint[] {
  const snapshots = db
    .prepare(
      `SELECT ms.month_end_date, a.name as account_name, ms.total_value
       FROM monthly_snapshots ms
       JOIN accounts a ON a.id = ms.account_id
       WHERE ms.source != 'tws'
       ORDER BY ms.month_end_date`
    )
    .all() as {
    month_end_date: string;
    account_name: string;
    total_value: number;
  }[];

  const byDate = new Map<string, PortfolioChartPoint>();
  for (const snap of snapshots) {
    if (!byDate.has(snap.month_end_date)) {
      byDate.set(snap.month_end_date, { date: snap.month_end_date });
    }
    byDate.get(snap.month_end_date)![snap.account_name] = snap.total_value;
  }

  return Array.from(byDate.values());
}

export interface PortfolioTotals {
  totalValue: number;
  totalPreviousValue: number;
  totalChange: number;
  totalChangePercent: number;
  accountCount: number;
  snapshotCount: number;
  latestDate: string | null;
  oldestDate: string | null;
}

export function getPortfolioTotals(db: Database.Database): PortfolioTotals {
  // Use same blending logic as getAccountSummaries: pick daily valuation or
  // non-TWS monthly snapshot per account, whichever is more recent.
  const row = db
    .prepare(
      `WITH latest_monthly AS (
        SELECT account_id, month_end_date, total_value,
          ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY month_end_date DESC) AS rn
        FROM monthly_snapshots
        WHERE source != 'tws'
      ),
      latest_daily AS (
        SELECT account_id, valuation_date, total_value,
          ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY valuation_date DESC) AS rn
        FROM daily_valuations
      ),
      account_values AS (
        SELECT
          a.id,
          CASE WHEN COALESCE(d.valuation_date, '') > COALESCE(m.month_end_date, '')
            THEN d.total_value ELSE m.total_value END AS current_value,
          CASE WHEN COALESCE(d.valuation_date, '') > COALESCE(m.month_end_date, '')
            THEN d.valuation_date ELSE m.month_end_date END AS as_of_date,
          (SELECT ms2.total_value FROM monthly_snapshots ms2
           WHERE ms2.account_id = a.id AND ms2.source != 'tws'
             AND ms2.month_end_date < CASE
               WHEN COALESCE(d.valuation_date, '') > COALESCE(m.month_end_date, '')
               THEN d.valuation_date ELSE m.month_end_date END
           ORDER BY ms2.month_end_date DESC LIMIT 1) AS prev_value
        FROM accounts a
        LEFT JOIN latest_monthly m ON m.account_id = a.id AND m.rn = 1
        LEFT JOIN latest_daily d ON d.account_id = a.id AND d.rn = 1
      )
      SELECT
        COALESCE(SUM(current_value), 0) AS totalValue,
        COALESCE(SUM(prev_value), 0) AS totalPreviousValue,
        MIN(as_of_date) AS oldestDate,
        MAX(as_of_date) AS latestDate
      FROM account_values`
    )
    .get() as {
    totalValue: number;
    totalPreviousValue: number;
    oldestDate: string | null;
    latestDate: string | null;
  };

  const totalChange = row.totalValue - row.totalPreviousValue;
  const totalChangePercent =
    row.totalPreviousValue !== 0
      ? (totalChange / row.totalPreviousValue) * 100
      : 0;

  const snapshotCount = (
    db
      .prepare("SELECT COUNT(*) as count FROM monthly_snapshots WHERE source != 'tws'")
      .get() as { count: number }
  ).count;
  const accountCount = (
    db.prepare("SELECT COUNT(*) as count FROM accounts").get() as {
      count: number;
    }
  ).count;

  return {
    totalValue: row.totalValue,
    totalPreviousValue: row.totalPreviousValue,
    totalChange,
    totalChangePercent,
    accountCount,
    snapshotCount,
    latestDate: row.latestDate,
    oldestDate: row.oldestDate,
  };
}
