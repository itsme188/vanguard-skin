import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getLatestDailyBar,
  get52WeekRange,
} from "@/lib/queries/ohlcv";
import { getKpisForSecurity } from "@/lib/queries/security-detail";

function seedSecurity(db: Database.Database, symbol: string): number {
  const result = db
    .prepare("INSERT INTO securities (symbol, name) VALUES (?, ?)")
    .run(symbol, symbol + " Corp");
  return result.lastInsertRowid as number;
}

/**
 * Seed N daily bars ending on `endDate`. Each bar's OHLC is based on
 * `basePrice + index * drift` with a +/- 1 wiggle for high/low so TR is
 * non-zero and ATR is computable.
 */
function seedDailyBars(
  db: Database.Database,
  securityId: number,
  endDate: string,
  count: number,
  basePrice: number = 100,
  drift: number = 0.1,
) {
  const end = new Date(endDate);
  const stmt = db.prepare(
    `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume)
     VALUES (?, ?, '1 day', ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < count; i++) {
    const d = new Date(end);
    d.setUTCDate(end.getUTCDate() - (count - 1 - i));
    const date = d.toISOString().slice(0, 10);
    const close = basePrice + i * drift;
    const open = close - 0.2;
    const high = close + 1;
    const low = close - 1;
    const volume = 1_000_000 + i * 1000;
    stmt.run(securityId, date, open, high, low, close, volume);
  }
}

describe("ohlcv queries — KPI row", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  describe("getLatestDailyBar", () => {
    it("returns the most recent daily bar", () => {
      const id = seedSecurity(db, "NVDA");
      seedDailyBars(db, id, "2026-04-23", 5, 100);
      const latest = getLatestDailyBar(db, id);
      expect(latest).not.toBeNull();
      expect(latest!.date).toBe("2026-04-23");
      expect(latest!.open).toBeCloseTo(100.2, 1);
      expect(latest!.high).toBeCloseTo(101.4, 1);
      expect(latest!.low).toBeCloseTo(99.4, 1);
      expect(latest!.volume).toBe(1_004_000);
    });

    it("returns null when no bars exist", () => {
      const id = seedSecurity(db, "ACME");
      expect(getLatestDailyBar(db, id)).toBeNull();
    });

    it("ignores non-daily bar_sizes", () => {
      const id = seedSecurity(db, "SPY");
      db.prepare(
        `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume)
         VALUES (?, ?, '1 min', 100, 101, 99, 100, 500)`,
      ).run(id, "2026-04-23");
      expect(getLatestDailyBar(db, id)).toBeNull();
    });
  });

  describe("get52WeekRange", () => {
    it("returns min-low and max-high across the trailing year window", () => {
      const id = seedSecurity(db, "HOOD");
      seedDailyBars(db, id, "2026-04-23", 200, 50, 0.2);
      // last bar close ≈ 50 + 199*0.2 = 89.8, high ≈ 90.8
      // first bar close ≈ 50, low ≈ 49
      const range = get52WeekRange(db, id);
      expect(range).not.toBeNull();
      expect(range!.low).toBeCloseTo(49, 1);
      expect(range!.high).toBeCloseTo(90.8, 1);
    });

    it("returns null when fewer than 10 bars exist", () => {
      const id = seedSecurity(db, "TINY");
      seedDailyBars(db, id, "2026-04-23", 5, 100);
      expect(get52WeekRange(db, id)).toBeNull();
    });

    it("uses the DB's latest bar date, not calendar today, for the window anchor", () => {
      const id = seedSecurity(db, "STALE");
      // 60 bars, latest date 6 months ago — still enough history behind that
      // point for a valid 52w window on the DB's anchor.
      seedDailyBars(db, id, "2025-10-15", 60, 200, 0.5);
      const range = get52WeekRange(db, id);
      expect(range).not.toBeNull();
      // Anchor is 2025-10-15, so bars from ~2025-08-17 onward are included.
      expect(range!.endDate).toBe("2025-10-15");
    });

    it("excludes bars older than 365 days from the latest anchor", () => {
      const id = seedSecurity(db, "DEEP");
      // One very-old bar + a fresh run of 30
      db.prepare(
        `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume)
         VALUES (?, ?, '1 day', 1, 9999, 1, 1, 1)`,
      ).run(id, "2020-01-01");
      seedDailyBars(db, id, "2026-04-23", 30, 100, 0.1);
      const range = get52WeekRange(db, id);
      expect(range).not.toBeNull();
      // The 9999 outlier must NOT be picked up (older than 365 days from
      // 2026-04-23).
      expect(range!.high).toBeLessThan(200);
    });
  });

  describe("getKpisForSecurity", () => {
    it("returns null when no bars exist", () => {
      const id = seedSecurity(db, "EMPTY");
      expect(getKpisForSecurity(db, id)).toBeNull();
    });

    it("packs the latest bar plus 52w range and ATR", () => {
      const id = seedSecurity(db, "NVDA");
      seedDailyBars(db, id, "2026-04-23", 60, 100, 0.1);
      const kpis = getKpisForSecurity(db, id);
      expect(kpis).not.toBeNull();
      expect(kpis!.asOfDate).toBe("2026-04-23");
      expect(kpis!.open).not.toBeNull();
      expect(kpis!.dayHigh).not.toBeNull();
      expect(kpis!.dayLow).not.toBeNull();
      expect(kpis!.volume).not.toBeNull();
      expect(kpis!.week52High).not.toBeNull();
      expect(kpis!.week52Low).not.toBeNull();
      // ATR with constant-sized H-L=2 + small drift should converge near 2.
      expect(kpis!.atr14).not.toBeNull();
      expect(kpis!.atr14!).toBeGreaterThan(1);
      expect(kpis!.atr14!).toBeLessThan(3);
    });

    it("omits ATR when fewer than 15 bars exist but still fills the rest", () => {
      const id = seedSecurity(db, "SHORT");
      seedDailyBars(db, id, "2026-04-23", 12, 50, 0.1);
      const kpis = getKpisForSecurity(db, id);
      expect(kpis).not.toBeNull();
      expect(kpis!.atr14).toBeNull();
      expect(kpis!.dayHigh).not.toBeNull();
      // 12 bars < 10 floor? No, 12 >= 10 so range should exist
      expect(kpis!.week52High).not.toBeNull();
    });
  });
});
