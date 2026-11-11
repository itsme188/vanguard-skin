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
  /** What was booked for a step in flight when the request was stopped, or null. */
  inFlightBookedUsd: number | null;
}

export interface PriceTurnInput {
  turn: TurnUsage | undefined;
  toolCalls: readonly string[];
  /** HTTP status of the request (a non-200 answer returned before any model call). */
  httpStatus: number;
  /** Steps the stream finished (`finish-step` chunks), or null when unknown. */
  streamedSteps: number | null;
  /** The runner stopped the request at the cost ceiling: a step was in flight. */
  ceilingAbort: boolean;
  /** The request ended abnormally otherwise (timeout, tool-result abort, transport error mid-stream). */
  abnormalEnd: boolean;
  /** What to book for the in-flight step of a ceiling abort (the runner's next-step worst case). */
  inFlightBooking: number | null;
  /** The static one-step worst case, booked for each step whose usage is unknown. */
  stepWorst: number;
  /** The model the guarantee was priced with. */
  expectedModel: string;
}

/**
 * Price one request from its per-step usage lines. Never assumes zero:
 *  - a step that streamed with no usage line books one step worst case and
 *    flags the run to stop;
 *  - a ceiling abort books the in-flight step at the runner's next-step
 *    worst case (the log never sees that step) and does not stop the run;
 *  - any other abnormal end books one step worst case and stops the run;
 *  - an unpriceable model, or a model other than the one the guarantee was
 *    priced with, stops the run;
 *  - a request refused before the model call (non-200) costs nothing;
 *  - each nested-AI tool call adds the reserve (that call is not in the log).
 * Pure.
 */
export function priceTurn(input: PriceTurnInput): PricedTurn {
  const { turn, toolCalls, httpStatus, streamedSteps, ceilingAbort, abnormalEnd, inFlightBooking, stepWorst, expectedModel } = input;
  const steps = (turn?.steps ?? []).map((s) => ({ step: s.step ?? 0, usage: s.usage }));
  const usage = steps.reduce((acc, s) => addUsage(acc, s.usage), ZERO_USAGE);
  const model = turn?.turn?.model ?? turn?.steps[turn.steps.length - 1]?.model ?? null;
  const out: PricedTurn = { model, steps, usage, costUsd: 0, reserveReason: null, unknownModel: null, usageMissing: null, inFlightBookedUsd: null };
  const notes: string[] = [];

  if (httpStatus !== 200) {
    out.reserveReason = `HTTP ${httpStatus || "error"}: refused before the model call, nothing booked`;
    return out;
  }
  const price = priceFor(model);
  if (model !== null && !price) {
    out.unknownModel = model;
    out.costUsd = stepWorst * Math.max(1, streamedSteps ?? steps.length);
    out.reserveReason = `model ${model} has no price; one step worst case booked per step`;
    return out;
  }
  // Step lines are the measurement (the turn line is their sum, and it is
  // missing on an aborted request).
  for (const s of turn?.steps ?? []) {
    const p = priceFor(s.model) ?? price;
    if (p) out.costUsd += costOf(s.usage, p);
  }
  if (model !== null && model !== expectedModel) {
    out.usageMissing = `the server used ${model}, the guarantee was priced for ${expectedModel}`;
  }
  const lines = turn?.steps.length ?? 0;
  if (streamedSteps !== null && lines < streamedSteps) {
    const missing = streamedSteps - lines;
    out.costUsd += missing * stepWorst;
    out.usageMissing = `${missing} step(s) streamed with no usage line`;
    notes.push(`${missing} x one-step worst case $${stepWorst.toFixed(2)} booked`);
  }
  if (ceilingAbort) {
    const b = inFlightBooking ?? stepWorst;
    out.costUsd += b;
    out.inFlightBookedUsd = b;
    notes.push(`stopped at the cost ceiling; the in-flight step booked at $${b.toFixed(2)}`);
  } else if (abnormalEnd) {
    out.costUsd += stepWorst;
    out.inFlightBookedUsd = stepWorst;
    out.usageMissing = out.usageMissing ?? "the request ended abnormally mid-step";
    notes.push(`in-flight step booked at the one-step worst case $${stepWorst.toFixed(2)}`);
  } else if (lines === 0) {
    out.usageMissing = out.usageMissing ?? "no usage line at all";
    out.costUsd += stepWorst;
    notes.push(`one-step worst case $${stepWorst.toFixed(2)} booked`);
  }
  const nested = toolCalls.filter((t) => NESTED_AI_TOOLS.includes(t));
  if (nested.length > 0) {
    out.costUsd += QUESTION_RESERVE_USD * nested.length;
    notes.push(`reserve added for nested AI tool(s) ${nested.join(", ")} (not in the chat log)`);
  }
  out.reserveReason = notes.length > 0 ? notes.join("; ") : null;
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
