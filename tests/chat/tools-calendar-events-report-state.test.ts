/**
 * QA finding chat-mobile-overlay-earnings-calendar-answer-all-accounts-chat-
 * says-unh-gs-and-jpm-already-reported-hours-befo (2026-10-13): at 04:20 ET
 * the chat told the owner three pre-open reporters "all reported before this
 * morning's open". The calendar tool handed the model dated rows with no word
 * on whether a result was on file, so the model guessed from the slot.
 *
 * Every row now carries a report_state and the result carries the Eastern
 * clock. Synthetic tickers only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { executeTool } from "@/lib/chat/tools";

let db: Database.Database;

type Row = { symbol: string; actual_value: string | null; report_state: string };
type Out = { data: { events: Row[]; now_et: string } };

beforeEach(() => {
  vi.useFakeTimers();
  // Tue 2026-03-10 04:20 ET (08:20 UTC, daylight time starts 2026-03-08).
  vi.setSystemTime(new Date("2026-03-10T08:20:00Z"));
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const ins = db.prepare(
    `INSERT INTO calendar_events
       (source, event_type, event_date, event_time, title, symbol, actual_value, superseded, source_key, week_of)
     VALUES ('manual', 'earnings', ?, ?, ?, ?, ?, 0, ?, '2026-03-09')`,
  );
  ins.run("2026-03-10", "07:00", "AAA earnings (pre-open, not out yet)", "AAA", null, "t:aaa");
  ins.run("2026-03-09", "16:05", "BBB earnings (reported)", "BBB", "EPS 1.20", "t:bbb");
  ins.run("2026-03-09", "16:05", "CCC earnings (no result on file)", "CCC", null, "t:ccc");
  ins.run("2026-03-12", "07:00", "DDD earnings (later this week)", "DDD", null, "t:ddd");
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe("chat query_calendar_events says whether a result is on file", () => {
  it("labels every row and carries the Eastern clock", async () => {
    const out = (await executeTool(db, "query_calendar_events", { event_type: "earnings", days_back: 2 })) as Out;
    const by = Object.fromEntries(out.data.events.map((e) => [e.symbol, e]));

    expect(by.AAA.actual_value).toBeNull();
    expect(by.AAA.report_state).toMatch(/^not yet reported/);
    expect(by.AAA.report_state).toMatch(/today/);
    expect(by.BBB.report_state).toBe("reported");
    expect(by.CCC.report_state).toMatch(/^not yet reported/);
    expect(by.CCC.report_state).not.toMatch(/today/);
    expect(by.DDD.report_state).toBe("upcoming");

    expect(out.data.now_et).toMatch(/^2026-03-10 04:20/);
  });
});
