/**
 * Review fixes to the dollar-free narrative prompts (ruling 21 = A follow-up):
 *
 * - Defense: the hedges that earn no credit (ruling 19 = B) and the cash line
 *   reach the prompt as shares, with a sentence saying neither is inside the
 *   protection ratio, and both move the defense fingerprint.
 * - Each prompt says in words what its shares are measured against, and no
 *   field is a bare "weight".
 * - Risk metrics: the invested-only Herfindahl sits beside the whole-book one.
 * - Position risk: cash-equivalent funds are not ranked as risk positions;
 *   one cash figure is passed instead.
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

import {
  generateNarrative,
  computeNarrativeFingerprint,
  buildDefenseFingerprintInputs,
} from "@/lib/compute/analysis-narratives";
import type { DefenseAnalysis } from "@/lib/compute/hedging";
import { generateTextForFeature } from "@/lib/ai/generate";
import { computeRiskMetrics, computePositionRisk } from "@/lib/compute/risk";
import { computeDefenseAnalysis } from "@/lib/compute/hedging";

function riskMetrics() {
  return {
    maxDrawdown: null,
    currentDrawdown: null,
    volatility: 0.2,
    sharpeRatio: 1,
    riskFreeRate: 0.04,
    herfindahl: 0.09,
    investedHerfindahl: 0.16,
    top5Concentration: 0.5,
    top5Positions: [{ symbol: "ZZA", securityName: "Zed A", marketValue: 1000, weight: 0.3 }],
    positionCount: 8,
    cashWeight: 0.25,
    cashMarketValue: 500,
    cashHoldingCount: 1,
    negativeCashHoldingCount: 0,
    dataPoints: 100,
    seamDaysBridged: 0,
    seriesStart: "2026-04-06",
    seriesEnd: "2026-11-13",
  };
}

function pos(id: number, symbol: string, weight: number, rc: number | null, cashEquivalent: boolean) {
  return {
    securityId: id,
    symbol,
    securityName: null,
    marketValue: 1000,
    weight,
    annualizedVol: rc == null ? null : 0.3,
    riskContribution: rc,
    correlationWithPortfolio: rc == null ? null : 0.6,
    dataPoints: 100,
    cashEquivalent,
  };
}

function positionRisk() {
  return {
    positions: [
      pos(1, "ZZM", 0.3, null, true), // a cash-equivalent fund, largest by value
      pos(2, "ZZA", 0.2, 0.5, false),
      pos(3, "ZZB", 0.1, 0.3, false),
      pos(4, "ZZN", 0.05, null, true),
    ],
    correlations: [
      { symbolA: "ZZA", symbolB: "ZZB", correlation: 0.4 },
      { symbolA: "ZZM", symbolB: "ZZA", correlation: 0.01 },
    ],
    portfolioVol: 0.18,
  };
}

function defense(over: { notCredited?: unknown[]; cashLine?: unknown } = {}) {
  return {
    summary: {
      longExposure: 1000,
      shortExposure: 0,
      protectiveNotional: 100,
      protectionRatio: 0.1,
      shortSideHedgeNotional: 0,
      shortSideHedgeExposure: 0,
      shortSideHedgeCount: 0,
      longSideHedgeCount: 1,
      notCreditedCount: 1,
      netExposure: 1000,
      grossExposure: 1000,
      hedgeCount: 1,
      optionPositionCount: 2,
      shortPositionCount: 0,
    },
    cashLine:
      over.cashLine === undefined
        ? { weight: 0.2, marketValue: 300, holdingCount: 1, borrowed: { marketValue: 0, holdingCount: 0 } }
        : over.cashLine,
    pairs: [],
    proxies: [],
    sectorCoverage: [],
    standaloneBets: [],
    rankedExposures: [],
    hedgeScores: [
      { securityId: 21, symbol: "ZZI P", underlying: "ZZI", protects: "book", protectedNotional: 100,
        thetaPerDay: -1, monthlyBleedPct: 0.01, runwayDays: 90, moneynessPct: -0.05, efficiency: 5, badges: [], side: "long" },
    ],
    diagnostics: [],
    notCreditedHedges: over.notCredited ?? [
      { underlying: "ZZG", symbols: ["ZZG P"], protectiveNotional: 150, reason: "bond fund: it does not protect stocks" },
    ],
    siblingPricedPositions: 0,
    leveragedFundsUnmodelled: { count: 0, valueShare: 0, symbols: [] },
  };
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

function split(prompt: string) {
  const marker = "Data (JSON):\n";
  const at = prompt.indexOf(marker);
  return { instruction: prompt.slice(0, at), ctx: JSON.parse(prompt.slice(at + marker.length)) };
}

/** Every key anywhere in a JSON value. */
function keysOf(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      keysOf(x, out);
    }
  }
  return out;
}

