/**
 * QA 2026-09-22 review of 49ce6ffb (PR #85), finding 1 —
 * the classify-before-send branch swallowed the pipeline's OWN errors.
 *
 * `prepareTradeReview` and `generateTradeReview` raise domain errors written
 * for this user ("No closed trades found for this account in …", "No
 * fully-tracked trades found for this period…", the 3-attempt empty-review
 * guard). None of them is an Anthropic failure, so the classifier returns
 * null and every one of them rendered as "Couldn't generate the review. Try
 * again" — wrong advice for a month that has no closed trades to review.
 *
 * The rule pinned here: classify ONLY a vendor/transport failure (an
 * Anthropic `APIError`, an AI SDK `APICallError`/`AISDKError`), and never
 * echo its prose; pass our own domain sentence through untouched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { APIError } from "@anthropic-ai/sdk";
import { APICallError } from "ai";

let db: Database.Database;
vi.mock("@/lib/db", () => ({
  get db() {
    return db;
  },
}));
vi.mock("@/lib/trade-review/generate", () => ({
  prepareTradeReview: vi.fn(),
  generateTradeReview: vi.fn(),
}));

import {
  prepareTradeReview,
  generateTradeReview,
} from "@/lib/trade-review/generate";
import { POST } from "@/app/api/trade-review/route";

const PERIOD = {
  accountId: 3,
  periodStart: "2026-08-01",
  periodEnd: "2026-08-31",
};

// A review the mock can hand back when the test needs a SUCCESSFUL generation.
const FAKE_RESULT = {
  review: { id: 1, total_realized_pnl: 100, win_rate: 0.5 },
  groupedTrades: [],
  tradeCount: 2,
};

interface SseEvent {
  error?: string;
  savedUnknown?: boolean;
  complete?: boolean;
  progress?: { phase: string; message: string };
  questions?: unknown[];
}

async function post(body: unknown = PERIOD): Promise<SseEvent[]> {
  const res = await POST(
    new Request("http://localhost/api/trade-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const text = await res.text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length))
    .filter((payload) => payload !== "[DONE]")
    .map((payload) => JSON.parse(payload) as SseEvent);
}

async function errorEvent(body: unknown = PERIOD): Promise<SseEvent> {
  const events = await post(body);
  const failure = events.find((e) => e.error !== undefined);
  expect(failure, "route emitted no error event").toBeDefined();
  return failure!;
}

beforeEach(() => {
  db = new Database(":memory:");
  vi.mocked(prepareTradeReview).mockReset();
  vi.mocked(generateTradeReview).mockReset();
  // The route logs the real text server-side; keep it out of the test output.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

describe("POST /api/trade-review — domain errors reach the user intact", () => {
  it("passes the 'no closed trades' sentence through verbatim", async () => {
    const domain =
      "No closed trades found for this account in 2026-08-01 to 2026-08-31";
    vi.mocked(prepareTradeReview).mockRejectedValue(new Error(domain));

    const failure = await errorEvent();
    expect(failure.error).toBe(domain);
    expect(failure.error).not.toMatch(/couldn't generate the review/i);
  });

  it("passes the incomplete-cost-basis sentence through verbatim", async () => {
    const domain =
      "No fully-tracked trades found for this period. 3 trade(s) were excluded " +
      "due to incomplete cost basis data (positions may pre-date imported " +
      "transaction history).";
    vi.mocked(prepareTradeReview).mockRejectedValue(new Error(domain));

    expect((await errorEvent()).error).toBe(domain);
  });

  it("passes the empty-review guard (with its remediation steps) through verbatim", async () => {
    const domain =
      "AI returned an empty review summary across 3 attempts. Try (a) splitting " +
      "the period if many trades, (b) removing trader-note Q&A answers if any.";
    vi.mocked(prepareTradeReview).mockResolvedValue({
      questions: [],
      groupedTrades: [],
      accountName: "Test",
    } as never);
    vi.mocked(generateTradeReview).mockRejectedValue(new Error(domain));

    const failure = await errorEvent();
    expect(failure.error).toBe(domain);
    expect(failure.savedUnknown).toBe(false);
  });
});

describe("POST /api/trade-review — vendor failures are classified, never echoed", () => {
  function anthropic(status: number, message: string): APIError {
    const payload = {
      type: "error",
      error: { type: "invalid_request_error", message },
      request_id: "req_testTEST",
    };
    return new APIError(
      status,
      payload,
      `${status} ${JSON.stringify(payload)}`,
      new Headers(),
    );
  }

  function aiSdk(message: string): APICallError {
    return new APICallError({
      message,
      url: "https://example.invalid/v1/messages",
      requestBodyValues: {},
      statusCode: 400,
    });
  }

  it("classifies an Anthropic billing 400 instead of quoting it", async () => {
    vi.mocked(prepareTradeReview).mockRejectedValue(
      anthropic(
        400,
        "Your credit balance is too low to access the Anthropic API. " +
          "Please go to Plans & Billing to upgrade or purchase credits.",
      ),
    );

    const failure = await errorEvent();
    expect(failure.error).toMatch(/billing needs attention/i);
    expect(failure.error).not.toMatch(/credit balance|request_id|req_test/i);
  });

  it("classifies the AI SDK's bare forced-tool-use 400 instead of quoting it", async () => {
    vi.mocked(prepareTradeReview).mockResolvedValue({
      questions: [],
      groupedTrades: [],
      accountName: "Test",
    } as never);
    vi.mocked(generateTradeReview).mockRejectedValue(
      aiSdk(
        'tool_choice: type "tool" and "any" are not supported for this model.',
      ),
    );

    const failure = await errorEvent();
    expect(failure.error).toMatch(/can't handle this kind of request/i);
    expect(failure.error).not.toMatch(/tool_choice|claude-|anthropic/i);
  });

  it("gives an unrecognized vendor failure generic wording, never its prose", async () => {
    vi.mocked(prepareTradeReview).mockRejectedValue(
      aiSdk("upstream shard 47 rejected the completion (trace abc123)"),
    );

    const failure = await errorEvent();
    expect(failure.error).toMatch(/ai service/i);
    expect(failure.error).not.toMatch(/shard 47|abc123/i);
  });
});

describe("POST /api/trade-review — the error event says whether a save could have happened", () => {
  it("reports savedUnknown=false when the failure precedes the DB-write step", async () => {
    vi.mocked(prepareTradeReview).mockRejectedValue(
      new Error("No closed trades found for this account in 2026-08-01 to 2026-08-31"),
    );
    expect((await errorEvent()).savedUnknown).toBe(false);
  });

  it("reports savedUnknown=true when the failure follows the DB-write step", async () => {
    vi.mocked(prepareTradeReview).mockResolvedValue({
      questions: [],
      groupedTrades: [],
      accountName: "Test",
    } as never);
    vi.mocked(generateTradeReview).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (async (_db: unknown, _params: unknown, _prepared: unknown, _answers: unknown, options: any) => {
        options?.onProgress?.("Saving review to database...", 5, 5);
        throw new Error("database is locked");
      }) as never,
    );

    const failure = await errorEvent();
    expect(failure.savedUnknown).toBe(true);
  });

  it("emits no error event at all on a clean run", async () => {
    vi.mocked(prepareTradeReview).mockResolvedValue({
      questions: [],
      groupedTrades: [],
      accountName: "Test",
    } as never);
    vi.mocked(generateTradeReview).mockResolvedValue(FAKE_RESULT as never);

    const events = await post();
    expect(events.some((e) => e.error !== undefined)).toBe(false);
    expect(events.some((e) => e.complete)).toBe(true);
  });
});
