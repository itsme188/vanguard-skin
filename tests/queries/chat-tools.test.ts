import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getHoldingsForChat,
  getPriceHistory,
  getAllocationBreakdown,
  getTaxLotsForChat,
  getTransactionsForChat,
  getPerformanceForChat,
  getIncomeSummaryForChat,
} from "@/lib/queries/chat-tools";
import { executeTool } from "@/lib/chat/tools";
import { buildSystemPrompt } from "@/lib/chat/system-prompt";

// ─── Seed helpers ─────────────────────────────────────────────────

function seedSecurity(
  db: Database.Database,
  symbol: string,
  opts?: {
    name?: string;
    security_type?: string;
    asset_class?: string;
    sector?: string;
    multiplier?: number;
  }
): number {
  const result = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, asset_class, multiplier)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      symbol,
      opts?.name ?? `${symbol} Corp`,
      opts?.security_type ?? "stock",
      opts?.asset_class ?? "equity",
      opts?.multiplier ?? 1
    );
  const id = result.lastInsertRowid as number;
  // Set sector if provided (requires migration 005)
  if (opts?.sector) {
    db.prepare("UPDATE securities SET sector = ? WHERE id = ?").run(opts.sector, id);
  }
  return id;
}

function seedHolding(
  db: Database.Database,
  accountId: number,
  securityId: number,
  quantity: number,
  asOfDate: string,
  costBasis?: number
): void {
  db.prepare(
    `INSERT OR REPLACE INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(accountId, securityId, quantity, costBasis ?? null, asOfDate, `hold-${accountId}-${securityId}-${asOfDate}`);
}

function seedPrice(db: Database.Database, securityId: number, date: string, price: number): void {
  db.prepare(
    "INSERT OR REPLACE INTO prices (security_id, date, close_price) VALUES (?, ?, ?)"
  ).run(securityId, date, price);
}

function seedTransaction(
  db: Database.Database,
  accountId: number,
  securityId: number | null,
  opts: {
    trade_date: string;
    type: string;
    quantity?: number;
    amount?: number;
    price_per_share?: number;
    fees?: number;
  }
): void {
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, price_per_share, fees, source_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    accountId,
    securityId,
    opts.trade_date,
    opts.type,
    opts.quantity ?? null,
    opts.amount ?? null,
    opts.price_per_share ?? null,
    opts.fees ?? 0,
    `txn-${accountId}-${opts.trade_date}-${opts.type}-${Math.random().toString(36).slice(2, 8)}`
  );
}

function seedTaxLot(
  db: Database.Database,
  accountId: number,
  securityId: number,
  opts: {
    acquisition_date: string;
    acquisition_price: number;
    quantity_acquired: number;
    quantity_remaining: number;
    cost_basis: number;
  }
): number {
  const result = db
    .prepare(
      `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      accountId,
      securityId,
      opts.acquisition_date,
      opts.acquisition_price,
      opts.quantity_acquired,
      opts.quantity_remaining,
      opts.cost_basis
    );
  return result.lastInsertRowid as number;
}

