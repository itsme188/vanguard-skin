/**
 * Scope rule (adopted 2026-10-08, finished here for the last three readers):
 * `undefined` (or `null` where the reader takes it) means every account; a
 * DEFINED EMPTY list means NO accounts and must never widen to the whole book.
 *
 * Readers covered: getDailyValuationsForAccounts (the Performance equity
 * curve's series), computePeriodAttribution, fetchInKindFlowsByDate.
 *
 * Two halves, same pattern as tests/compute/risk-empty-account-scope.test.ts:
 *  1. an empty list reads nothing, and each caller's empty-data path holds;
 *  2. every account, each single account and a two-account list answer
 *     exactly as they did before the rule was applied (a digest captured at
 *     the commit before the change).
 *
 * Synthetic tickers and round invented figures only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getDailyValuationsCombined,
  getDailyValuationsForAccounts,
} from "@/lib/queries/daily-valuations";
import { computePeriodAttribution } from "@/lib/compute/period-attribution";
import {
  fetchAnchorSourceSeamDates,
  fetchInKindFlowsByDate,
  fetchNetFlowsByDate,
} from "@/lib/compute/flow-adjusted";
import { buildEquityCurveData } from "@/lib/compute/equity-curve";
import { getIncomeSummary } from "@/lib/queries/income";
import { getExpiringOptions } from "@/lib/compute/options-expirations";
import { curveFloorDate, firstStatementAnchorForCurve } from "@/lib/compute/equity-curve-floor";

// Migration 002 seeds accounts 1, 2 and 3. Account 2 holds nothing here.
const A = 1;
const B = 3;
const START = "2025-01-02";
const END = "2025-02-20";

let db: Database.Database;

function day(offset: number): string {
  const d = new Date(Date.UTC(2025, 0, 2 + offset));
  return d.toISOString().slice(0, 10);
}

function seedSecurity(symbol: string, sector: string): number {
  return db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, asset_class, currency, multiplier, sector)
       VALUES (?, ?, 'stock', 'equity', 'USD', 1, ?)`,
    )
    .run(symbol, `${symbol} Corp`, sector).lastInsertRowid as number;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);

  const zza = seedSecurity("ZZA", "Technology");
  const zzb = seedSecurity("ZZB", "Energy");

  const price = db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')",
  );
  const bench = db.prepare(
    "INSERT INTO benchmark_prices (symbol, date, close_price, source) VALUES ('SPY', ?, ?, 'test')",
  );
  const valuation = db.prepare(
    `INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < 50; i++) {
    const pa = 100 + ((i * 7) % 11) - 5;
    const pb = 50 + ((i * 5) % 7) - 3;
    price.run(zza, day(i), pa);
    price.run(zzb, day(i), pb);
    bench.run(day(i), 400 + ((i * 3) % 13) - 6);
    // A deposit of 1,000 lands in account A on day 10. An in-kind transfer of
    // 2,000 lands in account B on day 20.
    const va = 100 * pa + (i >= 10 ? 1000 : 0);
    valuation.run(A, day(i), i >= 10 ? 1000 : 0, 100 * pa, va);
    // Account B's daily history starts five days after account A's, so the
    // summed series has a coverage onset for fullCoverageOnly to drop.
    if (i >= 5) {
      const vb = 200 * pb + (i >= 20 ? 2000 : 0);
      valuation.run(B, day(i), 0, vb, vb);
    }
  }

  const hold = db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  hold.run(A, zza, 100, 9000, START, "t:a:zza");
  hold.run(B, zzb, 200, 9000, START, "t:b:zzb");

  db.prepare(
    `INSERT INTO transactions (account_id, trade_date, type, amount, is_external_flow, source_key)
     VALUES (?, ?, 'DEPOSIT', 1000, 1, 't:flow:a')`,
  ).run(A, day(10));
  const inKind = db.prepare(
    `INSERT INTO transactions
       (account_id, security_id, trade_date, type, amount, is_external_flow, source_key)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
  );
  inKind.run(B, zzb, day(20), "TRANSFER_IN", 2000, "t:inkind:b");
  inKind.run(A, zza, day(30), "TRANSFER_OUT", 500, "t:inkind:a");

  const anchor = db.prepare(
    `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source)
     VALUES (?, ?, 10000, ?)`,
  );
  // Account A changes its anchor source at the end of January: a seam day.
  anchor.run(A, "2024-12-31", "canonical");
  anchor.run(A, "2025-01-31", "plaid");
  anchor.run(B, "2024-12-31", "canonical");
  anchor.run(B, "2025-01-31", "canonical");
});

/** The Performance view's equity-curve pipeline, for one scope. */
function curveFor(ids: number[] | undefined) {
  const floor = firstStatementAnchorForCurve(db, ids, START, END);
  const start = curveFloorDate(START, floor);
  const vals = getDailyValuationsForAccounts(db, ids, {
    startDate: start,
    endDate: END,
    fullCoverageOnly: true,
  });
  const benchRows = db
    .prepare(
      `SELECT date, close_price FROM benchmark_prices
       WHERE symbol = 'SPY' AND date BETWEEN ? AND ? ORDER BY date ASC`,
    )
    .all(START, END) as { date: string; close_price: number }[];
  const first = vals[0]?.valuation_date;
  const last = vals[vals.length - 1]?.valuation_date;
  const flows = vals.length >= 2 ? fetchNetFlowsByDate(db, ids, first, last) : [];
  const seams = vals.length >= 2 ? fetchAnchorSourceSeamDates(db, ids, first, last) : [];
  return { vals, curve: buildEquityCurveData(vals, benchRows, flows, seams, floor) };
}

