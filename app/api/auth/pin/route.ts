/**
 * POST /api/auth/pin — SET a convenience PIN (#35, task 16, spec §B2).
 *
 * Requires a live full-password session: the caller's session cookie is
 * verified and the PIN is bound to that exact session row. Classified
 * "human" by default-deny in lib/auth/route-policy.ts (not on any
 * public/cron/electron allowlist), so the task-18 proxy already gates it on
 * a valid session cookie + CSRF. No session cookie / expired session -> 401;
 * the PIN can never be established without a prior password login on the
 * device.
 *
 * `handleSetPin` (lib/auth/pin.ts) is the pure, dependency-injected core;
 * POST is a thin wrapper: read cookie -> verify session -> call handler.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifySession } from "@/lib/queries/sessions";
import { handleSetPin } from "@/lib/auth/pin";
import { SESSION_COOKIE } from "@/lib/auth/cookies";

export async function POST(request: NextRequest) {
  const rawToken = request.cookies.get(SESSION_COOKIE)?.value;
  if (!rawToken) {
    return NextResponse.json({ success: false, error: "Not signed in." }, { status: 401 });
  }
  const session = verifySession(db, rawToken, Date.now());
  if (!session) {
    return NextResponse.json({ success: false, error: "Session expired. Sign in with your password." }, { status: 401 });
  }

  const parsed = (await request.json().catch(() => ({}))) as { pin?: string };
  const result = handleSetPin(db, session.id, parsed.pin ?? "", Date.now());

  if (!result.ok) {
    if (result.reason === "invalid-pin") {
      return NextResponse.json({ success: false, error: "PIN must be 4–8 digits." }, { status: 400 });
    }
    // session-invalid (raced expiry between verify and handler)
    return NextResponse.json({ success: false, error: "Session expired. Sign in with your password." }, { status: 401 });
  }

  return NextResponse.json({ success: true, data: {} });
}
