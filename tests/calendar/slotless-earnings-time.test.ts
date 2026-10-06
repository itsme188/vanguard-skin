/**
 * A slot-less vendor earnings row must not show a definite 4:15 PM
 * (user ruling 2026-10-05).
 *
 * Finding: every nasdaq/finnhub row with no BMO/AMC slot got the 16:15
 * default and rendered like a confirmed after-close print — even for
 * companies whose own history is pre-market.
 *
 * Shipped part of the ruling: HISTORY FIRST. New ingests of a slot-less row
 * take the symbol's own history (symbol_release_times / observed wire times /
 * the slot of its last reported print). The no-history case still stores the
 * legacy 16:15 (storing NULL would drop the row from the time-gated pipeline
 * readers — held for a separate ruling). Any row whose stored time IS NULL
 * renders "time unknown" on the week-ahead card and Today's releases.
 *
 * All symbols and figures here are synthetic.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { runMigrations } from "@/lib/db/migrate";
import { upsertCalendarEvents } from "@/lib/mutations/calendar";
import { upsertSymbolReleaseTime, lastReportedPrintSlot } from "@/lib/earnings/wire-times";
import {
  UNKNOWN_RELEASE_TIME_LABEL,
  earningsTimeLabel,
} from "@/lib/calendar/release-times";
import type { CalendarEventInput } from "@/lib/mutations/calendar";

let db: Database.Database;
const DATE = "2026-11-04";
const WEEK = "2026-11-02";

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function vendorRow(
  symbol: string,
  hour: "bmo" | "amc" | "dmh" | null,
  overrides: Partial<CalendarEventInput> = {},
): CalendarEventInput {
  return {
    source: "nasdaq",
    event_type: "earnings",
    event_date: DATE,
    event_time: null,
    title: `${symbol} earnings`,
    symbol,
    source_key: `nasdaq:${symbol}:${DATE}:earnings`,
    week_of: WEEK,
    raw_json: JSON.stringify({ entry: { hour } }),
    ...overrides,
  } as CalendarEventInput;
}

function storedTime(symbol: string, date = DATE): string | null | undefined {
  const row = db
    .prepare(
      `SELECT release_time FROM calendar_events WHERE symbol = ? AND event_date = ?`,
    )
    .get(symbol, date) as { release_time: string | null } | undefined;
  return row ? row.release_time : undefined;
}

/** A past, reported print for `symbol` carrying the given vendor hour. */
function seedReportedPrint(symbol: string, hour: "bmo" | "amc" | null, date = "2026-08-05"): void {
  db.prepare(
    `INSERT INTO calendar_events
       (source, event_type, event_date, title, symbol, source_key, week_of, raw_json,
        release_time, actual_value)
     VALUES ('finnhub', 'earnings', ?, ?, ?, ?, '2026-08-03', ?, ?, 'EPS 1.00')`,
  ).run(
    date,
    `${symbol} earnings`,
    symbol,
    `finnhub:${symbol}:${date}:earnings`,
    JSON.stringify({ entry: { hour } }),
    hour === "bmo" ? "08:00" : "16:15",
  );
}