describe("a defined empty account list is no accounts", () => {
  it("getDailyValuationsForAccounts reads no series; undefined is every account", () => {
    expect(getDailyValuationsForAccounts(db, undefined)).toEqual(getDailyValuationsCombined(db));
    expect(getDailyValuationsForAccounts(db, undefined)).toHaveLength(50);
    expect(getDailyValuationsForAccounts(db, [])).toEqual([]);
    expect(
      getDailyValuationsForAccounts(db, [], { startDate: START, endDate: END, fullCoverageOnly: true }),
    ).toEqual([]);
  });

  it("the equity-curve pipeline draws nothing for an empty scope", () => {
    expect(curveFor(undefined).curve.length).toBeGreaterThan(10);
    expect(curveFor([])).toEqual({ vals: [], curve: [] });
  });

  it("computePeriodAttribution attributes nothing: its insufficient-data result", () => {
    const whole = computePeriodAttribution(db, undefined, START, END, "SPY");
    expect(whole.decomposedReturn).not.toBeNull();
    expect(whole.topContributors.length + whole.topDetractors.length).toBeGreaterThan(0);

    const none = computePeriodAttribution(db, [], START, END, "SPY");
    expect(none).toEqual({
      topContributors: [],
      topDetractors: [],
      sectorContribution: [],
      betaVsAlpha: { betaContribution: 0, alphaContribution: 0 },
      betaWindow: null,
      decomposedReturn: null,
    });
    // Exactly what an account with no data returns (account 2 holds nothing).
    expect(none).toEqual(computePeriodAttribution(db, [2], START, END, "SPY"));
  });

  it("fetchInKindFlowsByDate reads no flow; null is every account", () => {
    expect(fetchInKindFlowsByDate(db, null, "0000-00-00", "9999-12-31")).toEqual([
      { date: day(20), net: 2000 },
      { date: day(30), net: -500 },
    ]);
    expect(fetchInKindFlowsByDate(db, [], "0000-00-00", "9999-12-31")).toEqual([]);
  });
});

