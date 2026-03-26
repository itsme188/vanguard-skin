import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeDailyValuations } from "@/lib/compute/daily-valuation";

function seedSecurity(db: Database.Database, symbol: string, securityType?: string): number {
  const result = db
    .prepare("INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, ?)")
    .run(symbol, symbol + " Corp", securityType ?? null);
  return result.lastInsertRowid as number;
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

function seedCashTransaction(
  db: Database.Database,
  accountId: number,
  date: string,
  amount: number,
  type: string = "DEPOSIT"
): void {
  db.prepare(
    `INSERT INTO transactions (account_id, trade_date, type, amount, is_external_flow, source_key)
     VALUES (?, ?, ?, ?, 1, ?)`
  ).run(accountId, date, type, amount, `cash-${accountId}-${date}-${Math.random()}`);
}

function seedSnapshot(
  db: Database.Database,
  accountId: number,
  date: string,
  totalValue: number
): void {
  db.prepare(
    `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value)
     VALUES (?, ?, ?)`
  ).run(accountId, date, totalValue);
}

describe("daily valuation computation", () => {
  let db: Database.Database;
  const ACCOUNT_ID = 1; // Vanguard Taxable

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("computes valuation from holdings and prices", () => {
    const sec = seedSecurity(db, "AAPL");
    seedHolding(db, ACCOUNT_ID, sec, 10, "2025-01-31");
    seedPrice(db, sec, "2025-01-31", 150);

    const result = computeDailyValuations(db);
    expect(result.datesComputed).toBe(1);

    const vals = db
      .prepare("SELECT * FROM daily_valuations WHERE account_id = ?")
      .all(ACCOUNT_ID) as any[];
    expect(vals).toHaveLength(1);
    expect(vals[0].holdings_value).toBe(1500); // 10 * 150
    expect(vals[0].total_value).toBe(1500);
    expect(vals[0].valuation_date).toBe("2025-01-31");
  });

  it("computes valuations across multiple dates", () => {
    const sec = seedSecurity(db, "AAPL");
    seedHolding(db, ACCOUNT_ID, sec, 10, "2025-01-31");
    seedPrice(db, sec, "2025-01-31", 150);
    seedPrice(db, sec, "2025-02-28", 160);

    const result = computeDailyValuations(db);
    expect(result.datesComputed).toBe(2);

    const vals = db
      .prepare(
        "SELECT * FROM daily_valuations WHERE account_id = ? ORDER BY valuation_date"
      )
      .all(ACCOUNT_ID) as any[];
    expect(vals).toHaveLength(2);
    expect(vals[0].holdings_value).toBe(1500); // 10 * 150
    expect(vals[1].holdings_value).toBe(1600); // 10 * 160
  });

  it("handles multiple securities per account", () => {
    const aapl = seedSecurity(db, "AAPL");
    const msft = seedSecurity(db, "MSFT");

    seedHolding(db, ACCOUNT_ID, aapl, 10, "2025-01-31");
    seedHolding(db, ACCOUNT_ID, msft, 5, "2025-01-31");
    seedPrice(db, aapl, "2025-01-31", 150);
    seedPrice(db, msft, "2025-01-31", 300);

    computeDailyValuations(db);

    const vals = db
      .prepare("SELECT * FROM daily_valuations WHERE account_id = ?")
      .all(ACCOUNT_ID) as any[];
    expect(vals).toHaveLength(1);
    expect(vals[0].holdings_value).toBe(3000); // (10*150) + (5*300)
  });

  it("handles multiple accounts independently", () => {
    const sec = seedSecurity(db, "AAPL");
    const ROTH = 2;

    seedHolding(db, ACCOUNT_ID, sec, 10, "2025-01-31");
    seedHolding(db, ROTH, sec, 5, "2025-01-31");
    seedPrice(db, sec, "2025-01-31", 150);

    computeDailyValuations(db);

    const taxable = db
      .prepare("SELECT * FROM daily_valuations WHERE account_id = ?")
      .all(ACCOUNT_ID) as any[];
    const roth = db
      .prepare("SELECT * FROM daily_valuations WHERE account_id = ?")
      .all(ROTH) as any[];

    expect(taxable[0].holdings_value).toBe(1500);
    expect(roth[0].holdings_value).toBe(750);
  });

  it("is idempotent — recomputing produces same results", () => {
    const sec = seedSecurity(db, "AAPL");
    seedHolding(db, ACCOUNT_ID, sec, 10, "2025-01-31");
    seedPrice(db, sec, "2025-01-31", 150);

    computeDailyValuations(db);
    computeDailyValuations(db);

    const vals = db
      .prepare("SELECT * FROM daily_valuations WHERE account_id = ?")
      .all(ACCOUNT_ID) as any[];
    expect(vals).toHaveLength(1);
    expect(vals[0].holdings_value).toBe(1500);
  });

  it("uses most recent holdings for dates without new snapshot", () => {
    const sec = seedSecurity(db, "AAPL");
    // Holdings as of Jan 31
    seedHolding(db, ACCOUNT_ID, sec, 10, "2025-01-31");
    // Prices for Jan and Feb — no Feb holdings snapshot
    seedPrice(db, sec, "2025-01-31", 150);
    seedPrice(db, sec, "2025-02-28", 160);

    computeDailyValuations(db);

    const vals = db
      .prepare(
        "SELECT * FROM daily_valuations WHERE account_id = ? ORDER BY valuation_date"
      )
      .all(ACCOUNT_ID) as any[];
    expect(vals).toHaveLength(2);
    // Feb uses Jan holdings (10 shares) with Feb price
    expect(vals[1].holdings_value).toBe(1600);
  });

  it("correctly values bonds at par-adjusted price", () => {
    const bond = seedSecurity(db, "TBILL", "bond");
    // 10000 face value, price 98.5 (% of par)
    seedHolding(db, ACCOUNT_ID, bond, 10000, "2025-01-31");
    seedPrice(db, bond, "2025-01-31", 98.5);

    computeDailyValuations(db);

    const vals = db
      .prepare("SELECT * FROM daily_valuations WHERE account_id = ?")
      .all(ACCOUNT_ID) as any[];
    expect(vals).toHaveLength(1);
    // Bond: 10000 * 98.5 / 100 = 9850
    expect(vals[0].holdings_value).toBe(9850);
  });

  it("handles mixed bond and equity holdings", () => {
    const stock = seedSecurity(db, "AAPL");
    const bond = seedSecurity(db, "TBILL", "bond");

    seedHolding(db, ACCOUNT_ID, stock, 10, "2025-01-31");
    seedHolding(db, ACCOUNT_ID, bond, 10000, "2025-01-31");
    seedPrice(db, stock, "2025-01-31", 150);
    seedPrice(db, bond, "2025-01-31", 98.5);

    computeDailyValuations(db);

    const vals = db
      .prepare("SELECT * FROM daily_valuations WHERE account_id = ?")
      .all(ACCOUNT_ID) as any[];
    expect(vals).toHaveLength(1);
    // Stock: 10 * 150 = 1500, Bond: 10000 * 98.5 / 100 = 9850
    expect(vals[0].holdings_value).toBe(11350);
  });

  it("returns summary statistics", () => {
    const sec = seedSecurity(db, "AAPL");
    seedHolding(db, ACCOUNT_ID, sec, 10, "2025-01-31");
    seedPrice(db, sec, "2025-01-31", 150);

    const result = computeDailyValuations(db);
    expect(result.datesComputed).toBeGreaterThan(0);
    expect(result.accountsProcessed).toBeGreaterThan(0);
  });

  // ─── Carry-forward price tests ──────────────────────────────────

  it("carries forward prices when exact date is missing", () => {
    // VFIAX only has a month-end price; AAPL has daily prices
    const fund = seedSecurity(db, "VFIAX", "mutual_fund");
    const stock = seedSecurity(db, "AAPL");

    seedHolding(db, ACCOUNT_ID, fund, 100, "2025-01-31");
    seedHolding(db, ACCOUNT_ID, stock, 10, "2025-01-31");

    // Fund: only month-end price
    seedPrice(db, fund, "2025-01-31", 400);
    // Stock: both month-end and mid-month prices
    seedPrice(db, stock, "2025-01-31", 150);
    seedPrice(db, stock, "2025-02-15", 155);

    computeDailyValuations(db);

    const vals = db
      .prepare(
        "SELECT * FROM daily_valuations WHERE account_id = ? ORDER BY valuation_date"
      )
      .all(ACCOUNT_ID) as any[];

    // Jan 31: both have exact prices → fund 100*400 + stock 10*150 = 41500
    expect(vals[0].valuation_date).toBe("2025-01-31");
    expect(vals[0].total_value).toBe(41500);

    // Feb 15: fund carries forward Jan 31 price, stock has exact price
    // fund 100*400 + stock 10*155 = 41550
    expect(vals[1].valuation_date).toBe("2025-02-15");
    expect(vals[1].total_value).toBe(41550);
  });

  it("does not carry forward prices beyond 45-day staleness limit", () => {
    const fund = seedSecurity(db, "VFIAX", "mutual_fund");
    const stock = seedSecurity(db, "AAPL");

    seedHolding(db, ACCOUNT_ID, fund, 100, "2025-01-31");
    seedHolding(db, ACCOUNT_ID, stock, 10, "2025-01-31");

    // Fund: price on Jan 31 only
    seedPrice(db, fund, "2025-01-31", 400);
    // Stock: price on Apr 1 (61 days after Jan 31 — beyond 45-day window for fund)
    seedPrice(db, stock, "2025-01-31", 150);
    seedPrice(db, stock, "2025-04-01", 160);

    computeDailyValuations(db);

    const aprVal = db
      .prepare(
        "SELECT * FROM daily_valuations WHERE account_id = ? AND valuation_date = '2025-04-01'"
      )
      .get(ACCOUNT_ID) as any;

    // Fund price from Jan 31 is >45 days stale — excluded
    // Only stock: 10 * 160 = 1600
    expect(aprVal.total_value).toBe(1600);
    expect(aprVal.priced_count).toBe(1);
    expect(aprVal.holdings_count).toBe(2);
  });

  it("tracks holdings_count and priced_count", () => {
    const sec1 = seedSecurity(db, "AAPL");
    const sec2 = seedSecurity(db, "MSFT");
    const sec3 = seedSecurity(db, "VFIAX", "mutual_fund");

    seedHolding(db, ACCOUNT_ID, sec1, 10, "2025-01-31");
    seedHolding(db, ACCOUNT_ID, sec2, 5, "2025-01-31");
    seedHolding(db, ACCOUNT_ID, sec3, 100, "2025-01-31");

    // Only sec1 and sec2 have prices on this date
    seedPrice(db, sec1, "2025-01-31", 150);
    seedPrice(db, sec2, "2025-01-31", 300);

    computeDailyValuations(db);

    const val = db
      .prepare(
        "SELECT * FROM daily_valuations WHERE account_id = ? AND valuation_date = '2025-01-31'"
      )
      .get(ACCOUNT_ID) as any;

    expect(val.holdings_count).toBe(3);
    expect(val.priced_count).toBe(2);
    expect(val.holdings_value).toBe(3000); // (10*150) + (5*300)
  });

  it("excludes ghost holdings from older snapshots (sold securities)", () => {
    // GOOG held in Jan snapshot, but NOT in Feb snapshot (sold)
    const aapl = seedSecurity(db, "AAPL");
    const goog = seedSecurity(db, "GOOG");

    // Jan snapshot: AAPL + GOOG
    seedHolding(db, ACCOUNT_ID, aapl, 10, "2025-01-31");
    seedHolding(db, ACCOUNT_ID, goog, 5, "2025-01-31");

    // Feb snapshot: AAPL only (GOOG was sold)
    seedHolding(db, ACCOUNT_ID, aapl, 10, "2025-02-28");

    // Prices for both on Feb 28
    seedPrice(db, aapl, "2025-01-31", 150);
    seedPrice(db, goog, "2025-01-31", 180);
    seedPrice(db, aapl, "2025-02-28", 160);
    seedPrice(db, goog, "2025-02-28", 190);

    computeDailyValuations(db);

    const janVal = db
      .prepare("SELECT * FROM daily_valuations WHERE account_id = ? AND valuation_date = '2025-01-31'")
      .get(ACCOUNT_ID) as any;
    const febVal = db
      .prepare("SELECT * FROM daily_valuations WHERE account_id = ? AND valuation_date = '2025-02-28'")
      .get(ACCOUNT_ID) as any;

    // Jan: both held → AAPL 10*150 + GOOG 5*180 = 2400
    expect(janVal.holdings_count).toBe(2);
    expect(janVal.total_value).toBe(2400);

    // Feb: only AAPL (GOOG sold, not in Feb snapshot) → 10*160 = 1600
    // Ghost fix: GOOG should NOT appear even though it has a price
    expect(febVal.holdings_count).toBe(1);
    expect(febVal.total_value).toBe(1600);
  });

  // ─── Cash inference from monthly snapshots ─────────────────────

  it("infers cash from monthly snapshot anchor", () => {
    const sec = seedSecurity(db, "AAPL");
    seedHolding(db, ACCOUNT_ID, sec, 10, "2025-01-31");
    seedPrice(db, sec, "2025-01-31", 150);
    // Snapshot says account is worth $2000, but holdings = $1500 → $500 cash
    seedSnapshot(db, ACCOUNT_ID, "2025-01-31", 2000);

    computeDailyValuations(db);

    const val = db
      .prepare("SELECT * FROM daily_valuations WHERE account_id = ? AND valuation_date = '2025-01-31'")
      .get(ACCOUNT_ID) as any;

    expect(val.holdings_value).toBe(1500);
    expect(val.cash_balance).toBe(500);
    expect(val.total_value).toBe(2000);
  });

  it("carries cash forward between snapshots", () => {
    const sec = seedSecurity(db, "AAPL");
    seedHolding(db, ACCOUNT_ID, sec, 10, "2025-01-31");
    seedPrice(db, sec, "2025-01-31", 150);
    seedPrice(db, sec, "2025-02-15", 160);
    seedPrice(db, sec, "2025-02-28", 170);

    // Jan snapshot: total=$2000, holdings=$1500 → cash=$500
    seedSnapshot(db, ACCOUNT_ID, "2025-01-31", 2000);
    // Feb snapshot: total=$2200, holdings=$1700 → cash=$500
    seedSnapshot(db, ACCOUNT_ID, "2025-02-28", 2200);

    computeDailyValuations(db);

    const vals = db
      .prepare(
        "SELECT valuation_date, holdings_value, cash_balance, total_value FROM daily_valuations WHERE account_id = ? ORDER BY valuation_date"
      )
      .all(ACCOUNT_ID) as any[];

    // Jan 31: cash from Jan snapshot ($500)
    expect(vals[0].cash_balance).toBe(500);
    expect(vals[0].total_value).toBe(2000);

    // Feb 15: between Jan and Feb snapshots → uses Jan cash ($500)
    expect(vals[1].cash_balance).toBe(500);
    expect(vals[1].total_value).toBe(1600 + 500); // holdings + cash

    // Feb 28: new snapshot → cash recalculated ($500)
    expect(vals[2].cash_balance).toBe(500);
    expect(vals[2].total_value).toBe(2200);
  });

  it("carries last snapshot cash forward indefinitely", () => {
    const sec = seedSecurity(db, "AAPL");
    seedHolding(db, ACCOUNT_ID, sec, 10, "2025-01-31");
    seedPrice(db, sec, "2025-01-31", 150);
    seedPrice(db, sec, "2025-03-15", 180);

    // Only Jan snapshot — cash carries forward to March
    seedSnapshot(db, ACCOUNT_ID, "2025-01-31", 2000);

    computeDailyValuations(db);

    const marVal = db
      .prepare("SELECT * FROM daily_valuations WHERE account_id = ? AND valuation_date = '2025-03-15'")
      .get(ACCOUNT_ID) as any;

    expect(marVal.holdings_value).toBe(1800); // 10 * 180
    expect(marVal.cash_balance).toBe(500);    // carried from Jan
    expect(marVal.total_value).toBe(2300);    // 1800 + 500
  });

  it("leaves cash at zero when no monthly snapshots exist", () => {
    const sec = seedSecurity(db, "AAPL");
    seedHolding(db, ACCOUNT_ID, sec, 10, "2025-01-31");
    seedPrice(db, sec, "2025-01-31", 150);
    // No snapshot seeded

    computeDailyValuations(db);

    const val = db
      .prepare("SELECT * FROM daily_valuations WHERE account_id = ?")
      .get(ACCOUNT_ID) as any;

    expect(val.cash_balance).toBe(0);
    expect(val.total_value).toBe(1500);
  });

  it("dates before first snapshot have no cash inference", () => {
    const sec = seedSecurity(db, "AAPL");
    // Holdings from Jan 1 so daily valuations exist on Jan 15
    seedHolding(db, ACCOUNT_ID, sec, 10, "2025-01-01");
    seedPrice(db, sec, "2025-01-15", 145);
    seedPrice(db, sec, "2025-01-31", 150);

    // Snapshot only on Jan 31
    seedSnapshot(db, ACCOUNT_ID, "2025-01-31", 2000);

    computeDailyValuations(db);

    const earlyVal = db
      .prepare("SELECT * FROM daily_valuations WHERE account_id = ? AND valuation_date = '2025-01-15'")
      .get(ACCOUNT_ID) as any;
    const snapshotVal = db
      .prepare("SELECT * FROM daily_valuations WHERE account_id = ? AND valuation_date = '2025-01-31'")
      .get(ACCOUNT_ID) as any;

    // Before snapshot: no cash
    expect(earlyVal.cash_balance).toBe(0);
    expect(earlyVal.total_value).toBe(1450);

    // At snapshot: cash inferred
    expect(snapshotVal.cash_balance).toBe(500);
    expect(snapshotVal.total_value).toBe(2000);
  });

  it("handles large cash residual (long-short portfolio)", () => {
    // Simulates IBKR: short positions reduce holdings_value, large cash from proceeds
    const longPos = seedSecurity(db, "SPY");
    const shortPos = seedSecurity(db, "QQQ");

    seedHolding(db, ACCOUNT_ID, longPos, 100, "2025-01-31");
    seedHolding(db, ACCOUNT_ID, shortPos, -50, "2025-01-31"); // short
    seedPrice(db, longPos, "2025-01-31", 500);
    seedPrice(db, shortPos, "2025-01-31", 400);

    // Holdings = 100*500 + (-50*400) = 50000 - 20000 = 30000
    // Account worth $100K → $70K in cash
    seedSnapshot(db, ACCOUNT_ID, "2025-01-31", 100000);

    computeDailyValuations(db);

    const val = db
      .prepare("SELECT * FROM daily_valuations WHERE account_id = ? AND valuation_date = '2025-01-31'")
      .get(ACCOUNT_ID) as any;

    expect(val.holdings_value).toBe(30000);
    expect(val.cash_balance).toBe(70000);
    expect(val.total_value).toBe(100000);
  });

  it("handles different cash levels per account", () => {
    const sec = seedSecurity(db, "AAPL");
    const ROTH = 2;

    seedHolding(db, ACCOUNT_ID, sec, 10, "2025-01-31");
    seedHolding(db, ROTH, sec, 5, "2025-01-31");
    seedPrice(db, sec, "2025-01-31", 150);

    // Taxable: $2000 total, $1500 holdings → $500 cash
    seedSnapshot(db, ACCOUNT_ID, "2025-01-31", 2000);
    // Roth: $750 total, $750 holdings → $0 cash
    seedSnapshot(db, ROTH, "2025-01-31", 750);

    computeDailyValuations(db);

    const taxVal = db
      .prepare("SELECT * FROM daily_valuations WHERE account_id = ? AND valuation_date = '2025-01-31'")
      .get(ACCOUNT_ID) as any;
    const rothVal = db
      .prepare("SELECT * FROM daily_valuations WHERE account_id = ? AND valuation_date = '2025-01-31'")
      .get(ROTH) as any;

    expect(taxVal.cash_balance).toBe(500);
    expect(taxVal.total_value).toBe(2000);
    expect(rothVal.cash_balance).toBe(0);
    expect(rothVal.total_value).toBe(750);
  });

  it("mixed daily and monthly-only securities produce stable valuations", () => {
    // Simulates the real scenario: stocks with daily prices + mutual fund with monthly only
    const stock = seedSecurity(db, "AAPL");
    const fund = seedSecurity(db, "VFIAX", "mutual_fund");

    seedHolding(db, ACCOUNT_ID, stock, 10, "2025-01-31");
    seedHolding(db, ACCOUNT_ID, fund, 100, "2025-01-31");

    // Fund: month-end prices only
    seedPrice(db, fund, "2025-01-31", 400);
    seedPrice(db, fund, "2025-02-28", 410);

    // Stock: daily prices
    seedPrice(db, stock, "2025-01-31", 150);
    seedPrice(db, stock, "2025-02-03", 152);
    seedPrice(db, stock, "2025-02-04", 153);
    seedPrice(db, stock, "2025-02-28", 160);

    computeDailyValuations(db);

    const vals = db
      .prepare(
        "SELECT valuation_date, total_value, priced_count FROM daily_valuations WHERE account_id = ? ORDER BY valuation_date"
      )
      .all(ACCOUNT_ID) as any[];

    // All dates should include both securities (fund carried forward)
    for (const v of vals) {
      expect(v.priced_count).toBe(2);
    }

    // Jan 31: stock 10*150 + fund 100*400 = 41500
    expect(vals[0].total_value).toBe(41500);
    // Feb 3: stock 10*152 + fund 100*400 (carried) = 41520
    expect(vals[1].total_value).toBe(41520);
    // Feb 4: stock 10*153 + fund 100*400 (carried) = 41530
    expect(vals[2].total_value).toBe(41530);
    // Feb 28: stock 10*160 + fund 100*410 = 42600
    expect(vals[3].total_value).toBe(42600);
  });
});
