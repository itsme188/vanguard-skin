/**
 * Owner ruling (U4): the display-only "usual time" estimate also reads
 * earnings_report_history, and uses a superseded same-date twin's explicit
 * slot as a tie-breaker only. Display only; nothing is stored.
 * Synthetic tickers only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { displayEarningsTime } from "@/lib/calendar/display-earnings-time";

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
  superseded?: number;
  eventTime?: string | null;
}) {
  const source = o.source ?? "nasdaq";
  const id = db
    .prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, event_time, release_time, title, symbol,
          raw_json, actual_value, source_key, superseded)
       VALUES (?, 'earnings', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      source,
      o.date,
      o.eventTime ?? null,
      o.releaseTime === undefined ? "16:15" : o.releaseTime,
      `${o.symbol} earnings`,
      o.symbol,
      hourJson(o.hour ?? null),
      o.actual ?? null,
      `${source}:${o.symbol}:${o.date}:${o.superseded ?? 0}`,
      o.superseded ?? 0,
    ).lastInsertRowid;
  return db.prepare(`SELECT * FROM calendar_events WHERE id = ?`).get(id) as Parameters<
    typeof displayEarningsTime
  >[1];
}

function history(symbol: string, date: string, time: "pre-market" | "post-market" | null) {
  db.prepare(
    `INSERT INTO earnings_report_history (symbol, reported_date, report_time) VALUES (?, ?, ?)`,
  ).run(symbol, date, time);
}

function calPrint(symbol: string, date: string, hour: "bmo" | "amc") {
  seed({
    symbol,
    date,
    source: "finnhub",
    hour,
    releaseTime: hour === "bmo" ? "08:00" : "16:15",
    actual: "EPS 1.00 / Rev 10M",
  });
}

const AMC = { label: "After the close (usual)", kind: "usual" };
const BMO = { label: "Before the open (usual)", kind: "usual" };
const UNK = { label: "time unknown", kind: "unknown" };

describe("history as evidence", () => {
  it("two post-market history rows give after-close", () => {
    history("ZZHA", "2026-04-21", "post-market");
    history("ZZHA", "2026-07-21", "post-market");
    expect(displayEarningsTime(db, seed({ symbol: "ZZHA", date: "2026-10-08" }))).toEqual(AMC);
  });

  it("history rows with NULL report_time are not votes", () => {
    history("ZZHB", "2026-04-21", null);
    history("ZZHB", "2026-07-21", "pre-market");
    expect(displayEarningsTime(db, seed({ symbol: "ZZHB", date: "2026-10-08" }))).toEqual(UNK);
  });

  it("history plus a calendar row on the same date counts once", () => {
    history("ZZHC", "2026-07-21", "pre-market");
    calPrint("ZZHC", "2026-07-21", "bmo");
    expect(displayEarningsTime(db, seed({ symbol: "ZZHC", date: "2026-10-08" }))).toEqual(UNK);
  });

  it("history on one date and calendar on another make two agreeing votes", () => {
    history("ZZHD", "2026-04-21", "pre-market");
    calPrint("ZZHD", "2026-07-21", "bmo");
    expect(displayEarningsTime(db, seed({ symbol: "ZZHD", date: "2026-10-08" }))).toEqual(BMO);
  });

  it("history outside the lookback, on/after the row date, is ignored", () => {
    history("ZZHE", "2025-07-21", "post-market");
    history("ZZHE", "2026-10-08", "post-market");
    history("ZZHE", "2026-11-21", "post-market");
    expect(displayEarningsTime(db, seed({ symbol: "ZZHE", date: "2026-10-08" }))).toEqual(UNK);
  });

  it("matches the issuer family, not string equality", () => {
    history("BRK.B", "2026-04-21", "post-market");
    history("BRK-B", "2026-07-21", "post-market");
    expect(displayEarningsTime(db, seed({ symbol: "BRK.A", date: "2026-10-08" }))).toEqual(AMC);
  });
});

describe("superseded same-date twin as tie-breaker", () => {
  it("twin alone (no history) is used", () => {
    seed({ symbol: "ZZHF", date: "2026-10-08", source: "alphavantage", hour: "bmo", releaseTime: "08:00", superseded: 1 });
    expect(displayEarningsTime(db, seed({ symbol: "ZZHF", date: "2026-10-08" }))).toEqual(BMO);
  });

  it("twin with only a default time (no explicit slot) is not evidence", () => {
    seed({ symbol: "ZZHG", date: "2026-10-08", source: "alphavantage", hour: null, superseded: 1 });
    expect(displayEarningsTime(db, seed({ symbol: "ZZHG", date: "2026-10-08" }))).toEqual(UNK);
  });

  it("breaks a split history", () => {
    history("ZZHH", "2026-04-21", "pre-market");
    history("ZZHH", "2026-07-21", "post-market");
    seed({ symbol: "ZZHH", date: "2026-10-08", source: "alphavantage", hour: "amc", superseded: 1 });
    expect(displayEarningsTime(db, seed({ symbol: "ZZHH", date: "2026-10-08" }))).toEqual(AMC);
  });

  it("does not override a clear history verdict", () => {
    history("ZZHI", "2026-04-21", "pre-market");
    history("ZZHI", "2026-07-21", "pre-market");
    seed({ symbol: "ZZHI", date: "2026-10-08", source: "alphavantage", hour: "amc", superseded: 1 });
    expect(displayEarningsTime(db, seed({ symbol: "ZZHI", date: "2026-10-08" }))).toEqual(BMO);
  });

  it("a twin on a different date is not used", () => {
    seed({ symbol: "ZZHJ", date: "2026-10-09", source: "alphavantage", hour: "bmo", superseded: 1 });
    expect(displayEarningsTime(db, seed({ symbol: "ZZHJ", date: "2026-10-08" }))).toEqual(UNK);
  });

  it("a non-superseded same-date row is not a twin", () => {
    seed({ symbol: "ZZHK", date: "2026-10-08", source: "alphavantage", hour: "bmo" });
    expect(displayEarningsTime(db, seed({ symbol: "ZZHK", date: "2026-10-08" }))).toEqual(UNK);
  });
});

describe("manual rows", () => {
  it("a manual past print is not evidence; a manual superseded twin is not a tie-breaker", () => {
    seed({ symbol: "ZZHL", date: "2026-07-21", source: "manual", eventTime: "BMO", releaseTime: "08:00", actual: "EPS 1.00 / Rev 10M" });
    history("ZZHL", "2026-04-21", "pre-market");
    seed({ symbol: "ZZHL", date: "2026-10-08", source: "manual", eventTime: "BMO", releaseTime: "08:00", superseded: 1 });
    expect(displayEarningsTime(db, seed({ symbol: "ZZHL", date: "2026-10-08" }))).toEqual(UNK);
  });
});
