/**
 * The chat evaluation's pure parts (plan 2026-11-11, Task 9): the scorer,
 * the price table and budget guard, the usage-line and stream readers, the
 * cache verdicts and the database guard, plus one end-to-end check of the
 * in-question cost ceiling against the real route with a STUBBED model
 * (no network, no live AI). The evaluation itself never runs here.
 */

import { describe, it, expect, vi } from "vitest";
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
import fs from "node:fs";
import {
  budgetAllows,
  CHARS_PER_TOKEN,
  ceilingAllowsNextStep,
  costOf,
  inFlightStepWorstCase,
  priceFor,
  QUESTION_RESERVE_USD,
  runGuarantee,
  STEP_INPUT_MARGIN_TOKENS,
  stepWorstCase,
  worstCaseInputTokens,
} from "@/scripts/chat-eval/pricing";
import { buildGolden, NOT_FOR_FILING, STALE_WORDS } from "@/scripts/chat-eval/golden";
import { behaviourFlags } from "@/scripts/chat-eval/scorer";
import type { ExpectedContext } from "@/scripts/chat-eval/expected";
import type { EvalManifest } from "@/scripts/chat-eval/manifest";
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

  it("one step's worst case: whole input at the dearer input rate plus the maximum output", () => {
    const price = { input: 2, cacheWrite: 2.5, cacheRead: 0.1, output: 10 };
    expect(stepWorstCase(10000, 1000, price)).toBeCloseTo((10000 * 2.5 + 1000 * 10) / 1e6, 12);
    expect(worstCaseInputTokens(3700)).toBe(1050);
  });

  it("the in-flight step: base + earlier tool results + earlier output (at most ceiling / output price) + margin", () => {
    const price = { input: 2, cacheWrite: 2.5, cacheRead: 0.1, output: 10 };
    const limits = { maxSteps: 4, maxOutputTokensPerStep: 1000, toolResultTokensPerStep: 500 };
    // earlier output: min(3 x 1000, 0.02 / $10 per M = 2000) = 2000 tokens
    const input = 10000 + 3 * 500 + 2000 + STEP_INPUT_MARGIN_TOKENS;
    expect(inFlightStepWorstCase(10000, limits, 0.02, price)).toBeCloseTo(stepWorstCase(input, 1000, price), 12);
    // a large ceiling is capped by the step limit's own output
    const input2 = 10000 + 3 * 500 + 3000 + STEP_INPUT_MARGIN_TOKENS;
    expect(inFlightStepWorstCase(10000, limits, 100, price)).toBeCloseTo(stepWorstCase(input2, 1000, price), 12);
  });

  it("the run and in-question rules", () => {
    // start rule: spent + per-question ceiling must fit the run cap
    expect(budgetAllows(2.8, 0.6, 3.4).run).toBe(true);
    expect(budgetAllows(2.81, 0.6, 3.4).run).toBe(false);
    expect(budgetAllows(Number.NaN, 0.6, 3.4).run).toBe(false);
    // in-question: stop when running + next step worst would pass the ceiling
    expect(ceilingAllowsNextStep(0.2, 0.4, 0.6)).toBe(true);
    expect(ceilingAllowsNextStep(0.21, 0.4, 0.6)).toBe(false);
    // guarantee: cap + one step in flight (+ any first-step excess over the ceiling)
    expect(runGuarantee(3.4, 0.6, 0.5, 0.4).guaranteedMax).toBeCloseTo(3.9, 12);
    expect(runGuarantee(3.4, 0.6, 0.5, 0.8).guaranteedMax).toBeCloseTo(4.1, 12);
  });

  it("the budget uses the route's own limits (pinned to the route source)", () => {
    const route = fs.readFileSync(path.resolve("app/api/chat/route.ts"), "utf8");
    const runner = fs.readFileSync(path.resolve("scripts/chat-eval/run-golden.ts"), "utf8");
    const routeMax = /maxOutputTokens:\s*(\d+)/.exec(route)?.[1];
    expect(routeMax).toBeDefined();
    expect(runner).toContain(`ROUTE_MAX_OUTPUT_TOKENS = ${routeMax};`);
    expect(route).toMatch(/stopWhen:\s*stepCountIs\(MAX_CHAT_STEPS\)/);
    expect(runner).toMatch(/maxSteps: MAX_CHAT_STEPS/);
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

  it("prices a request from its step lines and never assumes zero for missing usage", () => {
    const base = {
      toolCalls: [] as string[],
      httpStatus: 200,
      ceilingAbort: false,
      abnormalEnd: false,
      inFlightBooking: null,
      stepWorst: 0.5,
      expectedModel: "claude-sonnet-4-6",
    };
    const sonnet = priceFor("claude-sonnet-4-6")!;
    const [g] = splitTurns(parseUsageLines([step(1, 0, 0), turn(1, 1)].join("\n")), 1);
    const one = costOf(g.steps[0].usage, sonnet);
    const priced = priceTurn({ ...base, turn: g, streamedSteps: 1 });
    expect(priced.reserveReason).toBeNull();
    expect(priced.usageMissing).toBeNull();
    expect(priced.costUsd).toBeCloseTo(one, 12);
    // two steps streamed, one usage line: one step worst case booked, run stops
    const short = priceTurn({ ...base, turn: g, streamedSteps: 2 });
    expect(short.usageMissing).toMatch(/1 step/);
    expect(short.costUsd).toBeCloseTo(one + 0.5, 12);
    // a ceiling abort books the in-flight step at the runner's figure and does not stop the run
    const ceil = priceTurn({ ...base, turn: g, streamedSteps: 1, ceilingAbort: true, inFlightBooking: 0.3 });
    expect(ceil.costUsd).toBeCloseTo(one + 0.3, 12);
    expect(ceil.usageMissing).toBeNull();
    // any other abnormal end books one step worst case and stops the run
    const odd = priceTurn({ ...base, turn: g, streamedSteps: 1, abnormalEnd: true });
    expect(odd.costUsd).toBeCloseTo(one + 0.5, 12);
    expect(odd.usageMissing).not.toBeNull();
    // no lines at all on a 200
    expect(priceTurn({ ...base, turn: undefined, streamedSteps: 0 }).costUsd).toBe(0.5);
    // refused before the model call
    expect(priceTurn({ ...base, turn: undefined, streamedSteps: null, httpStatus: 429 }).costUsd).toBe(0);
    // a model other than the guarantee's
    expect(priceTurn({ ...base, turn: g, streamedSteps: 1, expectedModel: "claude-opus-5-5" }).usageMissing).toMatch(/priced for/);
    // nested AI tool adds the reserve
    expect(priceTurn({ ...base, turn: g, streamedSteps: 1, toolCalls: ["query_filing_section"] }).costUsd).toBeCloseTo(one + QUESTION_RESERVE_USD, 12);
    const unknown = splitTurns(parseUsageLines(formatUsageLine("turn", { conversationId: 2, scope: "all", model: "claude-x", steps: 1, noCache: 1, cacheWrite: 1, cacheRead: 1, output: 1, finishReason: "stop" })), 2);
    const u = priceTurn({ ...base, turn: unknown[0], streamedSteps: 0 });
    expect(u.unknownModel).toBe("claude-x");
    expect(u.costUsd).toBe(0.5);
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

describe("figure bindings and signs (RF-11)", () => {
  it("unitAfter: a days figure must be followed by 'days'", () => {
    const t = { absTol: 1, unitAfter: /(more |calendar )?days?\b/ };
    expect(findNumber("about 106 days to go, and 67 shares", 66, t)).toBeNull();
    expect(findNumber("66 more days until long-term", 66, t)).not.toBeNull();
  });

  it("near: the figure must share a line with its label", () => {
    const t = { absTol: 1, near: /dividend/ };
    expect(findNumber("Interest: $851.20\nDividends were small.", 851.2, t)).toBeNull();
    expect(findNumber("| Dividends | $851.20 |", 851.2, t)).not.toBeNull();
  });

  it("signed: loss words, minus signs and parentheses all make a figure negative", () => {
    const t = { absTol: 1, signed: true };
    expect(findNumber("a gain of $420.50", -420.5, t)).toBeNull();
    expect(findNumber("a loss of $420.50", -420.5, t)).not.toBeNull();
    expect(findNumber("($420.50)", -420.5, t)).not.toBeNull();
    expect(findNumber("-$420.50", -420.5, t)).not.toBeNull();
    expect(findNumber("$420.50 lower", -420.5, t)).not.toBeNull();
    expect(findNumber("a loss of $420.50", 420.5, t)).toBeNull();
  });

  it("the tightened caveat patterns", () => {
    const s = (text: string, re: RegExp) => scoreAnswer(answer(text), [{ kind: "contains", label: "x", pattern: re }]).pass;
    expect(s("Short-term 155.58. (My estimate.)", NOT_FOR_FILING)).toBe(false);
    expect(s("These figures are not for filing.", NOT_FOR_FILING)).toBe(true);
    expect(s("Everything checks out as of 2026-11-11 and looks good.", STALE_WORDS)).toBe(false);
    expect(s("Several prices are stale.", STALE_WORDS)).toBe(true);
  });
});

// One plausible WRONG answer per golden question (it must fail) and one
// right answer (it must pass), on a synthetic expected context.
const MANIFEST: EvalManifest = {
  version: "1",
  builtFor: "2026-11-11",
  priceDay: "2026-11-11",
  accounts: { taxable: "Vanguard Taxable", roth: "Vanguard Roth IRA", ibkr: "IBKR" },
  rothLoser: "ROTHL",
  harvestCandidate: "HRVST",
  pendingLot: "PNDG",
  short: "SHRT",
  foreign: { symbol: "KAIZN", currency: "JPY" },
  longTermWait: { symbol: "LTWT", acquired: "2026-01-14" },
  bill: { symbol: "912797ZZ9", maturity: "2026-12-26" },
  liveOption: { symbol: "AAPL  261201C00260000", underlying: "AAPL", expiry: "2026-12-01" },
  expiredOption: { symbol: "NVDA  261101C00150000", underlying: "NVDA", expiry: "2026-11-01" },
  reinvestedDividend: { symbol: "VTI", date: "2026-09-27" },
  multiAccountName: "MSFT",
  multiAccountOption: { symbol: "MSFT  261226C00480000", expiry: "2026-12-26" },
  staleName: "JNJ",
  unknownTicker: "ZZZZ",
};

const X: ExpectedContext = {
  today: "2026-11-11",
  manifest: MANIFEST,
  registeredTools: [],
  ibkrTopWeight: { symbol: "912828ZQ7", name: "US Treasury Note 2.875% 2032", accountWeightPct: 35.35, accountValueWeightPct: 31.2, wholeBookWeightPct: 8.7 },
  dividends12m: { single: 851.2, naiveDoubleCount: 971.2, marginInterestPaid: 35 },
  realized: {
    year: 2026,
    shortTerm: -420.5,
    longTerm: 310.25,
    lifetimeAllAccounts: 900,
    closedThisYear: ["AAPL", "TSLA"],
    closedOtherYearsOnly: ["GOOGL"],
  },
  foreign: { symbol: "KAIZN", currency: "JPY", nativePrice: 950, usdValue: 627, quantity: 100 },
  longTermWait: { symbol: "LTWT", daysToLongTerm: 66, unrealizedGain: 600 },
  previousMonthName: "October",
  stalePriceDate: "2026-11-05",
  shortDayEffect: -60,
  harvestLoss: -300,
  excludedLosses: { roth: -500, pending: -150 },
};

const LONG_REVIEW =
  "Performance: the time-weighted return this year is 6.1% against SPY at 9.4%, so you trail the index. " +
  "Risk: volatility is moderate and the largest drawdown this year was 7%; concentration in the bond and in MSFT is the main risk. " +
  "Tax: HRVST is a harvest candidate in the taxable account; realized short-term results are a small loss, and these are not for filing. " +
  "Upcoming: AAPL earnings this week on Thursday at 16:30 ET, and the Treasury bill matures on 2026-12-26. " +
  "Overall the book is in reasonable shape; the main open questions are the cash level, whether to keep the short, and how much bond exposure you want once the bill matures.";

type Case = { tools: string[]; right: string; wrong: string; wrongTools?: string[] };
const CASES: Record<string, Case> = {
  Q1: {
    tools: ["query_twr"],
    right: "Time-weighted return (TWR) from 2026-01-01 to 2026-10-31: 6.1%. Money-weighted (XIRR): 5.8%.",
    wrong: "You are up 8.2% this year, the sum of monthly returns.",
    wrongTools: ["query_performance"],
  },
  Q2: {
    tools: ["query_market_snapshot"],
    right: "As of 2026-11-11: SHRT rose 4.5%, a loss of $60 for your short.",
    wrong: "As of 2026-11-11: SHRT rose 4.5%, adding $60 to the book.",
  },
  Q3: {
    tools: ["query_performance_vs_benchmark"],
    right: "Your TWR was 6.1% against SPY at 9.4% over 2026-01-01 to 2026-10-31.",
    wrong: "The S&P is up roughly 15% for the S&P this year, from memory, so you are behind.",
    wrongTools: [],
  },
  Q4: {
    tools: ["query_performance_vs_benchmark"],
    right: "In October the main contributors were MSFT (+0.4%), while TSLA detracted (-0.2%).",
    wrong: "Your largest holdings today are MSFT and TSLA, so they drove the result.",
    wrongTools: ["query_holdings"],
  },
  Q5: {
    tools: ["query_tax_lots"],
    right: "HRVST is the one candidate, a loss of $300 in Vanguard Taxable. Mind the wash-sale rule.",
    wrong: "Candidates: HRVST, ROTHL and PNDG. Mind the wash-sale rule.",
  },
  Q6: {
    tools: ["query_realized_gains"],
    right: "Short-term: a loss of $420.50, from the AAPL calls and the TSLA sale. Long-term: a gain of $310.25. These are not for filing.",
    wrong: "Short-term: a gain of $420.50, from the AAPL calls and the TSLA sale. Long-term: a gain of $310.25. These are not for filing.",
  },
  Q7: {
    tools: ["query_options_book"],
    right: "One contract expires in the window: the AAPL $260 call on 2026-12-01.",
    wrong: "The AAPL $260 call expires 2026-12-01 and the NVDA $150 call expires 2026-11-01.",
  },
  Q8: {
    tools: ["query_scenarios"],
    right: "A 20% market drop costs about 18% of the book; two positions could not be modelled and are listed below.",
    wrong: "With a beta of 1.1, beta × value gives roughly a 22% drop.",
    wrongTools: [],
  },
  Q9: {
    tools: [],
    right: "The US Treasury Note is your biggest IBKR position at 35.4% of long market value.",
    wrong: "The US Treasury Note is your biggest position at 8.7% of the book.",
  },
  Q10: {
    tools: [],
    right: "The US Treasury Bill matures on 2026-12-26; the 2032 note is years out.",
    wrong: "Your bond book has a duration of about 6.2 years; the note matures in 2032.",
  },
  Q11: {
    tools: ["query_income_summary"],
    right: "Dividend income over the last 12 months: $851.20.",
    wrong: "Dividend income over the last 12 months: $971.20.",
  },
  Q12: {
    tools: ["query_data_confidence"],
    right: "Mostly, but JNJ is stale: last priced 2026-11-05.",
    wrong: "Everything checks out as of 2026-11-11 and looks good.",
  },
  Q13: {
    tools: [],
    right:
      "My read: I would wait. You have 66 days until the lot turns long-term, with a gain of $600. Assuming a 20-point rate gap between short- and long-term rates, waiting saves about $120.",
    wrong: "My read: I would wait, assuming a rate gap of 20 points. The lot has $600.00 of gain; you have about 106 days to go, and 67 shares.",
  },
  Q14: {
    tools: ["query_calendar_events"],
    right: "AAPL reports Thursday at 16:30 ET, after the close.",
    wrong: "AAPL already reported, before the open tomorrow.",
  },
  Q15: {
    tools: ["query_holdings"],
    right: "You hold 100 shares of KAIZN at ¥950 (JPY), worth $627.",
    wrong: "You hold 100 KAIZN at $950 per share (JPY), worth $627.",
  },
  Q16: {
    tools: ["query_holdings", "query_options_greeks"],
    right: "Delta-adjusted MSFT exposure: Vanguard Taxable 80 shares; IBKR 100 shares less 35 delta on the short call.",
    wrong: "MSFT: 180 shares plus $600 of option premium in total exposure.",
  },
  Q17: {
    tools: ["query_notes"],
    right: "There is no security ZZZZ on file, so there are no notes about it.",
    wrong: "Your notes on ZZZZ say the margins look strong.",
  },
  Q18: {
    tools: ["query_twr", "query_risk"],
    right: LONG_REVIEW,
    wrong: "Performance is fine, risk is moderate, tax is in order and earnings are upcoming.",
  },
};

describe("golden questions: one right and one plausible wrong answer each", () => {
  const golden = buildGolden(X);
  it("covers all 18 questions", () => {
    expect(golden.map((q) => q.id)).toEqual(Object.keys(CASES));
  });
  for (const q of golden) {
    const c = CASES[q.id];
    it(`${q.id}: the right answer passes`, () => {
      const r = scoreAnswer(answer(c.right, { toolCalls: c.tools }), q.checks);
      expect(r.checks.filter((k) => !k.pass)).toEqual([]);
      expect(r.pass).toBe(true);
    });
    it(`${q.id}: the wrong answer fails`, () => {
      const r = scoreAnswer(answer(c.wrong, { toolCalls: c.wrongTools ?? c.tools }), q.checks);
      expect(r.pass).toBe(false);
    });
  }
});

// ─── The abort path, end to end with a stubbed model (no network, no live AI) ──
//
// The REAL chat route runs in process with a MockLanguageModelV3 behind
// getModelForFeature; the runner talks to it through a fetch that streams
// the route's own Response and passes the abort signal through. The
// fixture database is built here (migrated temp file + buildEvalFixture).

const stub = vi.hoisted(() => ({ db: null as unknown, model: null as unknown }));
vi.mock("@/lib/db", () => ({
  get db() {
    return stub.db;
  },
}));
vi.mock("@/lib/ai/provider", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/provider")>("@/lib/ai/provider");
  return { ...actual, getModelForFeature: () => stub.model };
});
vi.mock("@/lib/env", async () => {
  const actual = await vi.importActual<typeof import("@/lib/env")>("@/lib/env");
  return { ...actual, getAnthropicApiKey: () => "sk-test-stub" };
});

describe("the in-question cost ceiling, with a stubbed model", () => {
  it("three expensive steps: aborts after the step that would let the next pass the ceiling, never runs a fourth, books exactly what it saw", async () => {
    const [{ default: Database }, { NextRequest }, { MockLanguageModelV3 }, { runMigrations }, { upsertSecurity }, { buildEvalFixture }, { todayET }, { main }] =
      await Promise.all([
        import("better-sqlite3"),
        import("next/server"),
        import("ai/test"),
        import("@/lib/db/migrate"),
        import("@/lib/mutations/securities"),
        import("@/scripts/chat-eval/build-eval-db"),
        import("@/lib/calendar/date-utils"),
        import("@/scripts/chat-eval/run-golden"),
      ]);
    const { POST } = await import("@/app/api/chat/route");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-eval-abort-"));
    const dbPath = path.join(dir, "eval.db");
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    runMigrations(db);
    // A minimal stand-in for the demo seed: two securities and one snapshot per account.
    const vtiId = upsertSecurity(db, { symbol: "VTI", name: "Total Market ETF", securityType: "etf", assetClass: "equity" });
    const jnjId = upsertSecurity(db, { symbol: "JNJ", name: "Johnson & Johnson", securityType: "stock", assetClass: "equity" });
    db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-03-27', 300, 'demo'), (?, '2026-03-27', 150, 'demo')").run(vtiId, jnjId);
    for (const acct of [1, 2, 3]) {
      db.prepare(
        "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (?, ?, 10, 1000, '2026-03-27', ?)",
      ).run(acct, acct === 3 ? jnjId : vtiId, `demo-hold-${acct}`);
    }
    db.transaction(() => buildEvalFixture(db, todayET()))();
    stub.db = db;

    // Every step: a tool call, 40k tokens written to cache and 1k output.
    let calls = 0;
    stub.model = new MockLanguageModelV3({
      modelId: "claude-sonnet-4-6",
      // Like a real provider fetch, the step honours the abort signal.
      doStream: async ({ abortSignal }) => {
        calls++;
        if (abortSignal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
        const usage = {
          inputTokens: { total: 40010, noCache: 10, cacheRead: 0, cacheWrite: 40000 },
          outputTokens: { total: 1000, text: 1000, reasoning: 0 },
        };
        const parts = [
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: `x${calls}`, toolName: "query_holdings", input: JSON.stringify({ limit: 1 }) },
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
        ];
        return {
          stream: new ReadableStream({
            async start(controller) {
              const aborted = await new Promise<boolean>((r) => {
                const timer = setTimeout(() => r(false), 200);
                abortSignal?.addEventListener("abort", () => {
                  clearTimeout(timer);
                  r(true);
                });
              });
              if (aborted) {
                controller.error(new DOMException("The operation was aborted.", "AbortError"));
                return;
              }
              for (const p of parts) controller.enqueue(p);
              controller.close();
            },
          }),
        } as unknown as Awaited<ReturnType<InstanceType<typeof MockLanguageModelV3>["doStream"]>>;
      },
    });

    let log = "";
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      const line = args.map(String).join(" ");
      if (line.startsWith("[chat-usage]")) log += line + "\n";
    });
    const deps = {
      fetch: (async (url: string | URL, init?: RequestInit) =>
        POST(new NextRequest(String(url), init as ConstructorParameters<typeof NextRequest>[1]))) as typeof fetch,
      readLogSince: (from: number) => log.slice(from),
      logSize: () => log.length,
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    };
    const out = path.join(dir, "e.json");
    try {
      await main(["--db", dbPath, "--log", path.join(dir, "server.log"), "--only", "Q9", "--out", out, "--max-usd", "1.3"], deps, () => {});
    } finally {
      spy.mockRestore();
    }
    const report = JSON.parse(fs.readFileSync(out, "utf8"));
    const q = report.questions[0];
    expect(q.status).toBe("aborted-cost-ceiling");
    expect(q.score.pass).toBe(false);
    // Step 1: $0.165 spent + next-step worst $0.40 = $0.565 <= $0.60, go on.
    // Step 2: $0.33 + $0.40 > $0.60, abort while step 3 is in flight.
    expect(q.perStep).toHaveLength(2);
    expect(calls).toBeLessThanOrEqual(3);
    await new Promise((r) => setTimeout(r, 600));
    expect(calls).toBeLessThanOrEqual(3); // no fourth step after the abort
    // Booked = the two usage lines seen + the in-flight step at the runner's next-step worst case.
    const sonnet = priceFor("claude-sonnet-4-6")!;
    const linesSum = q.perStep.reduce((s: number, st: { usage: Parameters<typeof costOf>[0] }) => s + costOf(st.usage, sonnet), 0);
    expect(linesSum).toBeCloseTo(2 * costOf({ noCache: 10, cacheWrite: 40000, cacheRead: 0, output: 1000 }, sonnet), 12);
    // the in-flight booking is the next-step worst case from the real sizes (the step-2 tool result adds a little)
    const floor = stepWorstCase(40010 + 1000 + STEP_INPUT_MARGIN_TOKENS, 16000, sonnet);
    expect(q.inFlightBookedUsd).toBeGreaterThanOrEqual(floor);
    expect(q.inFlightBookedUsd).toBeLessThan(floor + 0.05);
    expect(q.costUsd).toBeCloseTo(linesSum + q.inFlightBookedUsd, 9);
    expect(report.spentUsd).toBeCloseTo(q.costUsd, 9);
    // The run guarantee holds: total <= run cap + one step in flight.
    expect(report.spentUsd).toBeLessThanOrEqual(report.guaranteedMaxUsd);
    db.close();
  }, 30000);
});

// Live answers the 2026-11-11 run mis-scored, shortened and made synthetic.
describe("scorer regressions from the live run", () => {
  const golden = Object.fromEntries(buildGolden(X).map((q) => [q.id, q]));
  const score = (id: string, text: string, tools: string[]) => scoreAnswer(answer(text, { toolCalls: tools }), golden[id].checks);

  it("Q4: an explicit no-data answer for the month passes (was a false fail)", () => {
    const r = score("Q4", "No October 2026 statement has been imported into the ledger, so last month cannot be attributed.", ["query_performance_vs_benchmark"]);
    expect(r.checks.filter((c) => !c.pass)).toEqual([]);
  });

  it("Q5: a hand-summed total that adds the Roth loss fails (was a false pass)", () => {
    const r = score("Q5", "HRVST is the candidate, a loss of $300 in Vanguard Taxable. Total harvestable: $800. Mind the wash-sale rule.", ["query_tax_lots"]);
    expect(r.pass).toBe(false);
    expect(r.checks.find((c) => c.label.includes("Roth loss"))?.pass).toBe(false);
  });

  it("Q5: a wrong figure for the candidate fails", () => {
    const r = score("Q5", "HRVST is the candidate, a loss of $1,000 in Vanguard Taxable. Mind the wash-sale rule.", ["query_tax_lots"]);
    expect(r.pass).toBe(false);
  });

  it("Q6: naming a sale from another year as the source fails (was a false pass)", () => {
    const r = score("Q6", "Short-term: a loss of $420.50, all from the GOOGL sale. Long-term: a gain of $310.25. Not for filing.", ["query_realized_gains"]);
    expect(r.pass).toBe(false);
  });

  it("Q9: the figure taken from the labelled context, with no tool call, passes (was a false fail)", () => {
    const r = score("Q9", "| Position | Weight (% of long MV) |\n|---|---:|\n| 912828ZQ7 (US Treasury Note) | 35.7% |", []);
    expect(r.checks.filter((c) => !c.pass)).toEqual([]);
  });

  it("Q13: a rate-gap table that depends on the bracket counts as labelled (was a false fail)", () => {
    const r = score(
      "Q13",
      "My read: wait. 66 days to go, a gain of $600. The tax saving depends on your rate gap: | 37% | 20% | about $100 |",
      [],
    );
    expect(r.checks.filter((c) => !c.pass)).toEqual([]);
  });

  it("Q14: an explicit empty calendar in other words passes (was a false fail)", () => {
    const r = score("Q14", "The calendar returned nothing for the next two weeks: zero events across all types.", ["query_calendar_events"]);
    expect(r.checks.filter((c) => !c.pass)).toEqual([]);
  });

  it("Q16: an answer of no live options now fails, because the fixture holds a live MSFT call", () => {
    const r = score("Q16", "MSFT: IBKR 100 shares, Vanguard Taxable 80 shares. No live options on file.", ["query_holdings"]);
    expect(r.pass).toBe(false);
  });

  it("Q18: crediting a sale from another year fails (was a false pass)", () => {
    const text = LONG_REVIEW.replace("realized short-term results are a small loss", "the realized gain came from the GOOGL sale");
    const r = score("Q18", text, ["query_twr"]);
    expect(r.pass).toBe(false);
  });
});

describe("harness fixes from the live run", () => {
  it("a provider error before any output (the 404 run) costs nothing", () => {
    const r = priceTurn({
      turn: undefined,
      toolCalls: [],
      httpStatus: 200,
      streamedSteps: 0,
      ceilingAbort: false,
      abnormalEnd: false,
      inFlightBooking: null,
      stepWorst: 0.81,
      expectedModel: "claude-sonnet-4-6",
      providerErrorBeforeOutput: true,
    });
    expect(r.costUsd).toBe(0);
    expect(r.usageMissing).toBeNull();
  });

  it("the token estimate uses the measured ratio (about 3.7 characters per token)", () => {
    // The live prefix: about 81,500 characters read back as 21,619 tokens.
    expect(Math.abs(81500 / CHARS_PER_TOKEN - 21619) / 21619).toBeLessThan(0.03);
  });
});

describe("run-2 regressions and rulings", () => {
  const golden = Object.fromEntries(buildGolden(X).map((q) => [q.id, q]));
  const score = (id: string, text: string, tools: string[]) => scoreAnswer(answer(text, { toolCalls: tools }), golden[id].checks);

  it("Q5: the wash-sale rule in other words passes", () => {
    const r = score("Q5", "HRVST is the candidate, a loss of $300 in Vanguard Taxable. Buying it back within 30 days could wash the loss.", ["query_tax_lots"]);
    expect(r.checks.filter((c) => !c.pass)).toEqual([]);
  });

  it("Q9: either base passes when stated; a bare percentage fails", () => {
    expect(score("Q9", "The US Treasury Note is 31.2% of account value, cash included.", []).pass).toBe(true);
    expect(score("Q9", "The US Treasury Note is 35.4% of invested positions.", []).pass).toBe(true);
    expect(score("Q9", "The US Treasury Note is your biggest position at 35.4%.", []).pass).toBe(false);
    expect(score("Q9", "The US Treasury Note is 35.4% of account value.", []).pass).toBe(false); // wrong figure for that base
  });

  it("Q6: an answer naming no sale fails", () => {
    expect(score("Q6", "Short-term: a loss of $420.50. Long-term: a gain of $310.25. Not for filing.", ["query_realized_gains"]).pass).toBe(false);
  });

  it("Q12: 'one is stale' without the security or its date fails", () => {
    expect(score("Q12", "Mostly fine, but one price is stale.", ["query_data_confidence"]).pass).toBe(false);
  });

  it("Q1: neither return labelled fails", () => {
    expect(score("Q1", "You are up 6.1% from 2026-01-01 to 2026-10-31.", ["query_twr"]).pass).toBe(false);
  });

  it("Q15 (decision: the native price is not required, the question asks how much is owned)", () => {
    expect(score("Q15", "You hold 100 shares of KAIZN, a JPY-listed stock, worth $627.", ["query_holdings"]).pass).toBe(true);
    expect(score("Q15", "You hold 100 shares of KAIZN at $950 (JPY), worth $627.", ["query_holdings"]).pass).toBe(false);
  });
});

describe("behaviour flags (counted per run, never scored)", () => {
  it("names a tool, field or parameter", () => {
    expect(behaviourFlags("I called query_holdings for this.").namesInternals).toBe(true);
    expect(behaviourFlags("The `day_effect` figure is not measured.").namesInternals).toBe(true);
    expect(behaviourFlags("The holdings show three names.").namesInternals).toBe(false);
  });

  it("opens with a progress announcement", () => {
    expect(behaviourFlags("Let me pull the full lot detail first. HRVST is the candidate.").progressOpening).toBe(true);
    expect(behaviourFlags("Pulling the numbers now.").progressOpening).toBe(true);
    expect(behaviourFlags("I'll check the calendar. Nothing is scheduled.").progressOpening).toBe(true);
    expect(behaviourFlags("First, I'll grab the lots.").progressOpening).toBe(true);
    expect(behaviourFlags("HRVST is the candidate.").progressOpening).toBe(false);
  });

  it("ends with an offer", () => {
    expect(behaviourFlags("Nothing is scheduled.\n\nWhich of those would be most useful, or want me to pull the transcripts?").offerEnding).toBe(true);
    expect(behaviourFlags("Done. Let me know if you want the lot detail.").offerEnding).toBe(true);
    expect(behaviourFlags("I can also run the scenario set.").offerEnding).toBe(true);
    expect(behaviourFlags("Let me know your bracket and I will refine it. The answer is to wait.").offerEnding).toBe(false);
  });
});
