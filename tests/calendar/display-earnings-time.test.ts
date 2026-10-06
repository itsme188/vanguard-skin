/**
 * User ruling 2026-10-06, "Option A, display only": a vendor earnings row that
 * arrived with no before-open / after-close slot STORES the 16:15 default, and
 * every screen used to print "4:15 PM" as if confirmed. The screen now shows
 * the company's own usual time (marked as an estimate) or "time unknown" —
 * while the stored time, and every gate that reads it, stays exactly as it is.
 *
 * All fixtures are synthetic (made-up tickers, no real figures).
 */

import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  displayEarningsTime,
  isDefaultedEarningsTime,
  withDisplayTimes,
} from "@/lib/calendar/display-earnings-time";
import { getTodayReleases } from "@/lib/queries/calendar";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

const hourJson = (hour: string | null) => JSON.stringify({ entry: { hour } });

interface Seed {
  symbol: string;
  date: string;
  source?: string;
  eventTime?: string | null;
  releaseTime?: string | null;
  rawJson?: string | null;
  actual?: string | null;
  superseded?: number;
  eventType?: string;
}

function seed(s: Seed) {
  const source = s.source ?? "nasdaq";
  const id = db
    .prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, event_time, release_time, title, symbol,
          raw_json, actual_value, source_key, superseded)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      source,
      s.eventType ?? "earnings",
      s.date,
      s.eventTime ?? null,
      s.releaseTime === undefined ? "16:15" : s.releaseTime,
      `${s.symbol} earnings`,
      s.symbol,
      s.rawJson === undefined ? hourJson(null) : s.rawJson,
      s.actual ?? null,
      `${source}:${s.symbol}:${s.date}:${s.eventType ?? "earnings"}`,
      s.superseded ?? 0,
    ).lastInsertRowid as number;
  return db.prepare(`SELECT * FROM calendar_events WHERE id = ?`).get(id) as Parameters<
    typeof displayEarningsTime
  >[1];
}

/** A past, reported, vendor-sourced print with a real slot. */
function pastPrint(symbol: string, date: string, hour: "bmo" | "amc", source = "finnhub") {
  return seed({
    symbol,
    date,
    source,
    rawJson: hourJson(hour),
    releaseTime: hour === "bmo" ? "08:00" : "16:15",
    actual: "EPS 1.00 / Rev 10M",
  });
}