function seedTaxLotSale(
  db: Database.Database,
  taxLotId: number,
  opts: {
    sale_date: string;
    sale_price: number;
    quantity_sold: number;
    proceeds: number;
    cost_basis_allocated: number;
    realized_gain_loss: number;
    is_long_term: boolean;
    holding_period_days: number;
  }
): void {
  // Need a transaction for the foreign key
  const txnId = db
    .prepare(
      `INSERT INTO transactions (account_id, trade_date, type, source_key)
       VALUES (1, ?, 'SELL', ?)`
    )
    .run(opts.sale_date, `sale-txn-${Math.random().toString(36).slice(2, 8)}`)
    .lastInsertRowid as number;

  db.prepare(
    `INSERT INTO tax_lot_sales (tax_lot_id, sale_transaction_id, sale_date, sale_price, quantity_sold, proceeds, cost_basis_allocated, realized_gain_loss, is_long_term, holding_period_days)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    taxLotId,
    txnId,
    opts.sale_date,
    opts.sale_price,
    opts.quantity_sold,
    opts.proceeds,
    opts.cost_basis_allocated,
    opts.realized_gain_loss,
    opts.is_long_term ? 1 : 0,
    opts.holding_period_days
  );
}

function seedSnapshot(
  db: Database.Database,
  accountId: number,
  monthEnd: string,
  totalValue: number,
  opts?: { dividends?: number; interest?: number; fees?: number }
): void {
  db.prepare(
    `INSERT OR REPLACE INTO monthly_snapshots (account_id, month_end_date, total_value, dividends, interest, fees)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(accountId, monthEnd, totalValue, opts?.dividends ?? null, opts?.interest ?? null, opts?.fees ?? null);
}

// ─── Tests ────────────────────────────────────────────────────────

describe("getHoldingsForChat", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("returns all holdings with market values", () => {
    const aapl = seedSecurity(db, "AAPL", { sector: "Technology" });
    const voo = seedSecurity(db, "VOO", { security_type: "etf", asset_class: "equity" });
    seedHolding(db, 1, aapl, 50, "2025-01-31", 7500);
    seedHolding(db, 1, voo, 20, "2025-01-31", 8000);
    seedPrice(db, aapl, "2025-01-31", 200);
    seedPrice(db, voo, "2025-01-31", 450);

    const holdings = getHoldingsForChat(db);
    expect(holdings).toHaveLength(2);
    // VOO should be first (higher market value: 20*450=9000 vs 50*200=10000)
    expect(holdings[0].symbol).toBe("AAPL");
    expect(holdings[0].market_value).toBe(10000);
    expect(holdings[0].unrealized_gain).toBe(2500); // 10000 - 7500
    expect(holdings[0].sector).toBe("Technology");
    expect(holdings[0].position_weight_pct).toBeCloseTo(52.6, 0);
  });

  it("filters by account name", () => {
    const aapl = seedSecurity(db, "AAPL");
    seedHolding(db, 1, aapl, 50, "2025-01-31");
    seedHolding(db, 2, aapl, 30, "2025-01-31");
    seedPrice(db, aapl, "2025-01-31", 200);

    const vanguard = getHoldingsForChat(db, { account_name: "Vanguard Taxable" });
    expect(vanguard).toHaveLength(1);
    expect(vanguard[0].quantity).toBe(50);

    const roth = getHoldingsForChat(db, { account_name: "Vanguard Roth IRA" });
    expect(roth).toHaveLength(1);
    expect(roth[0].quantity).toBe(30);
  });

  it("normalizes a Bloomberg-spelling sector filter to canonical GICS-11 before matching", () => {
    // The chat model may still say "Financial" / "Health Care" even though
    // securities.sector is pure GICS-11 post sector-tag-verification — the
    // filter must normalize so these still match canonical rows.
    const bac = seedSecurity(db, "BAC", { sector: "Financials" });
    const unh = seedSecurity(db, "UNH", { sector: "Healthcare" });
    seedHolding(db, 1, bac, 50, "2025-01-31");
    seedHolding(db, 1, unh, 30, "2025-01-31");
    seedPrice(db, bac, "2025-01-31", 40);
    seedPrice(db, unh, "2025-01-31", 500);

    const financial = getHoldingsForChat(db, { sector: "Financial" });
    expect(financial.map((h) => h.symbol)).toEqual(["BAC"]);

    const healthCare = getHoldingsForChat(db, { sector: "Health Care" });
    expect(healthCare.map((h) => h.symbol)).toEqual(["UNH"]);

    // Canonical spelling still works unchanged
    const canonical = getHoldingsForChat(db, { sector: "Financials" });
    expect(canonical.map((h) => h.symbol)).toEqual(["BAC"]);
  });

  it("filters by symbol", () => {
    const aapl = seedSecurity(db, "AAPL");
    const msft = seedSecurity(db, "MSFT");
    seedHolding(db, 1, aapl, 50, "2025-01-31");
    seedHolding(db, 1, msft, 30, "2025-01-31");
    seedPrice(db, aapl, "2025-01-31", 200);
    seedPrice(db, msft, "2025-01-31", 400);

    const result = getHoldingsForChat(db, { symbol: "AAPL" });
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe("AAPL");
  });

  it("handles bonds with price/100 adjustment", () => {
    const bond = seedSecurity(db, "TBOND", { security_type: "bond", asset_class: "fixed_income" });
    seedHolding(db, 1, bond, 10000, "2025-01-31", 9800);
    seedPrice(db, bond, "2025-01-31", 98.5);

    const result = getHoldingsForChat(db, { symbol: "TBOND" });
    expect(result).toHaveLength(1);
    // Bond: 10000 * 98.5 / 100 = 9850
    expect(result[0].market_value).toBeCloseTo(9850, 1);
  });

  it("returns empty array on no holdings", () => {
    const result = getHoldingsForChat(db);
    expect(result).toEqual([]);
  });

  it("respects limit", () => {
    for (let i = 0; i < 5; i++) {
      const sec = seedSecurity(db, `SYM${i}`);
      seedHolding(db, 1, sec, 10, "2025-01-31");
      seedPrice(db, sec, "2025-01-31", 100 + i);
    }
    const result = getHoldingsForChat(db, { limit: 3 });
    expect(result).toHaveLength(3);
  });

  // ─── includeShorts (Task 6) ─────────────────────────────────────
  // Opt-in only; every existing call site (query_holdings tool,
  // market-snapshot's buildUniverse, and every call above in this file)
  // omits the option and must keep seeing the long-only book.

  it("excludes shorts by default (existing behavior pinned)", () => {
    const long = seedSecurity(db, "LONGCO");
    const short = seedSecurity(db, "SHORTCO");
    seedHolding(db, 1, long, 10, "2025-01-31", 900);
    seedHolding(db, 1, short, -5, "2025-01-31", 400);
    seedPrice(db, long, "2025-01-31", 100);
    seedPrice(db, short, "2025-01-31", 100);

    const result = getHoldingsForChat(db);
    expect(result.map((h) => h.symbol)).toEqual(["LONGCO"]);
    // Long-only book: the plain signed denominator equals the one long
    // position's own market value, so its weight is 100%.
    expect(result[0].position_weight_pct).toBeCloseTo(100, 5);
  });

  it("includeShorts: true returns the short with a gross-denominator, all-positive weight", () => {
    const long = seedSecurity(db, "LONGCO");
    const short = seedSecurity(db, "SHORTCO");
    seedHolding(db, 1, long, 10, "2025-01-31", 900); // mv = 1000
    seedHolding(db, 1, short, -5, "2025-01-31", 400); // mv = -500
    seedPrice(db, long, "2025-01-31", 100);
    seedPrice(db, short, "2025-01-31", 100);

    const result = getHoldingsForChat(db, { includeShorts: true });
    expect(result).toHaveLength(2);

    const longRow = result.find((h) => h.symbol === "LONGCO")!;
    const shortRow = result.find((h) => h.symbol === "SHORTCO")!;

    // Signed market value is preserved (a short's mv is genuinely negative).
    expect(longRow.market_value).toBe(1000);
    expect(shortRow.market_value).toBe(-500);

    // Gross-exposure weights: denominator = ABS(1000) + ABS(-500) = 1500.
    expect(longRow.position_weight_pct).toBeCloseTo((1000 / 1500) * 100, 5);
    expect(shortRow.position_weight_pct).toBeCloseTo((500 / 1500) * 100, 5);

    // Every weight is positive (never a negative short weight) and the set
    // sums to exactly 100%.
    for (const row of result) {
      expect(row.position_weight_pct).toBeGreaterThan(0);
    }
    const totalWeight = result.reduce((sum, h) => sum + (h.position_weight_pct ?? 0), 0);
    expect(totalWeight).toBeCloseTo(100, 5);
  });
});

