/**
 * POST /api/auth/login
 *
 * Packaged-app trust boundary (#35, task 6). Reads the single account
 * password from `process.env.APP_PASSWORD_HASH` (there is exactly one
 * account — no username, no user table) and, on success, mints a session +
 * CSRF cookie pair. No enforcement lives here yet: the session proxy that
 * actually gates every OTHER route on a valid cookie is task 18. Until then
 * this route exists and works but nothing requires calling it first.
 *
 * `handleLogin` is a pure, dependency-injected handler — no `NextRequest`,
 * no env read for anything but the password hash + cookie config — so it is
 * directly unit-testable without spinning up an HTTP server. `POST` is a
 * thin wrapper: parse the body, compute `secure` from config, call the
 * handler, translate its result into a real `Response`.
 */

import { NextRequest, NextResponse } from "next/server";
import type Database from "better-sqlite3";
import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/auth/credentials";
import { createSession } from "@/lib/mutations/sessions";
import { checkLoginThrottle, recordLoginFailure, resetLoginThrottle } from "@/lib/auth/throttle";
import { buildSessionCookie, buildCsrfCookie, serializeSetCookie, type SetCookie } from "@/lib/auth/cookies";

export interface LoginResult {
  status: number;
  setCookies: SetCookie[];
  body: { success: true; data: { csrfToken: string } } | { success: false; error: string };
}

/**
 * Pure login handler. Order of checks is deliberate:
 *   1. Throttle gate FIRST — a locked-out caller gets 429 regardless of
 *      whether the server is even configured correctly or what password
 *      they sent (don't leak configuration state to a caller who's already
 *      being rate-limited).
 *   2. Missing APP_PASSWORD_HASH → 500 (server misconfiguration, not a
 *      failed login attempt — does not consume a throttle slot).
 *   3. Wrong password → 401, no cookies, records a throttle failure.
 *   4. Correct password → creates a session, resets the throttle, returns
 *      both cookies.
 */
export function handleLogin(
  database: Database.Database,
  input: { password: string },
  config: { secure: boolean },
  nowMs: number = Date.now()
): LoginResult {
  if (!checkLoginThrottle(nowMs)) {
    return { status: 429, setCookies: [], body: { success: false, error: "Too many attempts. Try again later." } };
  }

  const storedHash = process.env.APP_PASSWORD_HASH;
  if (!storedHash) {
    return {
      status: 500,
      setCookies: [],
      body: { success: false, error: "Server not configured: APP_PASSWORD_HASH missing." },
    };
  }

  if (!verifyPassword(input.password, storedHash)) {
    recordLoginFailure(nowMs);
    return { status: 401, setCookies: [], body: { success: false, error: "Incorrect password." } };
  }

  resetLoginThrottle();
  const session = createSession(database, {}, nowMs);
  return {
    status: 200,
    setCookies: [
      buildSessionCookie(session.rawToken, config.secure),
      buildCsrfCookie(session.csrfToken, config.secure),
    ],
    body: { success: true, data: { csrfToken: session.csrfToken } },
  };
}

export async function POST(request: NextRequest) {
  const parsed = (await request.json().catch(() => ({}))) as { password?: string };
  // Config-driven, NOT req.url-derived: cloudflared terminates TLS and
  // proxies to the Mac over plain HTTP, so req.url would read "http" even
  // though the real client connection was HTTPS — a url-derived Secure flag
  // would wrongly omit Secure on the tunnel path. Electron's Chromium also
  // honors Secure on `localhost` in packaged-app dev, so defaulting true is
  // safe there too; APP_COOKIE_SECURE=0 is the explicit opt-out.
  const secure = process.env.APP_COOKIE_SECURE !== "0";

  const result = handleLogin(db, { password: parsed.password ?? "" }, { secure });

  const response = NextResponse.json(result.body, { status: result.status });
  for (const cookie of result.setCookies) {
    response.headers.append("Set-Cookie", serializeSetCookie(cookie));
  }
  return response;
}
