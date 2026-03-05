import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getSnapshotsByAccount,
  getAllSnapshots,
  getLatestSnapshotByAccount,
} from "@/lib/queries/monthly-snapshots";

function seedSnapshot(
  db: Database.Database,
  accountId: number,
  monthEnd: string,
  totalValue: number
): void {
  db.prepare(
    `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value)
     VALUES (?, ?, ?)`
  ).run(accountId, monthEnd, totalValue);
}

describe("monthly-snapshots queries", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  describe("getSnapshotsByAccount", () => {
    it("returns snapshots ordered by date", () => {
      seedSnapshot(db, 1, "2025-02-28", 110000);
      seedSnapshot(db, 1, "2025-01-31", 100000);

      const snapshots = getSnapshotsByAccount(db, 1);
      expect(snapshots).toHaveLength(2);
      expect(snapshots[0].month_end_date).toBe("2025-01-31");
      expect(snapshots[1].month_end_date).toBe("2025-02-28");
    });

    it("returns empty array for account with no snapshots", () => {
      const snapshots = getSnapshotsByAccount(db, 1);
      expect(snapshots).toHaveLength(0);
    });

    it("only returns snapshots for the specified account", () => {
      seedSnapshot(db, 1, "2025-01-31", 100000);
      seedSnapshot(db, 2, "2025-01-31", 50000);

      const snapshots = getSnapshotsByAccount(db, 1);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].total_value).toBe(100000);
    });
  });

  describe("getAllSnapshots", () => {
    it("returns all snapshots ordered by date then account", () => {
      seedSnapshot(db, 1, "2025-01-31", 100000);
      seedSnapshot(db, 2, "2025-01-31", 50000);
      seedSnapshot(db, 1, "2025-02-28", 110000);

      const snapshots = getAllSnapshots(db);
      expect(snapshots).toHaveLength(3);
      expect(snapshots[0].month_end_date).toBe("2025-01-31");
      expect(snapshots[0].account_id).toBe(1);
      expect(snapshots[1].month_end_date).toBe("2025-01-31");
      expect(snapshots[1].account_id).toBe(2);
      expect(snapshots[2].month_end_date).toBe("2025-02-28");
    });
  });

  describe("getLatestSnapshotByAccount", () => {
    it("returns the most recent snapshot", () => {
      seedSnapshot(db, 1, "2025-01-31", 100000);
      seedSnapshot(db, 1, "2025-02-28", 110000);

      const latest = getLatestSnapshotByAccount(db, 1);
      expect(latest).not.toBeNull();
      expect(latest!.month_end_date).toBe("2025-02-28");
      expect(latest!.total_value).toBe(110000);
    });

    it("returns null when no snapshots exist", () => {
      const latest = getLatestSnapshotByAccount(db, 1);
      expect(latest).toBeNull();
    });
  });
});
