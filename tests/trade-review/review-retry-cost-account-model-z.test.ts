/**
 * Trade-review generation, review round 3 (Analysis tab fix wave 2026-11-15).
 *
 *  Z1  a reply cut off at the output cap is retried at the ceiling only when
 *      the ceiling is materially larger than the first cap (at least 1.5x).
 *      A big month whose first cap is already near the ceiling goes straight
 *      to TradeReviewTooLargeError instead of paying for a second cut-off.
 *  Z2  an AI account outage on a LATER attempt is rethrown as it is, so the
 *      route can flag it, never reported as "no written summary".
 *  Z4  the saved review records the model that answered (`answeredModelId`),
 *      falling back to the resolved id.
 *
 * No AI call is made: `generateObjectForFeature` and `resolveFeatureModel`
 * are mocked. All figures and symbols are synthetic.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APICallError } from "ai";
import { runMigrations } from "@/lib/db/migrate";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { ibkrTradeDirectionNote } from "@/lib/import/ibkr-trade-direction";

const modelIds: Record<string, string> = {
  tradeReviewMain: "claude-sonnet-5-5",
  tradeReviewMainLarge: "claude-sonnet-5-5",
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

import { AITruncatedError, generateObjectForFeature } from "@/lib/ai/generate";
import {
  generateTradeReview,
  prepareTradeReview,
  retryCapAfterCutOff,
  REVIEW_OUTPUT_TOKEN_CEILING,
  TradeReviewTooLargeError,
} from "@/lib/trade-review/generate";
import { accountFailureOf } from "@/lib/earnings/ai-unavailable";

const gen = vi.mocked(generateObjectForFeature);
const ACCOUNT = 3;
const PERIOD = { accountId: ACCOUNT, periodStart: "2026-08-01", periodEnd: "2026-08-31" };

const debugDir = fs.mkdtempSync(path.join(os.tmpdir(), "trade-review-z-"));
const priorDbDir = process.env.VANGUARD_DB_DIR;
process.env.VANGUARD_DB_DIR = debugDir;
afterAll(() => {
  if (priorDbDir === undefined) delete process.env.VANGUARD_DB_DIR;
  else process.env.VANGUARD_DB_DIR = priorDbDir;
  fs.rmSync(debugDir, { recursive: true, force: true });
});

let db: Database.Database;

function trade(securityId: number, type: string, date: string, qty: number, price: number, code: string) {
  db.prepare(
    "INSERT INTO transactions(account_id,security_id,type,trade_date,quantity,price_per_share,amount,fees,notes) VALUES(?,?,?,?,?,?,?,0,?)"
  ).run(ACCOUNT, securityId, type, date, qty, price, (type === "BUY" ? -1 : 1) * qty * price, ibkrTradeDirectionNote(code, `${date}, 12:00:00`));
}

/** `n` long round trips, one synthetic security each. */
function seedRoundTrips(n: number) {
  const insert = db.prepare("INSERT INTO securities(id,symbol,name,security_type) VALUES(?,?,?,'Stock')");
  for (let i = 1; i <= n; i++) {
    insert.run(i, `ZZ${String(i).padStart(3, "0")}`, `Synthetic ${i}`);
    const buyDay = String(1 + (i % 9)).padStart(2, "0");
    const sellDay = String(12 + (i % 15)).padStart(2, "0");
    trade(i, "BUY", `2026-08-${buyDay}`, 10, 50, "O");
    trade(i, "SELL", `2026-08-${sellDay}`, 10, i % 2 === 0 ? 60 : 45, "C");
  }
  computeTaxLots(db);
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
  gen.mockReset();
  modelIds.tradeReviewMain = "claude-sonnet-5-5";
  modelIds.tradeReviewMainLarge = "claude-sonnet-5-5";
});
afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

async function prepared() {
  return prepareTradeReview(db, PERIOD, { skipQuestions: true });
}

function caps(): number[] {
  return gen.mock.calls.map((c) => (c[1] as { maxOutputTokens: number }).maxOutputTokens);
}

