/**
 * POST /api/auth/desktop-bootstrap
 *
 * Packaged-app trust boundary (#35, task 14). The Electron main process
 * launches the Next server as a child, but cannot open the SQLite session
 * store itself (better-sqlite3's native binary only loads in the system-Node
 * child, per findSystemNode / npmRebuild:false) and runs before migrations.
 * So the SERVER mints the renderer window's human session here, authenticated
 * by the ELECTRON-MAIN SERVICE CREDENTIAL, and Electron installs the returned
 * cookies on the window partition before loading /dashboard.
 *
 * This is NOT the login route. It authenticates the Electron MAIN PROCESS (a
 * trusted local peer holding the service credential), not a human password.
 * It is loopback-only and classified `electron` by lib/auth/route-policy.ts
 * (task 3); the loopback host assertion below is defense-in-depth on top of
 * the task-18 proxy.
 *
 * `handleDesktopBootstrap` is pure + dependency-injected (no NextRequest, no
 * env beyond the service credential) so it is unit-testable without HTTP.
 */

import { NextRequest, NextResponse } from "next/server";
import type Database from "better-sqlite3";
import { db } from "@/lib/db";
import { createSession, cleanupExpiredSessions } from "@/lib/mutations/sessions";
import { isLoopbackHost, verifyElectronCred } from "@/lib/auth/electron-cred";

// isLoopbackHost is re-exported so existing callers/tests keep importing it
// from this route; the implementation is single-sourced in electron-cred.ts.
export { isLoopbackHost };

export interface DesktopBootstrapResult {
  status: number;
  body:
    | { success: true; data: { session: string; csrf: string } }
    | { success: false; error: string };
}

/**
 * Pure bootstrap handler.
 *   1. Missing ELECTRON_SERVICE_CRED env → 500 (server misconfiguration).
 *   2. Missing/wrong credential → 401 (constant-time compare).
 *   3. Match → mint a FRESH `desktop`-labeled session and return its raw
 *      bearer token + CSRF secret. A fresh session per launch is intentional:
 *      only the token hash is stored, so raw-token reuse is impossible.
 * Opportunistically reclaims absolute-expired session rows on the success
 * path (bounded sweep) so repeated launches don't accumulate dead rows.
 */
export function handleDesktopBootstrap(
  database: Database.Database,
  providedCred: string,
  nowMs: number = Date.now(),
): DesktopBootstrapResult {
  const check = verifyElectronCred(providedCred);
  if (!check.ok) {
    return { status: check.status, body: { success: false, error: check.error } };
  }

  cleanupExpiredSessions(database, nowMs);
  const session = createSession(database, { label: "desktop" }, nowMs);
  return {
    status: 200,
    body: { success: true, data: { session: session.rawToken, csrf: session.csrfToken } },
  };
}

export async function POST(request: NextRequest) {
  // Loopback-only, defense in depth: the Electron main process reaches this
  // over http://localhost:PORT. A non-loopback Host means the request did not
  // originate from the local shell — refuse without touching the credential.
  if (!isLoopbackHost(request.headers.get("host"))) {
    return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
  }

  const cred = request.headers.get("x-electron-cred") ?? "";
  const result = handleDesktopBootstrap(db, cred);
  return NextResponse.json(result.body, { status: result.status });
}