describe("displayEarningsTime", () => {
  it("shows the stored time for a row with a real vendor slot", () => {
    const amc = seed({ symbol: "ZZAA", date: "2026-10-08", rawJson: hourJson("amc") });
    expect(isDefaultedEarningsTime(amc)).toBe(false);
    expect(displayEarningsTime(db, amc)).toEqual({ label: "4:15 PM", kind: "stored" });

    const bmo = seed({
      symbol: "ZZAB",
      date: "2026-10-08",
      rawJson: hourJson("bmo"),
      releaseTime: "08:00",
    });
    expect(displayEarningsTime(db, bmo)).toEqual({ label: "8:00 AM", kind: "stored" });
  });

  it("never second-guesses a real slot even when history disagrees", () => {
    pastPrint("ZZAC", "2026-04-20", "bmo");
    pastPrint("ZZAC", "2026-07-20", "bmo");
    const row = seed({ symbol: "ZZAC", date: "2026-10-08", rawJson: hourJson("amc") });
    expect(displayEarningsTime(db, row)).toEqual({ label: "4:15 PM", kind: "stored" });
  });

  it("shows the stored time for a manual row and for an explicit clock time", () => {
    const manual = seed({ symbol: "ZZAD", date: "2026-10-08", source: "manual", rawJson: null });
    expect(displayEarningsTime(db, manual)).toEqual({ label: "4:15 PM", kind: "stored" });

    const explicit = seed({ symbol: "ZZAE", date: "2026-10-08", eventTime: "16:15" });
    expect(displayEarningsTime(db, explicit)).toEqual({ label: "4:15 PM", kind: "stored" });
  });

  it("a slot-less row whose stored time is not the default is shown as stored", () => {
    const row = seed({ symbol: "ZZAF", date: "2026-10-08", releaseTime: "07:30" });
    expect(isDefaultedEarningsTime(row)).toBe(false);
    expect(displayEarningsTime(db, row)).toEqual({ label: "7:30 AM", kind: "stored" });
  });

  it("slot-less default + a known per-symbol time → an estimate label", () => {
    db.prepare(
      `INSERT INTO symbol_release_times (symbol, release_time, source) VALUES ('ZZAG', '07:00', 'web_verified')`,
    ).run();
    for (const hour of [null, "unknown", "dmh"]) {
      db.prepare(`DELETE FROM calendar_events`).run();
      const row = seed({ symbol: "ZZAG", date: "2026-10-08", rawJson: hourJson(hour) });
      expect(isDefaultedEarningsTime(row)).toBe(true);
      expect(displayEarningsTime(db, row)).toEqual({
        label: "~7:00 AM (usual time)",
        kind: "usual",
      });
    }
  });

  it("slot-less default + two agreeing vendor prints → a slot label, no invented clock", () => {
    pastPrint("ZZAH", "2026-04-21", "bmo");
    pastPrint("ZZAH", "2026-07-21", "bmo", "nasdaq");
    const row = seed({ symbol: "ZZAH", date: "2026-10-08" });
    expect(displayEarningsTime(db, row)).toEqual({
      label: "Before the open (usual)",
      kind: "usual",
    });

    pastPrint("ZZAI", "2026-04-21", "amc");
    pastPrint("ZZAI", "2026-07-21", "amc");
    const amc = seed({ symbol: "ZZAI", date: "2026-10-08" });
    expect(displayEarningsTime(db, amc)).toEqual({
      label: "After the close (usual)",
      kind: "usual",
    });
  });

  it("only one print → time unknown", () => {
    pastPrint("ZZAJ", "2026-07-21", "bmo");
    const row = seed({ symbol: "ZZAJ", date: "2026-10-08" });
    expect(displayEarningsTime(db, row)).toEqual({ label: "time unknown", kind: "unknown" });
  });

  it("two source rows for the SAME print count once", () => {
    pastPrint("ZZAK", "2026-07-21", "bmo", "finnhub");
    pastPrint("ZZAK", "2026-07-21", "bmo", "nasdaq");
    const row = seed({ symbol: "ZZAK", date: "2026-10-08" });
    expect(displayEarningsTime(db, row).kind).toBe("unknown");
  });

  it("a manual print is not vendor evidence", () => {
    pastPrint("ZZAL", "2026-04-21", "bmo");
    seed({
      symbol: "ZZAL",
      date: "2026-07-21",
      source: "manual",
      eventTime: "BMO",
      releaseTime: "08:00",
      rawJson: null,
      actual: "EPS 1.00 / Rev 10M",
    });
    const row = seed({ symbol: "ZZAL", date: "2026-10-08" });
    expect(displayEarningsTime(db, row)).toEqual({ label: "time unknown", kind: "unknown" });
  });

  it("two disagreeing prints → time unknown", () => {
    pastPrint("ZZAM", "2026-04-21", "bmo");
    pastPrint("ZZAM", "2026-07-21", "amc");
    const row = seed({ symbol: "ZZAM", date: "2026-10-08" });
    expect(displayEarningsTime(db, row)).toEqual({ label: "time unknown", kind: "unknown" });
  });

  it("unreported, superseded, future and older-than-400-day prints are not evidence", () => {
    pastPrint("ZZAN", "2026-07-21", "bmo");
    // no actual → never reported
    seed({ symbol: "ZZAN", date: "2026-04-21", rawJson: hourJson("bmo"), releaseTime: "08:00" });
    // superseded twin on another date
    seed({
      symbol: "ZZAN",
      date: "2026-01-21",
      rawJson: hourJson("bmo"),
      releaseTime: "08:00",
      actual: "EPS 1.00 / Rev 10M",
      superseded: 1,
    });
    pastPrint("ZZAN", "2025-07-21", "bmo"); // > 400 days before the row
    pastPrint("ZZAN", "2026-11-21", "bmo"); // after the row
    const row = seed({ symbol: "ZZAN", date: "2026-10-08" });
    expect(displayEarningsTime(db, row).kind).toBe("unknown");
  });

  it("a 16:15 that a source supplied stays 4:15 PM", () => {
    // The standing per-symbol time IS 16:15 — the stored value is that
    // source's answer, not the fallback.
    db.prepare(
      `INSERT INTO symbol_release_times (symbol, release_time, source) VALUES ('ZZAO', '16:15', 'user')`,
    ).run();
    const row = seed({ symbol: "ZZAO", date: "2026-10-08" });
    expect(displayEarningsTime(db, row)).toEqual({ label: "4:15 PM", kind: "stored" });
  });

  it("a slot-less row with no stored time and no history reads time unknown", () => {
    const row = seed({ symbol: "ZZAP", date: "2026-10-08", releaseTime: null });
    expect(displayEarningsTime(db, row)).toEqual({ label: "time unknown", kind: "unknown" });
  });

  it("macro rows are untouched", () => {
    const cpi = seed({
      symbol: "",
      date: "2026-10-08",
      eventType: "cpi",
      source: "claude_macro",
      releaseTime: "08:30",
      rawJson: null,
    });
    expect(displayEarningsTime(db, cpi)).toEqual({ label: "8:30 AM", kind: "stored" });
  });

  it("is read-only: the stored row is never changed", () => {
    pastPrint("ZZAQ", "2026-04-21", "bmo");
    pastPrint("ZZAQ", "2026-07-21", "bmo");
    const row = seed({ symbol: "ZZAQ", date: "2026-10-08" });
    const before = JSON.stringify(db.prepare(`SELECT * FROM calendar_events ORDER BY id`).all());
    const [out] = withDisplayTimes(db, [row]);
    expect(out.display_time.kind).toBe("usual");
    expect(out.release_time).toBe("16:15");
    expect(JSON.stringify(db.prepare(`SELECT * FROM calendar_events ORDER BY id`).all())).toBe(
      before,
    );
  });
});