describe("narrative prompts: share bases, cash and not-credited hedges", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    vi.mocked(generateTextForFeature).mockReset();
    vi.mocked(computeRiskMetrics).mockReturnValue(riskMetrics() as never);
    vi.mocked(computePositionRisk).mockReturnValue(positionRisk() as never);
    vi.mocked(computeDefenseAnalysis).mockReturnValue(defense() as never);
  });

  it("no prompt carries a bare `weight` or `cashWeight` field", async () => {
    for (const surface of ["risk-metrics", "position-risk", "defense"]) {
      const { ctx } = split(await promptFor(db, surface));
      const keys = keysOf(ctx);
      expect(keys, surface).not.toContain("weight");
      expect(keys, surface).not.toContain("cashWeight");
    }
  });

  it("risk-metrics: both Herfindahls, and the instruction names the gross whole book as the base", async () => {
    const { instruction, ctx } = split(await promptFor(db, "risk-metrics"));
    expect(ctx.herfindahl).toBe(0.09);
    expect(ctx.investedHerfindahl).toBe(0.16);
    expect(ctx.cashWeightOfGrossBook).toBe(0.25);
    expect(ctx.top5Positions[0].weightOfGrossBook).toBe(0.3);
    expect(instruction).toContain("investedHerfindahl");
    expect(instruction).toMatch(/whole gross book/);
  });

  it("position-risk: cash-equivalent funds leave the ranked list; one cash share is passed instead", async () => {
    const { instruction, ctx } = split(await promptFor(db, "position-risk"));
    expect(ctx.positions.map((p: { symbol: string }) => p.symbol)).toEqual(["ZZA", "ZZB"]);
    expect(ctx.cashWeightOfLongBook).toBeCloseTo(0.35, 10);
    // No correlation pair names a cash fund.
    expect(ctx.correlations).toEqual([{ symbolA: "ZZA", symbolB: "ZZB", correlation: 0.4 }]);
    expect(JSON.stringify(ctx)).not.toContain("ZZM");
    expect(instruction).toMatch(/long book/);
    expect(instruction).toContain("cashWeightOfLongBook");
  });

  it("defense: not-credited hedges and the cash line are in the context, and the instruction says they are outside protectionRatio", async () => {
    const { instruction, ctx } = split(await promptFor(db, "defense"));
    expect(ctx.notCreditedHedges).toEqual([
      { underlying: "ZZG", reason: "bond fund: it does not protect stocks", protectiveNotionalPctOfLong: 0.15 },
    ]);
    expect(ctx.cashLine).toEqual({ weightOfScope: 0.2, borrowing: false });
    expect(instruction).toContain("notCreditedHedges");
    expect(instruction).toContain("cashLine");
    expect(instruction).toMatch(/NOT inside protectionRatio/);
    expect(instruction).toMatch(/held but not credited because/);
  });

  it("defense: a missing cash line or not-credited list (older analysis shape) still builds", async () => {
    const legacy = defense();
    delete (legacy as Record<string, unknown>).cashLine;
    delete (legacy as Record<string, unknown>).notCreditedHedges;
    vi.mocked(computeDefenseAnalysis).mockReturnValue(legacy as never);
    const { ctx } = split(await promptFor(db, "defense"));
    expect(ctx.notCreditedHedges).toEqual([]);
    expect(ctx.cashLine).toBeNull();
  });

  describe("defense fingerprint", () => {
    const fp = (a: unknown) => {
      vi.mocked(computeDefenseAnalysis).mockReturnValue(a as never);
      return computeNarrativeFingerprint(db, "all", "defense");
    };

    it("drifts when a not-credited hedge appears, leaves, changes reason or moves half a point", () => {
      const base = fp(defense());
      expect(fp(defense({ notCredited: [] }))).not.toBe(base);
      expect(
        fp(defense({ notCredited: [{ underlying: "ZZG", symbols: [], protectiveNotional: 150, reason: "commodity fund" }] })),
      ).not.toBe(base);
      expect(
        fp(defense({ notCredited: [{ underlying: "ZZG", symbols: [], protectiveNotional: 200, reason: "bond fund: it does not protect stocks" }] })),
      ).not.toBe(base);
      // Price noise under half a point is not drift.
      expect(
        fp(defense({ notCredited: [{ underlying: "ZZG", symbols: [], protectiveNotional: 150.4, reason: "bond fund: it does not protect stocks" }] })),
      ).toBe(base);
    });

    it("drifts when the cash weight moves half a point or borrowing appears, not on dollar-only change", () => {
      const base = fp(defense());
      expect(
        fp(defense({ cashLine: { weight: 0.3, marketValue: 300, holdingCount: 1, borrowed: { marketValue: 0, holdingCount: 0 } } })),
      ).not.toBe(base);
      expect(
        fp(defense({ cashLine: { weight: 0.2, marketValue: 300, holdingCount: 1, borrowed: { marketValue: -10, holdingCount: 1 } } })),
      ).not.toBe(base);
      expect(
        fp(defense({ cashLine: { weight: 0.2001, marketValue: 999, holdingCount: 1, borrowed: { marketValue: 0, holdingCount: 0 } } })),
      ).toBe(base);
    });

    it("buildDefenseFingerprintInputs carries both, as shares", () => {
      const fpIn = buildDefenseFingerprintInputs(defense() as unknown as DefenseAnalysis);
      expect(fpIn.notCreditedHedges).toEqual([
        { underlying: "ZZG", reason: "bond fund: it does not protect stocks", protectiveNotionalPctOfLong: 0.15 },
      ]);
      expect(fpIn.cashLine).toEqual({ weightOfScope: 0.2, borrowing: false });
    });
  });
});
