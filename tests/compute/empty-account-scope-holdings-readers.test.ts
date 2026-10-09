/**
 * Scope rule (adopted 2026-10-08, finished here for the holdings readers):
 * `undefined` means every account; a DEFINED EMPTY list means NO accounts and
 * must never widen to the whole book.
 *
 * Readers covered: getAllocationByDimension (sector look-through, plain and
 * factor dimensions), getClassificationCoverage, getAnalysisDataCoverage,
 * getFactorCoverage, getAnalysisTrustState, getHoldingsInBucket,
 * computeScenario / computeRecipeScenario, computeExposureDelta,
 * suggestAllocation, getOptionExposureMap, getPortfolioExposureSummary,
 * computeDefenseAnalysis, computeCashFlowResiduals.
 *
 * Two halves, same pattern as tests/compute/risk-empty-account-scope.test.ts:
 *  1. an empty list reads nothing, and each reader answers exactly as it does
 *     for an account that holds nothing;
 *  2. every account, each single account and a two-account list answer
 *     exactly as they did before the rule was applied (a digest captured
 *     before the change).
 *
 * The JS clock is pinned (option Greeks read it). The fixture is built so the
 * answer is the same whichever clock a SQL date cutoff reads: prices are old
 * on both, the bond and the option are live on both.
 *
 * Synthetic tickers and round invented figures only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getAllocationByDimension,
  getAnalysisDataCoverage,
  getClassificationCoverage,
  getFactorCoverage,
} from "@/lib/queries/analysis";
import { getAnalysisTrustState } from "@/lib/queries/analysis-trust-state";
import { getHoldingsInBucket } from "@/lib/queries/drill-down";
import { computeAllScenarios, computeScenario, type ScenarioDefinition } from "@/lib/compute/scenarios";
import { computeExposureDelta } from "@/lib/compute/exposure-delta";
import { suggestAllocation } from "@/lib/compute/cash-deploy";
import { getOptionExposureMap, getPortfolioExposureSummary } from "@/lib/compute/exposure";
import { computeDefenseAnalysis } from "@/lib/compute/hedging";
import { computeCashFlowResiduals } from "@/lib/compute/cash-flow-audit";

// Migration 002 seeds accounts 1, 2 and 3. Account 2 holds nothing here.
const A = 1;
const B = 3;
const EMPTY_ACCOUNT = 2;
const PINNED_NOW = new Date("2090-01-15T17:00:00Z");
const PINNED_TODAY = "2090-01-15";

const CUSTOM: ScenarioDefinition = {
  id: "t-custom-drop",
  name: "Custom drop",
  description: "Synthetic custom scenario",
  category: "custom",
  marketMove: -0.1,
  rateMove: 100,
  sectorMoves: { Technology: -0.2 },
};

let db: Database.Database;

function seedSecurity(cols: Record<string, string | number | null>): number {
  const names = Object.keys(cols);
  return db
    .prepare(
      `INSERT INTO securities (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
    )
    .run(...names.map((n) => cols[n])).lastInsertRowid as number;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: PINNED_NOW });

  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);

  const stock = { security_type: "stock", asset_class: "equity", currency: "USD", multiplier: 1 };
  const zza = seedSecurity({
    ...stock, symbol: "ZZA", name: "ZZA Corp", sector: "Technology",
    geography: "US", market_cap_category: "Large", style: "Growth",
  });
  const zzb = seedSecurity({
    ...stock, symbol: "ZZB", name: "ZZB Corp", sector: "Energy",
    geography: "US", market_cap_category: "Mid", style: "Value",
  });
  // Held in BOTH accounts, and unclassified.
  const zzc = seedSecurity({ ...stock, symbol: "ZZC", name: "ZZC Corp" });
  const zzf = seedSecurity({
    symbol: "ZZF", name: "ZZF Index Fund", security_type: "etf", asset_class: "equity",
    currency: "USD", multiplier: 1, fund_category: "Large Blend",
  });
  const bond = seedSecurity({
    symbol: "ZZT 2099", name: "ZZ Treasury Note", security_type: "bond", asset_class: "fixed_income",
    currency: "USD", multiplier: 1, fund_category: "US Treasury",
    maturity_date: "2099-06-30", duration_years: 4, coupon_rate: 3,
  });
  // A bond with no duration and no price: the trust strip lists it.
  const bondNoDuration = seedSecurity({
    symbol: "ZZU 2099", name: "ZZ Unpriced Note", security_type: "bond", asset_class: "fixed_income",
    currency: "USD", multiplier: 1, maturity_date: "2099-06-30",
  });
  const option = seedSecurity({
    symbol: "ZZA   900620P00090000", name: "ZZA put", security_type: "option", asset_class: "equity",
    currency: "USD", multiplier: 100, underlying_symbol: "ZZA", option_type: "put",
    strike_price: 90, expiration_date: "2090-06-20",
  });
  const sweep = seedSecurity({
    symbol: "ZZMM", name: "ZZ Money Market", security_type: "mutual fund", asset_class: "cash",
    currency: "USD", multiplier: 1, fund_category: "Money Market",
  });
  const watch = seedSecurity({
    ...stock, symbol: "ZZW", name: "ZZW Corp", sector: "Healthcare",
  });

  const price = db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')",
  );
  for (const [id, px] of [
    [zza, 100], [zzb, 50], [zzc, 20], [zzf, 200], [bond, 98], [option, 4], [sweep, 1], [watch, 40],
  ] as Array<[number, number]>) {
    price.run(id, "2020-03-02", px - 1);
    price.run(id, "2020-03-03", px);
  }

  const hold = db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, ?, '2020-03-03', ?)`,
  );
  hold.run(A, zza, 100, 9000, "t:a:zza");
  hold.run(A, zzc, 50, 900, "t:a:zzc");
  hold.run(A, zzf, 10, 1800, "t:a:zzf");
  hold.run(A, option, 2, 700, "t:a:opt");
  hold.run(A, sweep, 3000, 3000, "t:a:sweep");
  hold.run(B, zzb, 200, 9000, "t:b:zzb");
  hold.run(B, zzc, 150, 2800, "t:b:zzc");
  hold.run(B, bond, 5000, 4900, "t:b:bond");
  hold.run(B, bondNoDuration, 1000, 1000, "t:b:bond2");

  const factors = db.prepare(
    `INSERT INTO security_factors
       (security_id, ai_exposure, cyclical, growth_vs_value, interest_rate_sensitive, factor_source,
        updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '2020-03-03 00:00:00')`,
  );
  factors.run(zza, "High", "Low", "Growth", "High", "csv_import");
  factors.run(zzb, "Low", "High", "Value", "Low", "ai");
  factors.run(zzf, "Medium", "Medium", "Blend", "Medium", "csv_import");

  const beta = db.prepare(
    `INSERT INTO security_betas (security_id, lookback_days, beta, computed_at)
     VALUES (?, ?, ?, '2020-03-03 00:00:00')`,
  );
  for (const lookback of [60, 90, 126, 180, 252]) {
    beta.run(zza, lookback, 1.4);
    beta.run(zzb, lookback, 0.8);
  }

  db.prepare(
    `INSERT INTO watchlist (security_id, group_name, thesis, is_active, added_date)
     VALUES (?, 'default', 'Synthetic thesis', 1, '2020-03-01')`,
  ).run(watch);

  const anchor = db.prepare(
    `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, cash_value, source)
     VALUES (?, ?, ?, ?, ?)`,
  );
  // Account A's latest snapshot states a cash balance; account B's does not.
  anchor.run(A, "2020-01-31", 16000, null, "canonical");
  anchor.run(A, "2020-02-29", 17000, 3000, "plaid");
  anchor.run(B, "2020-01-31", 19000, null, "canonical");
  anchor.run(B, "2020-02-29", 20000, null, "canonical");

  const valuation = db.prepare(
    `INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value)
     VALUES (?, ?, ?, ?, ?)`,
  );
  // Cash in A steps up by 1,000 on the 4th with a matching deposit, and by
  // 700 on the 6th with nothing behind it. Cash in B steps by 400, unexplained.
  const cashA = [3000, 3000, 4000, 4000, 4700, 4700];
  const cashB = [500, 500, 500, 900, 900, 900];
  for (let i = 0; i < 6; i++) {
    const d = `2020-03-0${i + 2}`;
    valuation.run(A, d, cashA[i], 13000, 13000 + cashA[i]);
    valuation.run(B, d, cashB[i], 18000, 18000 + cashB[i]);
  }
  db.prepare(
    `INSERT INTO transactions (account_id, trade_date, type, amount, is_external_flow, source_key)
     VALUES (?, '2020-03-04', 'DEPOSIT', 1000, 1, 't:flow:a')`,
  ).run(A);
});

afterEach(() => {
  vi.useRealTimers();
});

type Scope = number[] | undefined;

/** Every reader in this file, for one scope. */
function readAll(ids: Scope) {
  return {
    allocSector: getAllocationByDimension(db, "sector", ids),
    allocAssetClass: getAllocationByDimension(db, "asset_class", ids),
    allocGeography: getAllocationByDimension(db, "geography", ids),
    allocAccount: getAllocationByDimension(db, "account", ids),
    allocFactor: getAllocationByDimension(db, "ai_exposure", ids),
    classification: getClassificationCoverage(db, ids),
    dataCoverage: getAnalysisDataCoverage(db, ids),
    factorCoverage: getFactorCoverage(db, ids),
    trust: getAnalysisTrustState(db, ids),
    drillSector: getHoldingsInBucket(db, "all", { kind: "classification", dimension: "sector", bucket: "Technology" }, ids),
    drillGeography: getHoldingsInBucket(db, "all", { kind: "classification", dimension: "geography", bucket: "US" }, ids),
    drillFactor: getHoldingsInBucket(db, "all", { kind: "factor", factor: "ai_exposure", bucket: "High" }, ids),
    drillTilt: getHoldingsInBucket(db, "all", { kind: "sector", sector: "Energy" }, ids),
    drillRisk: getHoldingsInBucket(db, "all", { kind: "risk", topN: 5 }, ids),
    customScenario: computeScenario(db, CUSTOM, { accountIds: ids }),
    presetScenarios: computeAllScenarios(db, { accountIds: ids }),
    exposureDelta: computeExposureDelta(db, "all", ids, [
      { symbol: "ZZW", action: "buy", dollarAmount: 2000 },
      { symbol: "ZZA", action: "sell", dollarAmount: 1000 },
    ]),
    cashDeploy: suggestAllocation(db, "all", ids, 5000),
    optionExposure: [...getOptionExposureMap(db, ids).entries()],
    exposureSummary: getPortfolioExposureSummary(db, ids, PINNED_TODAY),
    defense: computeDefenseAnalysis(db, ids),
    cashResiduals: computeCashFlowResiduals(db, { accountIds: ids }),
  };
}

