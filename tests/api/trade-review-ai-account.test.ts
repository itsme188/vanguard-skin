/**
 * QA finding (medium): an Anthropic account outage (out of credit) ended a
 * trade-review generation with "The AI service failed on this request. Try
 * again in a minute." The AI SDK's APICallError carries the provider's bare
 * prose, which the message classifier does not recognise as billing.
 *
 * The route now asks `accountFailureOf` first and ends the stream with the
 * shared `aiUnavailableReason(kind)` sentence and `aiAccount: true`; the
 * client words it without a "try again" (pinned below by source scan, since
 * there is no DOM harness). Errors are built by the REAL AI SDK.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { aiUnavailableReason } from "@/lib/earnings/ai-unavailable";
import {
  ANTHROPIC_FAILURES,
  CREDIT_BALANCE_MESSAGE,
  errorFromRealSdk,
} from "@/tests/helpers/ai-sdk-real-errors";
import { anchorIndex } from "@/tests/helpers/source-anchor";

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

import { prepareTradeReview, generateTradeReview } from "@/lib/trade-review/generate";
import { POST } from "@/app/api/trade-review/route";
import { tradeReviewFailureMessage } from "@/app/dashboard/components/TradeReviewView";

interface SseEvent {
  error?: string;
  aiAccount?: boolean;
  savedUnknown?: boolean;
}

async function errorEvent(): Promise<SseEvent> {
  const res = await POST(
    new Request("http://localhost/api/trade-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: 3, periodStart: "2026-08-01", periodEnd: "2026-08-31" }),
    }),
  );
  const events = (await res.text())
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)) as SseEvent);
  const failure = events.find((e) => e.error !== undefined);
  expect(failure, "route emitted no error event").toBeDefined();
  return failure!;
}

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  db = new Database(":memory:");
  vi.mocked(prepareTradeReview).mockReset();
  vi.mocked(generateTradeReview).mockReset();
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

describe("POST /api/trade-review — AI account outage", () => {
  it("names the out-of-credit outage from the AI SDK's error, never 'try again in a minute'", async () => {
    const { error } = await errorFromRealSdk(ANTHROPIC_FAILURES.billing400, { maxRetries: 0 });
    vi.mocked(prepareTradeReview).mockResolvedValue({ questions: [], groupedTrades: [], accountName: "T" } as never);
    vi.mocked(generateTradeReview).mockRejectedValue(error);

    const failure = await errorEvent();
    expect(failure.error).toBe(aiUnavailableReason("billing"));
    expect(failure.aiAccount).toBe(true);
    expect(failure.savedUnknown).toBe(false);
    expect(failure.error).not.toMatch(/try again|credit balance/i);
    expect(errSpy.mock.calls.some((c: unknown[]) => c.map(String).join(" ").includes(CREDIT_BALANCE_MESSAGE))).toBe(true);
  });

  it("names a rejected key the same way", async () => {
    const { error } = await errorFromRealSdk(ANTHROPIC_FAILURES.auth401, { maxRetries: 0 });
    vi.mocked(prepareTradeReview).mockRejectedValue(error);
    const failure = await errorEvent();
    expect(failure.error).toBe(aiUnavailableReason("auth"));
    expect(failure.aiAccount).toBe(true);
  });

  it("leaves a domain error unflagged and verbatim", async () => {
    const domain = "No closed trades found for this account in 2026-08-01 to 2026-08-31";
    vi.mocked(prepareTradeReview).mockRejectedValue(new Error(domain));
    const failure = await errorEvent();
    expect(failure.error).toBe(domain);
    expect(failure.aiAccount).toBeUndefined();
  });
});

describe("tradeReviewFailureMessage — account outage", () => {
  it("names the outage and says when to retry, with no 'Try again'", () => {
    const msg = tradeReviewFailureMessage(aiUnavailableReason("billing"), "nothing-saved", { aiAccount: true });
    expect(msg).toBe(
      "Couldn't generate the review — AI unavailable (billing). Nothing was saved and the period is unchanged. Retry once the account is restored.",
    );
    expect(msg).not.toMatch(/try again|no attempt counted/i);
  });

  it("uses the recovery clause for a passing outage", () => {
    expect(tradeReviewFailureMessage(aiUnavailableReason("outage"), "nothing-saved", { aiAccount: true })).toMatch(
      /Retry once the AI service recovers\.$/,
    );
  });

  it("keeps the old copy without the flag", () => {
    expect(tradeReviewFailureMessage("No closed trades found", "nothing-saved")).toMatch(/Try again, or pick a different month\.$/);
  });

  it("the SSE consumer passes the server's aiAccount flag through", () => {
    const src = readFileSync("app/dashboard/components/TradeReviewView.tsx", "utf8");
    const at = anchorIndex(src, "saveStateUnknown = data.savedUnknown === true;");
    expect(src.slice(at, at + 500)).toMatch(/aiAccount:\s*data\.aiAccount === true/);
  });
});
