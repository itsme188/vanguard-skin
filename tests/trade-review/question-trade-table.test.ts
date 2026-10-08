/**
 * QA analysis-trade-reviews--context-question-says-sold-all-of-position-still-held.
 *
 * The "Quick context check" question said the owner "sold all" of a position
 * that was mostly still held, and that the holding period "isn't shown". The
 * question step's trade lines carried only the close date, P&L and quantity;
 * the full review prompt already had the trim/full-exit fact and the FIFO
 * holding period. The question lines now carry the same facts.
 *
 * All figures are synthetic.
 */
import { describe, expect, it, vi } from "vitest";

const generateObjectForFeature = vi.fn(async () => ({ object: { questions: [] } }));
vi.mock("@/lib/ai/generate", () => ({
  generateObjectForFeature: (...args: unknown[]) => generateObjectForFeature(...(args as [])),
}));

import { buildQuestionTradeTable, generateQuestions, getAccountProfile } from "@/lib/trade-review/questions";
import { computeGroupedSummary, computeGroupedTrades, type RoundTrip } from "@/lib/compute/trade-roundtrips";
import type { TradeMarketContext } from "@/lib/trade-review/market-context";

function lot(overrides: Partial<RoundTrip>): RoundTrip {
  return {
    accountId: 1,
    securityId: 1,
    symbol: "AAA",
    securityName: "Test Co",
    entryDate: "2021-06-24",
    entryPrice: 50,
    entryQuantity: 10,
    entryCost: 500,
    exitDate: "2026-08-10",
    exitPrice: 150,
    exitQuantity: 10,
    exitProceeds: 1500,
    holdingDays: 1873,
    realizedPnl: 1000,
    returnPct: 200,
    saleTransactionId: 1,
    sellTransactionQty: 10,
    ...overrides,
  };
}

function ctx(overrides: Partial<TradeMarketContext>): TradeMarketContext {
  return {
    symbol: "AAA",
    exitDate: "2026-08-10",
    stockContext: null,
    benchmarkReturn: null,
    positionPctOfPortfolio: null,
    remainingPosition: null,
    concurrentActivity: null,
    optionOrigin: null,
    ...overrides,
  };
}

describe("buildQuestionTradeTable", () => {
  it("a trim of 10 with 30 still held says TRIM, the kept share, and the holding period", () => {
    const trades = computeGroupedTrades([lot({})]);
    const line = buildQuestionTradeTable(trades, [
      // Sold 10, 30 remain: 30 / (30 + 10) = 75% of the position kept.
      ctx({ remainingPosition: { remainingShares: 30, soldShares: 10, retainedPct: 0.75, isTrim: true } }),
    ]);
    expect(line).toContain("TRIM — closed 10, 30 still held (75% of position kept)");
    expect(line).toContain("FIFO holding period 1873 days");
    expect(line).toContain("long — bought 2021-06-24, sold 2026-08-10");
    expect(line).not.toContain("FULL EXIT");
  });

  it("a close that leaves nothing says FULL EXIT", () => {
    const trades = computeGroupedTrades([lot({})]);
    const line = buildQuestionTradeTable(trades, [
      ctx({ remainingPosition: { remainingShares: 0, soldShares: 10, retainedPct: 0, isTrim: false } }),
    ]);
    expect(line).toContain("FULL EXIT — nothing left");
    expect(line).not.toContain("TRIM");
  });

  it("says the remaining position is not known rather than implying a full exit", () => {
    const trades = computeGroupedTrades([lot({})]);
    const line = buildQuestionTradeTable(trades, [ctx({})]);
    expect(line).toContain("remaining position not known");
    expect(line).not.toMatch(/TRIM|FULL EXIT/);
  });

  it("a short is worded sold-to-open then bought-to-cover, from the lot's own direction", () => {
    // Short 10 at 100, covered at 90: gain = 10 x (100 - 90) = +100.
    const trades = computeGroupedTrades([
      lot({ symbol: "ZZZ", isShort: true, entryDate: "2026-08-12", exitDate: "2026-08-14", entryPrice: 100, exitPrice: 90, entryCost: 900, exitProceeds: 1000, realizedPnl: 100, holdingDays: 2 }),
    ]);
    const line = buildQuestionTradeTable(trades, [ctx({ symbol: "ZZZ" })]);
    expect(line).toContain("short — sold to open 2026-08-12, bought to cover 2026-08-14");
    expect(line).toContain("+$100");
    expect(line).toContain("FIFO holding period 2 days");
  });

  it("a sale across lots shows the entry-date span and the holding-period range", () => {
    const trades = computeGroupedTrades([
      lot({ entryDate: "2026-01-05", holdingDays: 217 }),
      lot({ entryDate: "2026-07-01", holdingDays: 40 }),
    ]);
    const line = buildQuestionTradeTable(trades, [ctx({})]);
    expect(line).toContain("bought 2026-01-05 to 2026-07-01");
    expect(line).toContain("FIFO holding period 40–217 days");
    expect(line).toContain("2 lot(s)");
  });
});

describe("generateQuestions prompt", () => {
  it("sends the enriched lines and tells the model a trim is not a full exit", async () => {
    const trades = computeGroupedTrades([lot({})]);
    await generateQuestions(
      trades,
      computeGroupedSummary(trades),
      [ctx({ remainingPosition: { remainingShares: 30, soldShares: 10, retainedPct: 0.75, isTrim: true } })],
      getAccountProfile("Test Roth IRA")
    );
    expect(generateObjectForFeature).toHaveBeenCalledTimes(1);
    const [feature, args] = generateObjectForFeature.mock.calls[0] as unknown as [string, { prompt: string; maxOutputTokens: number }];
    expect(feature).toBe("tradeReviewQA");
    expect(args.maxOutputTokens).toBeGreaterThan(0);
    expect(args.prompt).toContain("TRIM — closed 10, 30 still held");
    expect(args.prompt).toContain("FIFO holding period 1873 days");
    expect(args.prompt).toMatch(/Never describe it as selling all of the position/);
    expect(args.prompt).toMatch(/holding period and entry date\(s\) are shown/);
  });
});
