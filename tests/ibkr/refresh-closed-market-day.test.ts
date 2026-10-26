/**
 * DECISIONS 2026-10-26 item 1: writeIbkrHoldings (the one writer behind the
 * Web API timer, the manual POST /api/tws/auto-refresh fallback and
 * scripts/ibkr-refresh-holdings.ts) writes no holdings, price, live-snapshot
 * or ledger FX row dated on a closed market day. Security metadata still
 * updates. Synthetic figures only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { writeIbkrHoldings } from "@/lib/ibkr/refresh";
import type { MappedPosition } from "@/lib/ibkr/map-positions";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

function stock(symbol: string, conid: number, currency = "USD"): MappedPosition {
  return {
    symbol,
    securityType: "Stock",
    assetClass: "STK",
    conid,
    quantity: 10,
    avgCost: 20,
    costBasis: 200,
    mktPrice: 25,
    mktValue: 250,
    currency,
  };
}

const SNAPSHOT = {
  accountCode: "U1",
  netLiq: 1000,
  cash: 100,
  positions: [stock("ZZA", 4101), stock("ZZK", 4102, "KRW")],
  fxRates: { KRW: 0.001 },
};

function count(sql: string): number {
  return (db.prepare(sql).get() as { c: number }).c;
}

describe("writeIbkrHoldings on a closed market day", () => {
  it.each([
    ["Saturday", "2026-03-14"],
    ["a full-closure holiday", "2026-07-03"],
  ])("writes no dated row on %s but still updates security metadata", (_label, day) => {
    const res = writeIbkrHoldings(db, SNAPSHOT, { asOfDate: day });

    expect(res.skippedReason).toBe("market_closed");
    expect(res.positionsWritten).toBe(0);
    expect(res.pricesWritten).toBe(0);
    expect(count("SELECT COUNT(*) AS c FROM holdings")).toBe(0);
    expect(count("SELECT COUNT(*) AS c FROM prices")).toBe(0);
    expect(count("SELECT COUNT(*) AS c FROM monthly_snapshots WHERE source = 'tws'")).toBe(0);
    expect(count("SELECT COUNT(*) AS c FROM fx_rates WHERE source = 'ibkr_ledger'")).toBe(0);
    expect(
      db.prepare("SELECT symbol, ib_con_id FROM securities WHERE symbol IN ('ZZA','ZZK') ORDER BY symbol").all(),
    ).toEqual([
      { symbol: "ZZA", ib_con_id: 4101 },
      { symbol: "ZZK", ib_con_id: 4102 },
    ]);
  });

  it("writes holdings, prices, the snapshot and the FX rate on a trading day", () => {
    const day = "2026-03-13";
    const res = writeIbkrHoldings(db, SNAPSHOT, { asOfDate: day });

    expect(res.skippedReason).toBeNull();
    expect(res.positionsWritten).toBe(2);
    expect(res.pricesWritten).toBe(2);
    expect(count(`SELECT COUNT(*) AS c FROM holdings WHERE as_of_date = '${day}'`)).toBe(2);
    expect(count(`SELECT COUNT(*) AS c FROM prices WHERE date = '${day}'`)).toBe(2);
    expect(count(`SELECT COUNT(*) AS c FROM monthly_snapshots WHERE month_end_date = '${day}' AND source = 'tws'`)).toBe(1);
    expect(count("SELECT COUNT(*) AS c FROM fx_rates WHERE source = 'ibkr_ledger'")).toBe(1);
  });
});
