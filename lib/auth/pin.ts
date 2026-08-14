import type Database from "better-sqlite3";
import { hashPin, verifyPin } from "@/lib/auth/credentials";
import { getLiveSessionById, getSessionPin } from "@/lib/queries/sessions";
import {
  setSessionPin,
  recordPinFailure,
  resetPinFailures,
  touchSession,
} from "@/lib/mutations/sessions";

// Packaged-app trust boundary (#35, task 16) — convenience-PIN semantics
// (spec §B2). Pure, dependency-injected handlers: no HTTP, no cookies, no
// env — the route files (app/api/auth/pin/*) resolve the caller's session id
// from the cookie and then call these, and the unit tests drive them
// directly against an in-memory DB.
//
// The PIN is NOT a second password. It re-activates an EXISTING, non-expired
// session on the SAME device — it never creates a session from cold and never
// works without a prior full-password login on that device. Concretely,
// verify does its own liveness check by session id (getLiveSessionById) and
// NEVER calls createSession: a dead session id can only ever be rejected.

/** Wrong-PIN attempts before the PIN is disabled and the full password is
 * required again. Matches the login throttle's tolerance. */
export const MAX_PIN_ATTEMPTS = 5;

const PIN_RE = /^\d{4,8}$/;

/** A convenience PIN is 4–8 digits. Deliberately strict: it's a numeric
 * quick-unlock, not an arbitrary passphrase (that's the full password). */
export function isValidPin(pin: string): boolean {
  return PIN_RE.test(pin);
}

export type PinSetOutcome =
  | { ok: true }
  | { ok: false; reason: "invalid-pin" | "session-invalid" };

export type PinVerifyReason = "session-invalid" | "no-pin" | "locked" | "wrong-pin";

export type PinVerifyOutcome =
  | { ok: true }
  | { ok: false; reason: PinVerifyReason; attemptsRemaining?: number };

/**
 * Sets (or replaces) the PIN bound to a session. Requires a LIVE session:
 * a missing/expired/revoked session id is rejected, so a PIN can only ever
 * be established from a request that already carries a valid full-password
 * session cookie (spec §B2: "set only by a request carrying a valid session").
 * Re-setting clears any prior failure/lockout state.
 */
export function handleSetPin(
  db: Database.Database,
  sessionId: number,
  pin: string,
  nowMs: number = Date.now()
): PinSetOutcome {
  if (!isValidPin(pin)) return { ok: false, reason: "invalid-pin" };

  const session = getLiveSessionById(db, sessionId, nowMs);
  if (!session) return { ok: false, reason: "session-invalid" };

  setSessionPin(db, sessionId, hashPin(pin), nowMs);
  return { ok: true };
}

/**
 * Verifies a PIN against its bound session and, on success, re-activates
 * that session by sliding its idle window forward (touchSession). NEVER
 * creates a session:
 *   - session absent/expired/revoked -> "session-invalid" (fall back to password)
 *   - no PIN set on the session       -> "no-pin"
 *   - PIN locked out                  -> "locked" (fall back to password)
 *   - wrong PIN                       -> "wrong-pin", fail count incremented;
 *                                        the Nth wrong PIN flips to "locked"
 *   - correct PIN                     -> ok, failures reset, session touched
 */
export function handleVerifyPin(
  db: Database.Database,
  sessionId: number,
  pin: string,
  nowMs: number = Date.now()
): PinVerifyOutcome {
  // Liveness FIRST — a dead session can never be re-animated by a PIN, and
  // this handler must never mint a new one to "help".
  const session = getLiveSessionById(db, sessionId, nowMs);
  if (!session) return { ok: false, reason: "session-invalid" };

  const pinRow = getSessionPin(db, sessionId);
  if (!pinRow) return { ok: false, reason: "no-pin" };
  if (pinRow.locked) return { ok: false, reason: "locked" };

  if (verifyPin(pin, pinRow.pin_hash)) {
    resetPinFailures(db, sessionId, nowMs);
    // throttle 0: a re-unlock always slides the idle window — that IS the point.
    touchSession(db, sessionId, nowMs, 0);
    return { ok: true };
  }

  const { failCount, locked } = recordPinFailure(db, sessionId, MAX_PIN_ATTEMPTS, nowMs);
  return {
    ok: false,
    reason: locked ? "locked" : "wrong-pin",
    attemptsRemaining: Math.max(0, MAX_PIN_ATTEMPTS - failCount),
  };
}
