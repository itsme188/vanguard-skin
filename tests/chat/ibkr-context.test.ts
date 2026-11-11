import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeBullishness, computeIbkrTradingContext } from "@/lib/chat/ibkr-context";
import { getHoldingsForChat } from "@/lib/queries/chat-tools";

describe("computeBullishness", () => {
  it("returns 1 for very high cash (>=50%)", () => {
    expect(computeBullishness(60, null)).toBe(1);
    expect(computeBullishness(50, null)).toBe(1);
  });

  it("returns 2 for high cash (40-49%)", () => {
    expect(computeBullishness(45, null)).toBe(2);
    expect(computeBullishness(40, null)).toBe(2);
  });

  it("returns 3 for moderate cash (30-39%)", () => {
    expect(computeBullishness(35, null)).toBe(3);
    expect(computeBullishness(30, null)).toBe(3);
  });

  it("returns 4 for low cash (20-29%)", () => {
    expect(computeBullishness(25, null)).toBe(4);
    expect(computeBullishness(20, null)).toBe(4);
  });

  it("returns 5 for very low cash (<20%)", () => {
    expect(computeBullishness(10, null)).toBe(5);
    expect(computeBullishness(5, null)).toBe(5);
    expect(computeBullishness(0, null)).toBe(5);
  });

  it("adjusts down by 1 for low beta (<0.5)", () => {
    // 25% cash → 4, but beta 0.3 → 3
    expect(computeBullishness(25, 0.3)).toBe(3);
    // 10% cash → 5, but beta 0.4 → 4
    expect(computeBullishness(10, 0.4)).toBe(4);
  });

  it("adjusts up by 1 for high beta (>1.2)", () => {
    // 35% cash → 3, but beta 1.5 → 4
    expect(computeBullishness(35, 1.5)).toBe(4);
    // 45% cash → 2, but beta 1.3 → 3
    expect(computeBullishness(45, 1.3)).toBe(3);
  });

  it("clamps to minimum 1", () => {
    // 60% cash → 1, beta 0.3 would adjust to 0, clamped to 1
    expect(computeBullishness(60, 0.3)).toBe(1);
  });

  it("clamps to maximum 5", () => {
    // 5% cash → 5, beta 1.5 would adjust to 6, clamped to 5
    expect(computeBullishness(5, 1.5)).toBe(5);
  });

  it("no adjustment when beta is exactly 0.5", () => {
    expect(computeBullishness(25, 0.5)).toBe(4); // no adjustment
  });

  it("no adjustment when beta is exactly 1.2", () => {
    expect(computeBullishness(25, 1.2)).toBe(4); // no adjustment
  });

  it("handles null beta (no adjustment)", () => {
    expect(computeBullishness(25, null)).toBe(4);
  });

  it("handles 100% cash", () => {
    expect(computeBullishness(100, null)).toBe(1);
  });
});

// ─── avgHoldingDays — signed-HPD convention (number-trust durable fixes) ──

