// Packaged-app trust boundary (#35, task 20) — import-undo confirmation gate
// + destructive-undo rate limit.
//
// The undo DELETE unwinds a whole import batch AND clears the derived tax-lot
// / valuation layer before recompute. A single stray or replayed DELETE must
// not be able to trigger that. This module provides a deliberate two-step:
// the client first obtains a short-lived, single-use token bound to a
// specific batch, then presents it on the actual delete.
//
// Like lib/auth/throttle.ts, this app is single-user / single-tenant behind a
// tunnel, so module-level global state is the deliberate design (one person,
// one undo button) — not a shortcut. All time is injected (nowMs) so the
// behavior is fully testable without real clocks.

import { randomBytes } from "node:crypto";

/** How long an issued confirmation token stays valid. */
export const UNDO_TOKEN_TTL_MS = 2 * 60 * 1000; // 2 minutes

/** Max confirmed destructive undos allowed inside UNDO_RATE_WINDOW_MS. */
export const MAX_UNDOS_PER_WINDOW = 3;

/** Sliding-count window for the destructive-undo rate limit. */
export const UNDO_RATE_WINDOW_MS = 60 * 1000; // 1 minute

interface PendingToken {
  batchId: number;
  expiresAt: number;
}

// token -> {batchId, expiresAt}. Single-use: consumed tokens are deleted.
let pendingTokens = new Map<string, PendingToken>();

// Epoch-ms timestamps of recent confirmed destructive undos (pruned to window).
let recentUndos: number[] = [];

/**
 * Issue a short-lived, single-use confirmation token bound to `batchId`.
 * Also opportunistically prunes any expired tokens so the map can't grow
 * unbounded across a long-lived process.
 */
export function issueUndoToken(
  batchId: number,
  nowMs: number = Date.now(),
): { token: string; expiresAt: number } {
  for (const [t, p] of pendingTokens) {
    if (nowMs >= p.expiresAt) pendingTokens.delete(t);
  }
  const token = randomBytes(24).toString("hex");
  const expiresAt = nowMs + UNDO_TOKEN_TTL_MS;
  pendingTokens.set(token, { batchId, expiresAt });
  return { token, expiresAt };
}

/**
 * Validate + consume a confirmation token. Returns true only when the token
 * exists, is bound to `batchId`, and has not expired. Always single-use: any
 * matching token is deleted whether or not it was still valid.
 */
export function consumeUndoToken(
  batchId: number,
  token: string,
  nowMs: number = Date.now(),
): boolean {
  const pending = pendingTokens.get(token);
  if (!pending) return false;
  if (nowMs >= pending.expiresAt) {
    pendingTokens.delete(token); // expired — clean it up
    return false;
  }
  // A wrong-batch guess must NOT burn a legitimately-issued token (else an
  // attacker could invalidate the real undo by guessing batch ids).
  if (pending.batchId !== batchId) return false;
  pendingTokens.delete(token); // single-use — burned only on a valid match
  return true;
}

/** true = a destructive undo is currently allowed; false = rate-limited. */
export function checkUndoRateLimit(nowMs: number = Date.now()): boolean {
  recentUndos = recentUndos.filter((t) => nowMs - t < UNDO_RATE_WINDOW_MS);
  return recentUndos.length < MAX_UNDOS_PER_WINDOW;
}

/** Record one confirmed destructive undo for the rate limiter. */
export function recordUndo(nowMs: number = Date.now()): void {
  recentUndos = recentUndos.filter((t) => nowMs - t < UNDO_RATE_WINDOW_MS);
  recentUndos.push(nowMs);
}

/** Test hook: clears all pending tokens + rate-limit history. */
export function resetUndoConfirmation(): void {
  pendingTokens = new Map();
  recentUndos = [];
}
