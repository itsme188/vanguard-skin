/**
 * Chat evaluation: pure accounting and verdicts (unit-tested in
 * tests/scripts/chat-eval-scorer.test.ts). No database, network or clock.
 */

import { NESTED_AI_TOOLS, QUESTION_RESERVE_USD, ZERO_USAGE, addUsage, costOf, priceFor, type TokenUsage } from "./pricing";
import type { TurnUsage } from "./usage-lines";

export interface PricedTurn {
  model: string | null;
  steps: { step: number; usage: TokenUsage }[];
  usage: TokenUsage;
  costUsd: number;
  /** Why the cost is a booking rather than a pure measurement, or null. */
  reserveReason: string | null;
  /** A model id with no price: the run must stop. */
  unknownModel: string | null;
  /** Usage the run cannot account for (a step with no line): the run must stop. */
  usageMissing: string | null;
}

export interface PriceTurnInput {
  turn: TurnUsage | undefined;
  toolCalls: readonly string[];
  /** HTTP status of the request (a non-200 answer returned before any model call). */
  httpStatus: number;
  /** Steps the stream finished (`finish-step` chunks), or null when unknown. */
  streamedSteps: number | null;
  /** The request was aborted mid-stream (by the runner or a timeout). */
  aborted: boolean;
  /** The question's worst case, booked whenever usage cannot be measured in full. */
  worstCase: number;
  /** The model the guard priced the worst case with. */
  expectedModel: string;
}

/**
 * Price one request from its per-step usage lines. Never assumes zero: a
 * missing step line, a missing turn line, an aborted request or a model
 * other than the one the worst case was priced with books the WHOLE worst
 * case and flags the run to stop. A request refused before the model call
 * (non-200) costs nothing. Nested AI tools add the reserve per call. Pure.
 */
export function priceTurn(input: PriceTurnInput): PricedTurn {
  const { turn, toolCalls, httpStatus, streamedSteps, aborted, worstCase, expectedModel } = input;
  const steps = (turn?.steps ?? []).map((s) => ({ step: s.step ?? 0, usage: s.usage }));
  const stepSum = steps.reduce((acc, s) => addUsage(acc, s.usage), ZERO_USAGE);
  const usage = turn?.turn ? turn.turn.usage : stepSum;
  const model = turn?.turn?.model ?? turn?.steps[turn.steps.length - 1]?.model ?? null;
  const out: PricedTurn = { model, steps, usage, costUsd: 0, reserveReason: null, unknownModel: null, usageMissing: null };

  if (httpStatus !== 200) {
    out.reserveReason = `HTTP ${httpStatus || "error"}: refused before the model call, nothing booked`;
    return out;
  }
  const book = (why: string) => {
    out.costUsd = Math.max(out.costUsd, worstCase);
    out.reserveReason = `${why}; the question's worst case $${worstCase.toFixed(2)} booked`;
  };
  const price = priceFor(model);
  if (model !== null && !price) {
    out.unknownModel = model;
    book(`model ${model} has no price`);
    return out;
  }
  if (price) out.costUsd = costOf(usage, price);
  if (model !== null && model !== expectedModel) {
    out.usageMissing = `the server used ${model}, the guard priced ${expectedModel}`;
    book(out.usageMissing);
  }
  if (!turn || turn.turn === null) {
    out.usageMissing = out.usageMissing ?? "no turn usage line in the log";
    book(out.usageMissing);
  } else if (streamedSteps !== null && turn.steps.length < streamedSteps) {
    out.usageMissing = `${streamedSteps - turn.steps.length} step(s) streamed with no usage line`;
    book(out.usageMissing);
  }
  if (aborted) {
    out.usageMissing = out.usageMissing ?? "request aborted mid-step";
    book(out.usageMissing);
  }
  const nested = toolCalls.filter((t) => NESTED_AI_TOOLS.includes(t));
  if (nested.length > 0 && out.costUsd < worstCase) {
    out.costUsd += QUESTION_RESERVE_USD * nested.length;
    out.reserveReason = `${out.reserveReason ? out.reserveReason + "; " : ""}reserve added for nested AI tool(s) ${nested.join(", ")} (not in the chat log)`;
  }
  return out;
}


