/**
 * dedupeWeekEarnings — the week view's filter over getEventsByWeek. It keeps
 * one card per earnings print, the same twin the Earnings Hub picks
 * (getEarningsForWeekDeduped), and leaves every other row alone.
 * QA: today-week-ahead--duplicate-multi-source-earnings-cards-regression-1.
 * Synthetic symbols and figures only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  dedupeWeekEarnings,
  getEarningsForWeekDeduped,
  getEventsByWeek,
} from "@/lib/queries/calendar";
import type { CalendarEvent } from "@/lib/types";

const WEEK = "2026-08-24";
let db: Database.Database;
let n = 0;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
  n = 0;
});

function seed(opts: {
  source: string;
  type?: string;
  symbol: string | null;
  date?: string;
  superseded?: number;
  title?: string;
}): number {
  n += 1;
  return db
    .prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, title, symbol, superseded, source_key, week_of)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.source,
      opts.type ?? "earnings",
      opts.date ?? "2026-08-25",
      opts.title ?? `${opts.symbol ?? "macro"} event`,
      opts.symbol,
      opts.superseded ?? 0,
      `${opts.source}:${opts.symbol ?? "macro"}:${n}`,
      WEEK,
    ).lastInsertRowid as number;
}

function getWeekAheadEvents(d: Database.Database, weekOf: string): CalendarEvent[] {
  return dedupeWeekEarnings(d, weekOf, getEventsByWeek(d, weekOf));
}

describe("dedupeWeekEarnings over getEventsByWeek", () => {
  it("collapses a hand-entered row and a vendor row for the same print to the Hub's pick", () => {
    seed({ source: "manual", symbol: "AAA" });
    seed({ source: "nasdaq", symbol: "AAA" });
    const macro = seed({ source: "claude_macro", type: "cpi", symbol: null });

    expect(getEventsByWeek(db, WEEK).filter((e) => e.symbol === "AAA")).toHaveLength(2);

    const rows = getWeekAheadEvents(db, WEEK);
    const aaa = rows.filter((e) => e.symbol === "AAA");
    expect(aaa).toHaveLength(1);
    const hubPick = getEarningsForWeekDeduped(db, WEEK).find((e) => e.symbol === "AAA");
    expect(aaa[0].id).toBe(hubPick?.id);
    expect(rows.map((e) => e.id)).toContain(macro);
    expect(rows).toHaveLength(2);
  });

  it("prefers the Finnhub twin, like the Hub", () => {
    seed({ source: "manual", symbol: "AAA" });
    const fh = seed({ source: "finnhub", symbol: "AAA" });
    const aaa = getWeekAheadEvents(db, WEEK).filter((e) => e.symbol === "AAA");
    expect(aaa.map((e) => e.id)).toEqual([fh]);
  });

  it("keeps the same symbol on two different dates as two cards", () => {
    seed({ source: "manual", symbol: "AAA", date: "2026-08-25" });
    seed({ source: "finnhub", symbol: "AAA", date: "2026-08-27" });
    expect(getWeekAheadEvents(db, WEEK).filter((e) => e.symbol === "AAA")).toHaveLength(2);
  });

  it("never collapses symbol-less earnings rows or non-earnings rows that share a date", () => {
    seed({ source: "manual", symbol: null, title: "Unnamed print one" });
    seed({ source: "manual", symbol: null, title: "Unnamed print two" });
    seed({ source: "claude_macro", type: "cpi", symbol: null });
    seed({ source: "claude_macro", type: "fomc", symbol: null });
    seed({ source: "wsh", type: "conference", symbol: "AAA" });
    seed({ source: "manual", type: "conference", symbol: "AAA" });
    expect(getWeekAheadEvents(db, WEEK)).toHaveLength(6);
  });

  it("keeps what the caller attached to a surviving row", () => {
    seed({ source: "manual", symbol: "AAA" });
    const fh = seed({ source: "finnhub", symbol: "AAA" });
    const tagged = getEventsByWeek(db, WEEK).map((e) => ({ ...e, tag: `t${e.id}` }));
    expect(dedupeWeekEarnings(db, WEEK, tagged)).toEqual([
      expect.objectContaining({ id: fh, tag: `t${fh}` }),
    ]);
  });

  it("still hides superseded rows and keeps the week query's order", () => {
    seed({ source: "finnhub", symbol: "ZZZ", superseded: 1 });
    const b = seed({ source: "finnhub", symbol: "BBB", date: "2026-08-26" });
    const a = seed({ source: "finnhub", symbol: "AAA", date: "2026-08-25" });
    expect(getWeekAheadEvents(db, WEEK).map((e) => e.id)).toEqual([a, b]);
  });
});
