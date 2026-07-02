/**
 * Tests for lib/ibkr/refresh.ts::writeIbkrHoldings — the DB-write half of the
 * Tier 2 Web API refresh (the network fetch is separate + integration-tested
 * live). Verifies it mirrors the TWS sync conventions: holdings source_key
 * `tws-…`, prices/snapshot source='tws', zero-qty skipped, securities upserted.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { writeIbkrHoldings } from "@/lib/ibkr/refresh";
import type { MappedPosition } from "@/lib/ibkr/map-positions";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db); // seeds the default accounts incl. 'IBKR'
});

function stock(
  symbol: string,
  qty: number,
  avgCost: number,
  mktPrice: number,
  opts: { currency?: string; mktValue?: number } = {},
): MappedPosition {
  return {
    symbol,
    securityType: "Stock",
    assetClass: "STK",
    conid: 1000 + symbol.length,
    quantity: qty,
    avgCost,
    costBasis: avgCost ? qty * avgCost : null,
    mktPrice,
    mktValue: opts.mktValue ?? qty * mktPrice,
    currency: opts.currency ?? "USD",
  };
}

describe("writeIbkrHoldings", () => {
  it("writes holdings + prices + snapshot mirroring TWS conventions", () => {
    const res = writeIbkrHoldings(
      db,
      {
        accountCode: "U13643679",
        netLiq: 487950,
        cash: 90411,
        positions: [stock("NET", 60, 200, 269.42), stock("SPY", 100, 473, 758.08)],
      },
      { asOfDate: "2026-06-03" },
    );

    expect(res.positionsWritten).toBe(2);
    expect(res.pricesWritten).toBe(2);
    expect(res.accountId).toBeGreaterThan(0);

    const holdings = db
      .prepare(
        "SELECT s.symbol, h.quantity, h.cost_basis, h.source_key FROM holdings h JOIN securities s ON s.id=h.security_id WHERE h.as_of_date='2026-06-03' ORDER BY s.symbol",
      )
      .all() as { symbol: string; quantity: number; cost_basis: number; source_key: string }[];
    expect(holdings.map((h) => h.symbol)).toEqual(["NET", "SPY"]);
    expect(holdings.every((h) => h.source_key.startsWith("tws-"))).toBe(true);
    expect(holdings.find((h) => h.symbol === "NET")!.cost_basis).toBe(60 * 200);

    const prices = db
      .prepare("SELECT COUNT(*) c FROM prices WHERE date='2026-06-03' AND source='tws'")
      .get() as { c: number };
    expect(prices.c).toBe(2);

    const snap = db
      .prepare("SELECT total_value, cash_value, source FROM monthly_snapshots WHERE month_end_date='2026-06-03'")
      .get() as { total_value: number; cash_value: number; source: string };
    expect(snap.total_value).toBe(487950);
    expect(snap.cash_value).toBe(90411);
    expect(snap.source).toBe("tws");
  });

  it("skips zero-quantity positions (closed) but still writes the snapshot", () => {
    const res = writeIbkrHoldings(
      db,
      { accountCode: "U1", netLiq: 1000, cash: 1000, positions: [stock("CLOSED", 0, 0, 10)] },
      { asOfDate: "2026-06-03" },
    );
    expect(res.positionsWritten).toBe(0);
    const h = db.prepare("SELECT COUNT(*) c FROM holdings WHERE as_of_date='2026-06-03'").get() as { c: number };
    expect(h.c).toBe(0);
  });

  it("persists a non-USD currency and derives + writes the fx_rates row", () => {
    const res = writeIbkrHoldings(
      db,
      {
        accountCode: "U1",
        netLiq: 500000,
        cash: 10000,
        positions: [
          stock("402340", 10, 1_632_979.2, 1_731_000, { currency: "KRW", mktValue: 12705 }),
        ],
      },
      { asOfDate: "2026-06-03" },
    );
    expect(res.positionsWritten).toBe(1);

    const sec = db.prepare("SELECT currency FROM securities WHERE symbol = '402340'").get() as { currency: string };
    expect(sec.currency).toBe("KRW");

    const fx = db
      .prepare("SELECT usd_per_unit, source FROM fx_rates WHERE currency = 'KRW'")
      .get() as { usd_per_unit: number; source: string };
    expect(fx.usd_per_unit).toBeCloseTo(0.000734, 6);
    expect(fx.source).toBe("ibkr_derived");
  });

  it("does not write an fx_rates row for a USD position", () => {
    writeIbkrHoldings(
      db,
      { accountCode: "U1", netLiq: 500000, cash: 10000, positions: [stock("NET", 60, 200, 269.42)] },
      { asOfDate: "2026-06-03" },
    );
    const count = db.prepare("SELECT COUNT(*) c FROM fx_rates").get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("throws when the DB account is missing", () => {
    db.prepare("DELETE FROM accounts").run();
    expect(() =>
      writeIbkrHoldings(db, { accountCode: "U1", netLiq: 1, cash: 1, positions: [] }, { asOfDate: "2026-06-03" }),
    ).toThrow(/account/i);
  });
});