describe("computeIbkrTradingContext — avgHoldingDays", () => {
  let db: Database.Database;
  const IBKR_ACCOUNT_ID = 3; // seeded by migration 002_seed_accounts.sql

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  function seedSecurity(symbol: string): number {
    const r = db
      .prepare(
        "INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, 'stock')"
      )
      .run(symbol, symbol);
    return r.lastInsertRowid as number;
  }

  function recentDate(daysAgo: number): string {
    return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
  }

  it("uses AVG(ABS(holding_period_days)) so a short round-trip's signed-negative days don't drag the average toward zero", () => {
    const longSec = seedSecurity("LONGCO");
    const shortSec = seedSecurity("SHRTCO");

    // Long round-trip: held 20 days, holding_period_days = +20 (unsigned already).
    const longBuyTxn = db
      .prepare(
        `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, source_key)
         VALUES (?, ?, ?, 'BUY', 10, 100, -1000, 'k-long-buy')`
      )
      .run(IBKR_ACCOUNT_ID, longSec, recentDate(30));
    const longLot = db
      .prepare(
        `INSERT INTO tax_lots (account_id, security_id, acquisition_transaction_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis, is_short)
         VALUES (?, ?, ?, ?, 100, 10, 0, 1000, 0)`
      )
      .run(IBKR_ACCOUNT_ID, longSec, longBuyTxn.lastInsertRowid, recentDate(30));
    const longSellTxn = db
      .prepare(
        `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, source_key)
         VALUES (?, ?, ?, 'SELL', 10, 110, 1100, 'k-long-sell')`
      )
      .run(IBKR_ACCOUNT_ID, longSec, recentDate(10));
    db.prepare(
      `INSERT INTO tax_lot_sales (tax_lot_id, sale_transaction_id, quantity_sold, sale_price, proceeds, cost_basis_allocated, realized_gain_loss, is_long_term, holding_period_days, sale_date)
       VALUES (?, ?, 10, 110, 1100, 1000, 100, 0, 20, ?)`
    ).run(longLot.lastInsertRowid, longSellTxn.lastInsertRowid, recentDate(10));

    // Short round-trip: open→cover span is 6 days, stored SIGNED NEGATIVE (-6)
    // per the WS1 convention — a bookkeeping signal (always short-term), not
    // a literal negative duration.
    const shortOpenTxn = db
      .prepare(
        `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, source_key)
         VALUES (?, ?, ?, 'SELL_TO_OPEN', 5, 50, 250, 'k-short-open')`
      )
      .run(IBKR_ACCOUNT_ID, shortSec, recentDate(15));
    const shortLot = db
      .prepare(
        `INSERT INTO tax_lots (account_id, security_id, acquisition_transaction_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis, is_short)
         VALUES (?, ?, ?, ?, 50, 5, 0, 250, 1)`
      )
      .run(IBKR_ACCOUNT_ID, shortSec, shortOpenTxn.lastInsertRowid, recentDate(15));
    const shortCoverTxn = db
      .prepare(
        `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, source_key)
         VALUES (?, ?, ?, 'BUY_TO_COVER', 5, 40, -200, 'k-short-cover')`
      )
      .run(IBKR_ACCOUNT_ID, shortSec, recentDate(9));
    db.prepare(
      `INSERT INTO tax_lot_sales (tax_lot_id, sale_transaction_id, quantity_sold, sale_price, proceeds, cost_basis_allocated, realized_gain_loss, is_long_term, holding_period_days, sale_date)
       VALUES (?, ?, 5, 40, 200, 250, 50, 0, -6, ?)`
    ).run(shortLot.lastInsertRowid, shortCoverTxn.lastInsertRowid, recentDate(9));

    const ctx = computeIbkrTradingContext(db, IBKR_ACCOUNT_ID, "IBKR");

    // AVG(ABS([20, -6])) = AVG([20, 6]) = 13 — NOT the naive signed average
    // AVG([20, -6]) = 7, which would understate true average days-in-trade
    // (or go negative for a short-heavy trader).
    expect(ctx.avgHoldingDays).toBe(13);
  });

  it("returns null when there are no closed lots in the window", () => {
    const ctx = computeIbkrTradingContext(db, IBKR_ACCOUNT_ID, "IBKR");
    expect(ctx.avgHoldingDays).toBeNull();
  });
});

// ─── Long/short summary — includeShorts opt-in (Task 6) ───────────────────

