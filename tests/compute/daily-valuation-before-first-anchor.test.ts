import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeDailyValuations } from "@/lib/compute/daily-valuation";
import {
  buildFlowAdjustedIndex,
  fetchAnchorSourceSeamDates,
  fetchNetFlowsByDate,
} from "@/lib/compute/flow-adjusted";

/**
 * Cash on daily rows dated BEFORE the account's very first monthly anchor
 * (user ruling 2026-10-06).
 *
 * These rows used to keep Phase 1's placeholder cash of 0, so the whole cash
 * balance appeared on the first statement day as a one-day jump. The engine
 * now back-steps the first resolvable anchor's cash residual over them:
 *
 *   cash(day) = residual − Σ net recorded external cash flows in (day, anchor]
 *
 * the exact mirror of the forward stepper. All figures are synthetic.
 */

const ACCOUNT_ID = 1;
const OTHER_ACCOUNT_ID = 2;
const D05 = "2026-01-05";
const D12 = "2026-01-12";
const D20 = "2026-01-20";
const ANCHOR = "2026-01-31"; // the account's first anchor
const D_AFTER = "2026-02-03";

interface ValuationRow {
  valuation_date: string;
  cash_balance: number;
  holdings_value: number;
  total_value: number;
  holdings_count: number;
  priced_count: number;
  data_quality: string;
}

function seedSecurity(
  db: Database.Database,
  symbol: string,
  securityType = "stock",
  fundCategory = "US Large Cap Equity"
): number {
  const result = db
    .prepare("INSERT INTO securities (symbol, name, security_type, fund_category) VALUES (?, ?, ?, ?)")
    .run(symbol, symbol + " Inc", securityType, fundCategory);
  return result.lastInsertRowid as number;
}

function seedHolding(
  db: Database.Database,
  securityId: number,
  quantity: number,
  asOfDate: string,
  accountId = ACCOUNT_ID
): void {
  db.prepare(
    `INSERT OR REPLACE INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, NULL, ?, ?)`
  ).run(accountId, securityId, quantity, asOfDate, `canonical:hold:TEST:${accountId}:${securityId}:${asOfDate}`);
}

function seedPrice(db: Database.Database, securityId: number, date: string, price: number): void {
  db.prepare("INSERT OR REPLACE INTO prices (security_id, date, close_price) VALUES (?, ?, ?)").run(
    securityId,
    date,
    price
  );
}

function seedSnapshot(
  db: Database.Database,
  date: string,
  totalValue: number,
  accountId = ACCOUNT_ID,
  source = "statement"
): void {
  db.prepare(
    `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source)
     VALUES (?, ?, ?, ?)`
  ).run(accountId, date, totalValue, source);
}

function seedExternalFlow(
  db: Database.Database,
  date: string,
  amount: number,
  type = "DEPOSIT",
  accountId = ACCOUNT_ID
): void {
  db.prepare(
    `INSERT INTO transactions (account_id, trade_date, type, amount, is_external_flow, source_key)
     VALUES (?, ?, ?, ?, 1, ?)`
  ).run(accountId, date, type, amount, `test-flow:${accountId}:${date}:${type}:${amount}`);
}