describe("ingest of a slot-less vendor earnings row", () => {
  it("with no history keeps the legacy 16:15 default (unchanged — pending a separate ruling)", () => {
    upsertCalendarEvents(db, [vendorRow("ZQNONE", null), vendorRow("ZQDMH", "dmh")]);
    expect(storedTime("ZQNONE")).toBe("16:15");
    expect(storedTime("ZQDMH")).toBe("16:15");
  });

  it("the curated per-symbol constant still beats last-print history", () => {
    seedReportedPrint("AAPL", "bmo");
    upsertCalendarEvents(db, [vendorRow("AAPL", null)]);
    expect(storedTime("AAPL")).toBe("16:30");
  });

  it("a row that names a slot ignores opposite-side print history", () => {
    seedReportedPrint("ZQSLOT", "bmo");
    upsertCalendarEvents(db, [vendorRow("ZQSLOT", "amc")]);
    expect(storedTime("ZQSLOT")).toBe("16:15");
  });

  it("a row that DOES name a slot is unchanged (AMC → 16:15, BMO → 08:00)", () => {
    upsertCalendarEvents(db, [vendorRow("ZQAMC", "amc"), vendorRow("ZQBMO", "bmo")]);
    expect(storedTime("ZQAMC")).toBe("16:15");
    expect(storedTime("ZQBMO")).toBe("08:00");
  });

  it("uses the symbol's remembered release time (symbol_release_times)", () => {
    upsertSymbolReleaseTime(db, {
      symbol: "ZQWEB",
      releaseTime: "07:30",
      source: "web_verified",
    });
    upsertCalendarEvents(db, [vendorRow("ZQWEB", null)]);
    expect(storedTime("ZQWEB")).toBe("07:30");
  });

  it("BMO history → BMO time: the slot of the last reported print", () => {
    seedReportedPrint("ZQHIST", "bmo");
    expect(lastReportedPrintSlot(db, "ZQHIST")).toBe("bmo");
    upsertCalendarEvents(db, [vendorRow("ZQHIST", null)]);
    expect(storedTime("ZQHIST")).toBe("08:00");
  });

  it("AMC history → AMC time", () => {
    seedReportedPrint("ZQHISTA", "amc");
    upsertCalendarEvents(db, [vendorRow("ZQHISTA", null)]);
    expect(storedTime("ZQHISTA")).toBe("16:15");
  });

  it("the newest reported print with a slot wins; an unreported row is not history", () => {
    seedReportedPrint("ZQMIX", "amc", "2026-05-06");
    seedReportedPrint("ZQMIX", "bmo", "2026-08-05");
    // An upcoming, un-reported AMC row for another date must not count.
    db.prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, title, symbol, source_key, week_of, raw_json)
       VALUES ('finnhub', 'earnings', '2026-12-01', 'ZQMIX earnings', 'ZQMIX',
               'finnhub:ZQMIX:2026-12-01:earnings', '2026-11-30', ?)`,
    ).run(JSON.stringify({ entry: { hour: "amc" } }));
    expect(lastReportedPrintSlot(db, "ZQMIX")).toBe("bmo");
  });

  it("no slot anywhere in the reported history → the legacy default", () => {
    seedReportedPrint("ZQBLANK", null);
    expect(lastReportedPrintSlot(db, "ZQBLANK")).toBeNull();
    upsertCalendarEvents(db, [vendorRow("ZQBLANK", null)]);
    expect(storedTime("ZQBLANK")).toBe("16:15");
  });

  it("never rewrites an existing stored time: a re-sync that lost the slot keeps it", () => {
    upsertCalendarEvents(db, [vendorRow("ZQKEEP", "amc")]);
    expect(storedTime("ZQKEEP")).toBe("16:15");
    upsertCalendarEvents(db, [vendorRow("ZQKEEP", null)]);
    expect(storedTime("ZQKEEP")).toBe("16:15");
  });
});

describe("readers of an unknown time", () => {
  it("earningsTimeLabel: a clock time formats, an unknown earnings time says so, macro stays blank", () => {
    expect(UNKNOWN_RELEASE_TIME_LABEL).toBe("time unknown");
    expect(earningsTimeLabel({ event_type: "earnings", release_time: "16:05" })).toBe("4:05 PM");
    expect(earningsTimeLabel({ event_type: "earnings", release_time: "08:00" })).toBe("8:00 AM");
    expect(earningsTimeLabel({ event_type: "earnings", release_time: null })).toBe("time unknown");
    // A BMO/AMC marker is not a clock time.
    expect(
      earningsTimeLabel({ event_type: "earnings", release_time: null, event_time: "BMO" }),
    ).toBe("time unknown");
    // An explicit HH:MM event_time is one.
    expect(
      earningsTimeLabel({ event_type: "earnings", release_time: null, event_time: "07:30" }),
    ).toBe("7:30 AM");
    expect(earningsTimeLabel({ event_type: "cpi", release_time: null })).toBeNull();
    expect(earningsTimeLabel({ event_type: "cpi", release_time: "08:30" })).toBe("8:30 AM");
  });

  it("the week-ahead card and the Today list both render through earningsTimeLabel (source pin)", () => {
    const week = readFileSync("app/dashboard/today/WeekAheadView.tsx", "utf8");
    const today = readFileSync("app/dashboard/components/TodayReleases.tsx", "utf8");
    expect(week).toMatch(/earningsTimeLabel\(event\)/);
    expect(today).toMatch(/earningsTimeLabel\(event\)/);
    // Neither surface may fall back to a hardcoded clock time.
    expect(week).not.toMatch(/"16:15"|4:15 PM/);
    expect(today).not.toMatch(/"16:15"|4:15 PM/);
  });
});
