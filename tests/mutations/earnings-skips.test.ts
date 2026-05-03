import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  recordEarningsEmailSkip,
  unrecordEarningsEmailSkip,
} from "@/lib/mutations/earnings-skips";
import { getSkippedPhasesForEvents } from "@/lib/queries/earnings-skips";

function seedEvent(db: Database.Database, id: number, symbol: string): void {
  db.prepare(
    `INSERT INTO calendar_events (
       id, source, event_type, event_date, title, source_key, symbol
     ) VALUES (?, 'finnhub', 'earnings', '2026-06-01', ?, ?, ?)`,
  ).run(id, `${symbol} earnings`, `finnhub:${symbol}:2026-06-01`, symbol);
}

describe("earnings-skips mutation + query", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    seedEvent(db, 1, "AAPL");
    seedEvent(db, 2, "MSFT");
  });

  it("records a skip and reports it via getSkippedPhasesForEvents", () => {
    const inserted = recordEarningsEmailSkip(db, 1, "preview");
    expect(inserted).toBe(true);
    expect(getSkippedPhasesForEvents(db, [1, 2])).toEqual({
      1: { preview: true, recap: false },
    });
  });

  it("idempotent: re-skipping returns false and stays a single row", () => {
    expect(recordEarningsEmailSkip(db, 1, "preview")).toBe(true);
    expect(recordEarningsEmailSkip(db, 1, "preview")).toBe(false);
    const count = (db
      .prepare("SELECT COUNT(*) AS n FROM earnings_email_skips")
      .get() as { n: number }).n;
    expect(count).toBe(1);
  });

  it("preview and recap are independent phases", () => {
    recordEarningsEmailSkip(db, 1, "preview");
    recordEarningsEmailSkip(db, 1, "recap");
    expect(getSkippedPhasesForEvents(db, [1])).toEqual({
      1: { preview: true, recap: true },
    });
  });

  it("unrecord deletes the matching row only", () => {
    recordEarningsEmailSkip(db, 1, "preview");
    recordEarningsEmailSkip(db, 1, "recap");
    expect(unrecordEarningsEmailSkip(db, 1, "preview")).toBe(true);
    expect(getSkippedPhasesForEvents(db, [1])).toEqual({
      1: { preview: false, recap: true },
    });
  });

  it("ON DELETE CASCADE: skip rows disappear when their event is deleted", () => {
    recordEarningsEmailSkip(db, 1, "preview");
    db.prepare("DELETE FROM calendar_events WHERE id = ?").run(1);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM earnings_email_skips").get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it("getSkippedPhasesForEvents returns empty object for empty input", () => {
    expect(getSkippedPhasesForEvents(db, [])).toEqual({});
  });
});
