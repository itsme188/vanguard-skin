import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  countEarningsDateConflicts,
  getEarningsDateConflicts,
} from "@/lib/queries/calendar";

let db: Database.Database;
const TODAY = "2026-07-26";

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedConflict(
  symbol: string,
  date: string,
  opts: { status?: string; superseded?: number; conflictWith?: string | null } = {},
): number {
  return db
    .prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, title, symbol, source_key, raw_json,
          date_status, date_conflict_with, superseded, release_time)
       VALUES ('nasdaq', 'earnings', ?, ?, ?, ?, '{}', ?, ?, ?, '16:15')`,
    )
    .run(
      date,
      `${symbol} earnings`,
      symbol,
      `nasdaq:${symbol}:${date}`,
      opts.status ?? "conflict",
      opts.conflictWith === undefined ? `finnhub:${date}` : opts.conflictWith,
      opts.superseded ?? 0,
    ).lastInsertRowid as number;
}

describe("getEarningsDateConflicts (mobile conflicts surface)", () => {
  it("lists conflict rows in the 14-day window with the fields the inbox renders", () => {
    seedConflict("KRC", "2026-08-03");
    seedConflict("GFL", "2026-08-05", { conflictWith: "finnhub:2026-08-06" });

    const rows = getEarningsDateConflicts(db, TODAY);
    expect(rows).toHaveLength(2);
    expect(rows[0].symbol).toBe("KRC"); // date-ordered
    expect(rows[0].event_date).toBe("2026-08-03");
    expect(rows[0].release_time).toBe("16:15");
    expect(rows[1].date_conflict_with).toBe("finnhub:2026-08-06");
    // Same rows the badge counts — surface and badge must agree.
    expect(countEarningsDateConflicts(db, TODAY)).toBe(2);
  });

  it("excludes resolved, superseded, and out-of-window rows", () => {
    seedConflict("AAA", "2026-08-01", { status: "user_confirmed" });
    seedConflict("BBB", "2026-08-01", { superseded: 1 });
    seedConflict("CCC", "2026-09-15"); // beyond today+14
    seedConflict("DDD", "2026-07-20"); // past

    expect(getEarningsDateConflicts(db, TODAY)).toHaveLength(0);
  });

  it("fills security_id via issuer siblings so SymbolLink can render", () => {
    db.prepare(
      "INSERT INTO securities (symbol, name, security_type) VALUES ('GOOG', 'Alphabet C', 'Stock')",
    ).run();
    seedConflict("GOOGL", "2026-08-04");

    const rows = getEarningsDateConflicts(db, TODAY);
    expect(rows).toHaveLength(1);
    expect(rows[0].security_id).not.toBeNull();
  });
});
