import type Database from "better-sqlite3";
import type { MonthlySnapshot } from "@/lib/types";

export function getSnapshotsByAccount(db: Database.Database, accountId: number): MonthlySnapshot[] {
  return db
    .prepare("SELECT * FROM monthly_snapshots WHERE account_id = ? ORDER BY month_end_date")
    .all(accountId) as MonthlySnapshot[];
}

export function getAllSnapshots(db: Database.Database): MonthlySnapshot[] {
  return db
    .prepare("SELECT * FROM monthly_snapshots ORDER BY month_end_date, account_id")
    .all() as MonthlySnapshot[];
}

export function getLatestSnapshotByAccount(db: Database.Database, accountId: number): MonthlySnapshot | null {
  return (
    db
      .prepare("SELECT * FROM monthly_snapshots WHERE account_id = ? ORDER BY month_end_date DESC LIMIT 1")
      .get(accountId) as MonthlySnapshot
  ) ?? null;
}
