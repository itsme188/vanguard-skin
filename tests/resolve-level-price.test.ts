import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  computeMovingAverage,
  resolveLevelPrice,
} from "@/lib/alerts/resolve-level-price";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedSec(symbol: string): number {
  const r = db.prepare(
    "INSERT INTO securities (symbol, security_type, asset_class, multiplier) VALUES (?, 'stock', 'equity', 1)"
  ).run(symbol);
  return r.lastInsertRowid as number;
}

function seedBars(secId: number, closes: number[], startDate = "2026-01-01"): void {
  // Use UTC to avoid DST / timezone boundary issues producing duplicate ISO dates.
  const [sy, sm, sd] = startDate.split("-").map(Number);
  const startMs = Date.UTC(sy, sm - 1, sd);
  const stmt = db.prepare(
    "INSERT INTO ohlcv_bars (security_id, bar_date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, 0)"
  );
  closes.forEach((close, i) => {
    const d = new Date(startMs + i * 86400000);
    const dateStr = d.toISOString().slice(0, 10);
    stmt.run(secId, dateStr, close, close, close, close);
  });
}

describe("computeMovingAverage", () => {
  it("returns null when insufficient bars for the period", () => {
    const sec = seedSec("AAPL");
    seedBars(sec, [100, 101, 102]); // only 3 bars
    expect(computeMovingAverage(db, sec, "sma_50")).toBeNull();
  });

  it("computes SMA over the trailing period", () => {
    const sec = seedSec("AAPL");
    // 10 bars, values 1..10 — SMA-5 of last 5 = (6+7+8+9+10)/5 = 8
    seedBars(sec, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(computeMovingAverage(db, sec, "sma_9")).toBeCloseTo(6, 4); // (2..10)/9 = 54/9 = 6
  });

  it("computes SMA-50 when exactly 50 bars exist", () => {
    const sec = seedSec("AAPL");
    const closes = Array.from({ length: 50 }, (_, i) => 100 + i); // 100..149
    seedBars(sec, closes);
    const avg = (100 + 149) / 2;  // arithmetic mean of 100..149
    expect(computeMovingAverage(db, sec, "sma_50")).toBeCloseTo(avg, 4);
  });

  it("computes EMA with the standard 2/(period+1) multiplier", () => {
    const sec = seedSec("AAPL");
    // 20 bars, constant value — EMA should equal the constant
    seedBars(sec, Array(20).fill(150));
    expect(computeMovingAverage(db, sec, "ema_9")).toBeCloseTo(150, 4);
  });

  it("returns the most recent MA value when bars exceed period", () => {
    const sec = seedSec("AAPL");
    // 100 bars rising linearly — latest SMA-9 should be near the end
    const closes = Array.from({ length: 100 }, (_, i) => i + 1);
    seedBars(sec, closes);
    // Last 9 closes: 92..100 → mean 96
    expect(computeMovingAverage(db, sec, "sma_9")).toBeCloseTo(96, 4);
  });

  it("returns null for unknown price sources", () => {
    const sec = seedSec("AAPL");
    seedBars(sec, Array(20).fill(100));
    // @ts-expect-error — intentionally invalid
    expect(computeMovingAverage(db, sec, "sma_foo")).toBeNull();
  });
});

describe("resolveLevelPrice", () => {
  it("returns static price unchanged for price_source=static", () => {
    const sec = seedSec("AAPL");
    const result = resolveLevelPrice(db, {
      security_id: sec,
      price: 180.50,
      price_source: "static",
    });
    expect(result).toBe(180.50);
  });

  it("returns computed MA for MA-based levels", () => {
    const sec = seedSec("AAPL");
    seedBars(sec, Array(20).fill(150));
    const result = resolveLevelPrice(db, {
      security_id: sec,
      price: 999, // reference; should be ignored
      price_source: "sma_9",
    });
    expect(result).toBeCloseTo(150, 4);
  });

  it("falls back to stored price when insufficient bars", () => {
    const sec = seedSec("AAPL");
    seedBars(sec, [100, 101]); // only 2 bars — not enough for sma_50
    const result = resolveLevelPrice(db, {
      security_id: sec,
      price: 175,
      price_source: "sma_50",
    });
    expect(result).toBe(175);
  });
});
