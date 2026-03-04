import type Database from "better-sqlite3";
import type { Account, MonthlySnapshot } from "@/lib/types";

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

export function getAccountSummaries(db: Database.Database): AccountSummary[] {
  const accounts = db
    .prepare("SELECT id, name FROM accounts ORDER BY id")
    .all() as Account[];

  return accounts.map((account) => {
    const latest = db
      .prepare(
        "SELECT * FROM monthly_snapshots WHERE account_id = ? ORDER BY month_end_date DESC LIMIT 1"
      )
      .get(account.id) as MonthlySnapshot | undefined;

    const previous = db
      .prepare(
        "SELECT * FROM monthly_snapshots WHERE account_id = ? ORDER BY month_end_date DESC LIMIT 1 OFFSET 1"
      )
      .get(account.id) as MonthlySnapshot | undefined;

    const latestValue = latest?.total_value ?? null;
    const previousValue = previous?.total_value ?? null;
    const monthlyChange =
      latestValue !== null && previousValue !== null
        ? latestValue - previousValue
        : null;
    const monthlyChangePercent =
      monthlyChange !== null && previousValue !== null && previousValue !== 0
        ? (monthlyChange / previousValue) * 100
        : null;

    return {
      id: account.id,
      name: account.name,
      latestValue,
      previousValue,
      latestDate: latest?.month_end_date ?? null,
      monthlyChange,
      monthlyChangePercent,
      twr: latest?.twr ?? null,
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