describe("getPriceHistory", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("returns price history in ascending order", () => {
    const sec = seedSecurity(db, "AAPL");
    seedPrice(db, sec, "2025-01-01", 190);
    seedPrice(db, sec, "2025-01-15", 195);
    seedPrice(db, sec, "2025-01-31", 200);

    // Pass explicit start_date since default is 90 days ago
    const prices = getPriceHistory(db, "AAPL", "2025-01-01");
    expect(prices).toHaveLength(3);
    expect(prices[0].date).toBe("2025-01-01");
    expect(prices[2].date).toBe("2025-01-31");
    expect(prices[2].close_price).toBe(200);
  });

  it("filters by date range", () => {
    const sec = seedSecurity(db, "AAPL");
    seedPrice(db, sec, "2025-01-01", 190);
    seedPrice(db, sec, "2025-01-15", 195);
    seedPrice(db, sec, "2025-01-31", 200);

    const prices = getPriceHistory(db, "AAPL", "2025-01-10", "2025-01-20");
    expect(prices).toHaveLength(1);
    expect(prices[0].date).toBe("2025-01-15");
  });

  it("returns empty for unknown symbol", () => {
    const prices = getPriceHistory(db, "UNKNOWN");
    expect(prices).toEqual([]);
  });
});

describe("getAllocationBreakdown", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("groups by asset class", () => {
    const stock = seedSecurity(db, "AAPL", { asset_class: "equity" });
    const bond = seedSecurity(db, "BND", { security_type: "bond", asset_class: "fixed_income" });
    seedHolding(db, 1, stock, 100, "2025-01-31");
    seedHolding(db, 1, bond, 10000, "2025-01-31");
    seedPrice(db, stock, "2025-01-31", 200);
    seedPrice(db, bond, "2025-01-31", 100);

    const alloc = getAllocationBreakdown(db, "asset_class");
    expect(alloc.length).toBeGreaterThanOrEqual(2);

    const equity = alloc.find((a) => a.group_name === "equity");
    const fixedIncome = alloc.find((a) => a.group_name === "fixed_income");
    expect(equity).toBeDefined();
    expect(fixedIncome).toBeDefined();
    // Stock: 100*200=20000, Bond: 10000*100/100=10000
    expect(equity!.total_market_value).toBe(20000);
    expect(fixedIncome!.total_market_value).toBe(10000);
    expect(equity!.percentage).toBeCloseTo(66.7, 0);
  });

  it("groups by account", () => {
    const sec = seedSecurity(db, "VTI");
    seedHolding(db, 1, sec, 100, "2025-01-31");
    seedHolding(db, 2, sec, 50, "2025-01-31");
    seedPrice(db, sec, "2025-01-31", 200);

    const alloc = getAllocationBreakdown(db, "account");
    expect(alloc).toHaveLength(2);
    expect(alloc[0].group_name).toBe("Vanguard Taxable");
    expect(alloc[0].total_market_value).toBe(20000);
    expect(alloc[1].group_name).toBe("Vanguard Roth IRA");
    expect(alloc[1].total_market_value).toBe(10000);
  });

  it("uses 'Unknown' for missing sector data", () => {
    const sec = seedSecurity(db, "VTI"); // No sector set
    seedHolding(db, 1, sec, 100, "2025-01-31");
    seedPrice(db, sec, "2025-01-31", 200);

    const alloc = getAllocationBreakdown(db, "sector");
    expect(alloc).toHaveLength(1);
    expect(alloc[0].group_name).toBe("Unknown");
  });

  it("keeps a statement-lag position (no tombstone) in the allocation total", () => {
    // Security A's only row predates security B's newer row in the same
    // account. Per-(account, security) keying must keep A's value in the
    // total rather than dropping it because the account's newest date
    // belongs to B.
    const secA = seedSecurity(db, "TBILL2", { security_type: "bond", asset_class: "fixed_income" });
    const secB = seedSecurity(db, "AAPL", { asset_class: "equity" });
    seedHolding(db, 1, secA, 10000, "2025-01-31", 9800);
    seedHolding(db, 1, secB, 100, "2025-02-28", 15000);
    seedPrice(db, secA, "2025-01-31", 98);
    seedPrice(db, secB, "2025-02-28", 200);

    const alloc = getAllocationBreakdown(db, "asset_class");
    const fixedIncome = alloc.find((a) => a.group_name === "fixed_income");
    const equity = alloc.find((a) => a.group_name === "equity");
    expect(fixedIncome).toBeDefined();
    expect(equity).toBeDefined();
    // Bond: 10000 * 98 / 100 = 9800
    expect(fixedIncome!.total_market_value).toBeCloseTo(9800, 2);
    expect(equity!.total_market_value).toBeCloseTo(20000, 2);
  });

  it("excludes a genuinely tombstoned (quantity=0) position from the allocation total", () => {
    // NOTE: because MSFT's tombstone lands on the same date as the
    // account's overall max (control's 2025-02-28), this test does not
    // discriminate per-account vs per-(account, security) keying — a
    // qty=0 row at the account's max date is picked up and excluded by
    // the quantity guard under BOTH correlations. It still guards against
    // MSFT's older non-zero row (2025-01-31) being wrongly resurrected.
    const secC = seedSecurity(db, "MSFT", { asset_class: "equity" });
    const control = seedSecurity(db, "AAPL", { asset_class: "equity" });
    seedHolding(db, 1, secC, 30, "2025-01-31", 9000);
    seedHolding(db, 1, secC, 0, "2025-02-28", 0); // tombstone
    seedHolding(db, 1, control, 50, "2025-02-28", 7500);
    seedPrice(db, secC, "2025-01-31", 400);
    seedPrice(db, control, "2025-02-28", 200);

    const alloc = getAllocationBreakdown(db, "asset_class");
    const equity = alloc.find((a) => a.group_name === "equity");
    expect(equity).toBeDefined();
    // Only the control position (50*200=10000); MSFT's tombstone excludes
    // it and its older non-zero row must not be resurrected.
    expect(equity!.total_market_value).toBeCloseTo(10000, 2);
    expect(equity!.position_count).toBe(1);
  });

  it("keeps a trailing account's only row when another account has a newer max date", () => {
    const acct1Sec = seedSecurity(db, "AAPL", { asset_class: "equity" });
    const acct2Sec = seedSecurity(db, "VTI", { asset_class: "equity" });

    seedHolding(db, 1, acct1Sec, 50, "2025-02-28", 7500);
    seedPrice(db, acct1Sec, "2025-02-28", 200);

    seedHolding(db, 2, acct2Sec, 20, "2025-01-31", 4000);
    seedPrice(db, acct2Sec, "2025-01-31", 200);

    const alloc = getAllocationBreakdown(db, "asset_class");
    const equity = alloc.find((a) => a.group_name === "equity");
    expect(equity).toBeDefined();
    // AAPL: 50*200=10000, VTI: 20*200=4000
    expect(equity!.total_market_value).toBeCloseTo(14000, 2);
    expect(equity!.position_count).toBe(2);
  });
});

