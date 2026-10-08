/**
 * The Today releases block lists at most four upcoming releases. Its "+N more"
 * cue is `totalCount - listed`, so totalCount must use the list's own predicate
 * (dated after today, has a time, not superseded), bounded to the end of the
 * last listed row's week. A drifted predicate would make the cue lie.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getTodayReleases } from "@/lib/queries/calendar";
import { hiddenReleaseCount } from "@/app/dashboard/components/TodayReleases";

let db: Database.Database;
const TODAY = "2026-06-05"; // a Friday; the next week is Mon 06-08 .. Sun 06-14

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function add(symbol: string, date: string, opts: { time?: string | null; superseded?: number } = {}) {
  db.prepare(
    `INSERT INTO calendar_events
       (source, event_type, event_date, release_time, title, symbol, source_key, superseded)
     VALUES ('manual', 'earnings', ?, ?, ?, ?, ?, ?)`,
  ).run(
    date,
    opts.time === undefined ? "16:05" : opts.time,
    `${symbol} earnings`,
    symbol,
    `manual:${symbol}:${date}`,
    opts.superseded ?? 0,
  );
}

describe("getTodayReleases totalCount", () => {
  it("counts the rest of the last listed row's week with the list's own predicate", () => {
    add("ZZA", "2026-06-08");
    add("ZZB", "2026-06-09");
    add("ZZC", "2026-06-09");
    add("ZZD", "2026-06-10");
    add("ZZE", "2026-06-11"); // hidden, same week
    add("ZZF", "2026-06-12"); // hidden, same week
    add("ZZG", "2026-06-12", { time: null }); // no time: not a release row
    add("ZZH", "2026-06-12", { superseded: 1 }); // hidden twin: not counted
    add("ZZI", "2026-06-15"); // next week: outside the bound

    const r = getTodayReleases(db, TODAY);
    expect(r.mode).toBe("upcoming");
    expect(r.releases).toHaveLength(4);
    expect(r.totalCount).toBe(6);
    expect(hiddenReleaseCount(r.totalCount, r.releases.length)).toBe(2);
  });

  it("nothing hidden when four or fewer are upcoming", () => {
    add("ZZA", "2026-06-08");
    add("ZZB", "2026-06-09");
    const r = getTodayReleases(db, TODAY);
    expect(r.totalCount).toBe(2);
    expect(hiddenReleaseCount(r.totalCount, r.releases.length)).toBe(0);
  });

  it("today mode lists every row, so the total equals the list", () => {
    for (const s of ["ZZA", "ZZB", "ZZC", "ZZD", "ZZE"]) add(s, TODAY);
    add("ZZF", "2026-06-08");
    const r = getTodayReleases(db, TODAY);
    expect(r.mode).toBe("today");
    expect(r.totalCount).toBe(r.releases.length);
  });

  it("no releases at all", () => {
    expect(getTodayReleases(db, TODAY).totalCount).toBe(0);
  });
});
