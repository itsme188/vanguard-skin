/**
 * Scope rule for the risk path (adopted 2026-10-08): `undefined` means every
 * account; a DEFINED EMPTY list means NO accounts and must never widen to the
 * whole book. Same rule as `accountIdsFilterSql` (lib/compute/factors.ts),
 * `accountScopeClause` (lib/queries/options.ts), `computeTwr`, `computeXirr`.
 *
 * Two halves:
 *  1. an empty list reads nothing, and each caller's empty-data path holds;
 *  2. `undefined` and a non-empty list answer exactly as they did before the
 *     rule was applied here (a digest captured at the commit before the change).
 *
 * Synthetic tickers and round invented figures only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeRiskMetrics, computePositionRisk, computeConcentration } from "@/lib/compute/risk";
import { fetchNetFlowsByDate, fetchAnchorSourceSeamDates } from "@/lib/compute/flow-adjusted";
import { getConcentrationUniverse } from "@/lib/queries/concentration-universe";
import { getConcentrationMetrics, getFactorHeatmap } from "@/lib/queries/analysis";
import { computeMacroFactorTilts } from "@/lib/compute/factors";

// Migration 002 seeds accounts 1, 2 and 3.
const A = 1;
const B = 3;
const AS_OF = "2025-02-20";
const START = "2025-01-02";

let db: Database.Database;

function day(offset: number): string {
  const d = new Date(Date.UTC(2025, 0, 2 + offset));
  return d.toISOString().slice(0, 10);
}

function seedSecurity(symbol: string): number {
  return db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, asset_class, currency, multiplier)
       VALUES (?, ?, 'stock', 'equity', 'USD', 1)`,
    )
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);

  const zza = seedSecurity("ZZA");
  const zzb = seedSecurity("ZZB");

  const price = db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')",
  );
  const valuation = db.prepare(
    `INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value)
     VALUES (?, ?, 0, ?, ?)`,
  );
  for (let i = 0; i < 50; i++) {
    // Two different, deterministic wiggles.
    const pa = 100 + ((i * 7) % 11) - 5;
    const pb = 50 + ((i * 5) % 7) - 3;
    price.run(zza, day(i), pa);
    price.run(zzb, day(i), pb);
    // A deposit of 1,000 lands in account A on day 10 and of 500 in B on day 12.
    const va = 100 * pa + (i >= 10 ? 1000 : 0);
    const vb = 200 * pb + (i >= 12 ? 500 : 0);
    valuation.run(A, day(i), va, va);
    valuation.run(B, day(i), vb, vb);
  }

  const hold = db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  hold.run(A, zza, 100, 9000, START, "t:a:zza");
  hold.run(B, zzb, 200, 9000, START, "t:b:zzb");

  const flow = db.prepare(
    `INSERT INTO transactions (account_id, trade_date, type, amount, is_external_flow, source_key)
     VALUES (?, ?, 'TRANSFER_IN', ?, 1, ?)`,
  );
  flow.run(A, day(10), 1000, "t:flow:a");
  flow.run(B, day(12), 500, "t:flow:b");

  const anchor = db.prepare(
    `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source)
     VALUES (?, ?, 10000, ?)`,
  );
  // Account A changes its anchor source at the end of January: a seam day.
  anchor.run(A, "2024-12-31", "statement");
  anchor.run(A, "2025-01-31", "plaid");
  anchor.run(B, "2024-12-31", "statement");
  anchor.run(B, "2025-01-31", "statement");

  db.prepare(
    `INSERT INTO security_factors (security_id, ai_exposure, cyclical, factor_source)
     VALUES (?, 'High', 'Low', 'csv_import')`,
  ).run(zza);
  db.prepare(
    `INSERT INTO security_factors (security_id, ai_exposure, cyclical, factor_source)
     VALUES (?, 'Low', 'High', 'csv_import')`,
  ).run(zzb);
});

describe("a defined empty account list is no accounts", () => {
  it("fetchNetFlowsByDate reads no flow", () => {
    expect(fetchNetFlowsByDate(db, undefined, "0000-00-00", "9999-12-31")).toHaveLength(2);
    expect(fetchNetFlowsByDate(db, [], "0000-00-00", "9999-12-31")).toEqual([]);
  });

  it("fetchAnchorSourceSeamDates reads no seam", () => {
    expect(fetchAnchorSourceSeamDates(db, undefined, "0000-00-00", "9999-12-31")).toEqual([
      "2025-01-31",
    ]);
    expect(fetchAnchorSourceSeamDates(db, [], "0000-00-00", "9999-12-31")).toEqual([]);
  });

  it("getConcentrationUniverse reads no position, and both callers take their empty path", () => {
    expect(getConcentrationUniverse(db, undefined, { asOfDate: AS_OF })).toHaveLength(2);
    expect(getConcentrationUniverse(db, [], { asOfDate: AS_OF })).toEqual([]);

    expect(computeConcentration(db, [], AS_OF)).toEqual({
      herfindahl: null,
      top5Concentration: 0,
      top5Positions: [],
      positionCount: 0,
    });
    expect(getConcentrationMetrics(db, [])).toEqual({
      hhi: 0,
      effective_positions: 0,
      top_positions: [],
      warnings: ["No positions with market value found."],
    });
  });

  it("getFactorHeatmap reads no row, and the tilt reader stays empty", () => {
    expect(getFactorHeatmap(db)).toHaveLength(2);
    expect(getFactorHeatmap(db, [])).toEqual([]);
    expect(computeMacroFactorTilts(db, { accountIds: [] })).toEqual(
      computeMacroFactorTilts(db, { accountIds: [2] }),
    );
  });

  it("computeRiskMetrics measures nothing: no series, no drawdown, no positions", () => {
    const whole = computeRiskMetrics(db, { asOfDate: AS_OF, riskFreeRate: 0.04 });
    expect(whole.dataPoints).toBe(50);
    expect(whole.positionCount).toBe(2);

    const none = computeRiskMetrics(db, { accountIds: [], asOfDate: AS_OF, riskFreeRate: 0.04 });
    expect(none.dataPoints).toBe(0);
    expect(none.maxDrawdown).toBeNull();
    expect(none.currentDrawdown).toBeNull();
    expect(none.volatility).toBeNull();
    expect(none.sharpeRatio).toBeNull();
    expect(none.herfindahl).toBeNull();
    expect(none.positionCount).toBe(0);
    expect(none.top5Positions).toEqual([]);
    // Exactly what an account with no data returns (account 2 holds nothing).
    expect(none).toEqual(
      computeRiskMetrics(db, { accountIds: [2], asOfDate: AS_OF, riskFreeRate: 0.04 }),
    );
  });

  it("an empty list never falls through to a lone accountId", () => {
    const none = computeRiskMetrics(db, {
      accountIds: [],
      accountId: A,
      asOfDate: AS_OF,
      riskFreeRate: 0.04,
    });
    expect(none.dataPoints).toBe(0);
    expect(none.positionCount).toBe(0);
  });

  it("computePositionRisk ranks nothing", () => {
    expect(computePositionRisk(db, { asOfDate: AS_OF }).positions).toHaveLength(2);
    expect(computePositionRisk(db, { accountIds: [], asOfDate: AS_OF })).toEqual({
      positions: [],
      correlations: [],
      portfolioVol: null,
    });
  });
});

describe("undefined and a non-empty list answer as before", () => {
  function capture(): string {
    const scopes: Array<number[] | undefined> = [undefined, [A], [B], [A, B], [2]];
    const out = scopes.map((ids) => ({
      ids: ids ?? "all",
      flows: fetchNetFlowsByDate(db, ids, "0000-00-00", "9999-12-31"),
      flowsNoInKind: fetchNetFlowsByDate(db, ids, START, AS_OF, { excludeInKind: true }),
      seams: fetchAnchorSourceSeamDates(db, ids, "0000-00-00", "9999-12-31"),
      universe: getConcentrationUniverse(db, ids, { asOfDate: AS_OF }),
      concentration: computeConcentration(db, ids, AS_OF),
      heatmap: getFactorHeatmap(db, ids),
      risk: computeRiskMetrics(db, { accountIds: ids, asOfDate: AS_OF, riskFreeRate: 0.04 }),
      riskScopeFloor: computeRiskMetrics(db, {
        accountIds: ids,
        asOfDate: AS_OF,
        riskFreeRate: 0.04,
        coverageFloor: "scope",
      }),
      positionRisk: computePositionRisk(db, { accountIds: ids, asOfDate: AS_OF }),
    }));
    return JSON.stringify(out);
  }

  it("every reader returns the figures it returned before the empty-list rule", () => {
    const json = capture();
    // The fixture really exercises the paths: a seam day is bridged and the
    // two deposits are netted out of the whole-book series.
    const parsed = JSON.parse(json) as Array<{
      risk: { seamDaysBridged: number; dataPoints: number };
      flows: unknown[];
    }>;
    expect(parsed[0].risk.dataPoints).toBe(50);
    expect(parsed[0].risk.seamDaysBridged).toBe(1);
    expect(parsed[0].flows).toHaveLength(2);

    // Digest of the full output, captured at the commit before this change.
    expect(createHash("sha256").update(json).digest("hex")).toBe(
      "76af410d8eab6f31e2c1543c5d262203d28398afc19cf474fa91e72aac6ecde4",
    );
  });

  it("a lone accountId is still that one account", () => {
    expect(computeRiskMetrics(db, { accountId: A, asOfDate: AS_OF, riskFreeRate: 0.04 })).toEqual(
      computeRiskMetrics(db, { accountIds: [A], asOfDate: AS_OF, riskFreeRate: 0.04 }),
    );
  });
});
