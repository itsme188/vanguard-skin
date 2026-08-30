/**
 * lib/queries/options.ts — FX conversion consistency (Gap 2, Task 10).
 *
 * Options are USD-denominated in practice, so this is a no-op today — but
 * getOptionPositions() computed market value + unrealized P&L inline
 * (`qty * price * multiplier`, `mv - cost_basis`) without threading the
 * security's currency/fx factor through, unlike every other market-value
 * site in the codebase (see .superpowers/sdd/fx-conversion-pattern.md).
 * This pins the USD-unchanged regression AND a hypothetical KRW-option
 * conversion so a future foreign-currency option (or a misclassified
 * currency) doesn't silently leak a native-currency notional as USD.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertFxRate } from "@/lib/mutations/fx-rates";
import {
  getOptionPositions,
  getOptionsPnL,
  getStockLegsForStrategyDetection,
} from "@/lib/queries/options";
import { stampTaxLotsConvention } from "@/lib/compute/tax-convention";

describe("getOptionPositions FX conversion", () => {
  let db: Database.Database;
  const TODAY = "2026-06-15";

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    // migration 002_seed_accounts.sql seeds id=1..3 (Vanguard Taxable, Vanguard
    // Roth IRA, IBKR) — reuse id=1, no need to insert.
  });

  it("USD option: marketValue / unrealizedPnl / costBasis unchanged (regression)", () => {
    db.prepare(
      `INSERT INTO securities (id, symbol, security_type, currency) VALUES (10, 'AAPL', 'stock', 'USD')`
    ).run();
    db.prepare(
      `INSERT INTO securities
         (id, symbol, security_type, option_type, strike_price, expiration_date, underlying_symbol, multiplier, currency)
       VALUES (100, 'AAPL  260120C00200000', 'option', 'CALL', 200, '2026-01-20', 'AAPL', 100, 'USD')`
    ).run();
    db.prepare(`INSERT INTO prices (security_id, date, close_price) VALUES (10, ?, 195)`).run(TODAY);
    db.prepare(`INSERT INTO prices (security_id, date, close_price) VALUES (100, ?, 5.20)`).run(TODAY);
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (1, 100, 1, 500, ?, 'opt-usd')`
    ).run(TODAY);

    const positions = getOptionPositions(db);
    expect(positions).toHaveLength(1);
    const p = positions[0];

    // mv = 1 * 5.20 * 100 = 520; unrealizedPnl = 520 - 500 = 20.
    expect(p.marketValue).toBeCloseTo(520, 6);
    expect(p.costBasis).toBe(500);
    expect(p.unrealizedPnl).toBeCloseTo(20, 6);
  });

  it("hypothetical KRW option converts marketValue, costBasis, and unrealizedPnl to USD", () => {
    db.prepare(
      `INSERT INTO securities (id, symbol, security_type, currency) VALUES (20, 'KTICK', 'stock', 'KRW')`
    ).run();
    db.prepare(
      `INSERT INTO securities
         (id, symbol, security_type, option_type, strike_price, expiration_date, underlying_symbol, multiplier, currency)
       VALUES (200, 'KTICK 260120C00100000', 'option', 'CALL', 100, '2026-01-20', 'KTICK', 100, 'KRW')`
    ).run();
    db.prepare(`INSERT INTO prices (security_id, date, close_price) VALUES (20, ?, 130000)`).run(TODAY);
    // Native (KRW) close price and cost basis.
    db.prepare(`INSERT INTO prices (security_id, date, close_price) VALUES (200, ?, 3000)`).run(TODAY);
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (1, 200, 2, 500000, ?, 'opt-krw')`
    ).run(TODAY);

    upsertFxRate(db, { currency: "KRW", usdPerUnit: 0.000734, asOf: TODAY, source: "test" });

    const positions = getOptionPositions(db);
    expect(positions).toHaveLength(1);
    const p = positions[0];

    // Native mv = 2 * 3000 * 100 = ₩600,000 -> USD = 600,000 * 0.000734 = 440.4
    const expectedMv = 2 * 3000 * 100 * 0.000734;
    expect(p.marketValue).toBeCloseTo(expectedMv, 5);
    expect(p.marketValue).toBeLessThan(1_000); // not the ₩600,000 phantom

    // Raw cost_basis (₩500,000) must be returned in USD too.
    const expectedCostBasis = 500_000 * 0.000734;
    expect(p.costBasis).toBeCloseTo(expectedCostBasis, 5);
    expect(p.costBasis).toBeLessThan(1_000);

    // unrealizedPnl is the USD difference, not a mixed-unit number.
    expect(p.unrealizedPnl).toBeCloseTo(expectedMv - expectedCostBasis, 5);
  });

  it("getOptionsPnL totalUnrealizedPnl sums the FX-converted per-position values", () => {
    db.prepare(
      `INSERT INTO securities (id, symbol, security_type, currency) VALUES (20, 'KTICK', 'stock', 'KRW')`
    ).run();
    db.prepare(
      `INSERT INTO securities
         (id, symbol, security_type, option_type, strike_price, expiration_date, underlying_symbol, multiplier, currency)
       VALUES (200, 'KTICK 260120C00100000', 'option', 'CALL', 100, '2026-01-20', 'KTICK', 100, 'KRW')`
    ).run();
    db.prepare(`INSERT INTO prices (security_id, date, close_price) VALUES (20, ?, 130000)`).run(TODAY);
    db.prepare(`INSERT INTO prices (security_id, date, close_price) VALUES (200, ?, 3000)`).run(TODAY);
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (1, 200, 2, 500000, ?, 'opt-krw')`
    ).run(TODAY);
    upsertFxRate(db, { currency: "KRW", usdPerUnit: 0.000734, asOf: TODAY, source: "test" });

    const pnl = getOptionsPnL(db);
    const expectedMv = 2 * 3000 * 100 * 0.000734;
    const expectedCostBasis = 500_000 * 0.000734;
    expect(pnl.totalUnrealizedPnl).toBeCloseTo(expectedMv - expectedCostBasis, 5);
  });
});

/**
 * getOptionsPnL closed trades — number-trust durable fixes, WS1 (Task 5).
 *
 * tests/queries/options.test.ts is named in the task brief but does not
 * exist in this repo; lib/queries/options.ts's real test coverage lives
 * here, so these cases extend this file instead.
 */
