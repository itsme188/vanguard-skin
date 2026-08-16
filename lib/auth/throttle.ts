// Packaged-app trust boundary (#35, task 6) — global login throttle.
//
// This is a single-user, single-tenant app reachable only through the
// cloudflared tunnel: every request's apparent source is the tunnel daemon,
// not the real client, so a per-IP throttle would be meaningless (either
// everyone shares one bucket, or the header can't be trusted). Global
// module-level state is the deliberate design, not a shortcut — there is
// only ever one login form for one person.
//
// Fixed-window failure counter: MAX_FAILURES failed attempts inside
// WINDOW_MS trips a LOCKOUT_MS lockout. Simple by design (brief: "keep it
// simple + testable") rather than a full exponential-backoff ladder.

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes once tripped

interface ThrottleState {
  failures: number;
  windowStart: number;
  /** 0 = not locked; otherwise the epoch-ms the lock releases. */
  lockedUntil: number;
}

let state: ThrottleState = { failures: 0, windowStart: 0, lockedUntil: 0 };

/** true = login attempts are currently allowed; false = locked out. */
export function checkLoginThrottle(nowMs: number): boolean {
  return state.lockedUntil === 0 || nowMs >= state.lockedUntil;
}

/**
 * Records one failed login attempt. Failures are counted in a fixed window
 * starting at the first failure seen; once MAX_FAILURES land inside
 * WINDOW_MS of that start, the throttle locks for LOCKOUT_MS. A failure
 * recorded after the window has elapsed starts a fresh window instead of
 * accumulating forever.
 */
export function recordLoginFailure(nowMs: number): void {
  if (nowMs - state.windowStart > WINDOW_MS) {
    state.windowStart = nowMs;
    state.failures = 0;
  }
  state.failures += 1;
  if (state.failures >= MAX_FAILURES) {
    state.lockedUntil = nowMs + LOCKOUT_MS;
  }
}

/** Test hook + successful-login reset: clears all throttle state. */
export function resetLoginThrottle(): void {
  state = { failures: 0, windowStart: 0, lockedUntil: 0 };
}
