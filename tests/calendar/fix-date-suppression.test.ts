/**
 * The "Fix date" marker and the suppression it leaves behind
 * (qa:today-earningshub-fix-date--suppression-row-delete-loses-coverage-permanently,
 * owner ruling 2026-09-02 option 2). Symbols are synthetic.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { fixDateOrigin, liftEarningsSuppression } from "@/lib/calendar/fix-date-suppression";
import { correctEarningsEventDate, suppressCalendarEvent } from "@/lib/mutations/calendar";
import { anchorIndex } from "../helpers/source-anchor";

vi.mock("@/lib/calendar/date-utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/calendar/date-utils")>()),
  todayET: () => "2026-08-31",
}));

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("fixDateOrigin", () => {
  it("reads the vendor date off a corrected manual row", () => {
    expect(
      fixDateOrigin({
        source: "manual",
        description: "Date corrected from 2026-09-03 (wrong sync-sourced date)",
      }),
    ).toBe("2026-09-03");
  });

  it("is null for a plain manual row, a blank description and any vendor row", () => {
    expect(fixDateOrigin({ source: "manual", description: null })).toBeNull();
    expect(fixDateOrigin({ source: "manual", description: "my own note" })).toBeNull();
    expect(
      fixDateOrigin({
        source: "finnhub",
        description: "Date corrected from 2026-09-03 (wrong sync-sourced date)",
      }),
    ).toBeNull();
  });

  it("recognises the row correctEarningsEventDate really mints", () => {
    db.prepare(
      `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key, week_of, raw_json)
       VALUES ('finnhub', 'earnings', '2026-09-03', 'ZZA earnings', 'ZZA', 'finnhub:ZZA:2026-09-03', '2026-08-31', '{}')`,
    ).run();
    const result = correctEarningsEventDate(db, {
      symbol: "ZZA",
      wrongDate: "2026-09-03",
      correctDate: "2026-09-04",
    });
    expect(result.ok).toBe(true);
    const minted = db
      .prepare("SELECT source, description FROM calendar_events WHERE id = ?")
      .get(result.newEventId) as { source: string; description: string | null };
    expect(fixDateOrigin(minted)).toBe("2026-09-03");
  });

  it("the description literal in the mutation still has the shape the reader matches", () => {
    const src = readFileSync("lib/mutations/calendar.ts", "utf8");
    anchorIndex(src, "description: `Date corrected from ${opts.wrongDate} (wrong sync-sourced date)`");
  });
});

describe("liftEarningsSuppression", () => {
  it("removes only the named (symbol, date) earnings suppression", () => {
    suppressCalendarEvent(db, { symbol: "ZZA", event_date: "2026-09-03" });
    suppressCalendarEvent(db, { symbol: "ZZA", event_date: "2026-09-10" });
    suppressCalendarEvent(db, { symbol: "ZZB", event_date: "2026-09-03" });

    expect(liftEarningsSuppression(db, { symbol: "zza", eventDate: "2026-09-03" })).toBe(1);
    const left = db
      .prepare("SELECT symbol, event_date FROM calendar_event_suppressions ORDER BY symbol, event_date")
      .all();
    expect(left).toEqual([
      { symbol: "ZZA", event_date: "2026-09-10" },
      { symbol: "ZZB", event_date: "2026-09-03" },
    ]);
    // Idempotent: nothing left to lift.
    expect(liftEarningsSuppression(db, { symbol: "ZZA", eventDate: "2026-09-03" })).toBe(0);
  });
});