describe("computeIbkrTradingContext — shorts visibility", () => {
  let db: Database.Database;
  const IBKR_ACCOUNT_ID = 3; // seeded by migration 002_seed_accounts.sql

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  function seedSecurity(symbol: string, sector?: string): number {
    const r = db
      .prepare(
        "INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, 'stock')"
      )
      .run(symbol, symbol);
    const id = r.lastInsertRowid as number;
    if (sector) db.prepare("UPDATE securities SET sector = ? WHERE id = ?").run(sector, id);
    return id;
  }

  function seedHolding(securityId: number, quantity: number, price: number): void {
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(IBKR_ACCOUNT_ID, securityId, quantity, Math.abs(quantity) * price * 0.9, "2025-01-31", `k-${securityId}`);
    db.prepare(
      "INSERT OR REPLACE INTO prices (security_id, date, close_price) VALUES (?, ?, ?)"
    ).run(securityId, "2025-01-31", price);
  }

  it("computeIbkrTradingContext (includeShorts: true) surfaces the short in longShortSummary", () => {
    const long = seedSecurity("LONGCO", "Technology");
    const short = seedSecurity("SHRTCO", "Energy");
    seedHolding(long, 10, 100); // long, mv = 1000
    seedHolding(short, -5, 100); // short, mv = -500

    const ctx = computeIbkrTradingContext(db, IBKR_ACCOUNT_ID, "IBKR");

    expect(ctx.activePositionCount).toBe(2);
    expect(ctx.longShortSummary).toContain("Long: 1 positions");
    expect(ctx.longShortSummary).toContain("Short: 1 positions");
    expect(ctx.longShortSummary).toContain("SHRTCO");
  });

  it("a default getHoldingsForChat call (the query_holdings tool shape, scoped by account_name) stays long-only, unaffected by ibkr-context's opt-in", () => {
    const long = seedSecurity("LONGCO");
    const short = seedSecurity("SHRTCO");
    seedHolding(long, 10, 100);
    seedHolding(short, -5, 100);

    // computeIbkrTradingContext internally opts into includeShorts: true...
    const ctx = computeIbkrTradingContext(db, IBKR_ACCOUNT_ID, "IBKR");
    expect(ctx.longShortSummary).toContain("Short: 1 positions");

    // ...but a default call (the shape other default consumers, e.g. the query_holdings
    // tool, use) still excludes the short.
    const defaultHoldings = getHoldingsForChat(db, { account_name: "IBKR" });
    expect(defaultHoldings.map((h) => h.symbol)).toEqual(["LONGCO"]);
  });
});

// ─── Cash from the account's own cash line (B7 / QA-7, Contract E, P12) ───

