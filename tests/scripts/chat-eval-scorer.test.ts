/**
 * The chat evaluation's pure parts (plan 2026-11-11, Task 9): the scorer,
 * the price table and budget guard, the usage-line and stream readers, the
 * cache verdicts and the database guard. Network-free and model-free; the
 * evaluation itself (scripts/chat-eval/run-golden.ts) never runs here.
 */

import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import {
  answerGate,
  findNumber,
  parseNumbers,
  scoreAnswer,
  type Check,
  type EvalAnswer,
} from "@/scripts/chat-eval/scorer";
import {
  budgetAllows,
  costOf,
  nextQuestionEstimate,
  priceFor,
  QUESTION_RESERVE_USD,
} from "@/scripts/chat-eval/pricing";
import { parseUsageLines, splitTurns } from "@/scripts/chat-eval/usage-lines";
import { summarizeSseBody } from "@/scripts/chat-eval/ui-stream";
import { cacheVerdicts, priceTurn, type CacheStepRow } from "@/scripts/chat-eval/accounting";
import { liveDbRefusal } from "@/scripts/chat-eval/db-guard";
import { formatUsageLine } from "@/lib/chat/usage-log";
import { CUT_OFF_SENTENCE } from "@/lib/chat/turn-outcome";

const answer = (text: string, extra: Partial<EvalAnswer> = {}): EvalAnswer => ({
  text,
  toolCalls: [],
  finishReason: "stop",
  ...extra,
});

describe("parseNumbers", () => {
  it("reads separators, currency, percent, suffixes and negatives", () => {
    const vals = (t: string) => parseNumbers(t).map((n) => n.value);
    expect(vals("$1,234.56")).toEqual([1234.56]);
    expect(vals("-$1,234")).toEqual([-1234]);
    expect(vals("$-1,234")).toEqual([-1234]);
    expect(vals("($1,234.56)")).toEqual([-1234.56]);
    expect(vals("(1,234)")).toEqual([-1234]);
    expect(vals("− 12.5%")).toEqual([-12.5]);
    expect(vals("$3.4M and $12.5K and 2bn")).toEqual([3_400_000, 12_500, 2_000_000_000]);
    expect(vals("JPY 2,500")).toEqual([2500]);
    expect(parseNumbers("12.5%")[0].percent).toBe(true);
  });

  it("ignores dates, clock times and digits glued to letters", () => {
    expect(parseNumbers("as of 2026-03-27 at 16:00, see the 10-K and Q1").map((n) => n.value)).toEqual([10]);
    expect(parseNumbers("S&P-500").map((n) => n.value)).toEqual([500]);
  });
});

describe("number checks", () => {
  it("matches within tolerance on absolute value by default", () => {
    expect(findNumber("a loss of $1,200.40", -1200, { absTol: 1 })).not.toBeNull();
    expect(findNumber("a loss of $1,202", -1200, { absTol: 1 })).toBeNull();
    expect(findNumber("down (1,200)", 1200, { absTol: 0.5, signed: true })).toBeNull();
    expect(findNumber("down (1,200)", -1200, { absTol: 0.5, signed: true })).not.toBeNull();
  });

  it("defaults to a 1% relative tolerance and honours percentOnly", () => {
    expect(findNumber("about $3,180", 3151.2)).not.toBeNull();
    expect(findNumber("about $3,200", 3151.2)).toBeNull();
    expect(findNumber("35 positions", 35.35, { absTol: 0.6, percentOnly: true })).toBeNull();
    expect(findNumber("35.4% of the account", 35.35, { absTol: 0.6, percentOnly: true })).not.toBeNull();
  });
});

