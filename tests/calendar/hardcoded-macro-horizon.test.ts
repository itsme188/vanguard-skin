/**
 * Weeks three and four of the week-ahead view showed earnings only
 * (user ruling 2026-10-05).
 *
 * Ruling: the hardcoded macro events — FOMC first, and the ISM / UMich /
 * Conference Board dates built by the same function — are synced for the full
 * four-week horizon earnings use, and a week whose FRED-sourced schedule has
 * not been fetched says so on the grid instead of showing an empty macro area.
 * Dates come ONLY from the hardcoded tables in lib/calendar/macro-events.ts.
 *
 * No network and no AI here: the API keys are unset and global fetch is a
 * stub that fails the test if anything reaches it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { runMigrations } from "@/lib/db/migrate";
import { syncCalendarForWeek } from "@/lib/calendar/sync";
import { buildHardcodedMacroEvents } from "@/lib/calendar/macro-events";
import {
  macroScheduleNotLoaded,
  MACRO_NOT_LOADED_NOTE,
} from "@/app/dashboard/today/WeekAheadView";

// "Today" for this file is Monday 2026-10-05; the week of 2026-10-26 is three
// weeks out and holds the hardcoded 2026-10-28 FOMC meeting.
const TODAY = "2026-10-05";
const WEEK = "2026-10-26";
const NO_OTHER_LEGS = { includeWsh: false, includeFinnhub: false, includeNasdaq: false };

let db: Database.Database;
const saved = { fred: process.env.FRED_API_KEY, ai: process.env.ANTHROPIC_API_KEY };
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  delete process.env.FRED_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  fetchSpy = vi.fn(async () => {
    throw new Error("network is off in tests");
  });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (saved.fred === undefined) delete process.env.FRED_API_KEY;
  else process.env.FRED_API_KEY = saved.fred;
  if (saved.ai === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = saved.ai;
});

function rows(): Array<{ source_key: string; event_date: string; event_type: string; week_of: string }> {
  return db
    .prepare(
      `SELECT source_key, event_date, event_type, week_of FROM calendar_events ORDER BY source_key`,
    )
    .all() as Array<{ source_key: string; event_date: string; event_type: string; week_of: string }>;
}

describe("hardcoded macro events across the four-week horizon", () => {
  it("syncing a week three weeks out inserts the hardcoded FOMC row", async () => {
    const result = await syncCalendarForWeek(db, WEEK, NO_OTHER_LEGS);
    // No source key is a failed read of the release schedule, reported as
    // such (2026-10-07): it used to come back as an empty schedule, which the
    // orphan cleanup then acted on. The built-in rows still land.
    expect(result.errors).toEqual([expect.stringMatching(/^macro: FRED_API_KEY/)]);
    const fomc = rows().filter((r) => r.event_type === "fomc");
    expect(fomc).toEqual([
      { source_key: "fomc:2026-10-28", event_date: "2026-10-28", event_type: "fomc", week_of: WEEK },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the other hardcoded indicators in that week come with it", async () => {
    await syncCalendarForWeek(db, WEEK, NO_OTHER_LEGS);
    expect(rows().map((r) => r.source_key)).toContain("nonfred:Consumer_Confidence:2026-10-27");
  });

  it("is idempotent on a second run", async () => {
    await syncCalendarForWeek(db, WEEK, NO_OTHER_LEGS);
    const first = rows();
    const second = await syncCalendarForWeek(db, WEEK, NO_OTHER_LEGS);
    expect(rows()).toEqual(first);
    expect(second.macroNew).toBe(0);
  });

  it("a FRED failure no longer takes the FOMC row down with it", async () => {
    process.env.FRED_API_KEY = "test-key"; // the FRED leg now runs — and the stub fails it
    const result = await syncCalendarForWeek(db, WEEK, NO_OTHER_LEGS);
    expect(result.errors).toEqual([expect.stringMatching(/^macro: /)]);
    expect(rows().map((r) => r.source_key)).toEqual([
      "fomc:2026-10-28",
      "nonfred:Consumer_Confidence:2026-10-27",
    ]);
    expect(result.macroEvents).toBe(2);

    // …and the fallback is idempotent too.
    const again = await syncCalendarForWeek(db, WEEK, NO_OTHER_LEGS);
    expect(rows()).toHaveLength(2);
    expect(again.macroNew).toBe(0);
  });

  it("the fallback does not re-add an indicator the verified road moved to another date", async () => {
    // The normal road wrote Consumer Confidence on a publisher-rescheduled date.
    db.prepare(
      `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, week_of)
       VALUES ('claude_macro', 'other_macro', '2026-10-29', 'October Consumer Confidence',
               'nonfred:Consumer_Confidence:2026-10-29', ?)`,
    ).run(WEEK);
    process.env.FRED_API_KEY = "test-key";
    await syncCalendarForWeek(db, WEEK, NO_OTHER_LEGS);
    expect(rows().map((r) => r.source_key)).toEqual([
      "fomc:2026-10-28",
      "nonfred:Consumer_Confidence:2026-10-29",
    ]);
  });

  it("never invents a date: a week past the end of the hardcoded tables yields nothing", () => {
    expect(buildHardcodedMacroEvents("2027-01-25", "2027-01-31", "2027-01-25").events).toEqual([]);
    // A week with no meeting has no FOMC row.
    const quiet = buildHardcodedMacroEvents("2026-10-12", "2026-10-18", "2026-10-12").events;
    expect(quiet.some((e) => e.event_type === "fomc")).toBe(false);
  });

  it("the Sunday briefing still syncs four weeks (source pin on the horizon)", () => {
    const src = readFileSync("lib/digest/send-briefing.ts", "utf8");
    expect(src).toMatch(
      /\[weekOf, addDays\(weekOf, 7\), addDays\(weekOf, 14\), addDays\(weekOf, 21\)\]/,
    );
  });
});

describe("macroScheduleNotLoaded — the grid's 'macro not loaded' helper", () => {
  const fomcOnly = [{ source_key: "fomc:2026-10-28" }, { source_key: "finnhub:ZQTEST:2026-10-27" }];
  const withFred = [...fomcOnly, { source_key: "fred:10:2026-10-29" }];

  it("reports not loaded for an upcoming week with no FRED rows — hardcoded rows do not count", () => {
    expect(macroScheduleNotLoaded(fomcOnly, WEEK, TODAY)).toBe(true);
    expect(macroScheduleNotLoaded([], WEEK, TODAY)).toBe(true);
  });

  it("reports loaded once a FRED row is present", () => {
    expect(macroScheduleNotLoaded(withFred, WEEK, TODAY)).toBe(false);
  });

  it("covers the current week, never a past one", () => {
    expect(macroScheduleNotLoaded(fomcOnly, "2026-10-05", TODAY)).toBe(true);
    expect(macroScheduleNotLoaded(fomcOnly, "2026-09-21", TODAY)).toBe(false);
  });

  it("the grid renders the note in the muted style (source pin)", () => {
    const src = readFileSync("app/dashboard/today/WeekAheadView.tsx", "utf8");
    expect(MACRO_NOT_LOADED_NOTE).toBe("Macro schedule not loaded yet for this week");
    expect(src).toMatch(
      /macroNotLoaded && \(\s*<p className="text-\[13px\] text-ink-faint italic">\{MACRO_NOT_LOADED_NOTE\}<\/p>/,
    );
  });
});