describe("getOptionsPnL closed trades — v2 dollar convention + conventionPending", () => {
  let db: Database.Database;
  const TODAY = "2026-06-15";

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  function seedClosedOption(): void {
    db.prepare(
      `INSERT INTO securities
         (id, symbol, security_type, option_type, strike_price, expiration_date, underlying_symbol, multiplier, currency)
       VALUES (100, 'AAPL  260619C00180000', 'option', 'CALL', 180, '2026-06-19', 'AAPL', 100, 'USD')`
    ).run();
    const lot = db
      .prepare(
        `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
         VALUES (1, 100, '2026-01-15', 2.5, 1, 0, 251)`
      )
      .run();
    const saleTxn = db
      .prepare(
        `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, source_key)
         VALUES (1, 100, ?, 'SELL_TO_CLOSE', 1, 4, 399, 'sell-to-close-1')`
      )
      .run(TODAY);
    db.prepare(
      `INSERT INTO tax_lot_sales (tax_lot_id, sale_transaction_id, sale_date, quantity_sold, sale_price, proceeds, cost_basis_allocated, realized_gain_loss, is_long_term, holding_period_days)
       VALUES (?, ?, ?, 1, 4, 399, 251, 148, 0, 76)`
    ).run(lot.lastInsertRowid, saleTxn.lastInsertRowid, TODAY);
  }

  it("closed-options P&L renders true dollars exactly once (Task 3 fixture: $251 cost, $399 proceeds, $148 gain) — no re-applied multiplier", () => {
    seedClosedOption();

    const pnl = getOptionsPnL(db);
    expect(pnl.closedTrades).toHaveLength(1);
    const trade = pnl.closedTrades[0];
    // tax_lot_sales already stores true dollars (multiplier baked in at
    // write time) — costBasis/proceeds/realizedGain must come through
    // unchanged, not re-multiplied by the ×100 contract multiplier.
    expect(trade.costBasis).toBeCloseTo(251, 2);
    expect(trade.proceeds).toBeCloseTo(399, 2);
    expect(trade.realizedGain).toBeCloseTo(148, 2);
    expect(pnl.totalRealizedPnl).toBeCloseTo(148, 2);
  });

  it("isSyntheticClose is false for a real sale, true for an engine-owned RECONCILE_CLOSE (finding 1, number-trust durable fixes)", () => {
    seedClosedOption();

    const real = getOptionsPnL(db);
    expect(real.closedTrades).toHaveLength(1);
    expect(real.closedTrades[0].isSyntheticClose).toBe(false);

    db.prepare(
      `UPDATE transactions SET type = 'RECONCILE_CLOSE' WHERE source_key = 'sell-to-close-1'`
    ).run();

    const synthetic = getOptionsPnL(db);
    expect(synthetic.closedTrades).toHaveLength(1);
    expect(synthetic.closedTrades[0].isSyntheticClose).toBe(true);
  });

  it("conventionPending is true before a v2 recompute stamp, false after", () => {
    seedClosedOption();

    const before = getOptionsPnL(db);
    expect(before.conventionPending).toBe(true);

    stampTaxLotsConvention(db);

    const after = getOptionsPnL(db);
    expect(after.conventionPending).toBe(false);
  });
});

/**
 * getOptionPositions / getExpiringOptions per-pair "latest" holdings —
 * holdings-latest-sweep Task 1. Both queries previously keyed "latest" off
 * a fully GLOBAL MAX(as_of_date) subquery (no account/security correlation
 * at all) with no quantity filter — worse than a per-account MAX: any
 * statement-lag position (Treasuries, mutual funds — not options in
 * practice, but the query shape was shared) or trailing account lost its
 * rows entirely, and a reconciler quantity=0 tombstone could surface as an
 * open position. `latestHoldingsPredicate({ accountFilter: "" })` fixes
 * both: per-(account, security) "latest" plus quantity != 0.
 */
