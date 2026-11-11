/**
 * Chat evaluation: token prices and the budget guard (pure, no imports).
 *
 * PRICE SOURCE: the Claude API reference bundled with Claude Code (model
 * table "cached: 2026-11-03"; cache multipliers from its prompt-caching
 * page), copied here on 2026-11-11. US dollars per million tokens, first-party
 * Anthropic API rates. Not checked against the live pricing page: confirm
 * there before trusting a total to the cent.
 *
 * The table is keyed by the model id the SERVER reports in its usage log
 * (the `model` field of a `[chat-usage]` line). The script never chooses a
 * model; it only prices the one the app used. Pricing is per id, not per
 * family, because versions inside one family differ (Sonnet 4.6 is $3/$15,
 * Sonnet 5.5 is $2/$10 with cache reads at 0.05x). An id that is not in the
 * table is refused (`priceFor` returns null): a guessed price would make
 * the budget guard and the cost report untrustworthy.
 *
 * Cache writes are priced at the 5-minute rate (1.25x input), the only TTL
 * the chat route uses (Contract D: `{ type: "ephemeral" }` with no ttl).
 */

export interface ModelPrice {
  /** Uncached input, $ per million tokens. */
  input: number;
  /** 5-minute cache write, $ per million tokens. */
  cacheWrite: number;
  /** Cache read, $ per million tokens. */
  cacheRead: number;
  /** Output (thinking included), $ per million tokens. */
  output: number;
}

export const PRICE_SOURCE =
  "Claude API reference bundled with Claude Code (model table cached 2026-11-03), copied 2026-11-11; " +
  "first-party API rates; 5-minute cache write = 1.25x input. Not re-checked against the live pricing page.";

function p(input: number, output: number, cacheRead: number): ModelPrice {
  return { input, output, cacheRead, cacheWrite: Math.round(input * 1.25 * 1000) / 1000 };
}

/** Exact model ids (date suffix allowed, see `normalizeModelId`). */
export const PRICE_TABLE: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5-5": p(4, 20, 0.2),
  "claude-opus-5": p(5, 25, 0.5),
  "claude-opus-4-8": p(5, 25, 0.5),
  "claude-opus-4-7": p(5, 25, 0.5),
  "claude-opus-4-6": p(5, 25, 0.5),
  "claude-sonnet-5-5": p(2, 10, 0.1),
  "claude-sonnet-5": p(2, 10, 0.2),
  "claude-sonnet-4-6": p(3, 15, 0.3),
  // Haiku 5.5: the rate for prompts up to 100K tokens; a chat request is
  // well under that (tools + system + history), so the higher tier is not modelled.
  "claude-haiku-5-5": p(0.1, 0.5, 0.01),
  "claude-haiku-4-5": p(1, 5, 0.1),
};

/** Strip a trailing `-YYYYMMDD` snapshot suffix (`claude-haiku-4-5-20251001`). */
export function normalizeModelId(modelId: string): string {
  return modelId.trim().replace(/-\d{8}$/, "");
}

/** The price for a model id, or null when the id is unknown (never a guess). */
export function priceFor(modelId: string | null | undefined): ModelPrice | null {
  if (!modelId) return null;
  return PRICE_TABLE[normalizeModelId(modelId)] ?? null;
}

export interface TokenUsage {
  noCache: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export const ZERO_USAGE: TokenUsage = { noCache: 0, cacheWrite: 0, cacheRead: 0, output: 0 };

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    noCache: a.noCache + b.noCache,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
    output: a.output + b.output,
  };
}

/** Dollar cost of a usage record at a price. */
export function costOf(usage: TokenUsage, price: ModelPrice): number {
  return (
    (usage.noCache * price.input +
      usage.cacheWrite * price.cacheWrite +
      usage.cacheRead * price.cacheRead +
      usage.output * price.output) /
    1_000_000
  );
}

/**
 * The plan's per-question reserve (Codex 15): booked for a question that
 * errored, a question whose usage line never appeared, and on top of any
 * answer that called a tool with a nested AI call the chat log cannot see.
 */
export const QUESTION_RESERVE_USD = 0.4;

/** Tools whose execution makes a nested AI call outside the chat usage log. */
export const NESTED_AI_TOOLS: readonly string[] = ["query_filing_section"];

