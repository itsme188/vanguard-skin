import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getOhlcvBars,
  getRecentOhlcvBars,
  getLatestOhlcvDate,
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

    it("ignores corrupt zero-low bars when computing the 52-week low", () => {
      const id = seedSecurity(db, "CORRUPT");
      seedDailyBars(db, id, "2026-04-23", 30, 100, 0.1);
      const trueMinLow = db
        .prepare(
          `SELECT MIN(low) AS low FROM ohlcv_bars WHERE security_id = ? AND low > 0`,
        )
        .get(id) as { low: number };
      // Corrupt two already-seeded in-window bars in place: real open/high
      // kept, but low and close wrongly zeroed (the observed bug shape —
      // TWS bars where open/high are real but low/close came back 0).
      db.prepare(
        `UPDATE ohlcv_bars SET open = 2780, high = 2960, low = 0, close = 0
         WHERE security_id = ? AND bar_date = ?`,
      ).run(id, "2026-04-20");
      db.prepare(
        `UPDATE ohlcv_bars SET open = 2790, high = 2965, low = 0, close = 0
         WHERE security_id = ? AND bar_date = ?`,
      ).run(id, "2026-04-21");
      const range = get52WeekRange(db, id);
      expect(range).not.toBeNull();
      expect(range!.low).toBeCloseTo(trueMinLow.low, 6);
      expect(range!.low).toBeGreaterThan(0);
    });

    it("ignores corrupt zero-high bars when computing the 52-week high", () => {
      const id = seedSecurity(db, "CORRUPTHIGH");
      seedDailyBars(db, id, "2026-04-23", 30, 100, 0.1);
      // Corrupting the LATEST bar (2026-04-23) matters: with positive drift,
      // that is the date that WOULD be the true max/endDate if the guard
      // were absent. If we corrupted an earlier date instead, the real max
      // (still sitting on the last bar) would mask a missing guard and this
      // test would pass for the wrong reason.
      const trueMaxHigh = db
        .prepare(
          `SELECT MAX(high) AS high FROM ohlcv_bars
           WHERE security_id = ? AND bar_date != ? AND high > 0`,
        )
        .get(id, "2026-04-23") as { high: number };
      db.prepare(
        `UPDATE ohlcv_bars SET open = 50, high = 0, low = 0, close = 0
         WHERE security_id = ? AND bar_date = ?`,
      ).run(id, "2026-04-23");
      const range = get52WeekRange(db, id);
      expect(range).not.toBeNull();
      expect(range!.high).toBeCloseTo(trueMaxHigh.high, 6);
      // Without the guard the corrupt bar's high (0) can't produce this —
      // but a stale MAX(bar_date) picking up the corrupt row would also be
      // wrong in a different way (see the endDate test below).
      expect(range!.high).toBeLessThan(103.9);
    });

    it("returns null once corrupt bars push the priced-bar count below the n>=10 floor, even with 12 raw rows", () => {
      const id = seedSecurity(db, "THINPRICED");
      seedDailyBars(db, id, "2026-04-23", 12, 100, 0.1);
      // 12 raw rows exist, but 5 are corrupted (zero-priced) — only 7 bars
      // carry a positive low, below the n >= 10 floor. A floor that counted
      // raw rows (or that dropped back to plain COUNT(*)) would wrongly
      // return a range here.
      const corruptDates = [
        "2026-04-12",
        "2026-04-13",
        "2026-04-14",
        "2026-04-15",
        "2026-04-16",
      ];
      for (const d of corruptDates) {
        db.prepare(
          `UPDATE ohlcv_bars SET high = 0, low = 0, close = 0
           WHERE security_id = ? AND bar_date = ?`,
        ).run(id, d);
      }
      expect(get52WeekRange(db, id)).toBeNull();
    });

    it("endDate ignores a trailing corrupt bar and names the last bar that actually contributed", () => {
      const id = seedSecurity(db, "TRAILCORRUPT");
      seedDailyBars(db, id, "2026-04-23", 30, 100, 0.1);
      // Corrupt only the very latest bar. A plain MAX(bar_date) would still
      // report 2026-04-23 as endDate even though that row contributed no
      // real price — endDate must fall back to the prior (real) bar.
      db.prepare(
        `UPDATE ohlcv_bars SET open = 50, high = 0, low = 0, close = 0
         WHERE security_id = ? AND bar_date = ?`,
      ).run(id, "2026-04-23");
      const range = get52WeekRange(db, id);
      expect(range).not.toBeNull();
      expect(range!.endDate).toBe("2026-04-22");
    });
  });

  describe("corrupt-bar read guard (getOhlcvBars / getRecentOhlcvBars / getLatestDailyBar / getLatestOhlcvDate)", () => {
    /**
     * Seeds 30 real daily bars ending 2026-04-23, then corrupts two of them
     * in place to the two known TWS defect shapes:
     *  - the NEWEST bar (2026-04-23): real open/high, low = 0, close = 0
     *    (the exact shape from the charts-candles finding — a trailing
     *    corrupt bar, which is the case that would break an incremental
     *    fetch anchor if getLatestOhlcvDate were ever filtered).
     *  - a middle bar (2026-04-15): high < low (the other guard condition,
     *    distinct from the zero-price shape).
     * Returns the corrupted dates so tests can assert they're excluded.
     */
    function seedWithCorruptBars(db: Database.Database, symbol: string) {
      const id = seedSecurity(db, symbol);
      seedDailyBars(db, id, "2026-04-23", 30, 100, 0.1);
      db.prepare(
        `UPDATE ohlcv_bars SET low = 0, close = 0
         WHERE security_id = ? AND bar_date = ?`,
      ).run(id, "2026-04-23");
      db.prepare(
        `UPDATE ohlcv_bars SET open = 50, high = 90, low = 95, close = 92
         WHERE security_id = ? AND bar_date = ?`,
      ).run(id, "2026-04-15");
      return { id, corruptDates: ["2026-04-23", "2026-04-15"] };
    }

    describe("getOhlcvBars", () => {
      it("skips corrupt bars with no options", () => {
        const { id, corruptDates } = seedWithCorruptBars(db, "KRWX");
        const bars = getOhlcvBars(db, id, "1 day");
        expect(bars.length).toBe(28); // 30 seeded - 2 corrupt
        for (const d of corruptDates) {
          expect(bars.some((b) => b.date === d)).toBe(false);
        }
        // Newest surviving bar is the day before the corrupted trailing bar.
        expect(bars[bars.length - 1].date).toBe("2026-04-22");
      });

      it("skips corrupt bars when limit is set (ASC-then-LIMIT takes oldest priced bars)", () => {
        const { id, corruptDates } = seedWithCorruptBars(db, "KRWX2");
        const bars = getOhlcvBars(db, id, "1 day", { limit: 3 });
        expect(bars.length).toBe(3);
        for (const b of bars) {
          expect(corruptDates).not.toContain(b.date);
        }
      });

      it("skips a corrupt bar even when it falls inside an explicit start/end window", () => {
        const { id } = seedWithCorruptBars(db, "KRWX3");
        // This window brackets the corrupted trailing bar (2026-04-23) —
        // without the read guard it would be included.
        const bars = getOhlcvBars(db, id, "1 day", {
          startDate: "2026-04-20",
          endDate: "2026-04-23",
        });
        expect(bars.some((b) => b.date === "2026-04-23")).toBe(false);
        expect(bars.every((b) => b.close > 0 && b.low > 0)).toBe(true);
        expect(bars.length).toBe(3); // 04-20, 04-21, 04-22
      });
    });

    describe("getRecentOhlcvBars", () => {
      it("returns exactly `limit` PRICED bars, newest-first-then-ascending, skipping a trailing corrupt bar", () => {
        const { id, corruptDates } = seedWithCorruptBars(db, "KRWX4");
        const bars = getRecentOhlcvBars(db, id, "1 day", 5);
        expect(bars.length).toBe(5);
        for (const b of bars) {
          expect(corruptDates).not.toContain(b.date);
        }
        // Strictly ascending dates (oldest to newest within the window).
        for (let i = 1; i < bars.length; i++) {
          expect(bars[i].date > bars[i - 1].date).toBe(true);
        }
        // The newest returned bar is the newest PRICED bar, not the
        // corrupted 2026-04-23 trailing row.
        expect(bars[bars.length - 1].date).toBe("2026-04-22");
      });

      it("still returns exactly `limit` PRICED bars when the window spans a corrupt bar in the middle", () => {
        const { id, corruptDates } = seedWithCorruptBars(db, "KRWX5");
        // 10 newest priced bars, walking back from 2026-04-22, spans across
        // the 2026-04-15 corrupt bar — the count must not come up short.
        const bars = getRecentOhlcvBars(db, id, "1 day", 10);
        expect(bars.length).toBe(10);
        for (const b of bars) {
          expect(corruptDates).not.toContain(b.date);
        }
      });
    });

    describe("getLatestDailyBar", () => {
      it("returns the newest PRICED bar, not a corrupt trailing bar", () => {
        const { id } = seedWithCorruptBars(db, "KRWX6");
        const latest = getLatestDailyBar(db, id);
        expect(latest).not.toBeNull();
        expect(latest!.date).toBe("2026-04-22");
        expect(latest!.close).toBeGreaterThan(0);
        expect(latest!.low).toBeGreaterThan(0);
      });
    });

    describe("getLatestOhlcvDate", () => {
      it("still returns the raw MAX(bar_date), including a corrupt trailing bar (incremental-fetch anchor)", () => {
        const { id } = seedWithCorruptBars(db, "KRWX7");
        // Deliberately unfiltered: filtering this anchor would make an
        // incremental TWS fetch re-request the same window forever once the
        // write-side guard (upsertOhlcvBars) refuses to re-store the same
        // corrupt bar.
        expect(getLatestOhlcvDate(db, id, "1 day")).toBe("2026-04-23");
      });
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

    it("never reports a zero 52-week low from corrupt zero-priced bars", () => {
      const id = seedSecurity(db, "NVDA");
      seedDailyBars(db, id, "2026-04-23", 30, 100, 0.1);
      // Corrupt an already-seeded in-window bar in place: real open/high,
      // low and close wrongly 0.
      db.prepare(
        `UPDATE ohlcv_bars SET open = 2780, high = 2960, low = 0, close = 0
         WHERE security_id = ? AND bar_date = ?`,
      ).run(id, "2026-04-21");
      // No security_quotes row, so the KPI falls through to the bars-derived
      // range — this is the exact path that rendered $0.00 on the page.
      const kpis = getKpisForSecurity(db, id);
      expect(kpis).not.toBeNull();
      expect(kpis!.week52Low).not.toBeNull();
      expect(kpis!.week52Low!).toBeGreaterThan(0);
    });
  });
});
