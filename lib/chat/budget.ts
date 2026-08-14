// Packaged-app trust boundary (#35, task 22, spec §G) — /api/chat per-session
// budget / rate limits, DEFENSE IN DEPTH on top of the auth boundary (a
// stolen session cookie, or a scripted client with a legitimate one, would
// otherwise still be able to hit unbounded Opus + 27 tools). Pure,
// dependency-injected (every fn takes an explicit `nowMs`/session key — no
// hidden clock reads), module-level in-memory state — same shape as
// lib/auth/throttle.ts's login throttle, but keyed PER SESSION (Map) instead
// of one global bucket, because a legitimate single user can have 1-2 real
// devices/tabs open concurrently and each should get its own budget rather
// than starving itself.
//
// All four guards are checked in app/api/chat/route.ts BEFORE the
// streamText call and never touch streamText's config, the tool set, or the
// useChat client wiring — see route.ts for the call sites and CLAUDE.md's
// "What NOT to Change" list for why that boundary matters.

import { todayET } from "@/lib/calendar/date-utils";

// ─── Tunable constants (single source — change limits ONLY here) ───────────

/** Hard ceiling on the number of messages in one request body. A real
 * conversation rarely exceeds a few dozen turns; this stops a scripted or
 * malformed client from resending an ever-growing transcript. */
export const MAX_MESSAGES = 200;

/** Hard ceiling on total request bytes: JSON-stringified `messages` array
 * plus `pageContext` (both land in the prompt — see route.ts). Generous —
 * far beyond any real multi-turn conversation with page context — but stops
 * a multi-MB payload from ever reaching the model. */
export const MAX_PROMPT_BYTES = 500_000; // ~500 KB

/** Simultaneous in-flight streamText calls allowed per session. 2 covers a
 * legitimate user with two tabs/devices open at once; more than that is
 * either a runaway client retry loop or misuse. */
export const MAX_CONCURRENT_STREAMS_PER_SESSION = 2;

/** Fixed request-rate window: at most RATE_LIMIT_MAX_REQUESTS requests per
 * session inside this many ms before the cooldown trips. */
export const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
export const RATE_LIMIT_MAX_REQUESTS = 20;

/** Once the window's request count is exceeded, the session is cooled down
 * for this long — held even past the point the fixed window would otherwise
 * have rolled over, so a client can't just wait out the window and resume
 * the burst immediately. */
export const RATE_LIMIT_COOLDOWN_MS = 30_000; // 30 seconds

/** Best-effort daily ceiling on cumulative OUTPUT tokens per session,
 * bucketed by ET calendar day (repo convention: ET-anchor "today"). Sized
 * well above realistic single-user interactive use — Opus, 16K
 * maxOutputTokens per request, an 8-step tool loop (worst case ~128K output
 * tokens/request) — so it stops a runaway/scripted burst, not normal use
 * across a long research session. */
export const DAILY_OUTPUT_TOKEN_CEILING = 3_000_000;

/** A stream that hasn't finished/errored/aborted within this long is treated
 * as stale and its concurrency slot silently reclaimed on the next
 * acquisition attempt. This is the safety net UNDER the onFinish/onError/
 * onAbort release path (route.ts) — even if none of those callbacks ever
 * fire (e.g. a hard process-level failure mid-stream), a session can't stay
 * PERMANENTLY stuck at the concurrency cap. */
export const STREAM_SLOT_STALE_MS = 10 * 60_000; // 10 minutes

/** Shared fallback bucket for a request with no valid session cookie. In
 * production every /api/chat request already carries a verified session
 * (proxy.ts default-denies this route otherwise — spec §E); this only
 * covers local dev without the auth boundary configured, or the rare
 * expiry race between the proxy's check and this route's re-check. All such
 * requests share one bucket rather than being unbounded — acceptable for a
 * single-user app per spec §G ("keying on a per-process/global bucket is an
 * acceptable simpler fallback"). */
export const NO_SESSION_KEY = "__no_session__";

/** Bucket the given instant into an ET calendar day for the daily ceiling —
 * matches the repo's ET-anchor convention. Exposed so route.ts derives the
 * same day string it later reports usage against. */
