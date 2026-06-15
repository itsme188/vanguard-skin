import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getArmedLevels } from "@/lib/queries/security-levels";
import {
  upsertLevel,
  deactivateLevel,
  setLevelReviewStatus,
} from "@/lib/mutations/security-levels";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedSecurity(symbol: string, name = `${symbol} Corp`): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)",
    )
    .run(symbol, name).lastInsertRowid as number;
}

function seedPrice(securityId: number, price: number, date = "2026-06-15"): void {
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'manual')",
  ).run(securityId, date, price);
}

function seedBenchmarkPrice(symbol: string, price: number, date = "2026-06-15"): void {
  db.prepare(
    "INSERT INTO benchmark_prices (symbol, date, close_price) VALUES (?, ?, ?)",
  ).run(symbol, date, price);
}

describe("getArmedLevels (U3 armed-levels view)", () => {
  it("returns armed levels enriched + sorted nearest-to-trigger first", () => {
    const aapl = seedSecurity("AAPL");
    seedPrice(aapl, 101);
    upsertLevel(db, { security_id: aapl, level_type: "entry", price: 100 }); // +1.0%

    const msft = seedSecurity("MSFT");
    seedPrice(msft, 98);
    upsertLevel(db, { security_id: msft, level_type: "support", price: 100 }); // -2.0%

    const tsla = seedSecurity("TSLA");
    seedPrice(tsla, 110);
    upsertLevel(db, { security_id: tsla, level_type: "resistance", price: 100 }); // +10.0%

    const armed = getArmedLevels(db);
    expect(armed.map((l) => l.symbol)).toEqual(["AAPL", "MSFT", "TSLA"]);

    const aaplRow = armed[0];
    expect(aaplRow.symbol).toBe("AAPL");
    expect(aaplRow.security_name).toBe("AAPL Corp");
    expect(aaplRow.effective_price).toBe(100);
    expect(aaplRow.current_price).toBe(101);
    expect(aaplRow.distance_pct).toBeCloseTo(0.01, 5);
    expect(armed[1].distance_pct).toBeCloseTo(-0.02, 5); // MSFT below its support
  });

  it("excludes pending-review, inactive, and expired levels", () => {
    const goog = seedSecurity("GOOG");
    seedPrice(goog, 100);
    const reviewId = upsertLevel(db, { security_id: goog, level_type: "entry", price: 95 });
    setLevelReviewStatus(db, reviewId, "pending_review"); // not yet armed

    const amzn = seedSecurity("AMZN");
    seedPrice(amzn, 100);
    const inactiveId = upsertLevel(db, { security_id: amzn, level_type: "entry", price: 95 });
    deactivateLevel(db, inactiveId);

    const meta = seedSecurity("META");
    seedPrice(meta, 100);
    upsertLevel(db, {
      security_id: meta,
      level_type: "entry",
      price: 95,
      expires_at: "2020-01-01",
    });

    expect(getArmedLevels(db)).toHaveLength(0);
  });

  it("keeps a level with no price but sinks it to the bottom (distance null)", () => {
    const aapl = seedSecurity("AAPL");
    seedPrice(aapl, 101);
    upsertLevel(db, { security_id: aapl, level_type: "entry", price: 100 });

    const nopx = seedSecurity("NOPX");
    // no price seeded
    upsertLevel(db, { security_id: nopx, level_type: "entry", price: 50 });

    const armed = getArmedLevels(db);
    expect(armed.map((l) => l.symbol)).toEqual(["AAPL", "NOPX"]);
    const nopxRow = armed[1];
    expect(nopxRow.current_price).toBeNull();
    expect(nopxRow.distance_pct).toBeNull();
  });

  it("resolves current_price from benchmark_prices when there's no primary price (index ETFs)", () => {
    const dia = seedSecurity("DIA", "SPDR Dow Jones");
    seedBenchmarkPrice("DIA", 440);
    upsertLevel(db, { security_id: dia, level_type: "support", price: 430 });

    const armed = getArmedLevels(db);
    expect(armed).toHaveLength(1);
    expect(armed[0].current_price).toBe(440);
    expect(armed[0].distance_pct).toBeCloseTo((440 - 430) / 430, 5);
  });
});