describe("getOptionPositions — per-pair latest holdings (holdings-latest-sweep Task 1)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  function seedOption(
    id: number,
    underlying: string,
    expiration: string
  ): void {
    db.prepare(
      `INSERT INTO securities
         (id, symbol, security_type, option_type, strike_price, expiration_date, underlying_symbol, multiplier, currency)
       VALUES (?, ?, 'option', 'CALL', 50, ?, ?, 100, 'USD')`
    ).run(id, `${underlying}  260117C00050000`, expiration, underlying);
  }

  it("fixture 1: statement-lag row survives — security A's only row is older than security B's, same account, both returned", () => {
    seedOption(300, "AAA", "2026-01-17");
    seedOption(301, "BBB", "2026-02-21");
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (1, 300, 1, 100, '2025-01-31', 'a-1')`
    ).run();
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (1, 301, 1, 100, '2025-02-28', 'b-1')`
    ).run();

    const positions = getOptionPositions(db);
    const underlyings = positions.map((p) => p.underlying).sort();
    expect(underlyings).toEqual(["AAA", "BBB"]);
  });

  it("fixture 2: tombstone hides — security C's newest row is a quantity=0 tombstone, absent from both getOptionPositions and getOptionsPnL sums", () => {
    seedOption(302, "CCC", "2026-03-20");
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (1, 302, 10, 500, '2025-01-31', 'c-1')`
    ).run();
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (1, 302, 0, 0, '2025-02-28', 'c-2')`
    ).run();

    const positions = getOptionPositions(db);
    expect(positions.find((p) => p.underlying === "CCC")).toBeUndefined();
    expect(positions).toHaveLength(0);

    const pnl = getOptionsPnL(db);
    expect(pnl.openPositions).toHaveLength(0);
    expect(pnl.totalUnrealizedPnl).toBe(0);
  });

  it("fixture 3: trailing account survives — account 2's only row predates account 1's latest, both returned", () => {
    seedOption(303, "XXX", "2026-04-17");
    seedOption(304, "YYY", "2026-05-15");
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (1, 303, 1, 100, '2025-02-28', 'x-1')`
    ).run();
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (2, 304, 1, 100, '2025-01-31', 'y-1')`
    ).run();

    const positions = getOptionPositions(db);
    const underlyings = positions.map((p) => p.underlying).sort();
    expect(underlyings).toEqual(["XXX", "YYY"]);
  });
});

describe("getStockLegsForStrategyDetection — per-pair latest holdings (holdings-latest-sweep Task 1)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  function seedStock(id: number, symbol: string): void {
    db.prepare(
      `INSERT INTO securities (id, symbol, security_type, currency) VALUES (?, ?, 'stock', 'USD')`
    ).run(id, symbol);
  }

  it("fixture 1: statement-lag row survives — stock A's only row is older than stock B's, same account, both returned", () => {
    seedStock(400, "AAA");
    seedStock(401, "BBB");
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (1, 400, 10, 1000, '2025-01-31', 'a-stock-1')`
    ).run();
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (1, 401, 10, 1000, '2025-02-28', 'b-stock-1')`
    ).run();

    const legs = getStockLegsForStrategyDetection(db);
    const symbols = legs.map((l) => l.symbol).sort();
    expect(symbols).toEqual(["AAA", "BBB"]);
    expect(legs.every((l) => typeof l.account_id === "number")).toBe(true);
  });

  it("fixture 2: tombstone hides — stock C's newest row is a quantity=0 tombstone, absent from the helper", () => {
    seedStock(402, "CCC");
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (1, 402, 10, 1000, '2025-01-31', 'c-stock-1')`
    ).run();
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (1, 402, 0, 0, '2025-02-28', 'c-stock-2')`
    ).run();

    const legs = getStockLegsForStrategyDetection(db);
    expect(legs.find((l) => l.symbol === "CCC")).toBeUndefined();
    expect(legs).toHaveLength(0);
  });

  it("fixture 3: trailing account survives — account 2's only row predates account 1's latest, both returned", () => {
    seedStock(403, "XXX");
    seedStock(404, "YYY");
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (1, 403, 10, 1000, '2025-02-28', 'x-stock-1')`
    ).run();
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (2, 404, 10, 1000, '2025-01-31', 'y-stock-1')`
    ).run();

    const legs = getStockLegsForStrategyDetection(db);
    const symbols = legs.map((l) => l.symbol).sort();
    expect(symbols).toEqual(["XXX", "YYY"]);
    expect(legs.find((l) => l.symbol === "YYY")?.account_id).toBe(2);
  });

  it("accountId filter still scopes to a single account (existing contract preserved)", () => {
    seedStock(405, "ZZZ");
    seedStock(406, "WWW");
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (1, 405, 10, 1000, '2025-02-28', 'z-stock-1')`
    ).run();
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (2, 406, 10, 1000, '2025-02-28', 'w-stock-1')`
    ).run();

    const legs = getStockLegsForStrategyDetection(db, 1);
    expect(legs.map((l) => l.symbol)).toEqual(["ZZZ"]);
  });
});