describe("getTaxLotsForChat", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("returns open tax lots sorted by unrealized gain (losses first)", () => {
    const aapl = seedSecurity(db, "AAPL");
    const msft = seedSecurity(db, "MSFT");
    seedPrice(db, aapl, "2025-01-31", 180); // loss
    seedPrice(db, msft, "2025-01-31", 450); // gain

    seedTaxLot(db, 1, aapl, {
      acquisition_date: "2024-06-01",
      acquisition_price: 200,
      quantity_acquired: 10,
      quantity_remaining: 10,
      cost_basis: 2000,
    });
    seedTaxLot(db, 1, msft, {
      acquisition_date: "2024-06-01",
      acquisition_price: 400,
      quantity_acquired: 5,
      quantity_remaining: 5,
      cost_basis: 2000,
    });

    const lots = getTaxLotsForChat(db);
    expect(lots).toHaveLength(2);
    // AAPL should be first (loss: 10*180 - 10*200 = -200)
    expect(lots[0].symbol).toBe("AAPL");
    expect(lots[0].unrealized_gain).toBe(-200);
    expect(lots[0].is_long_term).toBe(true); // >365 days
  });

  // Calendar-anniversary rule (finding 3, number-trust durable fixes):
  // the open-lots SQL used to classify LT via `days_held > 365`, which a
  // leap-year-spanning holding period breaks — a lot held EXACTLY one
  // calendar year (acquired 2024-01-01, sold 2025-01-01) spans 366 real
  // days (2024 is a leap year) but is NOT long-term under IRS Pub 550 (must
  // be held MORE than a year). The old fixed day-count rule called this
  // long-term; the anniversary rule (mirroring
  // lib/compute/tax-lots.ts::isLongTermHolding) correctly calls it
  // short-term. Pin "today" via fake timers since the query reads
  // `new Date()` internally.
  describe("calendar-anniversary rule (leap-year span)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("classifies a lot at the exact one-year anniversary as short-term, even though the leap-year span is 366 days", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2025-01-01T12:00:00Z"));

      const sec = seedSecurity(db, "LEAP");
      seedPrice(db, sec, "2024-12-31", 100);
      seedTaxLot(db, 1, sec, {
        acquisition_date: "2024-01-01",
        acquisition_price: 100,
        quantity_acquired: 10,
        quantity_remaining: 10,
        cost_basis: 1000,
      });

      const lots = getTaxLotsForChat(db);
      expect(lots).toHaveLength(1);
      expect(lots[0].days_held).toBe(366); // 2024 is a leap year
      expect(lots[0].is_long_term).toBe(false); // exactly one year — not yet long-term
      expect(lots[0].long_term_date).toBe("2025-01-02");
    });

    it("classifies the same lot as long-term the day after the anniversary", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2025-01-02T12:00:00Z"));

      const sec = seedSecurity(db, "LEAP2");
      seedPrice(db, sec, "2024-12-31", 100);
      seedTaxLot(db, 1, sec, {
        acquisition_date: "2024-01-01",
        acquisition_price: 100,
        quantity_acquired: 10,
        quantity_remaining: 10,
        cost_basis: 1000,
      });

      const lots = getTaxLotsForChat(db);
      expect(lots).toHaveLength(1);
      expect(lots[0].is_long_term).toBe(true);
    });
  });

  it("returns closed tax lot sales", () => {
    const sec = seedSecurity(db, "VTI");
    const lotId = seedTaxLot(db, 1, sec, {
      acquisition_date: "2024-01-01",
      acquisition_price: 200,
      quantity_acquired: 10,
      quantity_remaining: 0,
      cost_basis: 2000,
    });
    seedTaxLotSale(db, lotId, {
      sale_date: "2025-06-01",
      sale_price: 250,
      quantity_sold: 10,
      proceeds: 2500,
      cost_basis_allocated: 2000,
      realized_gain_loss: 500,
      is_long_term: true,
      holding_period_days: 517,
    });

    const closed = getTaxLotsForChat(db, { status: "closed" });
    expect(closed).toHaveLength(1);
    expect(closed[0].realized_gain_loss).toBe(500);
    expect(closed[0].is_long_term).toBe(true);
  });

  it("filters by symbol", () => {
    const aapl = seedSecurity(db, "AAPL");
    const msft = seedSecurity(db, "MSFT");
    seedPrice(db, aapl, "2025-01-31", 200);
    seedPrice(db, msft, "2025-01-31", 400);

    seedTaxLot(db, 1, aapl, {
      acquisition_date: "2025-01-01",
      acquisition_price: 190,
      quantity_acquired: 10,
      quantity_remaining: 10,
      cost_basis: 1900,
    });
    seedTaxLot(db, 1, msft, {
      acquisition_date: "2025-01-01",
      acquisition_price: 380,
      quantity_acquired: 5,
      quantity_remaining: 5,
      cost_basis: 1900,
    });

    const result = getTaxLotsForChat(db, { symbol: "AAPL" });
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe("AAPL");
  });
});