describe("scoreAnswer", () => {
  const checks: Check[] = [
    { kind: "contains", label: "substring", pattern: "hrvst" },
    { kind: "contains", label: "regex", pattern: /wash[- ]sale/ },
    { kind: "notContains", label: "no roth", pattern: /\bROTHL\b/ },
    { kind: "number", label: "figure", value: 3151.2, absTol: 1 },
    { kind: "notNumber", label: "no double count", value: 3271.2, absTol: 0.5 },
    { kind: "calledTool", label: "tool", tool: ["query_tax_lots", "query_holdings"] },
    { kind: "notCalledTool", label: "no note", tool: "create_note" },
  ];

  it("passes when every check holds (case-insensitive text)", () => {
    const r = scoreAnswer(
      answer("Consider HRVST. Mind the Wash Sale rule. Dividends: $3,151.20.", { toolCalls: ["query_holdings"] }),
      checks,
    );
    expect(r.gate).toBeNull();
    expect(r.checks.filter((c) => !c.pass)).toEqual([]);
    expect(r.pass).toBe(true);
    expect(r.passed).toBe(7);
  });

  it("fails each kind when violated", () => {
    const r = scoreAnswer(
      answer("ROTHL and $3,271.20", { toolCalls: ["create_note"] }),
      checks,
    );
    expect(r.pass).toBe(false);
    expect(r.checks.map((c) => c.pass)).toEqual([false, false, false, false, false, false, false]);
  });

  it("an empty, errored or cut-off answer always fails, even with no checks", () => {
    expect(scoreAnswer(answer("   "), []).pass).toBe(false);
    expect(scoreAnswer(answer("fine", { error: "HTTP 500" }), []).gate).toMatch(/error/);
    for (const reason of ["tool-calls", "length", "content-filter", "error"]) {
      expect(answerGate(answer("partial text", { finishReason: reason }))).toMatch(/cut off/);
    }
    expect(scoreAnswer(answer(CUT_OFF_SENTENCE), []).pass).toBe(false);
    expect(scoreAnswer(answer(`Here is part.\n\n${CUT_OFF_SENTENCE}`), []).pass).toBe(false);
    expect(scoreAnswer(answer("A complete answer."), []).pass).toBe(true);
  });

  it("minLength counts trimmed characters", () => {
    const c: Check[] = [{ kind: "minLength", label: "long", chars: 10 }];
    expect(scoreAnswer(answer("  short  "), c).pass).toBe(false);
    expect(scoreAnswer(answer("long enough text"), c).pass).toBe(true);
  });
});

describe("prices and the budget guard", () => {
  it("prices a known id (snapshot suffix allowed) and refuses an unknown one", () => {
    expect(priceFor("claude-sonnet-4-6")).not.toBeNull();
    expect(priceFor("claude-haiku-4-5-20251001")).toEqual(priceFor("claude-haiku-4-5"));
    expect(priceFor("claude-unknown-9")).toBeNull();
    expect(priceFor(null)).toBeNull();
  });

  it("costs the four token kinds at their own rates", () => {
    const p = { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 };
    expect(costOf({ noCache: 1e6, cacheWrite: 1e6, cacheRead: 1e6, output: 1e6 }, p)).toBeCloseTo(22.05, 10);
  });

  it("checks spent + next estimate against the cap before each question", () => {
    expect(nextQuestionEstimate([])).toBe(QUESTION_RESERVE_USD);
    expect(nextQuestionEstimate([0.1, 0.5])).toBeCloseTo(0.75);
    expect(budgetAllows(3.5, 0.4, 4).run).toBe(true);
    expect(budgetAllows(3.61, 0.4, 4).run).toBe(false);
    expect(budgetAllows(Number.NaN, 0.4, 4).run).toBe(false);
  });
});

