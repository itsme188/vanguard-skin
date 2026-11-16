/**
 * Trade-review generation pipeline (Analysis tab fix wave 2026-11-15, unit H2).
 *
 *  H2a  phase 2 does not ask the AI for questions again, and an answer binds
 *       to its trade by the closing transaction id, never by row number; an
 *       answer whose trade left the set is refused, not moved.
 *  H2b  the "other model" attempt is skipped when both trade-review feature
 *       keys resolve to the same model id; the user-facing text names no
 *       model family.
 *  H2c  a reply cut off at the output cap is retried once at the ceiling,
 *       then surfaces a plain-language domain error (never a blind retry).
 *  H2e  `currentReviewCoverage` counts what a review leaves out, through the
 *       generator's own selection path.
 *  H2g  the review row and its round trips are saved in one transaction, and
 *       the model's arrays are checked before use.
 *
 * No AI call is made: `generateObjectForFeature` and `resolveFeatureModel`
 * are mocked. All figures and symbols are synthetic.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NoObjectGeneratedError } from "ai";
import { runMigrations } from "@/lib/db/migrate";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { ibkrTradeDirectionNote } from "@/lib/import/ibkr-trade-direction";

const modelIds: Record<string, string> = {
  tradeReviewMain: "claude-sonnet-5-5",
  tradeReviewMainLarge: "claude-sonnet-5-5",
  tradeReviewQA: "claude-sonnet-5-5",
};

vi.mock("@/lib/ai/models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/models")>();
  return {
    ...actual,
    resolveFeatureModel: vi.fn((key: string) => ({
      modelId: modelIds[key] ?? "claude-sonnet-5-5",
      provider: "anthropic",
    })),
  };
});
vi.mock("@/lib/ai/generate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/generate")>();
  return { ...actual, generateObjectForFeature: vi.fn() };
});
vi.mock("@/lib/trade-review/market-context", () => ({
  getMarketContext: vi.fn(() => []),
  formatMarketContext: vi.fn(() => ""),
  countCachedPricePoints: vi.fn(() => 0),
}));
vi.mock("@/lib/tws/client", () => ({ getIbApi: vi.fn(() => null) }));
vi.mock("@/lib/vital-knowledge", () => ({ fetchVitalKnowledge: vi.fn(async () => null) }));

const saveRoundtripsFails = { value: false };
vi.mock("@/lib/mutations/trade-reviews", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mutations/trade-reviews")>();
  return {
    ...actual,
    saveTradeRoundtrips: vi.fn((...args: Parameters<typeof actual.saveTradeRoundtrips>) => {
      if (saveRoundtripsFails.value) throw new Error("synthetic write failure");
      return actual.saveTradeRoundtrips(...args);
    }),
  };
});

import { AITruncatedError, generateObjectForFeature } from "@/lib/ai/generate";
import { bindAnswersToTrades, buildTradeReviewPrompt } from "@/lib/trade-review/prompt";
import {
  currentReviewCoverage,
  generateTradeReview,
  prepareTradeReview,
  REVIEW_OUTPUT_TOKEN_CEILING,
  TradeReviewTooLargeError,
} from "@/lib/trade-review/generate";
import { getAvailableReviewPeriods } from "@/lib/compute/trade-roundtrips";

const gen = vi.mocked(generateObjectForFeature);
const ACCOUNT = 3;
const PERIOD = { accountId: ACCOUNT, periodStart: "2026-08-01", periodEnd: "2026-08-31" };

const debugDir = fs.mkdtempSync(path.join(os.tmpdir(), "trade-review-h2-"));
const priorDbDir = process.env.VANGUARD_DB_DIR;
process.env.VANGUARD_DB_DIR = debugDir;
afterAll(() => {
  if (priorDbDir === undefined) delete process.env.VANGUARD_DB_DIR;
  else process.env.VANGUARD_DB_DIR = priorDbDir;
  fs.rmSync(debugDir, { recursive: true, force: true });
});

let db: Database.Database;

function trade(securityId: number, type: string, date: string, qty: number, price: number, code: string) {
  return db
    .prepare(
      "INSERT INTO transactions(account_id,security_id,type,trade_date,quantity,price_per_share,amount,fees,notes) VALUES(?,?,?,?,?,?,?,0,?)"
    )
    .run(ACCOUNT, securityId, type, date, qty, price, (type === "BUY" ? -1 : 1) * qty * price, ibkrTradeDirectionNote(code, `${date}, 12:00:00`))
    .lastInsertRowid as number;
}

const GOOD_REVIEW = {
  review_markdown: "# Review\n" + "Synthetic analysis. ".repeat(20),
  trade_grades: [],
  patterns_identified: ["p1"],
  strengths: ["s1"],
  weaknesses: ["w1"],
};
const EMPTY_REVIEW = { ...GOOD_REVIEW, review_markdown: "" };

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare(
    "INSERT INTO securities(id,symbol,name,security_type) VALUES(1,'ZZA','A Co','Stock'),(2,'ZZB','B Co','Stock')"
  ).run();
  // Two long round trips: ZZA +100, ZZB -50.
  trade(1, "BUY", "2026-08-03", 10, 50, "O");
  trade(1, "SELL", "2026-08-10", 10, 60, "C");
  trade(2, "BUY", "2026-08-04", 10, 50, "O");
  trade(2, "SELL", "2026-08-12", 10, 45, "C");
  computeTaxLots(db);
  gen.mockReset();
  saveRoundtripsFails.value = false;
  modelIds.tradeReviewMain = "claude-sonnet-5-5";
  modelIds.tradeReviewMainLarge = "claude-sonnet-5-5";
});
afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

async function failureOf(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected the review to fail");
}

async function prepared() {
  return prepareTradeReview(db, PERIOD, { skipQuestions: true });
}

describe("H2a: phase 2 asks no questions and binds answers by trade key", () => {
  it("skipQuestions prepares the data without the question AI call", async () => {
    const data = await prepareTradeReview(db, PERIOD, { skipQuestions: true });
    expect(data.groupedTrades).toHaveLength(2);
    expect(data.questions).toEqual([]);
    // generateQuestions is the only AI call in phase 1; none was made.
    expect(gen).not.toHaveBeenCalled();
  });

  it("phase 1 still asks, and each question carries its trade's closing transaction id", async () => {
    gen.mockResolvedValueOnce({
      object: {
        questions: [
          { trade_number: 2, symbol: "WRONG", question: "Why this exit?" },
          { trade_number: 9, symbol: "ZZQ", question: "Names no trade" },
        ],
      },
    } as never);
    const data = await prepareTradeReview(db, PERIOD);
    expect(gen).toHaveBeenCalledTimes(1);
    expect(data.questions).toHaveLength(1);
    const [q] = data.questions;
    const second = data.groupedTrades[1];
    expect(q).toMatchObject({ tradeNumber: 2, symbol: second.symbol, saleTransactionId: second.saleTransactionId });
  });

  it("an answer keyed to a trade binds to that trade even after the order changed", async () => {
    const data = await prepared();
    const [first, second] = data.groupedTrades;
    // Phase 1 called the second trade "#1"; phase 2's order put it at #2.
    const answers = [{ tradeNumber: 1, answer: "planned exit", saleTransactionId: second.saleTransactionId }];
    const { bound, refused } = bindAnswersToTrades([first, second], answers);
    expect(refused).toEqual([]);
    expect(bound).toEqual([{ tradeNumber: 2, symbol: second.symbol, answer: "planned exit" }]);
  });

  it("an answer whose trade is no longer in the set is refused, never moved onto another trade", async () => {
    const data = await prepared();
    const answers = [{ tradeNumber: 1, answer: "gone", saleTransactionId: 999999 }];
    const { bound, refused } = bindAnswersToTrades(data.groupedTrades, answers);
    expect(bound).toEqual([]);
    expect(refused).toEqual(answers);
    const { user } = buildTradeReviewPrompt(
      data.groupedTrades,
      data.summary,
      [],
      "August 2026",
      { style: "unknown", description: "x" },
      undefined,
      answers
    );
    expect(user).not.toContain("gone");
    expect(user).not.toContain("Trader's Notes");
  });

  it("an older client's answer with no key still binds by row number", async () => {
    const data = await prepared();
    const { bound } = bindAnswersToTrades(data.groupedTrades, [{ tradeNumber: 1, answer: "legacy" }]);
    expect(bound).toEqual([{ tradeNumber: 1, symbol: data.groupedTrades[0].symbol, answer: "legacy" }]);
  });

  it("a refused answer is reported in a progress note and left out of the prompt", async () => {
    gen.mockResolvedValue({ object: GOOD_REVIEW, usage: {} } as never);
    const messages: string[] = [];
    await generateTradeReview(db, PERIOD, await prepared(), [
      { tradeNumber: 1, answer: "orphan note", saleTransactionId: 999999 },
    ], { onProgress: (m) => messages.push(m) });
    expect(messages.some((m) => /answer\(s\) left out/.test(m))).toBe(true);
    const sent = gen.mock.calls[0][1] as { prompt: string };
    expect(sent.prompt).not.toContain("orphan note");
  });
});

describe("H2b: the other-model attempt runs only for a different model", () => {
  it("both keys on one model: two attempts, then a plain error naming no model family", async () => {
    gen.mockResolvedValue({ object: EMPTY_REVIEW, usage: {} } as never);
    const err = await failureOf(generateTradeReview(db, PERIOD, await prepared()));
    expect(gen).toHaveBeenCalledTimes(2);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/all 2 attempts/);
    expect(err.message).toMatch(/nothing was saved/);
    expect(err.message).not.toMatch(/Opus|Sonnet|Haiku|Fable|dev team/i);
    expect(db.prepare("SELECT COUNT(*) AS n FROM trade_reviews").get()).toEqual({ n: 0 });
  });

  it("keys on different models: the third attempt runs, and its progress line names no family", async () => {
    modelIds.tradeReviewMainLarge = "claude-opus-5-5";
    gen
      .mockResolvedValueOnce({ object: EMPTY_REVIEW, usage: {} } as never)
      .mockResolvedValueOnce({ object: EMPTY_REVIEW, usage: {} } as never)
      .mockResolvedValueOnce({ object: GOOD_REVIEW, usage: {} } as never);
    const messages: string[] = [];
    const result = await generateTradeReview(db, PERIOD, await prepared(), undefined, {
      onProgress: (m) => messages.push(m),
    });
    expect(gen).toHaveBeenCalledTimes(3);
    expect(gen.mock.calls[2][0]).toBe("tradeReviewMainLarge");
    expect(result.review.model).toBe("claude-opus-5-5");
    const fallbackLine = messages.find((m) => /different AI model/.test(m));
    expect(fallbackLine).toBeDefined();
    expect(fallbackLine).not.toMatch(/Opus|Sonnet|falling back/i);
  });
});

describe("H2c: a reply cut off at the output cap", () => {
  it("is retried once at the ceiling, then fails with a domain error that says what happened", async () => {
    gen.mockRejectedValue(new AITruncatedError("tradeReviewMain", "claude-sonnet-5-5"));
    const err = await failureOf(generateTradeReview(db, PERIOD, await prepared()));
    expect(gen).toHaveBeenCalledTimes(2);
    const caps = gen.mock.calls.map((c) => (c[1] as { maxOutputTokens: number }).maxOutputTokens);
    expect(caps[0]).toBeLessThan(REVIEW_OUTPUT_TOKEN_CEILING);
    expect(caps[1]).toBe(REVIEW_OUTPUT_TOKEN_CEILING);
    expect(err).toBeInstanceOf(TradeReviewTooLargeError);
    expect(err.message).toMatch(/too many trades for one review/);
    expect(err.message).toMatch(/Trying again gives the same result/);
    expect(err.message).not.toMatch(/Try again in a minute/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM trade_reviews").get()).toEqual({ n: 0 });
  });

  it("an SDK no-object error with finish reason length counts as a cut-off; the raised cap can succeed", async () => {
    const cut = new NoObjectGeneratedError({
      message: "No object generated",
      text: "{\"review_markdown\": \"partial",
      response: { id: "r", timestamp: new Date(0), modelId: "m" },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as never,
      finishReason: "length",
    });
    gen.mockRejectedValueOnce(cut).mockResolvedValueOnce({ object: GOOD_REVIEW, usage: {} } as never);
    const result = await generateTradeReview(db, PERIOD, await prepared());
    expect(gen).toHaveBeenCalledTimes(2);
    expect(result.review.id).toBeGreaterThan(0);
  });

  it("a returned reply that still stopped at the cap is treated as cut off too", async () => {
    gen.mockResolvedValue({ object: GOOD_REVIEW, usage: {}, finishReason: "length" } as never);
    await expect(generateTradeReview(db, PERIOD, await prepared())).rejects.toBeInstanceOf(
      TradeReviewTooLargeError
    );
    expect(gen).toHaveBeenCalledTimes(2);
  });

  it("another vendor failure is not treated as a cut-off and is not retried here", async () => {
    gen.mockRejectedValue(new Error("upstream 529"));
    await expect(generateTradeReview(db, PERIOD, await prepared())).rejects.toThrow("upstream 529");
    expect(gen).toHaveBeenCalledTimes(1);
  });
});

describe("H2g: one write, checked arrays", () => {
  it("a failure saving the round trips leaves no review row behind", async () => {
    gen.mockResolvedValue({ object: GOOD_REVIEW, usage: {} } as never);
    saveRoundtripsFails.value = true;
    await expect(generateTradeReview(db, PERIOD, await prepared())).rejects.toThrow("synthetic write failure");
    expect(db.prepare("SELECT COUNT(*) AS n FROM trade_reviews").get()).toEqual({ n: 0 });
  });

  it("non-array grades and patterns are stored as empty lists", async () => {
    gen.mockResolvedValue({
      object: { ...GOOD_REVIEW, trade_grades: "oops", patterns_identified: null, strengths: { a: 1 } },
      usage: {},
    } as never);
    const result = await generateTradeReview(db, PERIOD, await prepared());
    const row = db
      .prepare("SELECT trade_grades, patterns_identified, strengths FROM trade_reviews WHERE id = ?")
      .get(result.review.id) as Record<string, string>;
    expect(row).toEqual({ trade_grades: "[]", patterns_identified: "[]", strengths: "[]" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM trade_roundtrips WHERE review_id = ?").get(result.review.id)).toEqual({ n: 2 });
  });
});

describe("H2e: what a review of the period leaves out, read today", () => {
  it("counts reviewed, low-coverage and engine closes through the generator's path", () => {
    // A close with thin lot history: 5 of 10 matched (50% < 90%).
    db.prepare("INSERT INTO securities(id,symbol,name,security_type) VALUES(3,'ZZC','C Co','Stock')").run();
    const thin = trade(3, "SELL", "2026-08-20", 10, 30, "C");
    const lot = db
      .prepare(
        "INSERT INTO tax_lots(account_id,security_id,acquisition_date,acquisition_price,quantity_acquired,quantity_remaining,cost_basis) VALUES(?,?,?,?,?,0,?)"
      )
      .run(ACCOUNT, 3, "2026-08-05", 20, 5, 100).lastInsertRowid;
    db.prepare(
      "INSERT INTO tax_lot_sales(tax_lot_id,sale_transaction_id,sale_date,quantity_sold,sale_price,proceeds,cost_basis_allocated,realized_gain_loss,is_long_term,holding_period_days) VALUES(?,?,?,?,?,?,?,?,0,?)"
    ).run(lot, thin, "2026-08-20", 5, 30, 150, 100, 50, 15);

    expect(currentReviewCoverage(db, PERIOD)).toEqual({
      reviewableCount: 2,
      userCloseCount: 3,
      lowCoverageCount: 1,
      syntheticCount: 0,
      // ZZA +100 and ZZB -50; the thin close is not in the total.
      totalRealizedPnl: 50,
    });
  });
});

describe("H2f: a month with no reviewable round trip is not offered", () => {
  it("the picker leaves out a month whose only close lacks lot history", () => {
    db.prepare("INSERT INTO securities(id,symbol,name,security_type) VALUES(3,'ZZC','C Co','Stock')").run();
    const thin = trade(3, "SELL", "2026-09-20", 10, 30, "C");
    const lot = db
      .prepare(
        "INSERT INTO tax_lots(account_id,security_id,acquisition_date,acquisition_price,quantity_acquired,quantity_remaining,cost_basis) VALUES(?,?,?,?,?,0,?)"
      )
      .run(ACCOUNT, 3, "2026-09-05", 20, 5, 100).lastInsertRowid;
    db.prepare(
      "INSERT INTO tax_lot_sales(tax_lot_id,sale_transaction_id,sale_date,quantity_sold,sale_price,proceeds,cost_basis_allocated,realized_gain_loss,is_long_term,holding_period_days) VALUES(?,?,?,?,?,?,?,?,0,?)"
    ).run(lot, thin, "2026-09-20", 5, 30, 150, 100, 50, 15);

    const offered = getAvailableReviewPeriods(db, ACCOUNT).map((p) => p.periodStart);
    expect(offered).toEqual(["2026-08-01"]);
  });
});