describe("getTransactionsForChat", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("returns recent transactions in descending order", () => {
    const sec = seedSecurity(db, "AAPL");
    seedTransaction(db, 1, sec, { trade_date: "2025-01-10", type: "BUY", quantity: 10, amount: -2000 });
    seedTransaction(db, 1, sec, { trade_date: "2025-01-20", type: "SELL", quantity: 5, amount: 1200 });

    const txns = getTransactionsForChat(db);
    expect(txns).toHaveLength(2);
    expect(txns[0].trade_date).toBe("2025-01-20"); // most recent first
    expect(txns[0].type).toBe("SELL");
  });

  it("filters by type", () => {
    const sec = seedSecurity(db, "VTI");
    seedTransaction(db, 1, sec, { trade_date: "2025-01-10", type: "BUY", amount: -5000 });
    seedTransaction(db, 1, sec, { trade_date: "2025-01-15", type: "DIVIDEND", amount: 50 });
    seedTransaction(db, 1, sec, { trade_date: "2025-01-20", type: "DIVIDEND", amount: 60 });

    const dividends = getTransactionsForChat(db, { type: "DIVIDEND" });
    expect(dividends).toHaveLength(2);
    expect(dividends.every((t) => t.type === "DIVIDEND")).toBe(true);
  });

  it("filters by date range", () => {
    const sec = seedSecurity(db, "AAPL");
    seedTransaction(db, 1, sec, { trade_date: "2025-01-01", type: "BUY", amount: -1000 });
    seedTransaction(db, 1, sec, { trade_date: "2025-02-15", type: "BUY", amount: -2000 });
    seedTransaction(db, 1, sec, { trade_date: "2025-03-01", type: "BUY", amount: -3000 });

    const result = getTransactionsForChat(db, { start_date: "2025-02-01", end_date: "2025-02-28" });
    expect(result).toHaveLength(1);
    expect(result[0].trade_date).toBe("2025-02-15");
  });
});

describe("getPerformanceForChat", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("returns monthly snapshots with month-over-month change", () => {
    seedSnapshot(db, 1, "2025-01-31", 100000, { dividends: 200, interest: 50 });
    seedSnapshot(db, 1, "2025-02-28", 105000, { dividends: 210, interest: 55 });

    const perf = getPerformanceForChat(db);
    expect(perf).toHaveLength(2);
    expect(perf[0].total_value).toBe(100000);
    expect(perf[0].monthly_change).toBeNull(); // first month has no prior
    expect(perf[1].total_value).toBe(105000);
    expect(perf[1].monthly_change).toBe(5000);
    expect(perf[1].dividends).toBe(210);
  });

  it("filters by account name", () => {
    seedSnapshot(db, 1, "2025-01-31", 100000);
    seedSnapshot(db, 2, "2025-01-31", 50000);

    const result = getPerformanceForChat(db, { account_name: "Vanguard Roth IRA" });
    expect(result).toHaveLength(1);
    expect(result[0].account_name).toBe("Vanguard Roth IRA");
    expect(result[0].total_value).toBe(50000);
  });
});

describe("getIncomeSummaryForChat", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("aggregates dividend income by symbol", () => {
    const aapl = seedSecurity(db, "AAPL");
    const voo = seedSecurity(db, "VOO");
    seedTransaction(db, 1, aapl, { trade_date: "2025-06-15", type: "DIVIDEND", amount: 100 });
    seedTransaction(db, 1, aapl, { trade_date: "2025-09-15", type: "DIVIDEND", amount: 110 });
    seedTransaction(db, 1, voo, { trade_date: "2025-06-15", type: "DIVIDEND", amount: 200 });

    const income = getIncomeSummaryForChat(db, { period: "all_time", group_by: "symbol" });
    expect(income.length).toBeGreaterThanOrEqual(2);

    const aaplIncome = income.find((i) => i.group_name === "AAPL");
    expect(aaplIncome).toBeDefined();
    expect(aaplIncome!.total_dividends).toBe(210);

    const vooIncome = income.find((i) => i.group_name === "VOO");
    expect(vooIncome).toBeDefined();
    expect(vooIncome!.total_dividends).toBe(200);
  });

  it("aggregates by month", () => {
    const sec = seedSecurity(db, "VTI");
    seedTransaction(db, 1, sec, { trade_date: "2025-06-15", type: "DIVIDEND", amount: 100 });
    seedTransaction(db, 1, sec, { trade_date: "2025-06-20", type: "INTEREST", amount: 50 });
    seedTransaction(db, 1, sec, { trade_date: "2025-07-15", type: "DIVIDEND", amount: 110 });

    const income = getIncomeSummaryForChat(db, { period: "all_time", group_by: "month" });
    const june = income.find((i) => i.group_name === "2025-06");
    const july = income.find((i) => i.group_name === "2025-07");
    expect(june).toBeDefined();
    expect(june!.total_dividends).toBe(100);
    expect(june!.total_interest).toBe(50);
    expect(july).toBeDefined();
    expect(july!.total_dividends).toBe(110);
  });
});

