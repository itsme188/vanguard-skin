import { timingSafeEqual } from "node:crypto";

// Packaged-app trust boundary (#35) — shared verification for the
// Electron-main SERVICE CREDENTIAL and the loopback-Host guard used by the
// loopback-only, electron-classified routes (desktop-bootstrap, revoke-all).
// Single source of truth so the two routes can never drift on how they check
// the credential. Pure crypto + string parsing: no DB, no HTTP, no env writes.

/** Constant-time string compare; a length mismatch short-circuits false
 * (timingSafeEqual throws on unequal buffer lengths). */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * True only for a loopback Host header (localhost / 127.0.0.1 / ::1), with an
 * optional port. Anything else — including a tunnel/public host — is rejected
 * before the credential is even examined.
 */
export function isLoopbackHost(host: string | null): boolean {
  if (!host) return false;
  let h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    // IPv6 literal: [::1]:port
    const end = h.indexOf("]");
    h = end >= 0 ? h.slice(1, end) : h.slice(1);
  } else {
    const colon = h.indexOf(":");
    if (colon >= 0) h = h.slice(0, colon);
  }
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

export type ElectronCredCheck = { ok: true } | { ok: false; status: number; error: string };

/**
 * Verifies the presented Electron-main service credential against
 * `process.env.ELECTRON_SERVICE_CRED`.
 *   - env missing/blank → 500 (server misconfiguration; fail-closed, mirrors
 *     withCronAuth's missing-secret behavior).
 *   - provided missing/wrong → 401 (constant-time compare).
 *   - match → ok.
 */
export function verifyElectronCred(provided: string | null | undefined): ElectronCredCheck {
  const expected = process.env.ELECTRON_SERVICE_CRED;
  if (!expected) {
    return { ok: false, status: 500, error: "Server not configured: ELECTRON_SERVICE_CRED missing." };
  }
  if (!provided || !constantTimeEqual(provided, expected)) {
    return { ok: false, status: 401, error: "Invalid Electron service credential." };
  }
  return { ok: true };
}