/** A purchase or sale: moves cash at the broker, but is NOT an external flow. */
function seedTrade(db: Database.Database, securityId: number, date: string, type: string, amount: number): void {
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, is_external_flow, source_key)
     VALUES (?, ?, ?, ?, 20, ?, 0, ?)`
  ).run(ACCOUNT_ID, securityId, date, type, amount, `test-trade:${date}:${type}:${amount}`);
}

function valuations(db: Database.Database, accountId = ACCOUNT_ID): Record<string, ValuationRow> {
  const rows = db
    .prepare(
      `SELECT valuation_date, cash_balance, holdings_value, total_value,
              holdings_count, priced_count, data_quality
         FROM daily_valuations WHERE account_id = ? ORDER BY valuation_date`
    )
    .all(accountId) as ValuationRow[];
  return Object.fromEntries(rows.map((r) => [r.valuation_date, r]));
}

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

describe("daily valuation — cash before the account's first anchor", () => {
  let db: Database.Database;
  let stock: number;

  beforeEach(() => {
    db = freshDb();
    // 100 shares held from 01-02. Holdings: 10,000 / 10,000 / 10,200 / 10,500.
    stock = seedSecurity(db, "TEST");
    seedHolding(db, stock, 100, "2026-01-02");
    seedPrice(db, stock, D05, 100);
    seedPrice(db, stock, D12, 100);
    seedPrice(db, stock, D20, 102);
    seedPrice(db, stock, ANCHOR, 105);
  });

  it("carries the first anchor's cash back over every earlier row when no flow was recorded", () => {
    seedSnapshot(db, ANCHOR, 15_500); // holdings 10,500 → residual 5,000

    computeDailyValuations(db);
    const vals = valuations(db);

    expect(vals[D05].cash_balance).toBe(5_000);
    expect(vals[D05].total_value).toBe(15_000);
    expect(vals[D12].cash_balance).toBe(5_000);
    expect(vals[D20].cash_balance).toBe(5_000);
    expect(vals[D20].total_value).toBe(15_200);
    // The step into the first statement day is the market move alone.
    expect(vals[ANCHOR].total_value - vals[D20].total_value).toBe(300);
  });

  it("takes a later deposit out of earlier days and puts a later withdrawal back in", () => {
    seedExternalFlow(db, D12, 1_000, "DEPOSIT");
    seedExternalFlow(db, D20, -250, "WITHDRAWAL");
    seedSnapshot(db, ANCHOR, 15_500); // residual 5,000

    computeDailyValuations(db);
    const vals = valuations(db);

    expect(vals[ANCHOR].cash_balance).toBe(5_000);
    // The withdrawal's own day is post-flow (end-of-day convention).
    expect(vals[D20].cash_balance).toBe(5_000);
    // Before the withdrawal the 250 was still in the account.
    expect(vals[D12].cash_balance).toBe(5_250);
    // Before the deposit the 1,000 was not there yet.
    expect(vals[D05].cash_balance).toBe(4_250);
    expect(vals[D05].total_value).toBe(14_250);

    // Flow-adjusted returns see market moves only.
    const series = Object.values(vals).map((v) => ({ date: v.valuation_date, value: v.total_value }));
    const flows = fetchNetFlowsByDate(db, [ACCOUNT_ID], D05, ANCHOR);
    const { returns } = buildFlowAdjustedIndex(series, flows);
    expect(returns.map((r) => r.date)).toEqual([D12, D20, ANCHOR]);
    expect(returns[0].logReturn).toBeCloseTo(0, 10); // (15,250 − 1,000) / 14,250
    expect(returns[1].logReturn).toBeCloseTo(Math.log((15_200 + 250) / 15_250), 10);
    expect(returns[2].logReturn).toBeCloseTo(Math.log(15_500 / 15_200), 10);
  });

  it("does not step cash for a purchase or sale — backward mirrors the forward convention", () => {
    // A buy before the anchor and a sell after it. Neither is an external
    // flow; in both directions the trade's cash effect stays inside the
    // anchor residual and cash is carried flat across the trade date.
    seedTrade(db, stock, D12, "BUY", -2_000);
    seedPrice(db, stock, D_AFTER, 105);
    seedTrade(db, stock, D_AFTER, "SELL", 2_000);
    seedSnapshot(db, ANCHOR, 15_500);

    computeDailyValuations(db);
    const vals = valuations(db);

    expect(vals[D05].cash_balance).toBe(5_000); // backward, across the buy
    expect(vals[D12].cash_balance).toBe(5_000);
    expect(vals[ANCHOR].cash_balance).toBe(5_000);
    expect(vals[D_AFTER].cash_balance).toBe(5_000); // forward, across the sell
  });

  it("leaves a negative back-stepped balance negative, as the forward stepper does", () => {
    // 8,000 deposited on 01-12 and mostly invested before the statement, so
    // only 5,000 of cash remains at the anchor. Before the deposit:
    // 5,000 − 8,000 = −3,000. Not clamped.
    seedExternalFlow(db, D12, 8_000, "DEPOSIT");
    seedSnapshot(db, ANCHOR, 15_500);
    // Forward mirror: a 6,000 withdrawal after the anchor → 5,000 − 6,000.
    seedPrice(db, stock, D_AFTER, 105);
    seedExternalFlow(db, D_AFTER, -6_000, "WITHDRAWAL");

    computeDailyValuations(db);
    const vals = valuations(db);

    expect(vals[D05].cash_balance).toBe(-3_000);
    expect(vals[D05].total_value).toBe(7_000);
    expect(vals[D12].cash_balance).toBe(5_000);
    expect(vals[D_AFTER].cash_balance).toBe(-1_000);
  });

  it("shows no cash before the funding deposit and the deposit amount after it", () => {
    // A second account that holds only its sweep fund (cash, not a position)
    // and was funded by one 10,000 deposit on 01-12.
    const sweep = seedSecurity(db, "SWEEP", "money_market", "Cash Equivalent");
    seedHolding(db, sweep, 10_000, "2026-01-02", OTHER_ACCOUNT_ID);
    seedExternalFlow(db, D12, 10_000, "DEPOSIT", OTHER_ACCOUNT_ID);
    seedSnapshot(db, ANCHOR, 10_000, OTHER_ACCOUNT_ID);

    computeDailyValuations(db);
    const vals = valuations(db, OTHER_ACCOUNT_ID);

    expect(vals[D05].cash_balance).toBe(0);
    expect(vals[D05].total_value).toBe(0);
    expect(vals[D12].cash_balance).toBe(10_000);
    expect(vals[D20].cash_balance).toBe(10_000);
    expect(vals[ANCHOR].cash_balance).toBe(10_000);
  });

  it("keeps accounts independent — one account's flows never move another's back-step", () => {
    const other = seedSecurity(db, "OTHR");
    seedHolding(db, other, 10, "2026-01-02", OTHER_ACCOUNT_ID);
    for (const d of [D05, D12, D20, ANCHOR]) seedPrice(db, other, d, 200);

    seedExternalFlow(db, D12, 1_000, "DEPOSIT"); // account 1 only
    seedSnapshot(db, ANCHOR, 15_500); // account 1 residual 5,000
    seedSnapshot(db, ANCHOR, 2_700, OTHER_ACCOUNT_ID); // holdings 2,000 → residual 700

    computeDailyValuations(db);

    expect(valuations(db)[D05].cash_balance).toBe(4_000);
    const otherVals = valuations(db, OTHER_ACCOUNT_ID);
    expect(otherVals[D05].cash_balance).toBe(700);
    expect(otherVals[D12].cash_balance).toBe(700);
    expect(otherVals[D20].cash_balance).toBe(700);
  });

  it("creates no source seam and writes nothing to the flow ledger", () => {
    seedExternalFlow(db, D12, 1_000, "DEPOSIT");
    seedSnapshot(db, ANCHOR, 15_500, ACCOUNT_ID, "tws");
    const before = db.prepare("SELECT COUNT(*) AS n FROM transactions").get() as { n: number };

    computeDailyValuations(db);

    const after = db.prepare("SELECT COUNT(*) AS n FROM transactions").get() as { n: number };
    expect(after.n).toBe(before.n);
    // A first anchor has no predecessor to differ from — still not a seam.
    expect(fetchAnchorSourceSeamDates(db, [ACCOUNT_ID], D05, ANCHOR)).toEqual([]);
  });

  it("leaves every row at or after the first anchor identical to a book with no earlier rows", () => {
    // Twin book: same anchor and later history, but its price series starts
    // at the anchor, so it has no pre-anchor rows and the back-step never
    // runs. Rows from the anchor onward must match column for column.
    function seedFromAnchorOnward(target: Database.Database, sec: number): void {
      seedPrice(target, sec, ANCHOR, 105);
      seedPrice(target, sec, D_AFTER, 106);
      seedPrice(target, sec, "2026-02-27", 107);
      seedPrice(target, sec, "2026-03-04", 108);
      seedExternalFlow(target, D_AFTER, 400, "DEPOSIT");
      seedSnapshot(target, ANCHOR, 15_500);
      seedSnapshot(target, "2026-02-27", 16_300);
    }

    seedExternalFlow(db, D12, 1_000, "DEPOSIT"); // pre-anchor flow, back-step only
    seedFromAnchorOnward(db, stock);

    const twin = freshDb();
    const twinStock = seedSecurity(twin, "TEST");
    seedHolding(twin, twinStock, 100, "2026-01-02");
    seedFromAnchorOnward(twin, twinStock);

    computeDailyValuations(db);
    computeDailyValuations(twin);

    const fromAnchor = (rows: Record<string, ValuationRow>) =>
      Object.values(rows).filter((r) => r.valuation_date >= ANCHOR);
    expect(fromAnchor(valuations(db))).toEqual(fromAnchor(valuations(twin)));
    expect(Object.keys(valuations(twin))[0]).toBe(ANCHOR);

    // And the hand-derived figures, so the twin cannot drift with it.
    const vals = valuations(db);
    expect(vals[ANCHOR].cash_balance).toBe(5_000);
    expect(vals[D_AFTER].cash_balance).toBe(5_400);
    expect(vals["2026-02-27"].cash_balance).toBe(5_600); // 16,300 − 10,700
    expect(vals["2026-03-04"].cash_balance).toBe(5_600);
    expect(vals[D05].cash_balance).toBe(4_000);
  });

  it("does not change the row's data_quality label, which describes prices and holdings only", () => {
    seedSnapshot(db, ANCHOR, 15_500);

    computeDailyValuations(db);
    const vals = valuations(db);

    // Holdings snapshot (01-02) is older than each of these days → estimated.
    expect(vals[D05].data_quality).toBe("estimated");
    expect(vals[D20].data_quality).toBe("estimated");
  });
});
