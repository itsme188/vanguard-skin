/**
 * Legacy zero bars vs the quote-strip KPIs (ATR 14, day range).
 *
 * `getKpisForSecurity` reads bars only through `getLatestDailyBar` and
 * `getOhlcvBars`, both filtered by the shared `PRICED_BAR_SQL`. This pins the
 * consequence the desk sees: one stored zero bar (real open/high, low = 0 and
 * close = 0) changes NOTHING — every KPI equals the same series with that row
 * deleted. Raw, a zero low made that day's true range the whole share price
 * and a zero close did the same to the next day's, inflating ATR many-fold.
 * All figures synthetic.
 */

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getKpisForSecurity } from "@/lib/queries/security-detail";

function build(mutate: (db: Database.Database, id: number, dates: string[]) => void) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const id = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, multiplier) VALUES ('QZKPI', 'Zero Bar KPI Co', 'Stock', 1)",
    )
    .run().lastInsertRowid as number;
  const stmt = db.prepare(
    `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume)
     VALUES (?, ?, '1 day', ?, ?, ?, ?, 1000)`,
  );
  const dates: string[] = [];
  const cursor = new Date("2026-02-02T00:00:00Z");
  while (dates.length < 40) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) {
      const iso = cursor.toISOString().slice(0, 10);
      // Gentle, non-flat series so ATR is a real number that could move.
      const close = 200 + (dates.length % 5) * 1.5;
      stmt.run(id, iso, close - 0.5, close + 2, close - 2, close);
      dates.push(iso);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  mutate(db, id, dates);
  return getKpisForSecurity(db, id);
}

const zero = (idx: number) => (db: Database.Database, id: number, dates: string[]) => {
  db.prepare(
    "UPDATE ohlcv_bars SET low = 0, close = 0 WHERE security_id = ? AND bar_date = ?",
  ).run(id, dates[idx]);
};
const remove = (idx: number) => (db: Database.Database, id: number, dates: string[]) => {
  db.prepare("DELETE FROM ohlcv_bars WHERE security_id = ? AND bar_date = ?").run(
    id,
    dates[idx],
  );
};

describe("getKpisForSecurity — a legacy zero bar is simply absent", () => {
  it("mid-series zero bar: ATR and every KPI match the series without that bar", () => {
    const withZero = build(zero(30));
    const without = build(remove(30));
    expect(withZero).not.toBeNull();
    expect(withZero).toEqual(without);
    // Sanity on scale: bars are ~4 wide, so ATR is single digits — not the
    // ~200 a zero low / zero prev-close produces.
    expect(withZero!.atr14).not.toBeNull();
    expect(withZero!.atr14!).toBeLessThan(10);
  });

  it("trailing zero bar: the day range comes from the last priced bar", () => {
    const withZero = build(zero(39));
    const without = build(remove(39));
    expect(withZero).toEqual(without);
    expect(withZero!.dayLow).toBeGreaterThan(0);
  });
});