describe("maturity-aware holdings", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("excludes matured bonds from holdings", () => {
    const stock = seedSecurity(db, "AAPL");
    const maturedBond = seedSecurity(db, "TBILL1", {
      name: "T-Bill (due 10/23/25)",
      security_type: "bond",
    });
    // Set maturity_date directly (migration backfill would do this for real data)
    db.prepare("UPDATE securities SET maturity_date = ? WHERE id = ?").run("2025-10-23", maturedBond);

    seedHolding(db, 1, stock, 50, "2025-01-31", 7500);
    seedHolding(db, 1, maturedBond, 10000, "2025-01-31", 9800);
    seedPrice(db, stock, "2025-01-31", 200);
    seedPrice(db, maturedBond, "2025-01-31", 99);

    const holdings = getHoldingsForChat(db);
    // Only AAPL should be returned — TBILL1 matured on 2025-10-23 which is in the past
    expect(holdings).toHaveLength(1);
    expect(holdings[0].symbol).toBe("AAPL");
  });

  it("includes non-matured bonds", () => {
    const futureBond = seedSecurity(db, "TNOTE1", {
      name: "T-Note 4.375% (due 05/15/34)",
      security_type: "bond",
    });
    db.prepare("UPDATE securities SET maturity_date = ? WHERE id = ?").run("2034-05-15", futureBond);

    seedHolding(db, 1, futureBond, 10000, "2025-01-31", 9800);
    seedPrice(db, futureBond, "2025-01-31", 98.5);

    const holdings = getHoldingsForChat(db);
    expect(holdings).toHaveLength(1);
    expect(holdings[0].symbol).toBe("TNOTE1");
    expect(holdings[0].maturity_date).toBe("2034-05-15");
  });

  it("excludes zero-quantity positions", () => {
    const stock = seedSecurity(db, "AAPL");
    const sold = seedSecurity(db, "MSFT");

    seedHolding(db, 1, stock, 50, "2025-01-31", 7500);
    seedHolding(db, 1, sold, 0, "2025-01-31", 0);
    seedPrice(db, stock, "2025-01-31", 200);
    seedPrice(db, sold, "2025-01-31", 400);

    const holdings = getHoldingsForChat(db);
    expect(holdings).toHaveLength(1);
    expect(holdings[0].symbol).toBe("AAPL");
  });

  it("uses per-account MAX date (not per-security)", () => {
    const stock = seedSecurity(db, "AAPL");

    // Old holding from January
    seedHolding(db, 1, stock, 100, "2025-01-31", 15000);
    // New holding from February (different quantity)
    seedHolding(db, 1, stock, 50, "2025-02-28", 7500);
    seedPrice(db, stock, "2025-02-28", 200);

    const holdings = getHoldingsForChat(db);
    // Should use Feb (latest for account 1), showing quantity 50
    expect(holdings).toHaveLength(1);
    expect(holdings[0].quantity).toBe(50);
  });

  it("keeps a position that didn't restate on the latest statement (no tombstone) — statement-lag row survives", () => {
    // MSFT's only row predates AAPL's newer row in the same account. A
    // per-account MAX(as_of_date) would drop MSFT entirely (it has no row
    // on the account's newest date); per-(account, security) keying keeps
    // it, because MSFT was never zeroed out — it just didn't restate on
    // the February statement (e.g. a Treasury/mutual fund that only
    // restates monthly). Absence without a quantity=0 tombstone is NOT the
    // same as a closed position — see latestHoldingsPredicate contract.
    const aapl = seedSecurity(db, "AAPL");
    const msft = seedSecurity(db, "MSFT");

    // January: both held
    seedHolding(db, 1, aapl, 50, "2025-01-31", 7500);
    seedHolding(db, 1, msft, 30, "2025-01-31", 9000);
    // February: only AAPL restates (MSFT simply doesn't appear — no tombstone)
    seedHolding(db, 1, aapl, 50, "2025-02-28", 7500);
    seedPrice(db, aapl, "2025-02-28", 200);
    seedPrice(db, msft, "2025-01-31", 400);

    const holdings = getHoldingsForChat(db);
    expect(holdings).toHaveLength(2);
    const symbols = holdings.map((h) => h.symbol).sort();
    expect(symbols).toEqual(["AAPL", "MSFT"]);
    const msftRow = holdings.find((h) => h.symbol === "MSFT");
    expect(msftRow!.quantity).toBe(30);
  });

  it("excludes a position with a genuine quantity=0 tombstone even though an older non-zero row exists", () => {
    // Same shape as above, but MSFT's February row is an explicit
    // quantity=0 tombstone (the closed-equity reconciler's mark of a real
    // sale) rather than simple absence. Per-(account, security) keying
    // must land on the tombstone (the true latest row) and hide MSFT —
    // never resurrect the older non-zero row.
    //
    // NOTE: because the tombstone lands on the same date as AAPL's
    // restatement (the account's overall max), this test does not
    // discriminate per-account vs per-(account, security) keying — a
    // qty=0 row at the account's max date is picked up and excluded by
    // "h.quantity > 0" under BOTH correlations. It still guards against
    // MSFT's older non-zero row being wrongly resurrected.
    const aapl = seedSecurity(db, "AAPL");
    const msft = seedSecurity(db, "MSFT");

    seedHolding(db, 1, aapl, 50, "2025-01-31", 7500);
    seedHolding(db, 1, msft, 30, "2025-01-31", 9000);
    seedHolding(db, 1, aapl, 50, "2025-02-28", 7500);
    seedHolding(db, 1, msft, 0, "2025-02-28", 0); // tombstone
    seedPrice(db, aapl, "2025-02-28", 200);
    seedPrice(db, msft, "2025-01-31", 400);

    const holdings = getHoldingsForChat(db);
    expect(holdings).toHaveLength(1);
    expect(holdings[0].symbol).toBe("AAPL");
  });

  it("keeps a trailing account's only row when another account has a newer max date", () => {
    // Account 1's holdings restate through February; account 2's only row
    // is January. Both accounts have always been individually correlated
    // here (WHERE h2.account_id = h.account_id), so per-(account, security)
    // keying changes nothing about cross-account behavior — this is a
    // regression guard, not a behavior change.
    const acct1Sec = seedSecurity(db, "AAPL");
    const acct2Sec = seedSecurity(db, "VTI");

    seedHolding(db, 1, acct1Sec, 50, "2025-02-28", 7500);
    seedPrice(db, acct1Sec, "2025-02-28", 200);

    seedHolding(db, 2, acct2Sec, 20, "2025-01-31", 4000);
    seedPrice(db, acct2Sec, "2025-01-31", 200);

    const holdings = getHoldingsForChat(db);
    expect(holdings).toHaveLength(2);
    const symbols = holdings.map((h) => h.symbol).sort();
    expect(symbols).toEqual(["AAPL", "VTI"]);
  });
});