export interface CacheStepRow {
  label: string;
  conversationId: number | null;
  page: string | undefined;
  steps: { step: number; usage: TokenUsage }[];
  costUsd: number;
}

export interface CacheVerdict {
  id: string;
  check: string;
  result: "PASS" | "FAIL" | "RECORDED" | "NOT RUN";
  detail: string;
}

/** Is `read` the prefix alone (within 5% or 300 tokens of P)? */
export function isAboutPrefix(read: number, p: number): boolean {
  return Math.abs(read - p) <= Math.max(300, 0.05 * p);
}

/** Is `read` clearly beyond the prefix (the conversation tail was reused too)? */
export function isBeyondPrefix(read: number, p: number): boolean {
  return read > p + Math.max(300, 0.05 * p);
}

/**
 * The verdicts, from measured rows. Pure. `p` is the measured prefix, or
 * null when no request read only the prefix.
 */
export function cacheVerdicts(turns: readonly CacheStepRow[], p: number | null): CacheVerdict[] {
  const byLabel = (l: string) => turns.find((t) => t.label === l);
  const read = (row: CacheStepRow | undefined, step: number) => row?.steps.find((s) => s.step === step)?.usage.cacheRead ?? null;
  const out: CacheVerdict[] = [];
  const pText = p === null ? "unmeasured" : String(p);

  out.push(
    p === null
      ? { id: "P", check: "prefix (tools + static block) read on a fresh conversation", result: "FAIL", detail: "no request read a cached prefix: prefix caching is not working (or the prefix is under the model's minimum cacheable size)" }
      : { id: "P", check: "prefix (tools + static block) read on a fresh conversation", result: "PASS", detail: `P = ${p} cache-read tokens` },
  );

  const a = byLabel("A1");
  const aStep1 = read(a, 1);
  if (!a || aStep1 === null) {
    out.push({ id: "a", check: "tool question: step 2 reads the cache", result: "NOT RUN", detail: a ? "the turn had one step (no tool call)" : "turn not run" });
  } else {
    const ok = aStep1 > 0 && (p === null || aStep1 >= p * 0.95);
    out.push({
      id: "a",
      check: "tool question: step 2 reads the cache (>= P)",
      result: ok ? "PASS" : "FAIL",
      detail: `step 2 cacheRead ${aStep1}, P ${pText}${p !== null && isBeyondPrefix(aStep1, p) ? " (prefix and in-turn tail reused)" : ""}`,
    });
  }

  const b = read(byLabel("A2"), 0);
  if (b === null) out.push({ id: "b", check: "second turn, same page: tail reuse", result: "NOT RUN", detail: "turn not run" });
  else {
    const ok = p !== null && isBeyondPrefix(b, p);
    out.push({
      id: "b",
      check: "second turn, nothing volatile changed: step 1 reads beyond P (tail reuse)",
      result: ok ? "PASS" : "FAIL",
      detail: `turn-2 step-1 cacheRead ${b}, P ${pText}${ok ? "" : " (no tail reuse: see OPEN-2, markLastMessageForCache)"}`,
    });
  }

  const b2 = read(byLabel("A3"), 0);
  if (b2 === null) out.push({ id: "b2", check: "turn after a page change", result: "NOT RUN", detail: "turn not run" });
  else {
    out.push({
      id: "b2",
      check: "turn after a page change: cacheRead about P (expected, D7)",
      result: "RECORDED",
      detail: `cacheRead ${b2}, P ${pText}; ${p === null ? "" : isAboutPrefix(b2, p) ? "prefix only, as expected" : isBeyondPrefix(b2, p) ? "beyond the prefix (the page note did not invalidate the history)" : "below the prefix"}`,
    });
  }
  return out;
}
