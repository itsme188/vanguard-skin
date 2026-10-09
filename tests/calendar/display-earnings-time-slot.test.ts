/**
 * Decision taken on recommendation 2026-10-08 (display only): the label a
 * screen shows for a slot-less vendor earnings row also carries the SIDE of
 * the session it stands for, so the "pre-release" chip on a hand-entered
 * figure can clear at the company's usual side. Nothing is stored and no
 * gate reads it. Synthetic tickers only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { displayEarningsTime, usualSideOfClock } from "@/lib/calendar/display-earnings-time";
import { isPreReleaseActual } from "@/lib/calendar/pre-release-actual";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

const hourJson = (hour: string | null) => JSON.stringify({ entry: { hour } });

function seed(o: {
  symbol: string;
  date: string;
  source?: string;
  hour?: string | null;
  releaseTime?: string | null;
  actual?: string | null;
}) {
  const source = o.source ?? "nasdaq";
  const id = db
    .prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, event_time, release_time, title, symbol,
          raw_json, actual_value, source_key)
       VALUES (?, 'earnings', ?, NULL, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      source,
      o.date,
      o.releaseTime === undefined ? "16:15" : o.releaseTime,
      `${o.symbol} earnings`,
      o.symbol,
      hourJson(o.hour ?? null),
      o.actual ?? null,
      `${source}:${o.symbol}:${o.date}:earnings`,
    ).lastInsertRowid;
  return db.prepare(`SELECT * FROM calendar_events WHERE id = ?`).get(id) as Parameters<
    typeof displayEarningsTime
  >[1] & { actual_value: string | null };
}

const pastPrint = (symbol: string, date: string, hour: "bmo" | "amc") =>
  seed({ symbol, date, source: "finnhub", hour, releaseTime: hour === "bmo" ? "08:00" : "16:15", actual: "EPS 1.00" });

function knownTime(symbol: string, hhmm: string) {
  db.prepare(
    `INSERT INTO symbol_release_times (symbol, release_time, source) VALUES (?, ?, 'web_verified')`,
  ).run(symbol, hhmm);
}

describe("usualSideOfClock", () => {
  it("before the 09:30 open is before-the-open; 16:00 on is after-the-close; the session is neither", () => {
    expect(usualSideOfClock("06:30")).toBe("bmo");
    expect(usualSideOfClock("09:29")).toBe("bmo");
    expect(usualSideOfClock("09:30")).toBeNull();
    expect(usualSideOfClock("12:00")).toBeNull();
    expect(usualSideOfClock("15:59")).toBeNull();
    expect(usualSideOfClock("16:00")).toBe("amc");
    expect(usualSideOfClock("17:00")).toBe("amc");
    expect(usualSideOfClock("soon")).toBeNull();
  });
});

describe("displayEarningsTime carries the usual side", () => {
  it("history agreeing on before-the-open → slot bmo", () => {
    pastPrint("ZZA", "2026-04-20", "bmo");
    pastPrint("ZZA", "2026-07-20", "bmo");
    const row = seed({ symbol: "ZZA", date: "2026-10-07" });
    expect(displayEarningsTime(db, row)).toEqual({
      label: "Before the open (usual)",
      kind: "usual",
      slot: "bmo",
    });
  });

  it("history agreeing on after-the-close → slot amc", () => {
    pastPrint("ZZB", "2026-04-20", "amc");
    pastPrint("ZZB", "2026-07-20", "amc");
    const row = seed({ symbol: "ZZB", date: "2026-10-07" });
    expect(displayEarningsTime(db, row).slot).toBe("amc");
  });

  it("a known usual clock time gives its side; an in-session one gives none", () => {
    knownTime("ZZC", "07:00");
    expect(displayEarningsTime(db, seed({ symbol: "ZZC", date: "2026-10-07" }))).toEqual({
      label: "~7:00 AM (usual time)",
      kind: "usual",
      slot: "bmo",
    });
    knownTime("ZZD", "12:00");
    const mid = displayEarningsTime(db, seed({ symbol: "ZZD", date: "2026-10-07" }));
    expect(mid.kind).toBe("usual");
    expect(mid.slot ?? null).toBeNull();
  });

  it("stored and unknown answers carry no side", () => {
    const real = seed({ symbol: "ZZE", date: "2026-10-07", hour: "amc" });
    expect(displayEarningsTime(db, real)).toEqual({ label: "4:15 PM", kind: "stored" });
    const unknown = displayEarningsTime(db, seed({ symbol: "ZZF", date: "2026-10-07" }));
    expect(unknown.kind).toBe("unknown");
    expect("slot" in unknown).toBe(false);
  });

  it("mixed history gives no side, so the chip keeps the stored default", () => {
    pastPrint("ZZG", "2026-04-20", "bmo");
    pastPrint("ZZG", "2026-07-20", "amc");
    const row = seed({ symbol: "ZZG", date: "2026-10-07", actual: "EPS 1.00" });
    const withTime = { ...row, display_time: displayEarningsTime(db, row) };
    expect(withTime.display_time.kind).toBe("unknown");
    expect(isPreReleaseActual(withTime, new Date("2026-10-07T12:00:00Z"))).toBe(true);
  });
});

describe("end to end: the row a screen receives", () => {
  it("a figure typed in at 08:00 ET for a usual before-the-open company is not pre-release", () => {
    pastPrint("ZZH", "2026-04-20", "bmo");
    pastPrint("ZZH", "2026-07-20", "bmo");
    const row = seed({ symbol: "ZZH", date: "2026-10-07", actual: "EPS 1.00" });
    const eightAm = new Date("2026-10-07T12:00:00Z");
    // Without the attached label the stored 16:15 default mutes it all day.
    expect(isPreReleaseActual(row, eightAm)).toBe(true);
    const shown = { ...row, display_time: displayEarningsTime(db, row) };
    expect(isPreReleaseActual(shown, eightAm)).toBe(false);
    expect(isPreReleaseActual(shown, new Date("2026-10-07T10:30:00Z"))).toBe(true); // 06:30 ET
  });

  it("nothing is written: the stored row is byte-identical afterwards", () => {
    pastPrint("ZZI", "2026-04-20", "bmo");
    pastPrint("ZZI", "2026-07-20", "bmo");
    const row = seed({ symbol: "ZZI", date: "2026-10-07", actual: "EPS 1.00" });
    const before = JSON.stringify(db.prepare(`SELECT * FROM calendar_events ORDER BY id`).all());
    const shown = { ...row, display_time: displayEarningsTime(db, row) };
    isPreReleaseActual(shown, new Date("2026-10-07T12:00:00Z"));
    expect(JSON.stringify(db.prepare(`SELECT * FROM calendar_events ORDER BY id`).all())).toBe(before);
  });
});