describe("computeIbkrTradingContext — cash line", () => {
  let db: Database.Database;
  const IBKR_ACCOUNT_ID = 3; // seeded by migration 002_seed_accounts.sql

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    // A second account whose name also says IBKR: the old reader picked the
    // first "ibkr"-named account's month-end total by NAME.
    db.prepare("INSERT INTO accounts (name) VALUES ('IBKR Old')").run();
    const oldId = (db.prepare("SELECT id FROM accounts WHERE name = 'IBKR Old'").get() as { id: number }).id;
    db.prepare(
      "INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source, cash_value) VALUES (?, '2026-10-31', 900, 'statement', 900)"
    ).run(oldId);
    db.prepare(
      "INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value, data_quality) VALUES (?, '2026-11-10', 900, 0, 900, 'live')"
    ).run(oldId);

    // The IBKR book: a long, a short and an option that expired.
    const stock = db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('LLL', 'LLL', 'Stock')").run()
      .lastInsertRowid as number;
    const short = db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('SSS', 'SSS', 'Stock')").run()
      .lastInsertRowid as number;
    const expired = db
      .prepare(
        "INSERT INTO securities (symbol, name, security_type, multiplier, expiration_date) VALUES ('LLL 201016C00010000', 'opt', 'Option', 100, '2020-10-16')"
      )
      .run().lastInsertRowid as number;
    for (const [sec, qty] of [[stock, 100], [short, -10], [expired, 1]] as const) {
      db.prepare(
        "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (?, ?, ?, 100, '2026-11-10', ?)"
      ).run(IBKR_ACCOUNT_ID, sec, qty, `cash-${sec}`);
      db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-11-10', 50, 't')").run(sec);
    }
  });

  function valuation(cash: number, holdings: number, date = "2026-11-10", quality = "recent") {
    db.prepare(
      "INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value, data_quality) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(IBKR_ACCOUNT_ID, date, cash, holdings, cash + holdings, quality);
  }

  function anchor(date: string, source: string, cash: number | null) {
    db.prepare(
      "INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source, cash_value) VALUES (?, ?, 10000, ?, ?)"
    ).run(IBKR_ACCOUNT_ID, date, source, cash);
  }

  it("cash comes from the account's own cash line", () => {
    // Statement anchor on the valuation day; cash 1400 of a 10000 total = 14%.
    anchor("2026-11-10", "statement", 1400);
    valuation(1400, 8600);
    const ctx = computeIbkrTradingContext(db, IBKR_ACCOUNT_ID, "IBKR");
    expect(ctx.estimatedCash).toBe(1400);
    expect(ctx.accountTotal).toBe(10000);
    expect(ctx.cashPct).toBeCloseTo(14, 6);
    expect(ctx.cashAsOf).toBe("2026-11-10");
    expect(ctx.accountTotalAsOf).toBe("2026-11-10");
    expect(ctx.cashSource).toBe("daily_valuation");
    expect(ctx.cashCarried).toBe(false);
    expect(ctx.cashTimingResidual).toBe(false);
    expect(ctx.cashPriceDateMismatch).toBe(false);
    expect(ctx.stanceWithheld).toBe(false);
    // 14% cash, no beta -> score 5 (fully invested end of the scale).
    expect(ctx.bullishnessScore).toBe(5);
  });

  it("a margin debit is not clamped to zero", () => {
    anchor("2026-11-10", "statement", -300);
    valuation(-300, 10300); // total 10000
    const ctx = computeIbkrTradingContext(db, IBKR_ACCOUNT_ID, "IBKR");
    expect(ctx.estimatedCash).toBe(-300);
    expect(ctx.cashPct).toBeCloseTo(-3, 6);
    expect(ctx.bullishnessScore).toBe(5); // borrowing reads as fully invested
    expect(ctx.stanceWithheld).toBe(false);
  });

  it("a carried or timing-residual negative figure withholds the stance", () => {
    // Live (TWS) anchor: the cash figure is a timing residual.
    anchor("2026-11-10", "tws", null);
    valuation(-300, 10300);
    const live = computeIbkrTradingContext(db, IBKR_ACCOUNT_ID, "IBKR");
    expect(live.estimatedCash).toBe(-300);
    expect(live.cashTimingResidual).toBe(true);
    expect(live.stanceWithheld).toBe(true);

    // Carried: the newest row is 'estimated' with no holdings of its own day,
    // so it carries the 2026-11-10 measurement; dated by the measurement.
    db.prepare("DELETE FROM monthly_snapshots WHERE account_id = ?").run(IBKR_ACCOUNT_ID);
    anchor("2026-11-10", "statement", -300);
    valuation(-300, 10300, "2026-11-11", "estimated");
    const carried = computeIbkrTradingContext(db, IBKR_ACCOUNT_ID, "IBKR");
    expect(carried.cashCarried).toBe(true);
    expect(carried.cashAsOf).toBe("2026-11-10");
    expect(carried.stanceWithheld).toBe(true);
  });

  it("no cash line means cash is not available and the stance is withheld", () => {
    const ctx = computeIbkrTradingContext(db, IBKR_ACCOUNT_ID, "IBKR");
    expect(ctx.cashSource).toBe("none");
    expect(ctx.cashAsOf).toBeNull();
    expect(ctx.estimatedCash).toBe(0);
    expect(ctx.stanceWithheld).toBe(true);
  });

  it("a zero or negative account total withholds the stance (R2-4)", () => {
    // Statement anchor, cash 0, positions 0: total 0. The old rule read 0%
    // cash as "fully deployed" (score 5).
    anchor("2026-11-10", "statement", 0);
    valuation(0, 0);
    const zero = computeIbkrTradingContext(db, IBKR_ACCOUNT_ID, "IBKR");
    expect(zero.accountTotal).toBe(0);
    expect(zero.stanceWithheld).toBe(true);

    // A debit larger than the positions: total -100.
    db.prepare("DELETE FROM daily_valuations WHERE account_id = ?").run(IBKR_ACCOUNT_ID);
    valuation(-600, 500);
    const negative = computeIbkrTradingContext(db, IBKR_ACCOUNT_ID, "IBKR");
    expect(negative.accountTotal).toBe(-100);
    expect(negative.stanceWithheld).toBe(true);
  });

  it("130 positions count as 130", () => {
    // B10, engine half: the count is not capped by a row limit.
    for (let i = 0; i < 128; i++) {
      const sec = db
        .prepare("INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, 'Stock')")
        .run(`P${i}`, `P${i}`).lastInsertRowid as number;
      db.prepare(
        "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (?, ?, 1, 10, '2026-11-10', ?)"
      ).run(IBKR_ACCOUNT_ID, sec, `many-${i}`);
    }
    // 128 new + the long + the short (the expired option is not a position).
    const ctx = computeIbkrTradingContext(db, IBKR_ACCOUNT_ID, "IBKR");
    expect(ctx.activePositionCount).toBe(130);
  });
});
