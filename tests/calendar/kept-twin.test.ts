/**
 * A superseded earnings row resolves to the row that kept its print, so a
 * link minted before a Refresh flipped the kept twin still opens the summary.
 * QA: dashboard-print-2117-filings-the-link-the-msft-filing-summary-pushes-carry-calendar-refresh-kept-row-flip-afte
 * Synthetic rows only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { runMigrations } from "@/lib/db/migrate";
import { resolveKeptEarningsEventId } from "@/lib/calendar/kept-twin";

let db: Database.Database;

function row(
  symbol: string,
  date: string,
  source: string,
  superseded: 0 | 1,
  eventType = "earnings",
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol, superseded)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(source, eventType, date, `${symbol} ${eventType}`, `${source}:${symbol}:${date}`, symbol, superseded)
      .lastInsertRowid,
  );
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

describe("resolveKeptEarningsEventId", () => {
  it("follows a superseded row to the unsuperseded twin of the same print", () => {
    const loser = row("AAA", "2026-10-28", "finnhub", 1);
    const kept = row("AAA", "2026-10-28", "nasdaq", 0);
    expect(resolveKeptEarningsEventId(db, loser)).toEqual({ id: kept, followedFrom: loser });
  });

  it("answers the row itself when it is not superseded", () => {
    const kept = row("AAA", "2026-10-28", "finnhub", 0);
    row("AAA", "2026-10-28", "nasdaq", 1);
    expect(resolveKeptEarningsEventId(db, kept)).toEqual({ id: kept, followedFrom: null });
  });

  it("is null for an id with no row", () => {
    expect(resolveKeptEarningsEventId(db, 999_999)).toBeNull();
  });

  it("never follows to another company, another print, or a macro row", () => {
    const loser = row("AAA", "2026-10-28", "finnhub", 1);
    row("ZZZ", "2026-10-28", "nasdaq", 0); // other company
    row("AAA", "2027-01-27", "finnhub", 0); // next quarter's print, outside the cluster window
    row("AAA", "2026-10-28", "fred", 0, "macro"); // not an earnings row
    expect(resolveKeptEarningsEventId(db, loser)).toEqual({ id: loser, followedFrom: null });
  });

  it("prefers the nearest date, then the lowest id, inside the cluster window", () => {
    const loser = row("AAA", "2026-10-28", "finnhub", 1);
    const far = row("AAA", "2026-11-05", "nasdaq", 0);
    const near = row("AAA", "2026-10-29", "manual", 0);
    expect(resolveKeptEarningsEventId(db, loser)!.id).toBe(near);
    expect(far).not.toBe(near);
  });

  it("follows across issuer siblings (dual-class symbols share a print)", () => {
    const loser = row("GOOG", "2026-10-28", "finnhub", 1);
    const kept = row("GOOGL", "2026-10-28", "nasdaq", 0);
    expect(resolveKeptEarningsEventId(db, loser)!.id).toBe(kept);
  });

  it("a superseded row with no kept twin is still shown as itself", () => {
    const loser = row("AAA", "2026-10-28", "finnhub", 1);
    expect(resolveKeptEarningsEventId(db, loser)).toEqual({ id: loser, followedFrom: null });
  });
});

describe("the filing summary page follows the kept twin", () => {
  it("resolves the route id through resolveKeptEarningsEventId before reading the view", () => {
    const src = readFileSync("app/dashboard/print/[eventId]/filings/page.tsx", "utf8");
    expect(src).toContain('from "@/lib/calendar/kept-twin"');
    const resolve = src.indexOf("resolveKeptEarningsEventId(db, id)");
    const view = src.indexOf("getFullView(db, kept.id");
    expect(resolve).toBeGreaterThan(0);
    expect(view).toBeGreaterThan(resolve);
  });
});
