/**
 * The golden runner's own behaviour (no network, no model): a fake fetch
 * streams the route's chunks and a fake log holds its usage lines.
 *
 * Run 5 (2026-11-12): the runner booked a cost-ceiling abort, and failed
 * the question, after the turn had already finished with "stop" (Q8; run
 * 4a's first Q18 too). The usage log can be read ahead of the stream's
 * finish chunk, so the last step's line was treated as if another step
 * would follow it. A step that finished with anything but "tool-calls" has
 * no step after it, so it can never trip the ceiling.
 *
 * Also: each question can carry its tool calls (input, output, and the
 * compact form the model received, from the app's own compactToolOutput).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  get db() {
    return null;
  },
}));

import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { compactToolOutput } from "@/lib/chat/tools";
import { costOf, priceFor, stepWorstCase, STEP_INPUT_MARGIN_TOKENS } from "@/scripts/chat-eval/pricing";
import {
  guardedAsk,
  requestLimits,
  stepMayContinue,
  toolTraceFromChunks,
  type EvalOptions,
  type EvalSetup,
} from "@/scripts/chat-eval/run-golden";
import type { TransportDeps } from "@/scripts/chat-eval/transport";
import type { ExpectedContext } from "@/scripts/chat-eval/expected";

const MODEL = "claude-sonnet-5-5";

function usageLine(obj: Record<string, unknown>): string {
  return `[chat-usage] ${JSON.stringify({ conversationId: 7, scope: "all", model: MODEL, ...obj })}\n`;
}

function sse(chunks: Record<string, unknown>[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

describe("stepMayContinue", () => {
  it("only a step that ended with tool calls, before the last allowed step, has a step after it", () => {
    expect(stepMayContinue("tool-calls", 0, 8)).toBe(true);
    expect(stepMayContinue("stop", 0, 8)).toBe(false);
    expect(stepMayContinue("length", 1, 8)).toBe(false);
    expect(stepMayContinue("tool-calls", 7, 8)).toBe(false);
    // Unknown: assume another step may follow (the safe side).
    expect(stepMayContinue(null, 0, 8)).toBe(true);
  });
});

describe("guardedAsk: a finished turn is never booked as a ceiling abort", () => {
  it("books the measured cost when the last step's usage line is read before the finish chunk", async () => {
    const price = priceFor(MODEL)!;
    const s0 = { noCache: 4, cacheWrite: 3615, cacheRead: 32810, output: 217 };
    const s1 = { noCache: 2, cacheWrite: 4217, cacheRead: 36425, output: 5000 };
    const limits = requestLimits(22000);
    const next = (u: typeof s0) =>
      stepWorstCase(u.noCache + u.cacheWrite + u.cacheRead + u.output + STEP_INPUT_MARGIN_TOKENS + 10, limits.maxOutputTokensPerStep, price);
    // After step 0 the next step fits; after step 1 it would not, but step 1 ended with "stop".
    const ceiling = costOf(s0, price) + next(s0) + 0.005;
    expect(costOf(s0, price) + costOf(s1, price) + next(s1)).toBeGreaterThan(ceiling);

    // The whole log is there before the first chunk is read (the race).
    const log =
      usageLine({ kind: "step", step: 0, ...s0, finishReason: "tool-calls" }) +
      usageLine({ kind: "step", step: 1, ...s1, finishReason: "stop" }) +
      usageLine({ kind: "turn", steps: 2, noCache: 6, cacheWrite: 7832, cacheRead: 69235, output: 5217, finishReason: "stop" });
    const body = sse([
      { type: "start" },
      { type: "start-step" },
      { type: "tool-input-start", toolCallId: "c1", toolName: "query_scenarios" },
      { type: "tool-input-available", toolCallId: "c1", toolName: "query_scenarios", input: {} },
      { type: "tool-output-available", toolCallId: "c1", output: { ok: 1 } },
      { type: "finish-step" },
      { type: "start-step" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "The answer." },
      { type: "finish-step" },
      { type: "finish", finishReason: "stop", messageMetadata: { finishReason: "stop", stepCount: 2 } },
    ]);
    const deps: TransportDeps = {
      fetch: (async () =>
        new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "x-conversation-id": "7" } })) as typeof fetch,
      readLogSince: () => log,
      logSize: () => 0,
      sleep: async () => {},
    };
    const db = new Database(":memory:");
    runMigrations(db);
    const setup: EvalSetup = { dbPath: ":memory:", db, expected: { today: "2026-11-12" } as ExpectedContext, predictedModel: MODEL };
    const opts = {
      baseUrl: "http://127.0.0.1:3095",
      timeoutMs: 10000,
      toolResultChars: 22000,
      maxUsdPerQuestion: ceiling,
    } as EvalOptions;
    const r = await guardedAsk(
      opts,
      setup,
      deps,
      { session: { rawToken: "x", csrfToken: "y" }, chatId: "c", scope: "all", conversationId: null, messages: [] },
      { baseInputTokens: 40000, firstStepWorst: 0.2, oneStepWorst: 0.3 },
      limits,
    );
    expect(r.ceilingAborted).toBe(false);
    expect(r.ex.stoppedByRunner).toBeNull();
    expect(r.ex.summary.text).toBe("The answer.");
    expect(r.priced.inFlightBookedUsd).toBeNull();
    expect(r.priced.costUsd).toBeCloseTo(costOf(s0, price) + costOf(s1, price), 9);
  });
});

describe("toolTraceFromChunks", () => {
  it("pairs each call's input with its output and the compact form the model received", () => {
    const output = {
      data: [
        { symbol: "AAA", market_value: 1000.123, sector: "Tech" },
        { symbol: "BBB", market_value: 2000.456, sector: "Tech" },
      ],
    };
    const trace = toolTraceFromChunks([
      { type: "tool-input-available", toolCallId: "a", toolName: "query_holdings", input: { symbol: "AAA" } },
      { type: "tool-output-available", toolCallId: "a", output },
      { type: "tool-input-available", toolCallId: "b", toolName: "query_twr", input: {} },
      { type: "tool-output-error", toolCallId: "b", errorText: "boom" },
    ]);
    expect(trace).toEqual([
      { toolCallId: "a", name: "query_holdings", input: { symbol: "AAA" }, output, compactOutput: compactToolOutput("query_holdings", output), error: null },
      { toolCallId: "b", name: "query_twr", input: {}, output: null, compactOutput: null, error: "boom" },
    ]);
  });
});
