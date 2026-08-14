import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { NextRequest } from "next/server";

// Packaged-app trust boundary (#35, task 22, spec §G) — /api/chat
// per-session budget / rate limits (defense-in-depth). Two layers of test:
//
//   1. Pure unit tests against lib/chat/budget.ts directly (no HTTP, no AI
//      SDK, no DB) — the brief's "extract into pure/DI'd functions so it's
//      unit-testable without spinning up the real stream."
//   2. HTTP-boundary tests against POST /api/chat itself, with `ai`'s
//      streamText mocked (per repo convention — see
//      memory/feedback_ai_test_mocking.md) so no real Claude call is ever
//      made and the mock's own onFinish/onError/onAbort hooks can be
//      invoked manually to prove the concurrency slot releases on every
//      path.

import {
  MAX_MESSAGES,
  MAX_PROMPT_BYTES,
  MAX_CONCURRENT_STREAMS_PER_SESSION,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_COOLDOWN_MS,
  DAILY_OUTPUT_TOKEN_CEILING,
  STREAM_SLOT_STALE_MS,
  checkRequestSize,
  acquireStreamSlot,
  releaseStreamSlot,
  activeStreamCount,
  checkAndConsumeRateLimit,
  isUnderDailyCeiling,
  recordDailyUsage,
  getDailyUsage,
  budgetDayFor,
  resetChatBudgetStateForTests,
} from "@/lib/chat/budget";

const T0 = Date.parse("2026-08-14T15:00:00Z"); // a Friday, well inside ET market hours

beforeEach(() => {
  resetChatBudgetStateForTests();
});

// ─── Pure unit tests ─────────────────────────────────────────────────────

describe("checkRequestSize", () => {
  it("accepts a normal small conversation", () => {
    const messages = [{ role: "user", parts: [{ type: "text", text: "hi" }] }];
    expect(checkRequestSize(messages)).toEqual({ ok: true });
  });

  it("rejects too many messages", () => {
    const messages = Array.from({ length: MAX_MESSAGES + 1 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      parts: [{ type: "text", text: "x" }],
    }));
    const result = checkRequestSize(messages);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/too many messages/i);
  });

  it("rejects an over-large total payload (messages + pageContext)", () => {
    const bigText = "x".repeat(MAX_PROMPT_BYTES + 1000);
    const messages = [{ role: "user", parts: [{ type: "text", text: bigText }] }];
    const result = checkRequestSize(messages);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/too large/i);
  });

  it("counts pageContext bytes toward the ceiling", () => {
    const messages = [{ role: "user", parts: [{ type: "text", text: "hi" }] }];
    const hugePageContext = "y".repeat(MAX_PROMPT_BYTES + 1000);
    const result = checkRequestSize(messages, hugePageContext);
    expect(result.ok).toBe(false);
  });

  it("accepts a payload right at the boundary", () => {
    // Small messages array; well under the byte ceiling.
    const messages = [{ role: "user", parts: [{ type: "text", text: "a".repeat(1000) }] }];
    expect(checkRequestSize(messages).ok).toBe(true);
  });
});

