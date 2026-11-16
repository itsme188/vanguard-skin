/**
 * Volatility and Sharpe are measured over trading days only (2026-11-15).
 *
 * daily_valuations carries rows on some weekends and holidays (a live sync
 * or a month-end statement can land on one). Each such row adds a near-zero
 * "return" to a series that is annualised with sqrt(252) and mean x 252, so
 * volatility read too low. computeRiskMetrics folds a closed day's return
 * into the next trading session's return (foldReturnsIntoSessions); the
 * index, the flow adjustment and the seam bridging still run on every row,
 * so a flow dated on a weekend is still stripped and drawdowns are unchanged.
 *
 * Migrated schema; synthetic values; fixed dates.
 */
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import { computeRiskMetrics, foldReturnsIntoSessions } from "@/lib/compute/risk";
import { isMarketClosed } from "@/lib/calendar/market-holidays";
import { addDays } from "@/lib/calendar/date-utils";

const ACCOUNT = 1; // seeded by the migrations

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function insertValuation(db: Database.Database, date: string, value: number): void {
  db.prepare(
    `INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value)
     VALUES (?, ?, 0, ?, ?)`
  ).run(ACCOUNT, date, value, value);
}

function insertFlow(db: Database.Database, date: string, amount: number): void {
  db.prepare(
    `INSERT INTO transactions (account_id, trade_date, type, amount, is_external_flow, source_key)
     VALUES (?, ?, 'DEPOSIT', ?, 1, ?)`
  ).run(ACCOUNT, date, amount, `t:${date}`);
}

/** Calendar days 2026-03-02 .. +120, with a value per TRADING day. */
function tradingSeries(): { date: string; value: number }[] {
  const out: { date: string; value: number }[] = [];
  let v = 100_000;
  let i = 0;
  for (let d = "2026-03-02"; d <= "2026-06-30"; d = addDays(d, 1)) {
    if (isMarketClosed(d)) continue;
    v *= 1 + Math.sin(i * 1.3) * 0.01;
    out.push({ date: d, value: v });
    i++;
  }
  return out;
}

const OPTS = { startDate: "2026-03-01", endDate: "2026-06-30", accountIds: [ACCOUNT], riskFreeRate: 0.04 };

describe("computeRiskMetrics — trading days only", () => {
  it("weekend and holiday rows carrying the prior close do not change volatility or Sharpe", () => {
    const trading = tradingSeries();
    expect(trading.some((p) => p.date === "2026-04-03")).toBe(false); // Good Friday 2026

    const clean = makeDb();
    for (const p of trading) insertValuation(clean, p.date, p.value);

    const padded = makeDb();
    let last = trading[0].value;
    const byDate = new Map(trading.map((p) => [p.date, p.value]));
    for (let d = "2026-03-02"; d <= "2026-06-30"; d = addDays(d, 1)) {
      const v = byDate.get(d);
      if (v !== undefined) last = v;
      insertValuation(padded, d, last); // closed days carry the last close
    }

    const a = computeRiskMetrics(clean, OPTS);
    const b = computeRiskMetrics(padded, OPTS);
    expect(a.volatility).not.toBeNull();
    expect(b.volatility).toBeCloseTo(a.volatility!, 12);
    expect(b.sharpeRatio).toBeCloseTo(a.sharpeRatio!, 12);
    expect(b.maxDrawdown?.percent).toBeCloseTo(a.maxDrawdown!.percent, 12);
    expect(b.seriesEnd).toBe(a.seriesEnd);
  });

  it("a flow dated on a weekend day is still stripped from the return series", () => {
    const trading = tradingSeries();
    // Deposit dated Saturday 2026-04-11 and visible in that day's row: 20% of
    // Friday's value, and every later value scales by 1.2, so the
    // flow-adjusted returns equal the flow-free reference exactly.
    const friday = trading.find((p) => p.date === "2026-04-10")!.value;
    const deposit = friday * 0.2;
    const withWeekendFlow = makeDb();
    for (const p of trading) {
      insertValuation(withWeekendFlow, p.date, p.date >= "2026-04-13" ? p.value * 1.2 : p.value);
    }
    insertValuation(withWeekendFlow, "2026-04-11", friday * 1.2);
    insertFlow(withWeekendFlow, "2026-04-11", deposit);

    const reference = makeDb();
    for (const p of trading) insertValuation(reference, p.date, p.value);

    const a = computeRiskMetrics(withWeekendFlow, OPTS);
    const b = computeRiskMetrics(reference, OPTS);
    // Flow stripped: the deposit is not a +20% "day", so vol matches the
    // flow-free reference exactly.
    expect(a.volatility).toBeCloseTo(b.volatility!, 12);
    expect(a.maxDrawdown?.percent).toBeCloseTo(b.maxDrawdown!.percent, 12);
  });
});

describe("foldReturnsIntoSessions", () => {
  it("adds a closed day's return into the next session and keeps other sessions one each", () => {
    const folded = foldReturnsIntoSessions([
      { date: "2026-04-09", logReturn: 0.01 }, // Thu
      { date: "2026-04-10", logReturn: 0.02 }, // Fri
      { date: "2026-04-11", logReturn: 0.005 }, // Sat -> Mon
      { date: "2026-04-13", logReturn: -0.01 }, // Mon
    ]);
    expect(folded).toHaveLength(3);
    expect(folded[2]).toBeCloseTo(-0.005, 15);
  });

  it("a closed-day move stands alone when the next session's own step was bridged", () => {
    // Good Friday 2026-04-03 and the weekend roll to Monday 04-06, whose own
    // step is absent (bridged): the closed-day moves form that session.
    const folded = foldReturnsIntoSessions([
      { date: "2026-04-02", logReturn: 0.01 },
      { date: "2026-04-03", logReturn: 0.002 },
      { date: "2026-04-04", logReturn: 0.003 },
      { date: "2026-04-07", logReturn: 0.004 },
    ]);
    expect(folded).toHaveLength(3);
    expect(folded[1]).toBeCloseTo(0.005, 15);
  });
});
