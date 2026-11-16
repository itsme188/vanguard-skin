/**
 * Owner ruling 21 = A (2026-11-16): no Analysis-tab AI narrative prompt may
 * carry a portfolio dollar amount.
 *
 * Guard: the risk-metrics, position-risk and defense prompts are built
 * (through generateNarrative, with the model mocked) from a synthetic book
 * whose every dollar figure is distinctive. The final prompt string must hold
 * no "$", none of those digit runs, and no 5+ digit number equal to a seeded
 * dollar amount, while the percentage versions the narrative needs are there.
 *
 * Synthetic symbols and figures only.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("@/lib/ai/generate", () => ({
  generateTextForFeature: vi.fn(),
  AIRefusalError: class AIRefusalError extends Error {},
}));
vi.mock("@/lib/ai/models", () => ({
  resolveFeatureModel: vi.fn(() => ({ provider: "anthropic", modelId: "claude-test" })),
}));
vi.mock("@/lib/compute/risk", () => ({
  computeRiskMetrics: vi.fn(),
  computePositionRisk: vi.fn(),
}));
vi.mock("@/lib/compute/hedging", () => ({ computeDefenseAnalysis: vi.fn() }));

import { generateNarrative, computeNarrativeFingerprint } from "@/lib/compute/analysis-narratives";
import { generateTextForFeature } from "@/lib/ai/generate";
import { computeRiskMetrics, computePositionRisk } from "@/lib/compute/risk";
import { computeDefenseAnalysis } from "@/lib/compute/hedging";

// ─── Seeded dollar amounts (each distinctive) ────────────────────────────────
const D = {
  peakValue: 2345678.91,
  troughValue: 1987654.32,
  ddFlows: 54321.98,
  curPeak: 2456789.12,
  curValue: 2109876.54,
  curFlows: -65432.19,
  top1Mv: 1234567.89,
  top2Mv: -876543.21,
  cashMv: 345678.12,
  posMvA: 1234567.89,
  posMvB: 765432.18,
  longExposure: 4567891.23,
  shortExposure: -567891.34,
  protective: 678912.45,
  shortHedgeNotional: 78912.56,
  shortHedgeExposure: 89123.67,
  net: 3999999.89,
  gross: 5135782.57,
  sectorLong: 3456789.01,
  sectorProtected: 456789.12,
  sectorBeyond: 12345.67,
  rankedNet: 891234.56,
  rankedNet2: -312345.78,
  legExposure: -91234.57,
  hedgeProtected: 345612.78,
  hedgeShortProtected: 56789.34,
  theta: -1234.56,
  theta2: 2345.69,
  notCreditedNotional: 234567.81,
  defenseCashMv: 456123.78,
  defenseBorrowedMv: -23456.71,
};
const SEEDED = Object.values(D);

function riskMetrics() {
  return {
    maxDrawdown: {
      percent: 0.1526,
      peakDate: "2026-02-10",
      troughDate: "2026-04-07",
      peakValue: D.peakValue,
      troughValue: D.troughValue,
      netFlowsInWindow: D.ddFlows,
    },
    currentDrawdown: {
      percent: 0.1412,
      peakDate: "2026-09-01",
      peakValue: D.curPeak,
      currentValue: D.curValue,
      netFlowsInWindow: D.curFlows,
    },
    volatility: 0.21,
    sharpeRatio: 1.3,
    riskFreeRate: 0.04,
    herfindahl: 0.11,
    investedHerfindahl: 0.1358,
    top5Concentration: 0.47,
    top5Positions: [
      { symbol: "ZZA", securityName: "Zed A", marketValue: D.top1Mv, weight: 0.24 },
      { symbol: "ZZB", securityName: "Zed B", marketValue: D.top2Mv, weight: 0.17 },
    ],
    positionCount: 12,
    cashWeight: 0.06,
    cashMarketValue: D.cashMv,
    cashHoldingCount: 2,
    dataPoints: 150,
    seamDaysBridged: 1,
    seriesStart: "2026-04-06",
    seriesEnd: "2026-11-13",
  };
}

function positionRisk() {
  return {
    positions: [
      { securityId: 1, symbol: "ZZA", securityName: "Zed A", marketValue: D.posMvA, weight: 0.3,
        annualizedVol: 0.35, riskContribution: 0.4, correlationWithPortfolio: 0.8, dataPoints: 120, cashEquivalent: false },
      { securityId: 2, symbol: "ZZB", securityName: "Zed B", marketValue: D.posMvB, weight: 0.2,
        annualizedVol: 0.5, riskContribution: 0.6, correlationWithPortfolio: 0.7, dataPoints: 120, cashEquivalent: false },
    ],
    correlations: [{ symbolA: "ZZA", symbolB: "ZZB", correlation: 0.55 }],
    portfolioVol: 0.22,
  };
}

function defense() {
  return {
    summary: {
      longExposure: D.longExposure,
      shortExposure: D.shortExposure,
      protectiveNotional: D.protective,
      protectionRatio: D.protective / D.longExposure,
      shortSideHedgeNotional: D.shortHedgeNotional,
      shortSideHedgeExposure: D.shortHedgeExposure,
      shortSideHedgeCount: 1,
      assumedBetaHedgeCount: 1,
      assumedBetaLowFitCount: 0,
      longSideHedgeCount: 1,
      notCreditedCount: 0,
      netExposure: D.net,
      grossExposure: D.gross,
      hedgeCount: 2,
      optionPositionCount: 3,
      shortPositionCount: 2,
    },
    pairs: [],
    proxies: [],
    sectorCoverage: [
      { sector: "Technology", longExposure: D.sectorLong, protected: D.sectorProtected, coveragePct: 0.1321, protectedBeyondExposure: D.sectorBeyond },
    ],
    standaloneBets: [],
    rankedExposures: [
      { underlying: "ZZA", netExposure: D.rankedNet, pctOfBook: 0.1951, tier1CoveragePct: 0.1, sectorProxyCoveragePct: 0.13,
        classification: "hedged_long", hasAmplifiers: false, sector: "Technology", securityId: 1 },
      { underlying: "ZZC", netExposure: D.rankedNet2, pctOfBook: 0.0684, tier1CoveragePct: null, sectorProxyCoveragePct: null,
        classification: "speculative", hasAmplifiers: false, sector: null, securityId: 3,
        legs: [{ securityId: 31, symbol: "ZZC 261218P00050000", optionType: "PUT", quantity: -37, exposure: D.legExposure }] },
    ],
    hedgeScores: [
      { securityId: 21, symbol: "ZZI 261218P00400000", underlying: "ZZI", protects: "book (β=1.0)", protectedNotional: D.hedgeProtected,
        thetaPerDay: D.theta, monthlyBleedPct: 0.012, runwayDays: 90, moneynessPct: -0.08, efficiency: 7.5,
        badges: ["expensive"], side: "long", betaAssumed: true, betaAssumedReason: "no_history" },
      { securityId: 22, symbol: "ZZB 261218C00090000", underlying: "ZZB", protects: "ZZB", protectedNotional: D.hedgeShortProtected,
        thetaPerDay: D.theta2, monthlyBleedPct: -0.02, runwayDays: 30, moneynessPct: 0.05, efficiency: null,
        badges: [], side: "short", betaAssumed: false },
    ],
    diagnostics: [{ kind: "assumed_beta", symbol: "ZZI", detail: "Too little price history to measure a beta for ZZI — assumed β=1.0" }],
    cashLine: {
      weight: 0.0731,
      marketValue: D.defenseCashMv,
      holdingCount: 2,
      borrowed: { marketValue: D.defenseBorrowedMv, holdingCount: 1 },
    },
    notCreditedHedges: [
      { underlying: "ZZG", symbols: ["ZZG 261218P00030000"], protectiveNotional: D.notCreditedNotional,
        reason: "not enough price history to measure its beta" },
    ],
    siblingPricedPositions: 0,
    leveragedFundsUnmodelled: { count: 0, valueShare: 0, symbols: [] },
  };
}

/** Every digit run a seeded amount could appear as: integer part, and the cents-free/cents-included forms. */
function digitRuns(v: number): string[] {
  const abs = Math.abs(v);
  const int = String(Math.trunc(abs));
  return [int, abs.toFixed(2).replace(".", ""), String(Math.round(abs))].filter((r) => r.length >= 5);
}

