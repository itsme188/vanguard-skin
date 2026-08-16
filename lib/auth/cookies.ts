// Packaged-app trust boundary (#35, task 6) — cookie names + attribute
// builders. Pure string/object construction: no DB, no Next.js types, so
// both the route handlers (which serialize these into real Set-Cookie
// headers) and tests (which assert on the plain object) can use it directly.

export const SESSION_COOKIE = "vgs_session";
export const CSRF_COOKIE = "vgs_csrf";

/** 30 days in seconds — matches the session's absolute lifetime
 * (`ABSOLUTE_MS` in lib/queries/sessions.ts). Both cookies expire alongside
 * the session row itself, never independently. */
export const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export interface CookieAttrs {
  path: string;
  httpOnly: boolean;
  sameSite: "Lax";
  /** From config (APP_COOKIE_SECURE), never derived from req.url — see
   * app/api/auth/login/route.ts for why. */
  secure: boolean;
  /** Seconds; 0 clears the cookie immediately. */
  maxAge: number;
}

export interface SetCookie {
  name: string;
  value: string;
  attrs: CookieAttrs;
}

/**
 * Host-only (no Domain attribute — both the Electron shell talking to
 * localhost and the cloudflared tunnel want the cookie scoped to exactly the
 * host it was set from, never a parent domain), Path=/, SameSite=Lax.
 */
function baseAttrs(httpOnly: boolean, secure: boolean, maxAgeSeconds: number): CookieAttrs {
  return { path: "/", httpOnly, sameSite: "Lax", secure, maxAge: maxAgeSeconds };
}

export function buildSessionCookie(value: string, secure: boolean): SetCookie {
  return { name: SESSION_COOKIE, value, attrs: baseAttrs(true, secure, COOKIE_MAX_AGE_SECONDS) };
}

/** Not HttpOnly — client JS reads this to echo it back as the CSRF header
 * (double-submit-cookie pattern; the server-side check lives in csrfMatches). */
export function buildCsrfCookie(value: string, secure: boolean): SetCookie {
  return { name: CSRF_COOKIE, value, attrs: baseAttrs(false, secure, COOKIE_MAX_AGE_SECONDS) };
}

export function clearSessionCookie(secure: boolean): SetCookie {
  return { name: SESSION_COOKIE, value: "", attrs: baseAttrs(true, secure, 0) };
}

export function clearCsrfCookie(secure: boolean): SetCookie {
  return { name: CSRF_COOKIE, value: "", attrs: baseAttrs(false, secure, 0) };
}

/** Serializes a SetCookie into a literal `Set-Cookie` header value. */
export function serializeSetCookie(cookie: SetCookie): string {
  const parts = [`${cookie.name}=${cookie.value}`, `Path=${cookie.attrs.path}`, `Max-Age=${cookie.attrs.maxAge}`, `SameSite=${cookie.attrs.sameSite}`];
  if (cookie.attrs.httpOnly) parts.push("HttpOnly");
  if (cookie.attrs.secure) parts.push("Secure");
  return parts.join("; ");
}