/**
 * The limits a chat request runs under. The step cap is the route's own
 * (`MAX_CHAT_STEPS`, lib/chat/history.ts); the per-step output cap is the
 * route's `maxOutputTokens` (pinned by a source test). Tool results are
 * bounded by the tools' owner (about 22,000 characters each, the full
 * transcript excepted); the eval ABORTS a request whose streamed tool output
 * exceeds the bound it assumes (run-golden.ts).
 */
export interface RequestLimits {
  maxSteps: number;
  maxOutputTokensPerStep: number;
  toolResultTokensPerStep: number;
}

export interface BudgetDecision {
  run: boolean;
  spent: number;
  worstCase: number;
  max: number;
  reason: string;
}

/** Does an amount still fit under a cap once added to what is spent? (The per-question start rule passes the ceiling as `worstCase`.) Pure. */
export function budgetAllows(spent: number, worstCase: number, max: number): BudgetDecision {
  const ok = Number.isFinite(spent) && Number.isFinite(worstCase) && spent + worstCase <= max + 1e-9;
  const sum = `spent $${spent.toFixed(4)} + worst case $${worstCase.toFixed(2)}`;
  return {
    run: ok,
    spent,
    worstCase,
    max,
    reason: ok ? `${sum} <= cap $${max.toFixed(2)}` : `${sum} would exceed cap $${max.toFixed(2)}`,
  };
}

// ─── The in-question ceiling (orchestrator ruling, review round 3) ──

/** The worst one model step can cost: its whole input at the dearer input rate plus the maximum output. Pure. */
export function stepWorstCase(inputTokens: number, maxOutputTokens: number, price: ModelPrice): number {
  return (inputTokens * Math.max(price.input, price.cacheWrite) + maxOutputTokens * price.output) / 1_000_000;
}

/** Margin for what the route adds to a step's input beyond history and tool results (the last-step note). */
export const STEP_INPUT_MARGIN_TOKENS = 500;

/**
 * The largest step that can be in flight when the ceiling trips (static, for
 * the printed guarantee). While a question runs, every check holds the
 * running cost at or under the ceiling before the next step, so all earlier
 * output together is at most ceiling / output price; earlier tool results
 * are at most (steps - 1) x the tool bound. The in-flight step's input is
 * the request's own input plus those, plus a margin. Pure.
 */
export function inFlightStepWorstCase(
  baseInputTokens: number,
  limits: RequestLimits,
  ceilingUsd: number,
  price: ModelPrice,
): number {
  const earlierOutput = Math.min(
    (limits.maxSteps - 1) * limits.maxOutputTokensPerStep,
    Math.ceil((ceilingUsd * 1_000_000) / price.output),
  );
  const input = baseInputTokens + (limits.maxSteps - 1) * limits.toolResultTokensPerStep + earlierOutput + STEP_INPUT_MARGIN_TOKENS;
  return stepWorstCase(input, limits.maxOutputTokensPerStep, price);
}

/**
 * The check after every finished step: may the request go on? It stops
 * when the cost so far plus the worst the NEXT step (already in flight) can
 * cost would pass the ceiling. Holding this before every step keeps a
 * question at or under ceiling + one step. Pure.
 */
export function ceilingAllowsNextStep(runningUsd: number, nextStepWorstUsd: number, ceilingUsd: number): boolean {
  return Number.isFinite(runningUsd) && Number.isFinite(nextStepWorstUsd) && runningUsd + nextStepWorstUsd <= ceilingUsd + 1e-9;
}

export interface RunGuarantee {
  /** The worst one step in flight can cost (static bound). */
  oneStepWorst: number;
  /** The first step of a question, which starts before any check. */
  firstStepWorst: number;
  /** Run cap + the in-flight step (+ any excess of a first step over the ceiling). */
  guaranteedMax: number;
}

/** The printed guarantee for a run. Pure. */
export function runGuarantee(runCap: number, ceiling: number, oneStepWorst: number, firstStepWorst: number): RunGuarantee {
  return { oneStepWorst, firstStepWorst, guaranteedMax: runCap + oneStepWorst + Math.max(0, firstStepWorst - ceiling) };
}

/** Rough token count: characters / 3 (deliberately high for prose). */
export function roughTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** A request's input size for the worst-case rule: characters / 3 plus a 20% margin. */
export function worstCaseInputTokens(chars: number): number {
  return Math.ceil((chars / 3) * 1.2);
}