describe("two more readers that widened an empty list (unreachable today, closed anyway)", () => {
  it("getIncomeSummary reports no income for an empty scope", () => {
    db.prepare(
      `INSERT INTO transactions (account_id, trade_date, type, amount, is_external_flow, source_key)
       VALUES (?, ?, 'DIVIDEND', 40, 0, 't:div:a')`,
    ).run(A, day(15));

    const whole = getIncomeSummary(db, START, END);
    expect(whole.totalDividends).toBe(40);
    expect(getIncomeSummary(db, START, END, [A])).toEqual(whole);

    const none = getIncomeSummary(db, START, END, []);
    expect(none.totalDividends).toBe(0);
    // Exactly what an account with no income returns.
    expect(none).toEqual(getIncomeSummary(db, START, END, [2]));
  });

  it("getExpiringOptions lists no option for an empty scope", () => {
    const opt = db
      .prepare(
        `INSERT INTO securities
           (symbol, name, security_type, asset_class, currency, multiplier,
            underlying_symbol, option_type, strike_price, expiration_date)
         VALUES ('ZZA   250321C00100000', 'ZZA call', 'option', 'equity', 'USD', 100,
                 'ZZA', 'call', 100, '2025-03-21')`,
      )
      .run().lastInsertRowid as number;
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (?, ?, 1, 300, ?, 't:a:opt')`,
    ).run(A, opt, START);

    const whole = getExpiringOptions(db, { today: END });
    expect(whole).toHaveLength(1);
    expect(getExpiringOptions(db, { today: END, accountIds: [A] })).toEqual(whole);
    expect(getExpiringOptions(db, { today: END, accountIds: [B] })).toEqual([]);
    expect(getExpiringOptions(db, { today: END, accountIds: [] })).toEqual([]);
  });
});

describe("every account and a non-empty list answer as before", () => {
  function capture(): string {
    const scopes: Array<number[] | undefined> = [undefined, [A], [B], [A, B], [2]];
    const out = scopes.map((ids) => ({
      ids: ids ?? "all",
      series: getDailyValuationsForAccounts(db, ids),
      seriesWindow: getDailyValuationsForAccounts(db, ids, { startDate: day(3), endDate: day(40) }),
      seriesFullCoverage: getDailyValuationsForAccounts(db, ids, {
        startDate: START,
        endDate: END,
        fullCoverageOnly: true,
      }),
      curve: curveFor(ids),
      attribution: computePeriodAttribution(db, ids, START, END, "SPY"),
      attributionLate: computePeriodAttribution(db, ids, day(7), day(40), "SPY"),
      inKind: fetchInKindFlowsByDate(db, ids ?? null, "0000-00-00", "9999-12-31"),
      inKindWindow: fetchInKindFlowsByDate(db, ids ?? null, day(20), day(30)),
    }));
    return JSON.stringify({
      out,
      combined: getDailyValuationsCombined(db, { fullCoverageOnly: true }),
      attributionLoneId: computePeriodAttribution(db, A, START, END, "SPY"),
    });
  }

  it("every reader returns the figures it returned before the empty-list rule", () => {
    const json = capture();
    // The fixture really exercises the paths: the coverage onset is dropped
    // from the summed series, a regression runs, positions are attributed,
    // a seam day and a deposit are handled by the curve.
    const parsed = JSON.parse(json) as {
      out: Array<{
        series: unknown[];
        seriesFullCoverage: unknown[];
        curve: { curve: unknown[] };
        attribution: { decomposedReturn: { observations: number } | null; topContributors: unknown[]; topDetractors: unknown[] };
        inKind: unknown[];
      }>;
    };
    const all = parsed.out[0];
    expect(all.series).toHaveLength(50);
    expect(all.seriesFullCoverage).toHaveLength(45);
    expect(all.curve.curve.length).toBeGreaterThan(10);
    expect(all.attribution.decomposedReturn?.observations).toBeGreaterThan(5);
    expect(
      all.attribution.topContributors.length + all.attribution.topDetractors.length,
    ).toBeGreaterThan(0);
    expect(all.inKind).toHaveLength(2);
    expect(parsed.out[1].series).toHaveLength(50);
    expect(parsed.out[2].series).toHaveLength(45);
    expect(parsed.out[4].series).toHaveLength(0);

    // Digest of the full output, captured at the commit before this change.
    expect(createHash("sha256").update(json).digest("hex")).toBe(
      "551deda654cfba1e07673bdcbce81ff94e5d87c1a3baa7b54599f46dc5cdcdfb",
    );
  });

  it("a lone account id is still that one account", () => {
    expect(computePeriodAttribution(db, A, START, END, "SPY")).toEqual(
      computePeriodAttribution(db, [A], START, END, "SPY"),
    );
  });
});