function numbersIn(s: string): number[] {
  return (s.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
}

async function promptFor(db: Database.Database, surfaceKey: string): Promise<string> {
  let captured = "";
  vi.mocked(generateTextForFeature).mockImplementationOnce(async (_f, args) => {
    captured = String(args.prompt);
    return { text: "The book reads as concentrated, with modest protection on its largest names." } as never;
  });
  await generateNarrative(db, { scope: "all", surfaceKey, weekOf: "2026-11-16", forceRegen: true });
  return captured;
}

function contextOf(prompt: string) {
  return JSON.parse(prompt.slice(prompt.indexOf("Data (JSON):\n") + "Data (JSON):\n".length));
}

function expectNoDollarFigure(prompt: string) {
  expect(prompt).not.toContain("$");
  for (const v of SEEDED) {
    for (const run of digitRuns(v)) expect(prompt, `seeded run ${run}`).not.toContain(run);
  }
  const seededAbs = SEEDED.map((v) => Math.abs(v));
  for (const n of numbersIn(prompt)) {
    if (String(Math.trunc(Math.abs(n))).length >= 5) {
      expect(seededAbs.some((v) => Math.abs(v - Math.abs(n)) < 1), `number ${n}`).toBe(false);
    }
  }
}

describe("Analysis narrative prompts carry no portfolio dollar amount (ruling 21 = A)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    vi.mocked(generateTextForFeature).mockReset();
    vi.mocked(computeRiskMetrics).mockReturnValue(riskMetrics() as never);
    vi.mocked(computePositionRisk).mockReturnValue(positionRisk() as never);
    vi.mocked(computeDefenseAnalysis).mockReturnValue(defense() as never);
  });

  it("risk-metrics: drawdowns as percents, top five and cash as weights, no peak/trough/current value", async () => {
    const prompt = await promptFor(db, "risk-metrics");
    expectNoDollarFigure(prompt);
    const ctx = contextOf(prompt);
    expect(ctx.maxDrawdown).toEqual({
      percent: 0.1526,
      peakDate: "2026-02-10",
      troughDate: "2026-04-07",
      netFlowsInWindowPctOfPeak: Number((D.ddFlows / D.peakValue).toFixed(4)),
    });
    expect(ctx.currentDrawdown.percent).toBe(0.1412);
    expect(ctx.currentDrawdown.netFlowsInWindowPctOfPeak).toBe(Number((D.curFlows / D.curPeak).toFixed(4)));
    expect(ctx.top5Positions).toEqual([
      { symbol: "ZZA", securityName: "Zed A", side: "long", weightOfGrossBook: 0.24 },
      { symbol: "ZZB", securityName: "Zed B", side: "short", weightOfGrossBook: 0.17 },
    ]);
    expect(ctx.cashWeightOfGrossBook).toBe(0.06);
    expect(ctx).not.toHaveProperty("cashMarketValue");
  });

  it("position-risk: each position by weight and risk figures, no market value", async () => {
    const prompt = await promptFor(db, "position-risk");
    expectNoDollarFigure(prompt);
    expect(prompt).not.toContain("marketValue");
    const ctx = contextOf(prompt);
    // Ranked by risk contribution, as the table shows it.
    expect(ctx.positions.map((p: { symbol: string }) => p.symbol)).toEqual(["ZZB", "ZZA"]);
    expect(ctx.positions[1]).toMatchObject({ symbol: "ZZA", weightOfLongBook: 0.3, riskContribution: 0.4, annualizedVol: 0.35 });
    expect(ctx.portfolioVol).toBe(0.22);
  });

  it("defense: exposures and hedge notionals as shares of the long (or short) exposure", async () => {
    const prompt = await promptFor(db, "defense");
    expectNoDollarFigure(prompt);
    for (const field of ["longExposure\":", "protectiveNotional\":", "protectedNotional", "thetaPerDay", "netExposure\":", "grossExposure\":", "quantity"]) {
      expect(prompt, field).not.toContain(field);
    }
    const ctx = contextOf(prompt);
    const share = (p: number, b: number) => Number((p / b).toFixed(4));
    expect(ctx.summary.protectionRatio).toBeCloseTo(D.protective / D.longExposure, 10);
    expect(ctx.summary.shortExposurePctOfLong).toBe(share(D.shortExposure, D.longExposure));
    expect(ctx.summary.netExposurePctOfLong).toBe(share(D.net, D.longExposure));
    expect(ctx.summary.grossExposurePctOfLong).toBe(share(D.gross, D.longExposure));
    expect(ctx.summary.shortSideHedgeRatio).toBe(share(D.shortHedgeNotional, -D.shortExposure));
    expect(ctx.summary.optionPositionCount).toBe(3);
    expect(ctx.sectorCoverage[0]).toEqual({
      sector: "Technology",
      longExposurePctOfLong: share(D.sectorLong, D.longExposure),
      coveragePct: 0.1321,
      protectedBeyondExposurePct: share(D.sectorBeyond, D.sectorLong),
    });
    expect(ctx.topExposures[0]).toMatchObject({ underlying: "ZZA", side: "long", pctOfBook: 0.1951 });
    expect(ctx.topExposures[1]).toMatchObject({ underlying: "ZZC", side: "short", pctOfBook: 0.0684 });
    expect(ctx.topExposures[1].legs).toEqual([
      { symbol: "ZZC 261218P00050000", optionType: "PUT", side: "short", exposurePctOfLong: share(D.legExposure, D.longExposure) },
    ]);
    expect(ctx.hedgeScores[0]).toMatchObject({
      symbol: "ZZI 261218P00400000",
      side: "long",
      protectedPct: share(D.hedgeProtected, D.longExposure),
      monthlyBleedPct: 0.012,
      efficiency: 7.5,
      badges: ["expensive"],
    });
    expect(ctx.hedgeScores[1]).toMatchObject({ side: "short", protectedPct: share(D.hedgeShortProtected, -D.shortExposure) });
    // Ruling 19 = B: hedges held but not credited, and the cash line, as shares only.
    expect(ctx.notCreditedHedges).toEqual([
      {
        underlying: "ZZG",
        reason: "not enough price history to measure its beta",
        protectiveNotionalPctOfLong: share(D.notCreditedNotional, D.longExposure),
      },
    ]);
    expect(ctx.cashLine).toEqual({ weightOfScope: 0.0731, borrowing: true });
    expect(prompt).not.toContain("marketValue");
  });

  it("the defense fingerprint does not move with dollar-only changes (it never held a dollar figure)", () => {
    const before = computeNarrativeFingerprint(db, "all", "defense");
    const moved = defense();
    moved.summary.grossExposure = 1;
    moved.hedgeScores[0].thetaPerDay = -1;
    vi.mocked(computeDefenseAnalysis).mockReturnValue(moved as never);
    expect(computeNarrativeFingerprint(db, "all", "defense")).toBe(before);
  });

  it("the risk fingerprints hash the dollar-free payload: a dollar-only change is not drift", () => {
    const before = computeNarrativeFingerprint(db, "all", "risk-metrics");
    const moved = riskMetrics();
    moved.cashMarketValue = 1;
    moved.maxDrawdown.troughValue = 1;
    vi.mocked(computeRiskMetrics).mockReturnValue(moved as never);
    expect(computeNarrativeFingerprint(db, "all", "risk-metrics")).toBe(before);

    const pBefore = computeNarrativeFingerprint(db, "all", "position-risk");
    const pMoved = positionRisk();
    pMoved.positions[0].marketValue = 1;
    vi.mocked(computePositionRisk).mockReturnValue(pMoved as never);
    expect(computeNarrativeFingerprint(db, "all", "position-risk")).toBe(pBefore);
  });
});