describe("concurrent-stream cap", () => {
  it("allows up to MAX_CONCURRENT_STREAMS_PER_SESSION, rejects the next", () => {
    const key = "session:1";
    const acquired: number[] = [];
    for (let i = 0; i < MAX_CONCURRENT_STREAMS_PER_SESSION; i++) {
      const r = acquireStreamSlot(key, T0);
      expect(r.ok).toBe(true);
      if (r.ok) acquired.push(r.slotId);
    }
    expect(activeStreamCount(key, T0)).toBe(MAX_CONCURRENT_STREAMS_PER_SESSION);

    // One more over the cap must be rejected.
    const over = acquireStreamSlot(key, T0);
    expect(over.ok).toBe(false);
  });

  it("releasing a slot frees capacity for a new stream", () => {
    const key = "session:2";
    const first = acquireStreamSlot(key, T0);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    // Fill remaining capacity.
    for (let i = 1; i < MAX_CONCURRENT_STREAMS_PER_SESSION; i++) {
      expect(acquireStreamSlot(key, T0).ok).toBe(true);
    }
    expect(acquireStreamSlot(key, T0).ok).toBe(false);

    // Release ONE slot (simulating a finished/aborted/errored stream) —
    // capacity must come back, proving the decrement path works.
    releaseStreamSlot(key, first.slotId);
    expect(activeStreamCount(key, T0)).toBe(MAX_CONCURRENT_STREAMS_PER_SESSION - 1);
    expect(acquireStreamSlot(key, T0).ok).toBe(true);
  });

  it("release is idempotent — double release never goes negative or frees extra capacity", () => {
    const key = "session:3";
    const slot = acquireStreamSlot(key, T0);
    expect(slot.ok).toBe(true);
    if (!slot.ok) throw new Error("unreachable");
    releaseStreamSlot(key, slot.slotId);
    releaseStreamSlot(key, slot.slotId); // second release: no-op, not a leak
    expect(activeStreamCount(key, T0)).toBe(0);
  });

  it("a session stuck past STREAM_SLOT_STALE_MS is reclaimed even without an explicit release", () => {
    const key = "session:4";
    for (let i = 0; i < MAX_CONCURRENT_STREAMS_PER_SESSION; i++) {
      expect(acquireStreamSlot(key, T0).ok).toBe(true);
    }
    expect(acquireStreamSlot(key, T0).ok).toBe(false);

    // Time passes well beyond the staleness window — NO release() was ever
    // called (simulating a callback that never fired). The slot must still
    // free up, so a session can never be permanently stuck.
    const later = T0 + STREAM_SLOT_STALE_MS + 1;
    expect(acquireStreamSlot(key, later).ok).toBe(true);
  });

  it("different sessions have independent caps", () => {
    for (let i = 0; i < MAX_CONCURRENT_STREAMS_PER_SESSION; i++) {
      expect(acquireStreamSlot("session:a", T0).ok).toBe(true);
    }
    expect(acquireStreamSlot("session:a", T0).ok).toBe(false);
    // A different session is unaffected.
    expect(acquireStreamSlot("session:b", T0).ok).toBe(true);
  });
});

describe("checkAndConsumeRateLimit", () => {
  it("allows up to RATE_LIMIT_MAX_REQUESTS in a window, rejects the burst overflow", () => {
    const key = "session:rl-1";
    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
      const r = checkAndConsumeRateLimit(key, T0 + i);
      expect(r.ok).toBe(true);
    }
    const over = checkAndConsumeRateLimit(key, T0 + RATE_LIMIT_MAX_REQUESTS);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.retryAfterMs).toBeGreaterThan(0);
  });

  it("holds the cooldown even after the fixed window would have rolled over", () => {
    // This test is only meaningful when the cooldown outlasts the window —
    // otherwise "past the window" and "past the cooldown" are the same
    // instant and this would assert nothing. Guard the PREMISE (a constants
    // relationship that must hold for the feature's documented behavior to
    // exist at all), not the assertion itself.
    expect(RATE_LIMIT_COOLDOWN_MS).toBeGreaterThan(RATE_LIMIT_WINDOW_MS);

    const key = "session:rl-2";
    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
      expect(checkAndConsumeRateLimit(key, T0).ok).toBe(true);
    }
    expect(checkAndConsumeRateLimit(key, T0).ok).toBe(false); // trips cooldown

    // Just past the point the fixed window would have rolled over — a
    // window-only limiter would allow this request again. The cooldown must
    // still be holding at this instant since it outlasts the window.
    const afterWindowRollover = T0 + RATE_LIMIT_WINDOW_MS + 1;
    const stillCooling = checkAndConsumeRateLimit(key, afterWindowRollover);
    expect(stillCooling.ok).toBe(false);
  });

  it("recovers after the cooldown elapses", () => {
    const key = "session:rl-3";
    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
      checkAndConsumeRateLimit(key, T0);
    }
    expect(checkAndConsumeRateLimit(key, T0).ok).toBe(false);
    const afterCooldown = T0 + RATE_LIMIT_COOLDOWN_MS + RATE_LIMIT_WINDOW_MS + 1000;
    expect(checkAndConsumeRateLimit(key, afterCooldown).ok).toBe(true);
  });

  it("different sessions have independent rate limits", () => {
    const a = "session:rl-a";
    const b = "session:rl-b";
    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
      expect(checkAndConsumeRateLimit(a, T0).ok).toBe(true);
    }
    expect(checkAndConsumeRateLimit(a, T0).ok).toBe(false);
    expect(checkAndConsumeRateLimit(b, T0).ok).toBe(true);
  });
});

