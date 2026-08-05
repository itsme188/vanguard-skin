/**
 * Regression pin (qa:security-detail-krw--suggested-levels-mix-native-level-with-usd-price):
 * the suggested-levels route must run the pivot/ATR math in ONE currency
 * frame (native — the bars' frame). Pre-fix it passed the USD-converted
 * getLatestPrice as currentPrice against native-KRW bars, producing
 * +199,687% distances and a panel ATR 1,389x the QuoteStats ATR.
 *
 * Display conversion happens at the client's dollar-text sites via the
 * `usdPerUnit` field this route now returns (chart-adjacent display pattern).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as import("better-sqlite3").Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

import { GET } from "@/app/api/suggested-levels/route";

const KRW_PER_USD = 1390;
const USD_PER_KRW = 1 / KRW_PER_USD;

function seedSecurity(
  db: Database.Database,
  opts: { symbol: string; currency: string; base: number },
): number {
  db.prepare(
    `INSERT INTO securities (symbol, name, security_type, currency)
     VALUES (?, ?, 'Stock', ?)`,
  ).run(opts.symbol, `${opts.symbol} test`, opts.currency);
  const secId = (
    db.prepare("SELECT id FROM securities WHERE symbol = ?").get(opts.symbol) as {
      id: number;
    }
  ).id;

  // ~60 daily bars oscillating around `base` with clear pivot structure.
  const insBar = db.prepare(
    `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume)
     VALUES (?, ?, '1 day', ?, ?, ?, ?, 1000)`,
  );
  const start = new Date("2026-05-04T00:00:00Z");
  let lastClose = opts.base;
  let offset = 0;
  for (let i = 0; i < 60; i++) {
    const d = new Date(start.getTime() + offset * 86_400_000);
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
      offset += 1;
      d.setTime(start.getTime() + offset * 86_400_000);
    }
    // Sine-wave oscillation ±8% gives repeated pivot highs/lows.
    const close = opts.base * (1 + 0.08 * Math.sin(i / 4));
    const high = close * 1.01;
    const low = close * 0.99;
    insBar.run(secId, d.toISOString().slice(0, 10), lastClose, high, low, close);
    lastClose = close;
    offset += 1;
  }

  // Latest price row in NATIVE currency (prices are stored native).
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-08-04', ?, 'tws')",
  ).run(secId, opts.base);
  return secId;
}

describe("GET /api/suggested-levels currency frame", () => {
  beforeEach(() => {
    hoisted.db = new Database(":memory:");
    hoisted.db.pragma("journal_mode = WAL");
    hoisted.db.pragma("foreign_keys = ON");
    runMigrations(hoisted.db);
    hoisted.db
      .prepare(
        `INSERT INTO fx_rates (currency, usd_per_unit, as_of, source)
         VALUES ('KRW', ?, '2026-08-04', 'ibkr_ledger')`,
      )
      .run(USD_PER_KRW);
  });

  it("computes distances native-vs-native for a KRW security and returns usdPerUnit", async () => {
    const secId = seedSecurity(hoisted.db, {
      symbol: "402340",
      currency: "KRW",
      base: 950_000,
    });

    const res = await GET(
      new Request(`http://localhost/api/suggested-levels?securityId=${secId}`) as never,
    );
    const body = await res.json();

    // Current price must be the NATIVE frame (the bars' frame), not USD.
    expect(body.currentPrice).toBeCloseTo(950_000, 0);
    expect(body.usdPerUnit).toBeCloseTo(USD_PER_KRW, 6);

    // Pre-fix every level sat +17,000%..+199,687% away. Native-vs-native,
    // pivots from a ±8% oscillation sit within a sane band.
    expect(body.levels.length).toBeGreaterThan(0);
    for (const level of body.levels) {
      expect(Math.abs(level.distancePct)).toBeLessThan(50);
    }

    // Panel ATR is native too — display converts via usdPerUnit; the native
    // ATR of a ±1% bar range around 950,000 is thousands of won, and
    // usdPerUnit maps it back to the QuoteStats dollar scale.
    expect(body.atr).toBeGreaterThan(1000);
  });

  it("returns usdPerUnit 1 for a USD security (display path unchanged)", async () => {
    const secId = seedSecurity(hoisted.db, {
      symbol: "TESTUS",
      currency: "USD",
      base: 100,
    });

    const res = await GET(
      new Request(`http://localhost/api/suggested-levels?securityId=${secId}`) as never,
    );
    const body = await res.json();
    expect(body.usdPerUnit).toBe(1);
    expect(body.currentPrice).toBeCloseTo(100, 5);
  });
});