describe("Z1: a cut-off is retried at the ceiling only when the ceiling is materially larger", () => {
  it("the rule: retry at the ceiling when it is at least 1.5x the first cap, otherwise none", () => {
    expect(retryCapAfterCutOff(12000)).toBe(REVIEW_OUTPUT_TOKEN_CEILING);
    // 64,000 / 1.5 = 42,666.67: the last first cap that still earns a retry.
    expect(retryCapAfterCutOff(42666)).toBe(REVIEW_OUTPUT_TOKEN_CEILING);
    expect(retryCapAfterCutOff(42667)).toBeNull();
    expect(retryCapAfterCutOff(61800)).toBeNull();
    expect(retryCapAfterCutOff(REVIEW_OUTPUT_TOKEN_CEILING)).toBeNull();
  });

  it("a small month (first cap 12,000) cut off is retried once at the ceiling", async () => {
    seedRoundTrips(2);
    gen.mockRejectedValue(new AITruncatedError("tradeReviewMain", "claude-sonnet-5-5"));
    await expect(generateTradeReview(db, PERIOD, await prepared())).rejects.toBeInstanceOf(TradeReviewTooLargeError);
    expect(caps()).toEqual([12000, REVIEW_OUTPUT_TOKEN_CEILING]);
  });

  it("a big month whose first cap is near the ceiling goes straight to the domain error, one paid call", async () => {
    seedRoundTrips(100); // first cap 5,000 + 100 x 400 = 45,000: 64,000 is only 1.42x
    const data = await prepared();
    expect(data.groupedTrades).toHaveLength(100);
    gen.mockRejectedValue(new AITruncatedError("tradeReviewMainLarge", "claude-sonnet-5-5"));
    await expect(generateTradeReview(db, PERIOD, data)).rejects.toBeInstanceOf(TradeReviewTooLargeError);
    expect(caps()).toEqual([45000]);
  });
});

function billingError(): Error {
  return new APICallError({
    message: "Your credit balance is too low to access the Anthropic API.",
    url: "https://example.invalid/v1/messages",
    requestBodyValues: {},
    statusCode: 400,
    responseBody: JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." },
    }),
    isRetryable: false,
  });
}

describe("Z2: an AI account outage on a later attempt is reported as one", () => {
  it("the synthetic error is an account failure", () => {
    expect(accountFailureOf(billingError())).toBe("billing");
  });

  it("empty, empty, then a billing error: the billing error reaches the caller, not a 'no written summary' error", async () => {
    seedRoundTrips(2);
    modelIds.tradeReviewMainLarge = "claude-opus-5-5";
    const billing = billingError();
    gen
      .mockResolvedValueOnce({ object: EMPTY_REVIEW, usage: {} } as never)
      .mockResolvedValueOnce({ object: EMPTY_REVIEW, usage: {} } as never)
      .mockRejectedValueOnce(billing);
    let caught: unknown;
    try {
      await generateTradeReview(db, PERIOD, await prepared());
    } catch (e) {
      caught = e;
    }
    expect(gen).toHaveBeenCalledTimes(3);
    expect(caught).toBe(billing);
    expect(accountFailureOf(caught)).toBe("billing");
    expect(db.prepare("SELECT COUNT(*) AS n FROM trade_reviews").get()).toEqual({ n: 0 });
  });

  it("another failure on the third attempt still ends in the plain 'no written summary' error", async () => {
    seedRoundTrips(2);
    modelIds.tradeReviewMainLarge = "claude-opus-5-5";
    gen
      .mockResolvedValueOnce({ object: EMPTY_REVIEW, usage: {} } as never)
      .mockResolvedValueOnce({ object: EMPTY_REVIEW, usage: {} } as never)
      .mockRejectedValueOnce(new Error("synthetic parse fault"));
    await expect(generateTradeReview(db, PERIOD, await prepared())).rejects.toThrow(/all 3 attempts/);
  });
});

/** A helper result carrying the non-enumerable answeredModelId, as lib/ai/generate.ts stamps it. */
function answered(object: unknown, answeredModelId: string) {
  const res = { object, usage: {} };
  Object.defineProperty(res, "answeredModelId", { value: answeredModelId, enumerable: false });
  return res;
}

describe("Z4: the saved review records the model that answered", () => {
  it("stores answeredModelId when the helper reports one (after a failover)", async () => {
    seedRoundTrips(2);
    gen.mockResolvedValueOnce(answered(GOOD_REVIEW, "claude-haiku-5-5") as never);
    const result = await generateTradeReview(db, PERIOD, await prepared());
    expect(result.review.model).toBe("claude-haiku-5-5");
  });

  it("falls back to the resolved id when the helper reports none", async () => {
    seedRoundTrips(2);
    gen.mockResolvedValueOnce({ object: GOOD_REVIEW, usage: {} } as never);
    const result = await generateTradeReview(db, PERIOD, await prepared());
    expect(result.review.model).toBe("claude-sonnet-5-5");
  });

  it("the other-model attempt records the model that answered it", async () => {
    seedRoundTrips(2);
    modelIds.tradeReviewMainLarge = "claude-opus-5-5";
    gen
      .mockResolvedValueOnce({ object: EMPTY_REVIEW, usage: {} } as never)
      .mockResolvedValueOnce({ object: EMPTY_REVIEW, usage: {} } as never)
      .mockResolvedValueOnce(answered(GOOD_REVIEW, "claude-opus-5-4") as never);
    const result = await generateTradeReview(db, PERIOD, await prepared());
    expect(result.review.model).toBe("claude-opus-5-4");
  });
});