describe("getTodayReleases — same rows, same order (display field is additive)", () => {
  /** The pre-ruling query, verbatim: the reference the reader must still match. */
  function referenceIds(today: string): number[] {
    const todays = db
      .prepare(
        `SELECT id FROM calendar_events
         WHERE event_date = ? AND release_time IS NOT NULL AND COALESCE(superseded, 0) = 0
         ORDER BY release_time ASC`,
      )
      .all(today) as { id: number }[];
    if (todays.length > 0) return todays.map((r) => r.id);
    return (
      db
        .prepare(
          `SELECT id FROM calendar_events
           WHERE event_date > ? AND release_time IS NOT NULL AND COALESCE(superseded, 0) = 0
           ORDER BY event_date ASC, release_time ASC LIMIT 4`,
        )
        .all(today) as { id: number }[]
    ).map((r) => r.id);
  }

  it("mixed fixture, today mode", () => {
    const today = "2026-10-08";
    pastPrint("ZZBA", "2026-04-21", "bmo");
    pastPrint("ZZBA", "2026-07-21", "bmo");
    seed({ symbol: "ZZBA", date: today }); // slot-less default, BMO history
    seed({ symbol: "ZZBB", date: today, rawJson: hourJson("bmo"), releaseTime: "08:00" });
    seed({ symbol: "ZZBC", date: today, rawJson: hourJson("amc"), releaseTime: "16:05" });
    seed({ symbol: "ZZBD", date: today, releaseTime: null }); // excluded: no stored time
    seed({ symbol: "ZZBE", date: today, superseded: 1 }); // excluded
    seed({ symbol: "", date: today, eventType: "cpi", source: "claude_macro", releaseTime: "08:30", rawJson: null });

    const { releases, mode } = getTodayReleases(db, today);
    expect(mode).toBe("today");
    expect(releases.map((r) => r.id)).toEqual(referenceIds(today));
    expect(releases).toHaveLength(4);

    const byId = new Map(releases.map((r) => [r.symbol, r]));
    // The estimate sorts where the STORED 16:15 puts it — ordering is not display.
    expect(releases.at(-1)?.symbol).toBe("ZZBA");
    expect(byId.get("ZZBA")?.release_time).toBe("16:15");
    expect(byId.get("ZZBA")?.display_time).toEqual({
      label: "Before the open (usual)",
      kind: "usual",
    });
    expect(byId.get("ZZBC")?.display_time).toEqual({ label: "4:05 PM", kind: "stored" });
  });

  it("mixed fixture, upcoming mode", () => {
    const today = "2026-10-08";
    seed({ symbol: "ZZCA", date: "2026-10-09" });
    seed({ symbol: "ZZCB", date: "2026-10-09", rawJson: hourJson("bmo"), releaseTime: "08:00" });
    seed({ symbol: "ZZCC", date: "2026-10-12", rawJson: hourJson("amc") });
    seed({ symbol: "ZZCD", date: "2026-10-13" });
    seed({ symbol: "ZZCE", date: "2026-10-14" });
    const { releases, mode } = getTodayReleases(db, today);
    expect(mode).toBe("upcoming");
    expect(releases.map((r) => r.id)).toEqual(referenceIds(today));
    expect(releases.map((r) => r.display_time.kind)).toEqual([
      "stored",
      "unknown",
      "stored",
      "unknown",
    ]);
  });
});

