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
      `WITH ranked AS (
        SELECT
          ms.account_id,
          ms.month_end_date,
          ms.total_value,
          ms.twr,
          ROW_NUMBER() OVER (PARTITION BY ms.account_id ORDER BY ms.month_end_date DESC) AS rn
        FROM monthly_snapshots ms
      )
      SELECT
        a.id, a.name,
        curr.total_value AS latestValue,
        curr.month_end_date AS latestDate,
        curr.twr,
        prev.total_value AS previousValue
      FROM accounts a
      LEFT JOIN ranked curr ON curr.account_id = a.id AND curr.rn = 1
      LEFT JOIN ranked prev ON prev.account_id = a.id AND prev.rn = 2
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
}

export function getPortfolioTotals(db: Database.Database): PortfolioTotals {
  const latestValues = db
    .prepare(
      `SELECT ms.total_value
       FROM monthly_snapshots ms
       INNER JOIN (
         SELECT account_id, MAX(month_end_date) as max_date
         FROM monthly_snapshots
         GROUP BY account_id
       ) latest ON ms.account_id = latest.account_id
         AND ms.month_end_date = latest.max_date`
    )
    .all() as { total_value: number }[];

  const previousValues = db
    .prepare(
      `SELECT ms.total_value
       FROM monthly_snapshots ms
       INNER JOIN (
         SELECT account_id, MAX(month_end_date) as max_date
         FROM monthly_snapshots
         WHERE month_end_date < (SELECT MAX(month_end_date) FROM monthly_snapshots)
         GROUP BY account_id
       ) prev ON ms.account_id = prev.account_id
         AND ms.month_end_date = prev.max_date`
    )
    .all() as { total_value: number }[];

  const totalValue = latestValues.reduce((sum, v) => sum + v.total_value, 0);
  const totalPreviousValue = previousValues.reduce(
    (sum, v) => sum + v.total_value,
    0
  );
  const totalChange = totalValue - totalPreviousValue;
  const totalChangePercent =
    totalPreviousValue !== 0 ? (totalChange / totalPreviousValue) * 100 : 0;

  const snapshotCount = (
    db
      .prepare("SELECT COUNT(*) as count FROM monthly_snapshots")
      .get() as { count: number }
  ).count;
  const accountCount = (
    db.prepare("SELECT COUNT(*) as count FROM accounts").get() as {
      count: number;
    }
  ).count;

  return {
    totalValue,
    totalPreviousValue,
    totalChange,
    totalChangePercent,
    accountCount,
    snapshotCount,
  };
}
