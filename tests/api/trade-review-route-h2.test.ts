/**
 * /api/trade-review route, unit H2 (Analysis tab fix wave 2026-11-15).
 *
 *  H2a  phase 2 prepares the data with `skipQuestions` (no second question AI
 *       call), forwards each answer's trade key, and a malformed answers body
 *       from an older client never crashes the route.
 *  H2c  the "too many trades for one review" domain error reaches the user in
 *       its own words, not as "Try again in a minute".
 *  H2d  the review list carries today's figures (`current`) and the stale
 *       pairings flag for the collapsed card.
 *
 * All figures are synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

let db: Database.Database;
vi.mock("@/lib/db", () => ({
  get db() {
    return db;
  },
}));
vi.mock("@/lib/trade-review/generate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/trade-review/generate")>();
  return { ...actual, prepareTradeReview: vi.fn(), generateTradeReview: vi.fn() };
});

import {
  generateTradeReview,
  prepareTradeReview,
  TradeReviewTooLargeError,
} from "@/lib/trade-review/generate";
import { GET, POST } from "@/app/api/trade-review/route";

const PERIOD = { accountId: 3, periodStart: "2026-08-01", periodEnd: "2026-08-31" };
const FAKE_RESULT = { review: { id: 1, total_realized_pnl: 100, win_rate: 0.5 }, groupedTrades: [], tradeCount: 2 };
const PREPARED = { questions: [], groupedTrades: [], accountName: "Test", summary: {} };

async function post(body: unknown): Promise<Array<Record<string, unknown>>> {
  const res = await POST(
    new Request("http://localhost/api/trade-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  return (await res.text())
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
  vi.mocked(prepareTradeReview).mockReset().mockResolvedValue(PREPARED as never);
  vi.mocked(generateTradeReview).mockReset().mockResolvedValue(FAKE_RESULT as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

describe("phase 2", () => {
  it("prepares without asking the questions again and forwards each answer's trade key", async () => {
    const events = await post({
      ...PERIOD,
      answers: [
        { tradeNumber: 2, answer: "  hedge unwind ", saleTransactionId: 41 },
        { tradeNumber: 1, answer: "legacy client" },
        { tradeNumber: 3, answer: "   " },
        "not an object",
      ],
    });
    expect(events.some((e) => e.complete)).toBe(true);
    const prepOpts = vi.mocked(prepareTradeReview).mock.calls[0][2] as { skipQuestions?: boolean };
    expect(prepOpts.skipQuestions).toBe(true);
    const answers = vi.mocked(generateTradeReview).mock.calls[0][3];
    expect(answers).toEqual([
      { tradeNumber: 2, answer: "hedge unwind", saleTransactionId: 41 },
      { tradeNumber: 1, answer: "legacy client", saleTransactionId: null },
    ]);
  });

  it("an empty answers list is still phase 2 (skip), and a non-array body does not crash", async () => {
    await post({ ...PERIOD, answers: [] });
    await post({ ...PERIOD, answers: { tradeNumber: 1 } });
    for (const call of vi.mocked(prepareTradeReview).mock.calls) {
      expect((call[2] as { skipQuestions?: boolean }).skipQuestions).toBe(true);
    }
    expect(vi.mocked(generateTradeReview).mock.calls.map((c) => c[3])).toEqual([[], []]);
  });

  it("phase 1 (no answers) still asks the questions", async () => {
    await post(PERIOD);
    const prepOpts = vi.mocked(prepareTradeReview).mock.calls[0][2] as { skipQuestions?: boolean };
    expect(prepOpts.skipQuestions).toBeFalsy();
  });
});

describe("a cut-off review", () => {
  it("passes the plain-language domain error through", async () => {
    vi.mocked(generateTradeReview).mockRejectedValue(new TradeReviewTooLargeError(150));
    const events = await post({ ...PERIOD, answers: [] });
    const failure = events.find((e) => e.error !== undefined)!;
    expect(failure.error).toMatch(/too many trades for one review/);
    expect(failure.error).not.toMatch(/Try again in a minute/);
    expect(failure.savedUnknown).toBe(false);
  });
});

describe("GET list carries today's figures for each saved review", () => {
  it("adds `current` (same selection path) and `pairingsStale` beside the saved row", async () => {
    db.prepare(
      `INSERT INTO trade_reviews (account_id, period_start, period_end, total_trades, winning_trades,
         losing_trades, win_rate, total_realized_pnl, review_markdown)
       VALUES (3, '2026-08-01', '2026-08-31', 2, 1, 1, 0.5, 100, 'saved prose')`
    ).run();
    const res = await GET(new Request("http://localhost/api/trade-review?accountId=3"));
    const { reviews } = (await res.json()) as { reviews: Array<Record<string, unknown>> };
    expect(reviews).toHaveLength(1);
    expect(reviews[0].total_realized_pnl).toBe(100);
    expect(reviews[0].review_markdown).toBe("saved prose");
    expect(reviews[0].current).toEqual({
      reviewableCount: 0,
      userCloseCount: 0,
      lowCoverageCount: 0,
      syntheticCount: 0,
      totalRealizedPnl: 0,
    });
    expect(typeof reviews[0].pairingsStale).toBe("boolean");
  });
});
