/**
 * POST /api/auth/logout
 *
 * Packaged-app trust boundary (#35, task 6). Revokes the caller's session
 * (if the cookie names a real, still-valid one) and clears both cookies
 * regardless — a stale/forged/already-expired session cookie should still
 * come back cleared, not bounce with an error. State-changing, so POST
 * (never GET — GET routes carry no CSRF protection under SameSite=Lax; see
 * task 5 / tests/api/no-state-changing-get.test.ts).
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifySession } from "@/lib/queries/sessions";
import { revokeSession } from "@/lib/mutations/sessions";
import { SESSION_COOKIE, clearSessionCookie, clearCsrfCookie, serializeSetCookie } from "@/lib/auth/cookies";

export async function POST(request: NextRequest) {
  const secure = process.env.APP_COOKIE_SECURE !== "0";

  const rawToken = request.cookies.get(SESSION_COOKIE)?.value;
  if (rawToken) {
    const session = verifySession(db, rawToken, Date.now());
    if (session) {
      revokeSession(db, session.id);
    }
  }

  const response = NextResponse.json({ success: true, data: {} });
  response.headers.append("Set-Cookie", serializeSetCookie(clearSessionCookie(secure)));
  response.headers.append("Set-Cookie", serializeSetCookie(clearCsrfCookie(secure)));
  return response;
}
