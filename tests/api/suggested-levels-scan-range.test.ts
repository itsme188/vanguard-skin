/**
 * Regression pin (qa:levels-suggestions--accept-arms-level-beyond-plausibility-
 * scan-range-regression-2): the route is the surface that actually offers
 * Accept buttons, so it must pass the security's type into the engine — the
 * scan band applies to stocks/ETFs and is waived for options exactly as the
 * scanner waives it.
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

const CURRENT = 100;

/**
 * Old regime around 300 (pivot highs 310 / lows 290), recent regime around 100
 * (pivot highs 110 / lows 90). At a current price of 100 the old-regime levels
 * are 66%+ away by the level's own denominator — outside the scan band.
 */
function seedSecurity(
  db: Database.Database,
  opts: { symbol: string; securityType: string },
): number {
  db.prepare(
    `INSERT INTO securities (symbol, name, security_type, currency)
     VALUES (?, ?, ?, 'USD')`,
  ).run(opts.symbol, `${opts.symbol} test`, opts.securityType);
  const secId = (
    db.prepare("SELECT id FROM securities WHERE symbol = ?").get(opts.symbol) as {
      id: number;
    }
  ).id;

  const insBar = db.prepare(
    `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume)
     VALUES (?, ?, '1 day', ?, ?, ?, ?, 1000)`,
  );
  let day = 0;
  const push = (base: number, high: number, low: number) => {
    const date = new Date(Date.UTC(2025, 0, day + 1)).toISOString().slice(0, 10);
    insBar.run(secId, date, base, high, low, base);
    day++;
  };
  for (let i = 0; i < 30; i++) {
    const phase = i % 10;
    push(300, phase === 4 ? 310 : 303, phase === 9 ? 290 : 297);
  }
  for (let i = 0; i < 45; i++) {
    const phase = i % 10;
    push(100, phase === 4 ? 110 : 103, phase === 9 ? 90 : 97);
  }

  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2025-04-15', ?, 'tws')",
  ).run(secId, CURRENT);
  return secId;
}

async function fetchLevels(secId: number) {
  const res = await GET(
    new Request(`http://localhost/api/suggested-levels?securityId=${secId}`) as never,
  );
  const body = await res.json();
  return body.levels as Array<{ price: number; type: string }>;
}

describe("GET /api/suggested-levels scan-range filter", () => {
  beforeEach(() => {
    hoisted.db = new Database(":memory:");
    hoisted.db.pragma("journal_mode = WAL");
    hoisted.db.pragma("foreign_keys = ON");
    runMigrations(hoisted.db);
  });

  it("never offers a stock level the scanner would skip", async () => {
    const secId = seedSecurity(hoisted.db, { symbol: "SCANQA", securityType: "Stock" });
    const levels = await fetchLevels(secId);

    expect(levels.length).toBeGreaterThan(0);
    for (const level of levels) {
      expect(Math.abs(CURRENT - level.price) / level.price).toBeLessThanOrEqual(0.5);
    }
    expect(levels.some((l) => l.price > 250)).toBe(false);
  });

  it("keeps far levels for options (scanner exempts them too)", async () => {
    const secId = seedSecurity(hoisted.db, {
      symbol: "SCANQA  270115C00100000",
      securityType: "Option",
    });
    const levels = await fetchLevels(secId);
    expect(levels.some((l) => l.price > 250)).toBe(true);
  });
});
