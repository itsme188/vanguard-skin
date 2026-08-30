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

  it("uses the per-(account, security) latest-holdings definition — a fund last restated on an older statement still counts as held (VHGEX regression)", () => {
    const acct = seedAccount("Vanguard Taxable");
    const vhgex = seedSecurity("VHGEX", "Mutual Fund");
    const xom = seedSecurity("XOM");

    // VHGEX's newest row is a statement from ~4 months ago; later live syncs
    // only restate XOM, so the ACCOUNT's global max as_of_date is today.
    seedHolding(acct, vhgex, 100, daysAgo(116));
    seedHolding(acct, xom, 10, today);

    seedPrice(vhgex, daysAgo(116), 30);
    seedPrice(xom, daysAgo(24), 100);

    const held = getPriceFreshness(db).filter((r) => r.hasHoldings);
    expect(held.map((r) => r.symbol).sort()).toEqual(["VHGEX", "XOM"]);

    // The stalest held security must be the one the Max Stale headline names.
    expect(held[0].symbol).toBe("VHGEX");

    // Panel universe == summary universe: one held-securities definition.
    const summary = getDataHealthSummary(db);
    expect(held.length).toBe(summary.totalSecurities);
    expect(summary.worstStaleSymbol).toBe("VHGEX");
  });

  it("counts short positions as held (quantity != 0, matching the summary universe)", () => {
    const acct = seedAccount("IBKR");
    const shortSec = seedSecurity("SHRT");
    seedHolding(acct, shortSec, -5, today);
    seedPrice(shortSec, today, 50);

    const held = getPriceFreshness(db).filter((r) => r.hasHoldings);
    expect(held.map((r) => r.symbol)).toEqual(["SHRT"]);
    expect(held.length).toBe(getDataHealthSummary(db).totalSecurities);
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

  it("counts short positions in the held universe", () => {
    // Pre-fix the hand-rolled join filtered on `h.quantity > 0`, so a short
    // position (a legitimate IBKR holding) silently dropped out of both the
    // numerator and denominator — an account holding 12 positions including
    // 4 shorts read "8/8 priced" instead of "12/12".
    const acct = seedAccount("IBKR");
    const long = seedSecurity("AAPL");
    const short = seedSecurity("TSLA");

    seedHolding(acct, long, 10, today);
    seedHolding(acct, short, -400, today);
    seedPrice(long, today, 150);
    seedPrice(short, today, 250);

    const result = getAccountCoverage(db);
    const ibkr = result.find((r) => r.accountName === "IBKR");
    expect(ibkr!.totalHoldings).toBe(2);
    expect(ibkr!.pricedHoldings).toBe(2);
  });

  it("keeps a position whose latest row predates the account's newest snapshot", () => {
    // Pre-fix the denominator was gated on a single global MAX(as_of_date)
    // per account, so a security whose own latest holdings row is older
    // than the account's newest snapshot date (e.g. a fund only revalued on
    // statement day while other positions get daily Plaid rows) dropped out
    // entirely — exactly the securities the Max Stale card names.
    const acct = seedAccount("Vanguard Taxable");
    const vhgex = seedSecurity("VHGEX");
    const xom = seedSecurity("XOM");

    seedHolding(acct, vhgex, 100, daysAgo(116));
    seedPrice(vhgex, daysAgo(120), 50);
    seedHolding(acct, xom, 10, today);
    seedPrice(xom, today, 110);

    const result = getAccountCoverage(db);
    const vt = result.find((r) => r.accountName === "Vanguard Taxable");
    expect(vt!.totalHoldings).toBe(2);
    expect(vt!.pricedHoldings).toBe(1);
    expect(vt!.coveragePct).toBe(50);
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

  it("converts native-currency prices to USD via fx_rates (diffPct unchanged)", () => {
    // KRW security: stored prices are native (919,000 KRW ≈ $611); the UI
    // renders priceA/priceB through <Money> with a $ prefix, so the query
    // must apply the fx factor — pre-fix the page showed "$919,000.00".
    const sec = seedSecurity("402340");
    db.prepare("UPDATE securities SET currency = 'KRW' WHERE id = ?").run(sec);
    db.prepare(
      `INSERT INTO fx_rates (currency, usd_per_unit, as_of, source)
       VALUES ('KRW', 0.0006648, '2026-07-10', 'ibkr_ledger')`,
    ).run();
    seedPrice(sec, "2026-07-30", 919000, "tws");
    db.prepare(
      `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume)
       VALUES (?, '2026-07-30', '1 day', 800000, 930000, 790000, 799000, 1000)`,
    ).run(sec);

    const result = getCrossSourceDiscrepancies(db);
    expect(result.length).toBe(1);
    expect(result[0].priceA).toBeCloseTo(919000 * 0.0006648, 2);
    expect(result[0].priceB).toBeCloseTo(799000 * 0.0006648, 2);
    // diffPct is currency-invariant
    expect(result[0].diffPct).toBeCloseTo(13.06, 1);
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
    // MSFT's only price is 10 days old — stale prices don't count as coverage
    // (same 7-day recency window as getAccountCoverage on the same page).
    expect(summary.securitiesWithPrices).toBe(1);
    expect(summary.securitiesWithoutPrices).toBe(2);
    expect(summary.overallCoveragePct).toBeCloseTo(33, 0);
    expect(summary.avgStaleDays).toBeGreaterThanOrEqual(0);
    expect(summary.maxStaleDays).toBeGreaterThanOrEqual(9);
    expect(summary.totalGaps).toBeGreaterThanOrEqual(1); // NOPRICE has no prices
  });

  it("returns 100% coverage when no holdings", () => {
    const summary = getDataHealthSummary(db);
    expect(summary.overallCoveragePct).toBe(100);
    expect(summary.totalSecurities).toBe(0);
  });

  it("excludes closed positions — a newest qty-0 row removes the security from the universe", () => {
    const acct = seedAccount("Test");
    const aapl = seedSecurity("AAPL");
    const sold = seedSecurity("SOLD");

    seedHolding(acct, aapl, 10, today);
    seedHolding(acct, sold, 25, daysAgo(60)); // once held...
    seedHolding(acct, sold, 0, daysAgo(30)); // ...closed a month ago

    seedPrice(aapl, today, 150);
    // SOLD's last price is from when it was held — very stale
    seedPrice(sold, daysAgo(60), 40);

    const summary = getDataHealthSummary(db);
    expect(summary.totalSecurities).toBe(1);
    expect(summary.securitiesWithPrices).toBe(1);
    expect(summary.overallCoveragePct).toBe(100);
    // Staleness must not cite the closed position either
    expect(summary.worstStaleSymbol).not.toBe("SOLD");
    expect(summary.maxStaleDays).toBeLessThan(30);
  });

  it("counts short positions in the universe (exposure is exposure)", () => {
    const acct = seedAccount("Test");
    const shrt = seedSecurity("SHRT");
    seedHolding(acct, shrt, -5, today);
    seedPrice(shrt, today, 90);

    const summary = getDataHealthSummary(db);
    expect(summary.totalSecurities).toBe(1);
    expect(summary.securitiesWithPrices).toBe(1);
  });

  it("a stale TWS intra-day row in one account does not mask an older statement holding in another", () => {
    const a1 = seedAccount("IBKR");
    const a2 = seedAccount("Vanguard");
    const sec = seedSecurity("BOTH");
    // IBKR row is newer, Vanguard statement row older — per-(account,security)
    // latest semantics keep both accounts' rows in play.
    seedHolding(a1, sec, 5, today);
    seedHolding(a2, sec, 10, daysAgo(20));
    seedPrice(sec, today, 55);

    const summary = getDataHealthSummary(db);
    expect(summary.totalSecurities).toBe(1);
    expect(summary.securitiesWithPrices).toBe(1);
  });
});
