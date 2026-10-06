/**
 * getEventById — the one healed by-id reader for a calendar event.
 *
 * A manual-actuals acceptance stamp can sit on a superseded twin of the same
 * print (lib/queries/manual-actuals-cluster.ts). Every reader that feeds a
 * plausibility decision must see the cluster's stamp, not just the row's own.
 * Synthetic figures only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getEventById } from "@/lib/queries/calendar";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

const STAMP = "2026-08-27 20:17:20";

function seed(opts: {
  symbol: string;
  source: string;
  superseded?: number;
  actual?: string | null;
  manualAt?: string | null;
  eventDate?: string;
}): number {
  return db
    .prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, event_time, release_time, title, symbol,
          consensus_value, actual_value, manual_actuals_at, superseded, source_key, week_of)
       VALUES (?, 'earnings', ?, 'AMC', '16:05', ?, ?, 'EPS 0.10 · Rev 400000000', ?, ?, ?, ?, '2026-08-24')`,
    )
    .run(
      opts.source,
      opts.eventDate ?? "2026-08-27",
      `${opts.symbol} earnings`,
      opts.symbol,
      opts.actual === undefined ? "EPS 0.50 · Rev 420000000" : opts.actual,
      opts.manualAt ?? null,
      opts.superseded ?? 0,
      `${opts.source}:${opts.symbol}:${opts.eventDate ?? "2026-08-27"}`,
    ).lastInsertRowid as number;
}

describe("getEventById", () => {
  it("returns null for a missing id", () => {
    expect(getEventById(db, 999)).toBeNull();
  });

  it("returns the full row with its own stamp", () => {
    const id = seed({ symbol: "ACME", source: "finnhub", manualAt: STAMP });
    const ev = getEventById(db, id);
    expect(ev?.id).toBe(id);
    expect(ev?.symbol).toBe("ACME");
    expect(ev?.actual_value).toBe("EPS 0.50 · Rev 420000000");
    expect(ev?.manual_actuals_at).toBe(STAMP);
  });

  it("heals the stamp from a superseded twin carrying the same accepted figure", () => {
    seed({ symbol: "ACME", source: "finnhub", superseded: 1, manualAt: STAMP });
    const canonical = seed({ symbol: "ACME", source: "nasdaq" });
    expect(getEventById(db, canonical)?.manual_actuals_at).toBe(STAMP);
    // Read-only: the heal never writes the stamp back.
    const stored = db
      .prepare(`SELECT manual_actuals_at FROM calendar_events WHERE id = ?`)
      .get(canonical) as { manual_actuals_at: string | null };
    expect(stored.manual_actuals_at).toBeNull();
  });

  it("does not borrow a stamp from a twin whose figure differs", () => {
    seed({
      symbol: "ACME", source: "finnhub", superseded: 1, manualAt: STAMP,
      actual: "EPS 0.60 · Rev 430000000",
    });
    const canonical = seed({ symbol: "ACME", source: "nasdaq" });
    expect(getEventById(db, canonical)?.manual_actuals_at).toBeNull();
  });
});