describe("usage lines", () => {
  const step = (conversationId: number, s: number, read: number) =>
    formatUsageLine("step", { conversationId, scope: "all", model: "claude-sonnet-4-6", step: s, noCache: 10, cacheWrite: 20, cacheRead: read, output: 5, finishReason: "stop" });
  const turn = (conversationId: number, steps: number) =>
    formatUsageLine("turn", { conversationId, scope: "all", model: "claude-sonnet-4-6", steps, noCache: 10 * steps, cacheWrite: 20 * steps, cacheRead: 100, output: 5 * steps, finishReason: "stop" });

  it("reads the route's own line format and groups lines per request", () => {
    const log = [
      "noise",
      step(7, 0, 0),
      step(8, 0, 1),
      step(7, 1, 40),
      turn(7, 2),
      "[chat-usage] {not json",
      step(7, 0, 60),
    ].join("\n");
    const lines = parseUsageLines(log);
    expect(lines).toHaveLength(5);
    const groups = splitTurns(lines, 7);
    expect(groups).toHaveLength(2);
    expect(groups[0].steps.map((s) => s.usage.cacheRead)).toEqual([0, 40]);
    expect(groups[0].turn?.steps).toBe(2);
    expect(groups[1].turn).toBeNull();
  });

  it("prices a turn from its turn line, books the reserve when lines are missing or the model is unknown", () => {
    const [g] = splitTurns(parseUsageLines([step(1, 0, 0), turn(1, 1)].join("\n")), 1);
    const priced = priceTurn(g, [], false);
    expect(priced.reserveReason).toBeNull();
    expect(priced.costUsd).toBeCloseTo(costOf(g.turn!.usage, priceFor("claude-sonnet-4-6")!), 12);
    expect(priceTurn(undefined, [], true).costUsd).toBe(QUESTION_RESERVE_USD);
    expect(priceTurn(g, ["query_filing_section"], false).costUsd).toBeCloseTo(priced.costUsd + QUESTION_RESERVE_USD, 12);
    const unknown = splitTurns(parseUsageLines(formatUsageLine("turn", { conversationId: 2, scope: "all", model: "claude-x", steps: 1, noCache: 1, cacheWrite: 1, cacheRead: 1, output: 1, finishReason: "stop" })), 2);
    expect(priceTurn(unknown[0], [], false).unknownModel).toBe("claude-x");
  });
});

describe("stream summary", () => {
  it("collects text, tool calls, steps and the route's finish metadata", () => {
    const sse = [
      { type: "start" },
      { type: "start-step" },
      { type: "tool-input-start", toolCallId: "a", toolName: "query_holdings" },
      { type: "tool-input-available", toolCallId: "a", toolName: "query_holdings", input: {} },
      { type: "finish-step" },
      { type: "start-step" },
      { type: "text-start", id: "1" },
      { type: "text-delta", id: "1", delta: "Hello " },
      { type: "text-delta", id: "1", delta: "there." },
      { type: "text-end", id: "1" },
      { type: "finish-step" },
      { type: "finish", finishReason: "stop", messageMetadata: { finishReason: "stop", stepCount: 2 } },
    ]
      .map((c) => `data: ${JSON.stringify(c)}\n`)
      .join("\n") + "\ndata: [DONE]\n";
    const s = summarizeSseBody(sse);
    expect(s.text).toBe("Hello there.");
    expect(s.toolCalls).toEqual(["query_holdings"]);
    expect(s.stepCount).toBe(2);
    expect(s.finishSteps).toBe(2);
    expect(s.finishReason).toBe("stop");
    expect(s.done).toBe(true);
  });
});

describe("cache verdicts", () => {
  const row = (label: string, reads: number[]): CacheStepRow => ({
    label,
    conversationId: 1,
    page: undefined,
    steps: reads.map((r, i) => ({ step: i, usage: { noCache: 0, cacheWrite: 0, cacheRead: r, output: 0 } })),
    costUsd: 0,
  });

  it("tells prefix reuse from tail reuse", () => {
    const v = Object.fromEntries(
      cacheVerdicts([row("A1", [20000, 22400]), row("A2", [23300]), row("A3", [20050])], 20000).map((x) => [x.id, x.result]),
    );
    expect(v).toEqual({ P: "PASS", a: "PASS", b: "PASS", b2: "RECORDED" });
  });

  it("fails tail reuse when turn 2 reads only the prefix, and fails P when nothing was read", () => {
    const v = Object.fromEntries(cacheVerdicts([row("A1", [20000, 20000]), row("A2", [20100])], 20000).map((x) => [x.id, x.result]));
    expect(v.b).toBe("FAIL");
    expect(cacheVerdicts([], null)[0].result).toBe("FAIL");
  });
});

describe("database guard", () => {
  it("requires --db and refuses any file named vanguard.db", () => {
    expect(liveDbRefusal(undefined)).toMatch(/required/);
    expect(liveDbRefusal(path.join("data", "vanguard.db"))).toMatch(/live database/);
    expect(liveDbRefusal(path.join(os.tmpdir(), "elsewhere", "VANGUARD.DB"))).toMatch(/live database/);
    expect(liveDbRefusal(path.join(os.tmpdir(), "chat-eval", "eval.db"))).toBeNull();
  });
});
