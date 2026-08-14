import type Database from "better-sqlite3";
import { getRecipientsFor, type EmailType } from "@/lib/queries/email-recipients";

/**
 * Route-level hardening for the 3 outbound email routes (#35 §G,
 * "packaged-app-trust-boundary" — task 21).
 *
 * These routes (`/api/digest/email`, `/api/earnings/email`,
 * `/api/calendar/email`) accept a caller-supplied `to` and send from the
 * verified domain via Resend. Auth (proxy.ts / session cookie) limits *who*
 * can call them; this module limits *what* they can do even after a session
 * is compromised or a route is reached some other way — defense-in-depth,
 * independent of the auth layer.
 *
 * Two independent guards, both fail-safe (block on ambiguity):
 *   1. `checkRecipientAllowed` — a caller-supplied `to` must resolve to
 *      addresses already configured as this app's own destination (the
 *      BRIEFING_EMAIL_TO env var and/or the settings-backed recipient list
 *      for that email surface). No `to` at all (the default path, used by
 *      the composer's own fallback) is always allowed — this guard only
 *      constrains an explicit override.
 *   2. `checkEmailSendRateLimit` — a simple fixed-window global counter per
 *      route, modeled on `lib/auth/throttle.ts`'s login throttle. Single-
 *      user, low-volume app — the point is to blunt a burst, not to
 *      implement a general-purpose limiter.
 */

/** "earnings" has no settings-backed recipient override — see getAllowedRecipients. */
export type RecipientGuardEmailType = EmailType | "earnings";

export interface GuardFailure {
  ok: false;
  status: number;
  error: string;
}
export interface GuardSuccess {
  ok: true;
}
export type GuardResult = GuardSuccess | GuardFailure;

function parseAddresses(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * The set of addresses a given email surface is already configured to send
 * to: the BRIEFING_EMAIL_TO env var (the fallback every surface shares) plus
 * the settings-backed override for that surface, if any. "earnings" has no
 * settings override key — `sendEarningsEmail` never calls
 * `getRecipientsFor`, it only falls back to the env var — so its allowlist
 * is env-var only. Normalized to lowercase/trimmed for case-insensitive
 * comparison.
 */
export function getAllowedRecipients(
  db: Database.Database,
  type: RecipientGuardEmailType,
): Set<string> {
  const allowed = new Set<string>(parseAddresses(process.env.BRIEFING_EMAIL_TO));
  if (type !== "earnings") {
    const overrides = getRecipientsFor(db, type);
    if (overrides) {
      for (const addr of overrides) allowed.add(addr.trim().toLowerCase());
    }
  }
  return allowed;
}

/**
 * Guards a caller-supplied `to` on an outbound email route.
 *
 * - No `to` (undefined/null) → always allowed. The composer falls back to
 *   its own default resolution (settings override / BRIEFING_EMAIL_TO)
 *   unchanged — this is the legitimate cron/in-process/manual-default path.
 * - `to` supplied but not a string (a JSON array/number/object slipped past
 *   the route's `as string | undefined` cast — `request.json()` gives no
 *   runtime type guarantee) → rejected (400). Checked BEFORE the override
 *   branch: `override` means "send to this address anyway", which
 *   presupposes an actual address string, not malformed input. Without this
 *   check, a non-string `to` would reach `.trim()` below and throw past the
 *   route's try/catch — still fail-closed (no send) but as an unhandled
 *   500 instead of a clean 400.
 * - `to` supplied, `override` true → always allowed (deliberate escape
 *   hatch, e.g. a one-off forward).
 * - `to` supplied, every address already in the allowlist → allowed (this
 *   is just the caller spelling out the configured recipient explicitly).
 * - `to` supplied with any address outside the allowlist, no override →
 *   rejected (400).
 */
export function checkRecipientAllowed(
  db: Database.Database,
  type: RecipientGuardEmailType,
  to: unknown,
  override: boolean,
): GuardResult {
  if (to === undefined || to === null) return { ok: true };
  if (typeof to !== "string") {
    return {
      ok: false,
      status: 400,
      error: "Body field 'to' must be a string.",
    };
  }
  if (!to.trim()) return { ok: true };
  if (override) return { ok: true };

  const requested = parseAddresses(to);
  if (requested.length === 0) return { ok: true };

  const allowed = getAllowedRecipients(db, type);
  const disallowed = requested.filter((addr) => !allowed.has(addr));
  if (disallowed.length === 0) return { ok: true };

  return {
    ok: false,
    status: 400,
    error: `Recipient(s) not in the allowlist: ${disallowed.join(", ")}. Pass override: true to send anyway.`,
  };
}

// ── Send rate limit ────────────────────────────────────────────────────
//
// Fixed-window counter, keyed per route (a distinct string per HTTP route,
// e.g. "digest" | "earnings" | "calendar"). Global module-level state is
// deliberate, same rationale as lib/auth/throttle.ts: single-user app behind
// one tunnel, no meaningful per-client identity to key on.

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RATE_LIMIT_MAX_SENDS = 5;

interface RateLimitBucket {
  count: number;
  windowStart: number;
}

const rateLimitBuckets = new Map<string, RateLimitBucket>();

/**
 * Checks and records one send attempt against routeKey's fixed window.
 * Returns ok:false (429) once RATE_LIMIT_MAX_SENDS attempts have landed
 * inside RATE_LIMIT_WINDOW_MS of the window's start; a request outside the
 * window starts a fresh one. Call this ONLY for a request that already
 * passed the recipient guard and is about to attempt a real send — a
 * rejected (400) request does not consume rate-limit budget.
 */
export function checkEmailSendRateLimit(
  routeKey: string,
  nowMs: number = Date.now(),
): GuardResult {
  const bucket = rateLimitBuckets.get(routeKey);
  if (!bucket || nowMs - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitBuckets.set(routeKey, { count: 1, windowStart: nowMs });
    return { ok: true };
  }
  if (bucket.count >= RATE_LIMIT_MAX_SENDS) {
    return {
      ok: false,
      status: 429,
      error: `Too many emails sent from this route recently. Try again in a few minutes.`,
    };
  }
  bucket.count += 1;
  return { ok: true };
}

/** Test hook: clears all rate-limit state. */
export function resetEmailSendRateLimits(): void {
  rateLimitBuckets.clear();
}
