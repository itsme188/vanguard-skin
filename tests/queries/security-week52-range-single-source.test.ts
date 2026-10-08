/**
 * qa: security-detail--two-different-52-week-ranges-on-same-page-regression-2
 *
 * The stats strip read a freshness-arbitrated range (bars, or the stored
 * quote when at least as fresh); QuoteStats read the stored quote alone. Where
 * the bars were fresher than the quote the page printed two lows and two
 * highs. Both now read one object, getWeek52Range. Invented round numbers.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertSecurityQuote } from "@/lib/mutations/security-quotes";
import {
  getKpisForSecurity,
  getSecurityDetail,
  getWeek52Range,
} from "@/lib/queries/security-detail";
import { anchorIndex } from "@/tests/helpers/source-anchor";

let db: Database.Database;
let id: number;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  id = db.prepare("INSERT INTO securities (symbol, name) VALUES ('AAA', 'AAA Corp')").run()
    .lastInsertRowid as number;
});

/** n consecutive daily bars ending at endDate: high level+1, low level-1. */
function seedBars(endDate: string, n: number, level: number): void {
  const stmt = db.prepare(
    `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume)
     VALUES (?, ?, '1 day', ?, ?, ?, ?, 1000)`
  );
  const end = new Date(`${endDate}T00:00:00Z`);
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    stmt.run(id, d.toISOString().slice(0, 10), level, level + 1, level - 1, level);
  }
}

function seedQuote(asOfDate: string, low: number | null, high: number | null): void {
  upsertSecurityQuote(db, {
    securityId: id,
    asOfDate,
    ivUnderlying: 0.3,
    hv30d: null,
    week52High: high,
    week52Low: low,
    dividendYield: null,
  });
}

function expectOneRange(expected: { low: number; high: number; asOf: string } | null): void {
  const range = getWeek52Range(db, id);
  expect(range).toEqual(expected);
  // The strip's figures are that same object.
  const kpis = getKpisForSecurity(db, id);
  if (kpis) {
    expect({ low: kpis.week52Low, high: kpis.week52High, asOf: kpis.week52AsOf }).toEqual(
      expected ?? { low: null, high: null, asOf: null }
    );
  }
  // And it is what the page hands QuoteStats.
  expect(getSecurityDetail(db, id)!.week52).toEqual(expected);
}

describe("getWeek52Range — one range for the strip and QuoteStats", () => {
  it("bars fresher than the quote: the bars range, not the stale quote (the finding)", () => {
    seedBars("2026-09-30", 20, 100);
    seedQuote("2026-09-01", 40, 110);
    expectOneRange({ low: 99, high: 101, asOf: "2026-09-30" });
  });

  it("quote at least as fresh as the bars: the quote range", () => {
    seedBars("2026-09-30", 20, 100);
    seedQuote("2026-09-30", 60, 150);
    expectOneRange({ low: 60, high: 150, asOf: "2026-09-30" });
  });

  it("no usable bars: the quote range still reaches QuoteStats while the strip has no KPIs", () => {
    seedQuote("2026-09-01", 60, 150);
    expect(getKpisForSecurity(db, id)).toBeNull();
    expectOneRange({ low: 60, high: 150, asOf: "2026-09-01" });
  });

  it("a quote with half a range never wins", () => {
    seedBars("2026-09-30", 20, 100);
    seedQuote("2026-10-05", null, 150);
    expectOneRange({ low: 99, high: 101, asOf: "2026-09-30" });
  });

  it("neither source: null", () => {
    expectOneRange(null);
  });
});

describe("wiring (source pin)", () => {
  it("the page passes the arbitrated range to QuoteStats", () => {
    const page = readFileSync("app/dashboard/security/[id]/page.tsx", "utf8");
    const call = page.slice(anchorIndex(page, "<QuoteStats"));
    expect(call.slice(0, call.indexOf("/>"))).toContain("range={detail.week52}");
  });

  it("QuoteStats prints the passed range and its as-of date, and reads the quote's own range only when none is passed", () => {
    const src = readFileSync("app/dashboard/components/QuoteStats.tsx", "utf8");
    const pick = src.slice(anchorIndex(src, "const shownRange ="), anchorIndex(src, "const hasRange"));
    expect(pick).toMatch(/range !== undefined\s*\?\s*range/);
    expect(src.split("quote.week52_").length - 1).toBe(4);
    expect(src).toContain("range as of {shownRange?.asOf}");
  });

  it("getKpisForSecurity takes its range from getWeek52Range and nowhere else", () => {
    const src = readFileSync("lib/queries/security-detail.ts", "utf8");
    const kpis = src.slice(
      anchorIndex(src, "export function getKpisForSecurity("),
      anchorIndex(src, "export interface Week52Range")
    );
    expect(kpis).toContain("getWeek52Range(db, securityId)");
    expect(kpis).not.toContain("get52WeekRange(");
    expect(kpis).not.toContain("getSecurityQuote(");
  });
});
