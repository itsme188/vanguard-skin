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
  /** Why the cost is a reserve booking rather than a measurement, or null. */
  reserveReason: string | null;
  /** A model id with no price: the run must stop. */
  unknownModel: string | null;
}

/** Price one request's usage lines; falls back to the reserve when they are missing. */
export function priceTurn(turn: TurnUsage | undefined, toolCalls: readonly string[], errored: boolean): PricedTurn {
  const steps = (turn?.steps ?? []).map((s) => ({ step: s.step ?? 0, usage: s.usage }));
  const stepSum = steps.reduce((acc, s) => addUsage(acc, s.usage), ZERO_USAGE);
  const usage = turn?.turn ? turn.turn.usage : stepSum;
  const model = turn?.turn?.model ?? turn?.steps[turn.steps.length - 1]?.model ?? null;
  const out: PricedTurn = { model, steps, usage, costUsd: 0, reserveReason: null, unknownModel: null };

  if (!turn || (turn.steps.length === 0 && !turn.turn)) {
    out.costUsd = QUESTION_RESERVE_USD;
    out.reserveReason = errored ? "request errored; reserve booked" : "no usage line in the log; reserve booked";
    return out;
  }
  const price = priceFor(model);
  if (!price) {
    out.unknownModel = model ?? "(none)";
    out.costUsd = QUESTION_RESERVE_USD;
    out.reserveReason = `model ${model ?? "(none)"} has no price; reserve booked`;
    return out;
  }
  out.costUsd = costOf(usage, price);
  if (turn.turn === null) {
    out.costUsd = Math.max(out.costUsd, QUESTION_RESERVE_USD);
    out.reserveReason = "turn line missing (steps only); at least the reserve booked";
  }
  if (errored) {
    out.costUsd = Math.max(out.costUsd, QUESTION_RESERVE_USD);
    out.reserveReason = "request errored; at least the reserve booked";
  }
  const nested = toolCalls.filter((t) => NESTED_AI_TOOLS.includes(t));
  if (nested.length > 0) {
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