describe("a defined empty account list is no accounts", () => {
  it("the fixture is read by every reader for the whole book", () => {
    const all = readAll(undefined);
    expect(all.allocSector.length).toBeGreaterThan(2);
    expect(all.allocAssetClass.length).toBeGreaterThan(1);
    expect(all.allocAccount).toHaveLength(2);
    expect(all.classification.total).toBe(8);
    expect(all.dataCoverage.snapshotTotal).toBeGreaterThan(0);
    expect(all.dataCoverage.holdingsTotal).toBeGreaterThan(0);
    expect(all.factorCoverage.totalHoldings).toBe(8);
    expect(all.trust.factorCoverage.totalNames).toBe(8);
    expect(all.trust.perAccountReconciliation).toHaveLength(3);
    expect(all.trust.bondDuration.totalBonds).toBe(2);
    expect(all.drillSector.length).toBeGreaterThan(0);
    expect(all.drillRisk.length).toBeGreaterThan(0);
    expect(all.customScenario.positionImpacts.length).toBeGreaterThan(3);
    expect(all.presetScenarios.length).toBeGreaterThan(1);
    expect(all.presetScenarios[0].positionImpacts.length).toBeGreaterThan(3);
    expect(all.exposureDelta.before.totalValue).toBeGreaterThan(0);
    expect(all.optionExposure).toHaveLength(1);
    expect(all.exposureSummary.total_market_value).toBeGreaterThan(0);
    expect(all.exposureSummary.net_exposure).not.toBe(all.exposureSummary.total_market_value);
    expect(all.cashResiduals.length).toBeGreaterThan(0);
  });

  it("every reader answers an empty list exactly as it answers an account that holds nothing", () => {
    const none = readAll([]);
    const emptyAccount = readAll([EMPTY_ACCOUNT]);

    // The trust strip lists one reconciliation row per account IN SCOPE: the
    // empty account is a row with nothing to reconcile; no accounts is no row.
    expect(emptyAccount.trust.perAccountReconciliation).toHaveLength(1);
    expect(none.trust.perAccountReconciliation).toEqual([]);
    expect(none.trust.crossCheckedThru).toBeNull();
    expect({ ...none.trust, perAccountReconciliation: [] }).toEqual({
      ...emptyAccount.trust,
      perAccountReconciliation: [],
    });

    expect({ ...none, trust: null }).toEqual({ ...emptyAccount, trust: null });
  });

  it("each reader's empty-data path, spelled out", () => {
    for (const dimension of ["sector", "asset_class", "geography", "account", "ai_exposure"] as const) {
      expect(getAllocationByDimension(db, dimension, [])).toEqual([]);
    }
    expect(getClassificationCoverage(db, []).total).toBe(0);
    expect(getClassificationCoverage(db, []).classified).toBe(0);
    expect(getAnalysisDataCoverage(db, [])).toEqual({
      holdingsTotal: 0,
      snapshotTotal: 0,
      coveragePct: 100,
      missingAccounts: [],
      holdingsDate: null,
      cashExcluded: false,
      unknownCashAccounts: [],
    });
    expect(getFactorCoverage(db, [])).toEqual({
      totalHoldings: 0,
      withFactors: 0,
      coveragePct: 0,
      bySource: [],
    });

    const trust = getAnalysisTrustState(db, []);
    expect(trust.factorCoverage).toEqual({ totalNames: 0, classified: 0, percentage: 0, missingSymbols: [] });
    expect(trust.stalePrices).toEqual({ count: 0, symbols: [] });
    expect(trust.neverPriced).toEqual({ count: 0, symbols: [] });
    expect(trust.bondDuration.totalBonds).toBe(0);
    expect(trust.bondDuration.missing).toEqual([]);

    expect(getHoldingsInBucket(db, "all", { kind: "classification", dimension: "sector", bucket: "Technology" }, [])).toEqual([]);
    expect(getHoldingsInBucket(db, "all", { kind: "factor", factor: "ai_exposure", bucket: "High" }, [])).toEqual([]);
    expect(getHoldingsInBucket(db, "all", { kind: "sector", sector: "Energy" }, [])).toEqual([]);
    expect(getHoldingsInBucket(db, "all", { kind: "risk", topN: 5 }, [])).toEqual([]);

    const custom = computeScenario(db, CUSTOM, { accountIds: [] });
    expect(custom.positionImpacts).toEqual([]);
    expect(custom.currentPortfolioValue).toBe(0);
    for (const preset of computeAllScenarios(db, { accountIds: [] })) {
      expect(preset.positionImpacts).toEqual([]);
      expect(preset.currentPortfolioValue).toBe(0);
    }
    // An empty list wins over a lone account id, as in normalizeAccountIds.
    expect(computeScenario(db, CUSTOM, { accountIds: [], accountId: A }).positionImpacts).toEqual([]);

    expect(computeExposureDelta(db, "all", [], []).before.totalValue).toBe(0);
    expect(getOptionExposureMap(db, []).size).toBe(0);
    expect(getPortfolioExposureSummary(db, [], PINNED_TODAY)).toEqual({
      total_market_value: 0,
      net_exposure: 0,
      gross_exposure: 0,
      net_ratio: null,
      gross_ratio: null,
    });
    expect(computeCashFlowResiduals(db, { accountIds: [] })).toEqual([]);
  });
});

describe("every account and a non-empty list answer as before", () => {
  it("every reader returns the figures it returned before the empty-list rule", () => {
    const scopes: Scope[] = [undefined, [A], [B], [A, B], [EMPTY_ACCOUNT]];
    const json = JSON.stringify(scopes.map((ids) => ({ ids: ids ?? "all", out: readAll(ids) })));

    // Digest of the full output, captured before this change.
    expect(createHash("sha256").update(json).digest("hex")).toBe(
      "1e4e771abac6b643937f6538d4b348507dcf3720c1198d3d62c506fa87051b18",
    );
  });

  it("the whole book and both holding accounts together are the same book", () => {
    const whole = readAll(undefined);
    const both = readAll([A, B]);
    // Only the per-account reconciliation list differs: account 2 is a row of
    // the whole book and is not in the two-account scope.
    expect({ ...both, trust: { ...both.trust, perAccountReconciliation: [], crossCheckedThru: null } }).toEqual({
      ...whole,
      trust: { ...whole.trust, perAccountReconciliation: [], crossCheckedThru: null },
    });
  });
});