describe("allocation with unpriced holdings", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("falls back to cost basis for positions without prices", () => {
    const priced = seedSecurity(db, "AAPL", { asset_class: "equity" });
    const unpriced = seedSecurity(db, "PRIVATE", { asset_class: "alternative" });

    seedHolding(db, 1, priced, 100, "2025-01-31", 15000);
    seedHolding(db, 1, unpriced, 50, "2025-01-31", 10000);
    seedPrice(db, priced, "2025-01-31", 200); // market value = 20000
    // No price for PRIVATE — should use cost_basis = 10000

    const alloc = getAllocationBreakdown(db, "asset_class");
    const equity = alloc.find((a) => a.group_name === "equity");
    const alt = alloc.find((a) => a.group_name === "alternative");

    expect(equity).toBeDefined();
    expect(alt).toBeDefined();
    // Total = 20000 + 10000 = 30000
    expect(equity!.total_market_value).toBe(20000);
    expect(alt!.total_market_value).toBe(10000);
    expect(equity!.percentage).toBeCloseTo(66.7, 0);
    expect(alt!.percentage).toBeCloseTo(33.3, 0);
  });
});

describe("executeTool dispatcher", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("dispatches to correct query function and wraps with annotations", async () => {
    const sec = seedSecurity(db, "AAPL");
    seedHolding(db, 1, sec, 50, "2025-01-31");
    seedPrice(db, sec, "2025-01-31", 200);

    const result = await executeTool(db, "query_holdings", { symbol: "AAPL" }) as {
      data: Array<{ symbol: string }>;
      quality_warnings: string[];
      data_freshness: { latest_price_date: string | null };
    };
    expect(result).toHaveProperty("data");
    expect(result).toHaveProperty("quality_warnings");
    expect(result).toHaveProperty("data_freshness");
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data[0].symbol).toBe("AAPL");
    expect(Array.isArray(result.quality_warnings)).toBe(true);
  });

  it("resolves account names case-insensitively", async () => {
    const sec = seedSecurity(db, "AAPL");
    seedHolding(db, 1, sec, 50, "2025-01-31", 7500);
    seedHolding(db, 2, sec, 30, "2025-01-31", 4500);
    seedPrice(db, sec, "2025-01-31", 200);

    // "roth" should match "Vanguard Roth IRA" (account 2)
    const result = await executeTool(db, "query_holdings", { account_name: "roth" }) as {
      data: Array<{ account_name: string; quantity: number }>;
    };
    expect(result.data).toHaveLength(1);
    expect(result.data[0].account_name).toBe("Vanguard Roth IRA");
    expect(result.data[0].quantity).toBe(30);
  });

  it("returns error for unknown tool", async () => {
    const result = await executeTool(db, "nonexistent_tool", {});
    expect(result).toEqual({ error: "Unknown tool: nonexistent_tool" });
  });

  it("handles tool execution errors gracefully", async () => {
    // Close the database to force an error
    db.close();
    const result = await executeTool(db, "query_holdings", {});
    expect(result).toHaveProperty("error");
  });

  it("query_research_feeds falls back to sanitizeThemeList when key_themes is not valid JSON", async () => {
    // Simulates a mangled row (the tag-remnant leak class) where key_themes
    // never made it into the DB as a JSON array — a bare JSON.parse would
    // throw and crash the whole tool call. The guard should fall back to
    // the raw string, which sanitizeThemeList comma-splits.
    // received_at must stay inside the tool's recency window relative to the
    // wall clock — a hardcoded date here rots out of the lookback and the
    // assertion below silently flips to an empty result (bit us 2026-07-30).
    db.prepare(
      `INSERT INTO research_articles
         (source_id, received_at, subject, sender, raw_text, key_themes, processed_at)
       VALUES (1, datetime('now', '-1 day'), 'Morning note', 'feed@example.com', 'body',
               'fed policy, tech earnings', datetime('now', '-1 day', '+5 minutes'))`
    ).run();

    const result = await executeTool(db, "query_research_feeds", {}) as {
      data: { articles: Array<{ themes: string[] }> };
    };
    expect(result.data.articles).toHaveLength(1);
    expect(result.data.articles[0].themes).toEqual(["fed policy", "tech earnings"]);
  });

  it("passes account_name to income summary", async () => {
    const sec = seedSecurity(db, "VTI");
    seedTransaction(db, 1, sec, { trade_date: "2025-06-15", type: "DIVIDEND", amount: 100 });
    seedTransaction(db, 2, sec, { trade_date: "2025-06-15", type: "DIVIDEND", amount: 200 });

    const result = await executeTool(db, "query_income_summary", {
      period: "all_time",
      account_name: "Vanguard Taxable",
    }) as { data: Array<{ total_dividends: number }> };
    expect(result.data).toHaveLength(1);
    expect(result.data[0].total_dividends).toBe(100);
  });
});