export function budgetDayFor(nowMs: number): string {
  return todayET(new Date(nowMs));
}

// ─── Request-size gate (stateless, pure) ────────────────────────────────────

export interface SizeCheckResult {
  ok: boolean;
  reason?: string;
}

/**
 * Rejects an over-large chat request before any DB/AI work. `pageContext` is
 * included in the byte count because route.ts appends it verbatim to the
 * system prompt.
 */
export function checkRequestSize(messages: unknown[], pageContext?: unknown): SizeCheckResult {
  if (messages.length > MAX_MESSAGES) {
    return { ok: false, reason: `Too many messages in request (${messages.length} > ${MAX_MESSAGES}).` };
  }

  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(messages), "utf8");
    if (pageContext !== undefined) {
      const serialized = JSON.stringify(pageContext);
      if (serialized !== undefined) bytes += Buffer.byteLength(serialized, "utf8");
    }
  } catch {
    // Non-serializable input (e.g. circular structure) — treat as oversize
    // rather than letting JSON.stringify throw uncaught later downstream.
    return { ok: false, reason: "Request payload could not be measured." };
  }

  if (bytes > MAX_PROMPT_BYTES) {
    return { ok: false, reason: `Request payload too large (${bytes} bytes > ${MAX_PROMPT_BYTES}).` };
  }

  return { ok: true };
}

// ─── Concurrent-stream cap ───────────────────────────────────────────────────

interface StreamSlot {
  id: number;
  startedAt: number;
}

const activeStreams = new Map<string, StreamSlot[]>();
let nextSlotId = 1;

/** Live slots for a session: everything not yet STREAM_SLOT_STALE_MS old. */
function liveSlots(sessionKey: string, nowMs: number): StreamSlot[] {
  const slots = activeStreams.get(sessionKey) ?? [];
  return slots.filter((s) => nowMs - s.startedAt < STREAM_SLOT_STALE_MS);
}

export type AcquireStreamSlotResult = { ok: true; slotId: number } | { ok: false };

/**
 * Reserves one concurrent-stream slot for `sessionKey`. First prunes stale
 * slots (see STREAM_SLOT_STALE_MS) so a leaked slot can never wedge a
 * session at the cap forever. Returns `{ok:false}` (429 upstream) once the
 * session already holds MAX_CONCURRENT_STREAMS_PER_SESSION live slots.
 */
export function acquireStreamSlot(sessionKey: string, nowMs: number): AcquireStreamSlotResult {
  const slots = liveSlots(sessionKey, nowMs);
  if (slots.length >= MAX_CONCURRENT_STREAMS_PER_SESSION) {
    activeStreams.set(sessionKey, slots);
    return { ok: false };
  }
  const slot: StreamSlot = { id: nextSlotId++, startedAt: nowMs };
  slots.push(slot);
  activeStreams.set(sessionKey, slots);
  return { ok: true, slotId: slot.id };
}

/**
 * Releases a previously-acquired slot. Idempotent (safe to call more than
 * once — route.ts's onFinish/onError/onAbort/catch paths all call the same
 * guarded release) and safe to call for a slot already pruned as stale.
 */
export function releaseStreamSlot(sessionKey: string, slotId: number): void {
  const slots = activeStreams.get(sessionKey);
  if (!slots) return;
  const next = slots.filter((s) => s.id !== slotId);
  if (next.length === 0) activeStreams.delete(sessionKey);
  else activeStreams.set(sessionKey, next);
}

/** Test-only introspection: current live slot count for a session. */
export function activeStreamCount(sessionKey: string, nowMs: number): number {
  return liveSlots(sessionKey, nowMs).length;
}

// ─── Fixed-window rate limit + cooldown ─────────────────────────────────────

interface RateWindowState {
  windowStart: number;
  count: number;
  /** 0 = not cooling down; otherwise the epoch-ms the cooldown releases. */
  cooldownUntil: number;
}

const rateWindows = new Map<string, RateWindowState>();

