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
import { getTaxInputGeneration } from "@/lib/compute/tax-convention";
import { countReconRowsOnDate } from "@/lib/mutations/closed-equity";

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

  it("persists a non-USD currency and writes the ledger-sourced fx_rates row", () => {
    // Live-verified 2026-07-03: the Web API's per-position `mktValue` is
    // NATIVE currency (16,010,000 KRW for 10 sh @ 1,601,000), so deriving
    // from it always yields ~1. The rate must come from the ledger's
    // per-currency `exchangerate`, threaded in via snapshot.fxRates.
    const res = writeIbkrHoldings(
      db,
      {
        accountCode: "U1",
        netLiq: 500000,
        cash: 10000,
        positions: [
          stock("402340", 10, 1_632_979.2, 1_731_000, { currency: "KRW", mktValue: 17_310_000 }),
        ],
        fxRates: { KRW: 0.0006531 },
      },
      { asOfDate: "2026-06-03" },
    );
    expect(res.positionsWritten).toBe(1);

    const sec = db.prepare("SELECT currency FROM securities WHERE symbol = '402340'").get() as { currency: string };
    expect(sec.currency).toBe("KRW");

    const fx = db
      .prepare("SELECT usd_per_unit, source, as_of FROM fx_rates WHERE currency = 'KRW'")
      .get() as { usd_per_unit: number; source: string; as_of: string };
    expect(fx.usd_per_unit).toBeCloseTo(0.0006531, 7);
    expect(fx.source).toBe("ibkr_ledger");
    expect(fx.as_of).toBe("2026-06-03");
  });

  it("writes NO fx_rates row for a non-USD position when the ledger has no rate (never derives ~1 from native mktValue)", () => {
    writeIbkrHoldings(
      db,
      {
        accountCode: "U1",
        netLiq: 500000,
        cash: 10000,
        positions: [
          stock("402340", 10, 1_632_979.2, 1_731_000, { currency: "KRW", mktValue: 17_310_000 }),
        ],
        // no fxRates — e.g. ledger fetch failed or lacked the currency
      },
      { asOfDate: "2026-06-03" },
    );
    const count = db.prepare("SELECT COUNT(*) c FROM fx_rates").get() as { c: number };
    expect(count.c).toBe(0);
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

describe("writeIbkrHoldings — tombstone-supersession + price bumps (reconciler-hardening, spec §4)", () => {
  function ibkrAccountId(): number {
    return (db.prepare("SELECT id FROM accounts WHERE name = 'IBKR'").get() as { id: number }).id;
  }
  function seedSecurity(symbol: string): number {
    return (
      db
        .prepare(`INSERT INTO securities (symbol, security_type) VALUES (?, 'Stock') RETURNING id`)
        .get(symbol) as { id: number }
    ).id;
  }
  function seedTombstone(accountId: number, securityId: number, date: string): void {
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
       VALUES (?, ?, 0, ?, ?)`,
    ).run(accountId, securityId, date, `recon:closed-equity:${accountId}:${securityId}:${date}:live`);
  }

  it("bumps on newer-date tombstone supersession (re-bought)", () => {
    const acctId = ibkrAccountId();
    const secId = seedSecurity("NET");
    seedTombstone(acctId, secId, "2000-01-01"); // latest row for NET is a tombstone
    const before = getTaxInputGeneration(db);

    const res = writeIbkrHoldings(
      db,
      { accountCode: "U1", netLiq: 1000, cash: 500, positions: [stock("NET", 60, 200, 269.42)] },
      { asOfDate: "2026-06-15" },
    );

    expect(res.positionsWritten).toBe(1);
    expect(getTaxInputGeneration(db)).toBe(before + 1);
  });

  it("same-date REPLACE of a tombstone bumps", () => {
    const acctId = ibkrAccountId();
    const secId = seedSecurity("SPY");
    seedTombstone(acctId, secId, "2026-06-15"); // same date the write will land on
    expect(countReconRowsOnDate(db, acctId, "2026-06-15")).toBe(1);
    const before = getTaxInputGeneration(db);

    const res = writeIbkrHoldings(
      db,
      { accountCode: "U1", netLiq: 1000, cash: 500, positions: [stock("SPY", 10, 400, 420)] },
      { asOfDate: "2026-06-15" },
    );

    expect(res.positionsWritten).toBe(1);
    // INSERT OR REPLACE consumed the tombstone at that (account, security, date).
    expect(countReconRowsOnDate(db, acctId, "2026-06-15")).toBe(0);
    expect(getTaxInputGeneration(db)).toBe(before + 1);
  });

  it("routine write of a held-only book does not bump (no tombstone anywhere)", () => {
    const before = getTaxInputGeneration(db);

    const res = writeIbkrHoldings(
      db,
      { accountCode: "U1", netLiq: 1000, cash: 500, positions: [stock("AAPL", 100, 150, 190)] },
      { asOfDate: "2026-06-15" },
    );

    expect(res.positionsWritten).toBe(1);
    expect(getTaxInputGeneration(db)).toBe(before);
  });

  it("a throw inside the writer's transaction rolls back writes AND bump together", () => {
    const acctId = ibkrAccountId();
    const secId = seedSecurity("NET");
    seedTombstone(acctId, secId, "2000-01-01");
    const before = getTaxInputGeneration(db);

    // No outer transaction wraps this call (discriminating: proves the
    // writer's OWN db.transaction is what rolls things back, not a caller's).
    // The sentinel quantity aborts the SECOND position's holdings insert,
    // after the first (NET, a tombstone re-buy) has already been written.
    db.exec(
      `CREATE TEMP TRIGGER boom BEFORE INSERT ON holdings WHEN NEW.quantity = 424242 BEGIN SELECT RAISE(ABORT,'boom'); END`,
    );

    expect(() =>
      writeIbkrHoldings(
        db,
        {
          accountCode: "U1",
          netLiq: 1,
          cash: 1,
          positions: [stock("NET", 60, 200, 269.42), stock("BOOM", 424242, 1, 1)],
        },
        { asOfDate: "2026-06-15" },
      ),
    ).toThrow();

    // NET's re-buy write must have rolled back with the aborted BOOM insert —
    // only the original tombstone (qty 0) survives.
    const netRows = db
      .prepare(`SELECT quantity FROM holdings WHERE security_id = ? ORDER BY as_of_date`)
      .all(secId) as { quantity: number }[];
    expect(netRows).toEqual([{ quantity: 0 }]);
    expect(getTaxInputGeneration(db)).toBe(before);
  });
});