describe("display surfaces (source pins)", () => {
  const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", "..", p), "utf-8");

  it("Today's releases renders the display label, with the stored-time label as fallback", () => {
    const src = read("app/dashboard/components/TodayReleases.tsx");
    expect(src).toMatch(/event\.display_time\?\.label \?\? earningsTimeLabel\(event\)/);
  });

  it("the Today's releases query attaches display times and nothing else changes shape", () => {
    const src = read("lib/queries/calendar.ts");
    expect(src).toMatch(/releases: withDisplayTimes\(db, releases\)/);
    // Only getTodayReleases — the week readers also feed emails and the sweep.
    expect(src.match(/withDisplayTimes\(/g)).toHaveLength(1);
  });

  it("the week-ahead card renders the display label", () => {
    const view = read("app/dashboard/today/WeekAheadView.tsx");
    expect(view).toMatch(/event\.display_time\?\.label \?\? earningsTimeLabel\(event\)/);
    const page = read("app/dashboard/today/page.tsx");
    expect(page).toMatch(/withDisplayTimes\(db, getEventsByWeek\(db, weekOf\)\)/);
  });

  it("the Earnings Hub row time goes through the display label", () => {
    const hub = read("app/dashboard/today/EarningsHub.tsx");
    expect(hub).toMatch(/withDisplayTimes\(db, getEarningsForWeekDeduped\(db, weekOf\)\)/);
    expect(hub).toMatch(/fmtSlot\(event\.event_time, event\.release_time, event\.display_time\)/);
    expect(hub).not.toMatch(/fmtSlot\(event\.event_time, event\.release_time\)/);
    expect(hub).toMatch(/display\.kind !== "stored"\) return display\.label/);
    // Both row layouts hand the estimate to the chips.
    expect(hub.match(/timeEstimateLabel=\{estimateLabel\(event\.display_time\)\}/g)).toHaveLength(2);
  });

  it("an estimated row shows no to-the-minute countdown and no stored clock on its chip", () => {
    const chips = read("app/dashboard/today/EarningsRowChips.tsx");
    expect(chips).toMatch(/!timeEstimateLabel &&\s*\n\s*cockpitRow\.stages\.released\.state === "upcoming"/);
    expect(chips).toMatch(/<StageChipStrip row=\{cockpitRow\} onOpen=\{handleCockpitOpen\} timeEstimateLabel=\{timeEstimateLabel\}/);
    const strip = read("app/dashboard/today/hub-live/send-state-chips.tsx");
    expect(strip).toMatch(/text: timeEstimateLabel \?\? row\.releaseTime \?\? row\.eventTime \?\? "—"/);
  });
});