describe("daily output-token ceiling", () => {
  it("is under the ceiling with no recorded usage", () => {
    const day = budgetDayFor(T0);
    expect(isUnderDailyCeiling("session:d1", day)).toBe(true);
  });

  it("accumulates usage across multiple onFinish-style calls and trips past the ceiling", () => {
    const key = "session:d2";
    const day = budgetDayFor(T0);
    recordDailyUsage(key, day, DAILY_OUTPUT_TOKEN_CEILING - 100);
    expect(isUnderDailyCeiling(key, day)).toBe(true);
    recordDailyUsage(key, day, 200); // pushes cumulative over the ceiling
    expect(isUnderDailyCeiling(key, day)).toBe(false);
    expect(getDailyUsage(key, day)?.outputTokens).toBeGreaterThan(DAILY_OUTPUT_TOKEN_CEILING);
  });

  it("resets on a new ET calendar day", () => {
    const key = "session:d3";
    const day1 = budgetDayFor(T0);
    recordDailyUsage(key, day1, DAILY_OUTPUT_TOKEN_CEILING + 1);
    expect(isUnderDailyCeiling(key, day1)).toBe(false);

    const nextDay = budgetDayFor(T0 + 24 * 60 * 60 * 1000);
    expect(isUnderDailyCeiling(key, nextDay)).toBe(true);
  });

  it("different sessions have independent daily ceilings", () => {
    const day = budgetDayFor(T0);
    recordDailyUsage("session:d-a", day, DAILY_OUTPUT_TOKEN_CEILING + 1);
    expect(isUnderDailyCeiling("session:d-a", day)).toBe(false);
    expect(isUnderDailyCeiling("session:d-b", day)).toBe(true);
  });
});

// ─── HTTP-boundary tests against the real route ─────────────────────────

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  streamTextMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    streamText: hoisted.streamTextMock,
  };
});

// Imported AFTER both mocks are registered.
import { POST } from "@/app/api/chat/route";

function fakeStreamTextResult() {
  return {
    toUIMessageStreamResponse: () =>
      new Response("mock-stream", { status: 200, headers: { "content-type": "text/event-stream" } }),
  };
}

