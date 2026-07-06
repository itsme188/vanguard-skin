import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertFxRate } from "@/lib/mutations/fx-rates";
import { getLatestPrice } from "@/lib/queries/ohlcv";

// The Charts page header renders getLatestPrice through <Money> — a foreign
// security's native close must carry the FX factor or ₩1,602,000 renders as
// $1.6M/share (QA finding: charts price header, 2026-07-06).

let db: Database.Database;
const TODAY = "2026-07-03";

function seedSecurity(symbol: string, currency: string): number {
  const r = db
    .prepare("INSERT INTO securities (symbol, name, security_type, currency) VALUES (?, ?, 'stock', ?)")
    .run(symbol, `${symbol} Corp`, currency);
  return r.lastInsertRowid as number;
}

function seedPrice(securityId: number, date: string, price: number): void {
  db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')").run(
    securityId,
    date,
    price
  );
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("getLatestPrice FX conversion", () => {
  it("KRW close converts to USD; picks the latest date", () => {
    const krw = seedSecurity("402340", "KRW");
    seedPrice(krw, "2026-07-01", 1_731_000);
    seedPrice(krw, TODAY, 1_602_000);
    upsertFxRate(db, { currency: "KRW", usdPerUnit: 0.0006531, asOf: TODAY, source: "test" });

    const p = getLatestPrice(db, krw);
    expect(p).toBeTruthy();
    expect(p!.date).toBe(TODAY);
    expect(p!.close_price).toBeCloseTo(1_602_000 * 0.0006531, 5);
    expect(p!.close_price).toBeLessThan(2_000);
  });

  it("USD security is byte-unchanged", () => {
    const aapl = seedSecurity("AAPL", "USD");
    seedPrice(aapl, TODAY, 208.5);
    const p = getLatestPrice(db, aapl);
    expect(p!.close_price).toBe(208.5);
  });

  it("missing fx row passes native through at rate 1", () => {
    const krw = seedSecurity("402340", "KRW");
    seedPrice(krw, TODAY, 1_602_000);
    const p = getLatestPrice(db, krw);
    expect(p!.close_price).toBe(1_602_000);
  });
});
