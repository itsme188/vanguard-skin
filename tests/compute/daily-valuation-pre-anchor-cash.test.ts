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
 * Cash on daily rows that fall BEFORE the first resolvable monthly anchor.
 *
 * Phase 1 writes every row with cash 0; Phase 2 attaches cash by stepping
 * FORWARD from each anchor. An anchor with no priced daily row inside its
 * 5-day lookback (and no broker cash figure) is skipped, so rows that sit
 * between a skipped anchor and the first resolvable one used to keep the
 * placeholder cash of 0 while their holdings were complete — a large fake
 * value step into the anchor day.
 *
 * The engine now BACK-STEPS: the first resolvable anchor's cash residual is
 * carried backward over those rows, reversing the recorded external cash
 * flows it passes. No flow row is ever invented.
 *
 * Repro series from the backlog entry: statement anchor at day N with no
 * daily row at N, priced rows at N+27 / N+30 / N+31. All figures synthetic.
 */

const ACCOUNT_ID = 1;
const DAY_N = "2026-02-28"; // statement anchor, no priced row near it
const DAY_N27 = "2026-03-27";
const DAY_N30 = "2026-03-30";
const DAY_N31 = "2026-03-31"; // first resolvable anchor

interface ValuationRow {
  valuation_date: string;
  cash_balance: number;
  holdings_value: number;
  total_value: number;
}

function seedSecurity(db: Database.Database, symbol: string): number {
  const result = db
    .prepare("INSERT INTO securities (symbol, name, security_type, fund_category) VALUES (?, ?, ?, ?)")
    .run(symbol, symbol + " Inc", "stock", "US Large Cap Equity");
  return result.lastInsertRowid as number;
}