export type RateLimitResult = { ok: true } | { ok: false; retryAfterMs: number };

/**
 * Atomic check-and-consume: call once per incoming request, before
 * streamText. Rolls the fixed window forward once it has elapsed, then
 * increments the request count. The request that pushes the count OVER
 * RATE_LIMIT_MAX_REQUESTS is itself rejected and trips a
 * RATE_LIMIT_COOLDOWN_MS cooldown that holds even past the point the fixed
 * window would otherwise roll over — so a client can't just wait out the
 * window mid-burst.
 */
export function checkAndConsumeRateLimit(sessionKey: string, nowMs: number): RateLimitResult {
  let state = rateWindows.get(sessionKey);

  if (state && state.cooldownUntil > nowMs) {
    return { ok: false, retryAfterMs: state.cooldownUntil - nowMs };
  }

  if (!state || nowMs - state.windowStart >= RATE_LIMIT_WINDOW_MS) {
    state = { windowStart: nowMs, count: 0, cooldownUntil: 0 };
  }

  state.count += 1;
  if (state.count > RATE_LIMIT_MAX_REQUESTS) {
    state.cooldownUntil = nowMs + RATE_LIMIT_COOLDOWN_MS;
    rateWindows.set(sessionKey, state);
    return { ok: false, retryAfterMs: RATE_LIMIT_COOLDOWN_MS };
  }

  rateWindows.set(sessionKey, state);
  return { ok: true };
}

// ─── Daily output-token ceiling (best-effort) ───────────────────────────────

interface DailyUsageState {
  day: string;
  outputTokens: number;
  requestCount: number;
}

const dailyUsage = new Map<string, DailyUsageState>();

/**
 * True while `sessionKey` is still under the daily ceiling for `day` (an ET
 * calendar-date string — see budgetDayFor). A session with no recorded
 * usage yet, or whose recorded usage is from a previous day, is always
 * under (the accumulator resets on day rollover — see recordDailyUsage).
 */
export function isUnderDailyCeiling(sessionKey: string, day: string): boolean {
  const usage = dailyUsage.get(sessionKey);
  if (!usage || usage.day !== day) return true;
  return usage.outputTokens < DAILY_OUTPUT_TOKEN_CEILING;
}

/**
 * Accumulates output tokens for `sessionKey` on `day`. Called from
 * streamText's onFinish with `totalUsage.outputTokens` — the AI SDK's
 * actual post-call usage figure (not an estimate). This IS the "usage
 * callback" accounting method chosen for the daily ceiling (see task
 * report for why request-count-per-day wasn't needed here: onFinish's
 * totalUsage is reliably available in this AI SDK version). A day rollover
 * (or first call of the day) resets the accumulator rather than carrying a
 * stale total forward.
 */
export function recordDailyUsage(sessionKey: string, day: string, outputTokens: number): void {
  const usage = dailyUsage.get(sessionKey);
  const delta = Math.max(0, outputTokens || 0);
  if (!usage || usage.day !== day) {
    dailyUsage.set(sessionKey, { day, outputTokens: delta, requestCount: 1 });
    return;
  }
  usage.outputTokens += delta;
  usage.requestCount += 1;
}

/** Test-only introspection: today's usage for a session, or undefined if
 * none recorded yet (or the last recorded usage was a prior day). */
export function getDailyUsage(sessionKey: string, day: string): Readonly<DailyUsageState> | undefined {
  const usage = dailyUsage.get(sessionKey);
  return usage && usage.day === day ? usage : undefined;
}

// ─── Test-only reset ─────────────────────────────────────────────────────────

/**
 * Clears ALL in-memory budget state (concurrency slots, rate windows, daily
 * usage). Test-only — production has no reason to reset these maps
 * mid-process; each vitest file that exercises this module (or the chat
 * route through it) should call this in beforeEach for isolation, mirroring
 * resetLoginThrottle() in lib/auth/throttle.ts.
 */
export function resetChatBudgetStateForTests(): void {
  activeStreams.clear();
  rateWindows.clear();
  dailyUsage.clear();
  nextSlotId = 1;
}
