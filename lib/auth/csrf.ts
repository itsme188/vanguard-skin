import { timingSafeEqual } from "node:crypto";

// Packaged-app trust boundary (#35, task 2) — double-submit CSRF check.
// Pure comparison: no DB, no HTTP. Caller supplies the header token, the
// cookie token, and the session's stored CSRF secret.

/**
 * Constant-time triple-equality: header token, cookie token, and the
 * session's CSRF secret must all match. An empty string never passes,
 * even if all three happen to be empty — that would trivially satisfy
 * equality and let an unset/missing token slip through.
 */
export function csrfMatches(headerToken: string, cookieToken: string, sessionSecret: string): boolean {
  if (headerToken.length === 0 || cookieToken.length === 0 || sessionSecret.length === 0) {
    return false;
  }

  const headerBuf = Buffer.from(headerToken, "utf8");
  const cookieBuf = Buffer.from(cookieToken, "utf8");
  const secretBuf = Buffer.from(sessionSecret, "utf8");

  if (headerBuf.length !== cookieBuf.length || headerBuf.length !== secretBuf.length) {
    return false;
  }

  // Both comparisons always run (no `&&`): a wrong cookie and a wrong
  // session secret cost the same work, so the time taken says nothing about
  // WHICH of the two failed.
  const headerEqualsCookie = timingSafeEqual(headerBuf, cookieBuf);
  const headerEqualsSecret = timingSafeEqual(headerBuf, secretBuf);
  return headerEqualsCookie && headerEqualsSecret;
}
