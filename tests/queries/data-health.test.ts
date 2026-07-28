import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getPriceFreshness,
  getAccountCoverage,
  getDataGaps,
  getCrossSourceDiscrepancies,
  getSnapshotReconciliation,
  getDataHealthSummary,
} from "@/lib/queries/data-health";

let db: Database.Database;

/** Today's date in YYYY-MM-DD. */
const today = new Date().toISOString().split("T")[0];

/** N days ago in YYYY-MM-DD. */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
}

function seedAccount(name: string): number {
  return (
    db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name),
    (
      db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as {
        id: number;
      }
    ).id
  );
}

function seedSecurity(
  symbol: string,
  type: string | null = "Stock",
): number {
  db.prepare(
    "INSERT OR IGNORE INTO securities (symbol, name, security_type) VALUES (?, ?, ?)",
  ).run(symbol, `${symbol} Inc`, type);
  return (
    db.prepare("SELECT id FROM securities WHERE symbol = ?").get(symbol) as {
      id: number;
    }
  ).id;
}

function seedHolding(
  accountId: number,
  securityId: number,
  quantity: number,
  asOfDate: string,
  costBasis: number | null = null,
) {
  db.prepare(
    `INSERT OR REPLACE INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    accountId,
    securityId,
    quantity,
    costBasis,
    asOfDate,
    `test:h:${accountId}:${securityId}:${asOfDate}`,
  );
}

function seedPrice(
  securityId: number,
  date: string,
  price: number,
  source = "tws",
) {
  db.prepare(
    `INSERT OR REPLACE INTO prices (security_id, date, close_price, source)
     VALUES (?, ?, ?, ?)`,
  ).run(securityId, date, price, source);
}

function seedSnapshot(
  accountId: number,
  monthEndDate: string,
  totalValue: number,
) {
  db.prepare(
    `INSERT OR REPLACE INTO monthly_snapshots (account_id, month_end_date, total_value, source)
     VALUES (?, ?, ?, 'test')`,
  ).run(accountId, monthEndDate, totalValue);
}

function seedValuation(
  accountId: number,
  date: string,
  holdingsValue: number,
  cashBalance: number,
  holdingsCount: number | null = null,
  pricedCount: number | null = null,
) {
  db.prepare(
    `INSERT OR REPLACE INTO daily_valuations
       (account_id, valuation_date, holdings_value, cash_balance, total_value, holdings_count, priced_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    accountId,
    date,
    holdingsValue,
    cashBalance,
    holdingsValue + cashBalance,
    holdingsCount,
    pricedCount,
  );
}

function seedTransaction(
  accountId: number,
  securityId: number,
  date: string,
  type: string,
  quantity: number,
  amount: number,
) {
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, source_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    accountId,
    securityId,
    date,
    type,
    quantity,
    amount,
    `test:txn:${accountId}:${securityId}:${date}:${type}:${Math.random()}`,
  );
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

// ── getPriceFreshness ─────────────────────────────────────────────

describe("getPriceFreshness", () => {
  it("returns securities with holdings sorted by staleness", () => {
    const acct = seedAccount("Test");
    const aapl = seedSecurity("AAPL");
    const msft = seedSecurity("MSFT");

    seedHolding(acct, aapl, 10, today);
    seedHolding(acct, msft, 5, today);

    seedPrice(aapl, today, 150);
    seedPrice(msft, daysAgo(30), 300);

    const result = getPriceFreshness(db);
    expect(result.length).toBe(2);
    // MSFT is more stale, should be first
    expect(result[0].symbol).toBe("MSFT");
    expect(result[0].daysStalePrices).toBeGreaterThanOrEqual(29);
    expect(result[0].hasHoldings).toBeTruthy();
    expect(result[1].symbol).toBe("AAPL");
    expect(result[1].daysStalePrices).toBe(0);
  });

  it("includes securities with prices but no holdings", () => {
    const sec = seedSecurity("GOOG");
    seedPrice(sec, today, 100);

    const result = getPriceFreshness(db);
    expect(result.length).toBe(1);
    expect(result[0].hasHoldings).toBeFalsy();
  });

  it("shows null staleness for securities with no prices", () => {
    const acct = seedAccount("Test");
    const sec = seedSecurity("NOPRICE");
    seedHolding(acct, sec, 10, today);

    const result = getPriceFreshness(db);
    const noprice = result.find((r) => r.symbol === "NOPRICE");
    expect(noprice).toBeDefined();
    expect(noprice!.daysStalePrices).toBeNull();
    expect(noprice!.priceCount).toBe(0);
  });
});

// ── getAccountCoverage ────────────────────────────────────────────

describe("getAccountCoverage", () => {
  it("computes coverage percentage correctly", () => {
    const acct = seedAccount("Vanguard Taxable");
    const aapl = seedSecurity("AAPL");
    const msft = seedSecurity("MSFT");
    const goog = seedSecurity("GOOG");

    seedHolding(acct, aapl, 10, today);
    seedHolding(acct, msft, 5, today);
    seedHolding(acct, goog, 3, today);

    // Only AAPL and MSFT have recent prices
    seedPrice(aapl, today, 150);
    seedPrice(msft, daysAgo(3), 300);
    // GOOG has no price

    const result = getAccountCoverage(db);
    const vt = result.find((r) => r.accountName === "Vanguard Taxable");
    expect(vt).toBeDefined();
    expect(vt!.totalHoldings).toBe(3);
    expect(vt!.pricedHoldings).toBe(2); // within 7 days
    expect(vt!.coveragePct).toBeCloseTo(66.7, 0);
  });

  it("tracks cost basis coverage", () => {
    const acct = seedAccount("IBKR");
    const aapl = seedSecurity("AAPL");
    const msft = seedSecurity("MSFT");

    seedHolding(acct, aapl, 10, today, 1500); // has cost basis
    seedHolding(acct, msft, 5, today, null); // no cost basis

    const result = getAccountCoverage(db);
    const ibkr = result.find((r) => r.accountName === "IBKR");
    expect(ibkr!.holdingsWithCostBasis).toBe(1);
  });

  it("falls back to the latest non-null cost basis when the newest row is NULL (Plaid daily sync)", () => {
    // Plaid writes cost_basis NULL on every daily sync; the statement row a
    // month earlier carries the real basis. Coverage must count it — pre-fix
    // this permanently reported "Cost basis: 0/N" while the Accounts tab
    // (getHoldingsByAccount's costBasisExpr) rendered real values.
    const acct = seedAccount("Vanguard Taxable");
    const vti = seedSecurity("VTI");
    const brkb = seedSecurity("BRK/B");

    seedHolding(acct, vti, 100, daysAgo(28), 37301.64); // statement row w/ basis
    seedHolding(acct, brkb, 20, daysAgo(28), null); // never had basis
    seedHolding(acct, vti, 100, today, null); // Plaid row, NULL basis
    seedHolding(acct, brkb, 20, today, null); // Plaid row, NULL basis

    const result = getAccountCoverage(db);
    const vt = result.find((r) => r.accountName === "Vanguard Taxable");
    expect(vt!.totalHoldings).toBe(2);
    expect(vt!.holdingsWithCostBasis).toBe(1); // VTI via fallback; BRK/B genuinely missing
  });
});

// ── getDataGaps ───────────────────────────────────────────────────

describe("getDataGaps", () => {
  it("finds securities with holdings but no prices", () => {
    const acct = seedAccount("Test");
    const sec = seedSecurity("NOPRICE");
    seedHolding(acct, sec, 10, today);

    const gaps = getDataGaps(db);
    expect(gaps.securitiesNoPrices.length).toBe(1);
    expect(gaps.securitiesNoPrices[0].symbol).toBe("NOPRICE");
  });

  it("finds securities with holdings but no transactions", () => {
    const acct = seedAccount("Test");
    const sec = seedSecurity("NOTXN");
    seedHolding(acct, sec, 10, today);
    seedPrice(sec, today, 100);

    const gaps = getDataGaps(db);
    expect(gaps.securitiesNoTransactions.length).toBe(1);
    expect(gaps.securitiesNoTransactions[0].symbol).toBe("NOTXN");
  });

  it("finds accounts without snapshots", () => {
    seedAccount("EmptyAccount");

    const gaps = getDataGaps(db);
    // All seeded accounts should appear (including the 3 from migrations)
    expect(gaps.accountsNoSnapshots.length).toBeGreaterThanOrEqual(1);
    expect(
      gaps.accountsNoSnapshots.some((a) => a.name === "EmptyAccount"),
    ).toBe(true);
  });

  it("finds stale holdings (>90 days old)", () => {
    const acct = seedAccount("Test");
    const sec = seedSecurity("STALE");
    seedHolding(acct, sec, 10, daysAgo(100));

    const gaps = getDataGaps(db);
    expect(gaps.staleHoldings.length).toBe(1);
    expect(gaps.staleHoldings[0].symbol).toBe("STALE");
    expect(gaps.staleHoldings[0].daysSince).toBeGreaterThanOrEqual(99);
  });

  it("does not flag fresh holdings", () => {
    const acct = seedAccount("Test");
    const sec = seedSecurity("FRESH");
    seedHolding(acct, sec, 10, today);

    const gaps = getDataGaps(db);
    expect(gaps.staleHoldings.length).toBe(0);
  });
});

// ── getCrossSourceDiscrepancies ───────────────────────────────────

describe("getCrossSourceDiscrepancies", () => {
  it("finds price discrepancies between prices and ohlcv_bars", () => {
    const sec = seedSecurity("DISC");
    const acct = seedAccount("Test");
    seedHolding(acct, sec, 10, today);

    // Price table says 100
    seedPrice(sec, "2025-03-15", 100, "vanguard-holdings");
    // OHLCV says 110 (10% diff)
    db.prepare(
      `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume)
       VALUES (?, '2025-03-15', '1 day', 105, 112, 98, 110, 1000)`,
    ).run(sec);

    const result = getCrossSourceDiscrepancies(db);
    expect(result.length).toBe(1);
    expect(result[0].symbol).toBe("DISC");
    expect(result[0].diffPct).toBeCloseTo(10, 0);
  });

  it("does not flag matching prices", () => {
    const sec = seedSecurity("MATCH");
    seedPrice(sec, "2025-03-15", 100, "tws");
    db.prepare(
      `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume)
       VALUES (?, '2025-03-15', '1 day', 99, 101, 99, 100.5, 1000)`,
    ).run(sec);

    const result = getCrossSourceDiscrepancies(db);
    expect(result.length).toBe(0);
  });
});

// ── getSnapshotReconciliation ─────────────────────────────────────

describe("getSnapshotReconciliation", () => {
  it("compares snapshot totals vs daily valuations", () => {
    const acct = seedAccount("Vanguard Taxable");
    seedSnapshot(acct, "2025-03-31", 100000);
    seedValuation(acct, "2025-03-31", 90000, 8000, 10, 8);

    const result = getSnapshotReconciliation(db);
    const row = result.find(
      (r) =>
        r.accountName === "Vanguard Taxable" &&
        r.snapshotDate === "2025-03-31",
    );
    expect(row).toBeDefined();
    expect(row!.snapshotTotal).toBe(100000);
    expect(row!.computedTotal).toBe(98000); // 90000 + 8000
    expect(row!.difference).toBe(-2000);
    expect(row!.diffPct).toBeCloseTo(-2.0, 1);
    expect(row!.holdingsCount).toBe(10);
    expect(row!.pricedCount).toBe(8);
  });

  it("returns null computed for snapshots without daily valuations", () => {
    const acct = seedAccount("IBKR");
    seedSnapshot(acct, "2025-02-28", 50000);

    const result = getSnapshotReconciliation(db);
    const row = result.find(
      (r) => r.accountName === "IBKR" && r.snapshotDate === "2025-02-28",
    );
    expect(row).toBeDefined();
    expect(row!.computedTotal).toBeNull();
    expect(row!.difference).toBeNull();
  });
});

// ── getDataHealthSummary ──────────────────────────────────────────

describe("getDataHealthSummary", () => {
  it("computes aggregate summary", () => {
    const acct = seedAccount("Test");
    const aapl = seedSecurity("AAPL");
    const msft = seedSecurity("MSFT");
    const nop = seedSecurity("NOPRICE");

    seedHolding(acct, aapl, 10, today);
    seedHolding(acct, msft, 5, today);
    seedHolding(acct, nop, 3, today);

    seedPrice(aapl, today, 150);
    seedPrice(msft, daysAgo(10), 300);
    // NOPRICE has no prices

    const summary = getDataHealthSummary(db);
    expect(summary.totalSecurities).toBe(3);
    expect(summary.securitiesWithPrices).toBe(2);
    expect(summary.securitiesWithoutPrices).toBe(1);
    expect(summary.overallCoveragePct).toBeCloseTo(67, 0);
    expect(summary.avgStaleDays).toBeGreaterThanOrEqual(0);
    expect(summary.maxStaleDays).toBeGreaterThanOrEqual(9);
    expect(summary.totalGaps).toBeGreaterThanOrEqual(1); // NOPRICE has no prices
  });

  it("returns 100% coverage when no holdings", () => {
    const summary = getDataHealthSummary(db);
    expect(summary.overallCoveragePct).toBe(100);
    expect(summary.totalSecurities).toBe(0);
  });
});