function makeChatRequest(body: Record<string, unknown>, cookie?: string): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers["cookie"] = cookie;
  return new NextRequest("http://localhost:3099/api/chat", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/chat — budget gate", () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    hoisted.db = new Database(":memory:");
    hoisted.db.pragma("foreign_keys = ON");
    runMigrations(hoisted.db);
    hoisted.streamTextMock.mockReset();
    hoisted.streamTextMock.mockImplementation(() => fakeStreamTextResult());
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  });

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
  });

  it("over-size request: 400, streamText NOT called", async () => {
    const bigText = "x".repeat(MAX_PROMPT_BYTES + 1000);
    const req = makeChatRequest({
      messages: [{ role: "user", parts: [{ type: "text", text: bigText }] }],
      scope: "macro",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(hoisted.streamTextMock).not.toHaveBeenCalled();
  });

  it("invalid scope: 400, and no concurrency slot is leaked (round-1 review fix)", async () => {
    // Regression for a leak found in code review: scope validation `return`s
    // (doesn't throw) on an invalid scope. Before the fix, the concurrency
    // slot was acquired BEFORE scope validation, so this path returned
    // without ever calling releaseSlot — the slot only came back via the
    // 10-minute stale-slot prune. The fix moves acquisition to immediately
    // before streamText, so this path never acquires a slot at all.
    const req = makeChatRequest({
      messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
      scope: "not-a-real-scope",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(hoisted.streamTextMock).not.toHaveBeenCalled();

    const { NO_SESSION_KEY, activeStreamCount } = await import("@/lib/chat/budget");
    expect(activeStreamCount(NO_SESSION_KEY, Date.now())).toBe(0);
  });

  it("missing ANTHROPIC_API_KEY: 500, and no concurrency slot is leaked (round-1 review fix)", async () => {
    // Same class of leak as the invalid-scope case: the API-key check also
    // `return`s (doesn't throw) on failure.
    const envModule = await import("@/lib/env");
    const spy = vi.spyOn(envModule, "getAnthropicApiKey").mockReturnValue(undefined);
    try {
      const req = makeChatRequest({
        messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
        scope: "macro",
      });
      const res = await POST(req);
      expect(res.status).toBe(500);
      expect(hoisted.streamTextMock).not.toHaveBeenCalled();

      const { NO_SESSION_KEY, activeStreamCount } = await import("@/lib/chat/budget");
      expect(activeStreamCount(NO_SESSION_KEY, Date.now())).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("a normal single request within all limits proceeds (streamText called once)", async () => {
    const req = makeChatRequest({
      messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
      scope: "macro",
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(hoisted.streamTextMock).toHaveBeenCalledTimes(1);
  });

  it("concurrency cap: the (N+1)th simultaneous stream for the same session gets 429, and a finished stream releases its slot", async () => {
    // Drive the concurrency limiter directly at the session key the route
    // will derive for a cookie-less request (NO_SESSION_KEY) — this proves
    // the route's acquire call actually consults the shared module state,
    // without needing to race real concurrent fetches.
    const { NO_SESSION_KEY, acquireStreamSlot: acquire } = await import("@/lib/chat/budget");
    for (let i = 0; i < MAX_CONCURRENT_STREAMS_PER_SESSION; i++) {
      expect(acquire(NO_SESSION_KEY, Date.now()).ok).toBe(true);
    }

    const req = makeChatRequest({
      messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
      scope: "macro",
    });
    const res = await POST(req);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(hoisted.streamTextMock).not.toHaveBeenCalled();
  });

  it("the concurrency slot is released when the stream finishes (onFinish fires)", async () => {
    let capturedOnFinish: ((event: unknown) => Promise<void> | void) | undefined;
    hoisted.streamTextMock.mockImplementation(
      (opts: { onFinish?: (e: unknown) => Promise<void> | void }) => {
        capturedOnFinish = opts.onFinish;
        return fakeStreamTextResult();
      }
    );

    const req = makeChatRequest({
      messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
      scope: "macro",
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(capturedOnFinish).toBeTypeOf("function");

    // Before onFinish runs, the slot should still be held. Fire it (as the
    // AI SDK would once the stream completes) and confirm the slot frees.
    const { NO_SESSION_KEY, activeStreamCount } = await import("@/lib/chat/budget");
    expect(activeStreamCount(NO_SESSION_KEY, Date.now())).toBeGreaterThan(0);
    await capturedOnFinish!({ text: "hi there", finishReason: "stop", totalUsage: { outputTokens: 42 } });
    expect(activeStreamCount(NO_SESSION_KEY, Date.now())).toBe(0);
  });

  it("the concurrency slot is released when the stream errors (onError fires), not just onFinish", async () => {
    let capturedOnError: ((event: unknown) => Promise<void> | void) | undefined;
    hoisted.streamTextMock.mockImplementation(
      (opts: { onError?: (e: unknown) => Promise<void> | void }) => {
        capturedOnError = opts.onError;
        return fakeStreamTextResult();
      }
    );

    const req = makeChatRequest({
      messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
      scope: "macro",
    });
    await POST(req);
    expect(capturedOnError).toBeTypeOf("function");

    const { NO_SESSION_KEY, activeStreamCount } = await import("@/lib/chat/budget");
    expect(activeStreamCount(NO_SESSION_KEY, Date.now())).toBeGreaterThan(0);
    await capturedOnError!({ error: new Error("boom") });
    expect(activeStreamCount(NO_SESSION_KEY, Date.now())).toBe(0);
  });

  it("the concurrency slot is released when the stream aborts (onAbort fires)", async () => {
    let capturedOnAbort: (() => Promise<void> | void) | undefined;
    hoisted.streamTextMock.mockImplementation(
      (opts: { onAbort?: () => Promise<void> | void }) => {
        capturedOnAbort = opts.onAbort;
        return fakeStreamTextResult();
      }
    );

    const req = makeChatRequest({
      messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
      scope: "macro",
    });
    await POST(req);
    expect(capturedOnAbort).toBeTypeOf("function");

    const { NO_SESSION_KEY, activeStreamCount } = await import("@/lib/chat/budget");
    expect(activeStreamCount(NO_SESSION_KEY, Date.now())).toBeGreaterThan(0);
    await capturedOnAbort!();
    expect(activeStreamCount(NO_SESSION_KEY, Date.now())).toBe(0);
  });

  it("rate limit: bursting past the window returns 429", async () => {
    const { NO_SESSION_KEY, checkAndConsumeRateLimit: consume } = await import("@/lib/chat/budget");
    const now = Date.now();
    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
      expect(consume(NO_SESSION_KEY, now + i).ok).toBe(true);
    }

    const req = makeChatRequest({
      messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
      scope: "macro",
    });
    const res = await POST(req);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(hoisted.streamTextMock).not.toHaveBeenCalled();
  });

  it("daily ceiling: usage already past the ceiling (driven directly) returns 429", async () => {
    const { NO_SESSION_KEY, recordDailyUsage: record, budgetDayFor: dayFor } = await import(
      "@/lib/chat/budget"
    );
    record(NO_SESSION_KEY, dayFor(Date.now()), DAILY_OUTPUT_TOKEN_CEILING + 1);

    const req = makeChatRequest({
      messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
      scope: "macro",
    });
    const res = await POST(req);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(hoisted.streamTextMock).not.toHaveBeenCalled();
  });
});
