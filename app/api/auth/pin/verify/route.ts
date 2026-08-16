/**
 * POST /api/auth/pin/verify — RE-UNLOCK an existing device session with the
 * convenience PIN (#35, task 16, spec §B2).
 *
 * Reachable with a live session cookie: a "lock" after a foreground/short-idle
 * event is a CLIENT-side UX state — the browser still holds the (non-expired)
 * session cookie, so the server reads it normally. This route NEVER creates a
 * session: it only re-activates the one the cookie already names (touch/extend
 * its idle window) when the PIN matches. If the session is truly gone
 * (expired/revoked) the PIN is useless and the client must fall back to the
 * full password at /login. Classified "human" by default-deny in route-policy.
 *
 * Success touches the session server-side; the client keeps using the SAME
 * cookie it already has, so no Set-Cookie is needed here.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifySession } from "@/lib/queries/sessions";
import { handleVerifyPin } from "@/lib/auth/pin";
import { SESSION_COOKIE } from "@/lib/auth/cookies";

export async function POST(request: NextRequest) {
  const rawToken = request.cookies.get(SESSION_COOKIE)?.value;
  if (!rawToken) {
    return NextResponse.json({ success: false, error: "Session expired.", data: { fallback: "password" } }, { status: 401 });
  }
  const session = verifySession(db, rawToken, Date.now());
  if (!session) {
    return NextResponse.json({ success: false, error: "Session expired.", data: { fallback: "password" } }, { status: 401 });
  }

  const parsed = (await request.json().catch(() => ({}))) as { pin?: string };
  const result = handleVerifyPin(db, session.id, parsed.pin ?? "", Date.now());

  if (result.ok) {
    return NextResponse.json({ success: true, data: {} });
  }

  switch (result.reason) {
    case "session-invalid":
      return NextResponse.json({ success: false, error: "Session expired.", data: { fallback: "password" } }, { status: 401 });
    case "no-pin":
      return NextResponse.json({ success: false, error: "No PIN is set on this device.", data: { fallback: "password" } }, { status: 400 });
    case "locked":
      // 423 Locked — the PIN is disabled; only the full password recovers.
      return NextResponse.json({ success: false, error: "Too many attempts. Sign in with your password.", data: { fallback: "password", locked: true } }, { status: 423 });
    case "wrong-pin":
    default:
      return NextResponse.json(
        { success: false, error: "Incorrect PIN.", data: { attemptsRemaining: result.attemptsRemaining ?? 0 } },
        { status: 401 }
      );
  }
}