describe("executeTool query_options_greeks — per-account strategy grouping (holdings-latest-sweep Task 2)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    // migration 002_seed_accounts.sql seeds id=1 Vanguard Taxable, id=2
    // Vanguard Roth IRA — reused below, no need to insert.
  });

  function seedStockSecurity(id: number, symbol: string): void {
    db.prepare(
      `INSERT INTO securities (id, symbol, security_type, currency) VALUES (?, ?, 'stock', 'USD')`
    ).run(id, symbol);
  }

  function seedCallOption(
    id: number,
    symbol: string,
    underlying: string,
    strike: number
  ): void {
    db.prepare(
      `INSERT INTO securities
         (id, symbol, security_type, option_type, strike_price, expiration_date, underlying_symbol, multiplier, currency)
       VALUES (?, ?, 'option', 'CALL', ?, '2027-01-15', ?, 100, 'USD')`
    ).run(id, symbol, strike, underlying);
  }

  function seedHolding(
    accountId: number,
    securityId: number,
    quantity: number,
    asOfDate: string,
    sourceKey: string
  ): void {
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (?, ?, ?, 0, ?, ?)`
    ).run(accountId, securityId, quantity, asOfDate, sourceKey);
  }

  it("includes the trailing-account stock leg and excludes the tombstoned stock leg from strategy detection", async () => {
    // Account 1: AAA stock (only row, dated well before the table's global
    // newest date) + a short call on AAA (dated later, mixing dates within
    // the account per fixture 1) — should form a covered call. Under the
    // OLD chat/tools.ts code (a single GLOBAL MAX(as_of_date) across the
    // whole holdings table, no account/security correlation, no quantity
    // filter), AAA's stock row would have been dropped entirely because
    // its as_of_date isn't the table-wide max.
    seedStockSecurity(500, "AAA");
    seedHolding(1, 500, 100, "2025-01-31", "aaa-stock-1");
    seedCallOption(501, "AAA  270115C00220000", "AAA", 220);
    seedHolding(1, 501, -1, "2025-02-15", "aaa-call-1");

    // Account 2: BBB stock is the "trailing account" fixture — its only row
    // predates account 1's rows — paired with its own short call. Should
    // also form a covered call, proving the trailing account's stock leg
    // was not dropped.
    seedStockSecurity(502, "BBB");
    seedHolding(2, 502, 100, "2025-01-31", "bbb-stock-1");
    seedCallOption(503, "BBB  270115C00150000", "BBB", 150);
    seedHolding(2, 503, -1, "2025-01-31", "bbb-call-1");

    // CCC: tombstoned stock in account 1, paired with its own short call.
    // The tombstone (quantity=0) row is dated 2025-03-31 — the newest
    // as_of_date in the whole table. Under the OLD global-MAX code this is
    // EXACTLY the row that would have matched (no quantity filter existed),
    // resurrecting a closed position as strategy collateral. The fixed
    // code excludes it via getStockLegsForStrategyDetection.
    seedStockSecurity(504, "CCC");
    seedHolding(1, 504, 10, "2025-01-31", "ccc-stock-1");
    seedHolding(1, 504, 0, "2025-03-31", "ccc-stock-2");
    seedCallOption(505, "CCC  270115C00090000", "CCC", 90);
    seedHolding(1, 505, -1, "2025-03-01", "ccc-call-1");

    const result = (await executeTool(db, "query_options_greeks", {})) as {
      data: { strategies: Array<{ type: string; underlying: string }> };
    };

    const coveredCallUnderlyings = result.data.strategies
      .filter((s) => s.type === "covered_call")
      .map((s) => s.underlying)
      .sort();
    expect(coveredCallUnderlyings).toEqual(["AAA", "BBB"]);

    // The tombstoned stock never covers its call — no covered_call for CCC.
    expect(
      result.data.strategies.some((s) => s.underlying === "CCC" && s.type === "covered_call")
    ).toBe(false);
    // Its short call surfaces as naked instead (no valid stock leg to pair it with).
    expect(
      result.data.strategies.some((s) => s.underlying === "CCC" && s.type === "naked_call")
    ).toBe(true);
  });

  it("cross-account regression: a short call in account 1 is NOT covered by 100 shares held only in account 2", async () => {
    // Codex F4: lib/compute/options-strategy.ts's detectStrategies assumes
    // account-local positions. Feeding it a combined cross-account leg list
    // would let account 2's shares wrongly "cover" account 1's call.
    seedCallOption(600, "SPY   270115C00500000", "SPY", 500);
    seedHolding(1, 600, -1, "2025-02-15", "spy-call-1");

    seedStockSecurity(601, "SPY");
    seedHolding(2, 601, 100, "2025-02-15", "spy-stock-1");

    const result = (await executeTool(db, "query_options_greeks", {})) as {
      data: { strategies: Array<{ type: string; underlying: string }> };
    };

    expect(
      result.data.strategies.some((s) => s.underlying === "SPY" && s.type === "covered_call")
    ).toBe(false);
    // Uncovered in its own account — surfaces as a naked call instead.
    expect(
      result.data.strategies.some((s) => s.underlying === "SPY" && s.type === "naked_call")
    ).toBe(true);
  });
});

describe("buildSystemPrompt", () => {
  it("includes current date and portfolio context", () => {
    const prompt = buildSystemPrompt("## Test Context\nSome data here", "2025-01-31");
    expect(prompt).toContain("2025-01-31");
    expect(prompt).toContain("## Test Context");
    expect(prompt).toContain("portfolio analyst");
    expect(prompt).toContain("Tax-loss harvesting");
    expect(prompt).toContain("Concentration risk");
  });

  it("includes fixed income intelligence sections", () => {
    const prompt = buildSystemPrompt("", "2025-01-31");
    expect(prompt).toContain("Fixed Income Intelligence");
    expect(prompt).toContain("Bond Maturity");
    expect(prompt).toContain("matured positions");
  });

  it("includes data quality awareness", () => {
    const prompt = buildSystemPrompt("", "2025-01-31");
    expect(prompt).toContain("Data Quality Awareness");
    expect(prompt).toContain("quality_warnings");
    expect(prompt).toContain("estimated cash");
  });

  it("includes position lifecycle", () => {
    const prompt = buildSystemPrompt("", "2025-01-31");
    expect(prompt).toContain("Position Lifecycle");
    expect(prompt).toContain("maturity");
    expect(prompt).toContain("expiration");
  });

  it("includes wash sale awareness", () => {
    const prompt = buildSystemPrompt("", "2025-01-31");
    expect(prompt).toContain("Wash Sale");
    expect(prompt).toContain("30 days");
  });

  it("mentions case-insensitive account matching", () => {
    const prompt = buildSystemPrompt("", "2025-01-31");
    expect(prompt).toContain("case-insensitive");
  });
});