function seedHolding(db: Database.Database, securityId: number, quantity: number, asOfDate: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, NULL, ?, ?)`
  ).run(ACCOUNT_ID, securityId, quantity, asOfDate, `canonical:hold:TEST:${securityId}:${asOfDate}`);
}

function seedPrice(db: Database.Database, securityId: number, date: string, price: number): void {
  db.prepare("INSERT OR REPLACE INTO prices (security_id, date, close_price) VALUES (?, ?, ?)").run(
    securityId,
    date,
    price
  );
}

function seedSnapshot(db: Database.Database, date: string, totalValue: number, source = "statement"): void {
  db.prepare(
    `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source)
     VALUES (?, ?, ?, ?)`
  ).run(ACCOUNT_ID, date, totalValue, source);
}

function seedExternalFlow(db: Database.Database, date: string, amount: number, type = "DEPOSIT"): void {
  db.prepare(
    `INSERT INTO transactions (account_id, trade_date, type, amount, is_external_flow, source_key)
     VALUES (?, ?, ?, ?, 1, ?)`
  ).run(ACCOUNT_ID, date, type, amount, `test-flow:${date}:${type}:${amount}`);
}

function valuations(db: Database.Database): Record<string, ValuationRow> {
  const rows = db
    .prepare(
      `SELECT valuation_date, cash_balance, holdings_value, total_value
         FROM daily_valuations WHERE account_id = ? ORDER BY valuation_date`
    )
    .all(ACCOUNT_ID) as ValuationRow[];
  return Object.fromEntries(rows.map((r) => [r.valuation_date, r]));
}

describe("daily valuation — cash before the first resolvable anchor", () => {
  let db: Database.Database;
  let stock: number;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    // 100 shares held from the day-N statement onward. Prices exist only at
    // the far edge of the month — the prices gap that leaves anchor N with
    // no daily row inside its lookback.
    stock = seedSecurity(db, "TEST");
    seedHolding(db, stock, 100, DAY_N);
    seedPrice(db, stock, DAY_N27, 100);
    seedPrice(db, stock, DAY_N30, 102);
    seedPrice(db, stock, DAY_N31, 105);
  });

  it("carries the first resolvable anchor's cash back over rows in a skipped anchor window", () => {
    seedSnapshot(db, DAY_N, 15_000); // unresolvable: no row within 5 days
    seedSnapshot(db, DAY_N31, 15_500); // holdings 10,500 → cash residual 5,000

    computeDailyValuations(db);
    const vals = valuations(db);

    expect(vals[DAY_N]).toBeUndefined();
    expect(vals[DAY_N31].cash_balance).toBe(5_000);

    // Pre-fix both rows carried cash 0 and the total jumped by the whole
    // cash balance on the anchor day.
    expect(vals[DAY_N27].cash_balance).toBe(5_000);
    expect(vals[DAY_N27].total_value).toBe(15_000);
    expect(vals[DAY_N30].cash_balance).toBe(5_000);
    expect(vals[DAY_N30].total_value).toBe(15_200);

    // The step into the anchor day is the market move alone.
    expect(vals[DAY_N31].total_value - vals[DAY_N30].total_value).toBe(300);
  });

  it("reverses recorded external cash flows while stepping backward", () => {
    seedSnapshot(db, DAY_N, 15_000);
    // A 1,000 deposit lands on N+30 and a 250 withdrawal on the anchor day
    // itself; both are already inside the anchor's total.
    seedExternalFlow(db, DAY_N30, 1_000, "DEPOSIT");
    seedExternalFlow(db, DAY_N31, -250, "WITHDRAWAL");
    seedSnapshot(db, DAY_N31, 16_250); // holdings 10,500 → cash residual 5,750

    computeDailyValuations(db);
    const vals = valuations(db);

    expect(vals[DAY_N31].cash_balance).toBe(5_750);
    // Before the anchor-day withdrawal: 5,750 + 250.
    expect(vals[DAY_N30].cash_balance).toBe(6_000);
    // Before the N+30 deposit (the deposit's own day is post-flow): 6,000 − 1,000.
    expect(vals[DAY_N27].cash_balance).toBe(5_000);

    // Flow-adjusted returns see market moves only — no fake step anywhere.
    const series = Object.values(vals).map((v) => ({ date: v.valuation_date, value: v.total_value }));
    const flows = fetchNetFlowsByDate(db, [ACCOUNT_ID], DAY_N27, DAY_N31);
    const { returns } = buildFlowAdjustedIndex(series, flows);
    expect(returns.map((r) => r.date)).toEqual([DAY_N30, DAY_N31]);
    expect(returns[0].logReturn).toBeCloseTo(Math.log(15_200 / 15_000), 10);
    expect(returns[1].logReturn).toBeCloseTo(Math.log((16_250 + 250) / 16_200), 10);
  });

  it("never steps cash for an in-kind transfer leg", () => {
    seedSnapshot(db, DAY_N, 15_000);
    db.prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, is_external_flow, source_key)
       VALUES (?, ?, ?, 'TRANSFER_IN', 10, 1020, 1, 'test-flow:inkind')`
    ).run(ACCOUNT_ID, stock, DAY_N30);
    seedSnapshot(db, DAY_N31, 15_500);

    computeDailyValuations(db);
    const vals = valuations(db);

    expect(vals[DAY_N27].cash_balance).toBe(5_000);
    expect(vals[DAY_N30].cash_balance).toBe(5_000);
  });

  it("back-steps across a source seam without touching the seam bridge or the ledger", () => {
    // The skipped anchor is a statement; the first resolvable one is a live
    // source. The anchor day stays a seam (bridged, no return observation),
    // and the pre-anchor rows no longer add a second, cash-sized step to it.
    seedSnapshot(db, DAY_N, 15_000, "statement");
    seedSnapshot(db, DAY_N31, 15_500, "tws");
    const flowRowsBefore = db.prepare("SELECT COUNT(*) AS n FROM transactions").get() as { n: number };

    computeDailyValuations(db);
    const vals = valuations(db);

    expect(vals[DAY_N27].cash_balance).toBe(5_000);
    expect(vals[DAY_N30].cash_balance).toBe(5_000);

    const flowRowsAfter = db.prepare("SELECT COUNT(*) AS n FROM transactions").get() as { n: number };
    expect(flowRowsAfter.n).toBe(flowRowsBefore.n);

    const seams = fetchAnchorSourceSeamDates(db, [ACCOUNT_ID], DAY_N27, DAY_N31);
    expect(seams).toEqual([DAY_N31]);
    const series = Object.values(vals).map((v) => ({ date: v.valuation_date, value: v.total_value }));
    const { returns, bridgedDays } = buildFlowAdjustedIndex(series, [], seams);
    expect(bridgedDays).toBe(1);
    expect(returns.map((r) => r.date)).toEqual([DAY_N30]);
  });

  it("reaches behind the account's first anchor (user ruling 2026-10-06)", () => {
    // A row that predates EVERY anchor carries the first resolvable anchor's
    // cash residual back-stepped through recorded flows. No flows here, so
    // the residual (15,000 − 100 × 100) carries unchanged.
    seedPrice(db, stock, "2026-02-10", 98);
    seedHolding(db, stock, 100, "2026-02-01");
    seedSnapshot(db, DAY_N, 15_000);
    seedSnapshot(db, DAY_N31, 15_500);

    computeDailyValuations(db);
    const vals = valuations(db);

    expect(vals["2026-02-10"].cash_balance).toBe(5_000);
    expect(vals["2026-02-10"].total_value).toBe(14_800);
    expect(vals[DAY_N27].cash_balance).toBe(5_000);
    expect(vals[DAY_N30].cash_balance).toBe(5_000);
  });

  it("leaves rows at and after the first resolvable anchor exactly as before", () => {
    seedSnapshot(db, DAY_N, 15_000);
    seedSnapshot(db, DAY_N31, 15_500);
    seedPrice(db, stock, "2026-04-01", 106);
    seedPrice(db, stock, "2026-04-06", 107);
    seedExternalFlow(db, "2026-04-06", 400, "DEPOSIT");

    computeDailyValuations(db);
    const vals = valuations(db);

    expect(vals[DAY_N31].cash_balance).toBe(5_000);
    expect(vals[DAY_N31].total_value).toBe(15_500);
    expect(vals["2026-04-01"].cash_balance).toBe(5_000);
    expect(vals["2026-04-06"].cash_balance).toBe(5_400);
    expect(vals["2026-04-06"].total_value).toBe(16_100);
  });
});
