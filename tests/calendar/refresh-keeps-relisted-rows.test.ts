/**
 * A refresh refreshes a re-listed row IN PLACE.
 *
 * Before 2026-10-24 the finnhub / nasdaq cleanup deleted every unenriched row
 * of the week and the upsert re-created the re-listed ones under new ids. The
 * re-minted row lost its date-verification note and stamp, and every child row
 * keyed on the id (bogey-scan ledger, worksheet flag, filing-summary record)
 * went with it through ON DELETE CASCADE. The macro phase already passed its
 * fresh keys as the keep list; the earnings phases now do the same, and the
 * delete also protects a row that carries one of those child records.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { replaceWeekRowsPublishingRemovals } from "@/lib/calendar/sync";
import { deleteUnenrichedEventsForWeek, type CalendarEventInput } from "@/lib/mutations/calendar";
import { todayET, addDays, mondayOf } from "@/lib/calendar/date-utils";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

const WEEK = mondayOf(todayET());
const D1 = addDays(WEEK, 1);
const D2 = addDays(WEEK, 3);

type Src = "finnhub" | "nasdaq";
const input = (symbol: string, date: string, source: Src = "finnhub"): CalendarEventInput =>
  ({
    source,
    event_type: "earnings",
    event_date: date,
    event_time: "AMC",
    title: `${symbol} earnings`,
    source_key: `${source}:${symbol}:${date}`,
    symbol,
    week_of: WEEK,
  }) as CalendarEventInput;

const seed = (symbol: string, date: string, source: Src = "finnhub") =>
  Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, event_time, title, source_key, symbol, week_of)
         VALUES (?, 'earnings', ?, 'AMC', ?, ?, ?, ?)`,
      )
      .run(source, date, `${symbol} earnings`, `${source}:${symbol}:${date}`, symbol, WEEK).lastInsertRowid,
  );

const stampVerified = (id: number) =>
  db
    .prepare(
      `UPDATE calendar_events SET date_verified_at = '2026-01-02 03:04:05', date_verification_note = 'checked: both vendors agree' WHERE id = ?`,
    )
    .run(id);

const seedArticle = () => {
  const src = Number(db.prepare(`INSERT INTO research_sources (name) VALUES ('Letter')`).run().lastInsertRowid);
  return Number(
    db
      .prepare(
        `INSERT INTO research_articles (source_id, received_at, subject, sender, raw_text)
         VALUES (?, '2026-01-01 12:00:00', 'Preview', 'a@b.c', 'text')`,
      )
      .run(src).lastInsertRowid,
  );
};

const addScan = (eventId: number, articleId: number) =>
  db
    .prepare(
      `INSERT INTO earnings_bogey_scans (event_id, article_id, extractor_version, status) VALUES (?, ?, 1, 'no_numbers')`,
    )
    .run(eventId, articleId);

const row = (id: number) =>
  db
    .prepare(`SELECT id, date_verified_at, date_verification_note FROM calendar_events WHERE id = ?`)
    .get(id) as { id: number; date_verified_at: string | null; date_verification_note: string | null } | undefined;

describe("a refresh keeps a re-listed earnings row in place", () => {
  for (const source of ["finnhub", "nasdaq"] as Src[]) {
    it(`${source}: the re-listed row keeps its id, its date-verification stamp and its bogey-scan ledger`, () => {
      const kept = seed("AAA", D1, source);
      stampVerified(kept);
      addScan(kept, seedArticle());

      const res = replaceWeekRowsPublishingRemovals(db, WEEK, source, [input("AAA", D1, source)]);

      expect(res.updated).toBe(1);
      expect(res.inserted).toBe(0);
      expect(row(kept)).toEqual({
        id: kept,
        date_verified_at: "2026-01-02 03:04:05",
        date_verification_note: "checked: both vendors agree",
      });
      expect(db.prepare(`SELECT COUNT(*) AS n FROM earnings_bogey_scans WHERE event_id = ?`).get(kept)).toEqual({
        n: 1,
      });
      expect(db.prepare(`SELECT COUNT(*) AS n FROM calendar_events`).get()).toEqual({ n: 1 });
    });
  }

  it("a row the vendor no longer lists is still removed, and only that one", () => {
    const dropped = seed("AAA", D1);
    const kept = seed("BBB", D1);
    replaceWeekRowsPublishingRemovals(db, WEEK, "finnhub", [input("BBB", D1)]);
    expect(db.prepare(`SELECT id FROM calendar_events ORDER BY id`).all()).toEqual([{ id: kept }]);
    expect(row(dropped)).toBeUndefined();
  });

  it("a vendor date move still replaces the row: the key carries the date, so the old row is an orphan", () => {
    const old = seed("AAA", D1);
    stampVerified(old);
    replaceWeekRowsPublishingRemovals(db, WEEK, "finnhub", [input("AAA", D2)]);
    const rows = db.prepare(`SELECT id, event_date, date_verification_note FROM calendar_events`).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_date: D2, date_verification_note: null });
    expect((rows[0] as { id: number }).id).not.toBe(old);
  });
});

describe("deleteUnenrichedEventsForWeek protects a row with an owner-facing child record", () => {
  it("keeps a row with a bogey-scan ledger entry", () => {
    const kept = seed("AAA", D1);
    const gone = seed("BBB", D1);
    addScan(kept, seedArticle());
    expect(deleteUnenrichedEventsForWeek(db, WEEK, "finnhub")).toBe(1);
    expect(row(kept)).toBeTruthy();
    expect(row(gone)).toBeUndefined();
  });

  it("keeps an armed row (worksheet flag) even before it has a bogey", () => {
    const kept = seed("AAA", D1);
    db.prepare(`INSERT INTO earnings_worksheet_flags (event_id) VALUES (?)`).run(kept);
    expect(deleteUnenrichedEventsForWeek(db, WEEK, "finnhub")).toBe(0);
    expect(row(kept)).toBeTruthy();
  });

  it("keeps a row with a filing-summary record", () => {
    const kept = seed("AAA", D1);
    db.prepare(`INSERT INTO filing_summary_events (event_id) VALUES (?)`).run(kept);
    expect(deleteUnenrichedEventsForWeek(db, WEEK, "finnhub")).toBe(0);
    expect(row(kept)).toBeTruthy();
  });
});
