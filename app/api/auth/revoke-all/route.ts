/**
 * POST /api/auth/revoke-all
 *
 * Packaged-app trust boundary (#35, task 15). The server-owned half of the
 * Electron change-password transaction: Electron main CANNOT open the SQLite
 * session store itself (better-sqlite3's native binary only loads in the
 * system-Node child, per findSystemNode / npmRebuild:false), so it calls this
 * loopback-only, Electron-service-credential-gated endpoint to delete every
 * session on password change ("log out everywhere", incl. a lost phone).
 *
 * Mirrors desktop-bootstrap's gating exactly (shared verifiers in
 * lib/auth/electron-cred.ts) and is classified `electron` in
 * lib/auth/route-policy.ts. The loopback Host assertion is defense-in-depth on
 * top of the task-18 proxy.
 *
 * `handleRevokeAll` is pure + dependency-injected (no NextRequest, no env) so
 * it is unit-testable without HTTP.
 */

import { NextRequest, NextResponse } from "next/server";
import type Database from "better-sqlite3";
import { db } from "@/lib/db";
import { revokeAllSessions } from "@/lib/mutations/sessions";
import { isLoopbackHost, verifyElectronCred } from "@/lib/auth/electron-cred";

export interface RevokeAllResult {
  status: number;
  body: { success: true } | { success: false; error: string };
}

/** Pure handler: deletes every session row. Idempotent — a second call on an
 * already-empty store is a harmless no-op that still returns success. */
export function handleRevokeAll(database: Database.Database): RevokeAllResult {
  revokeAllSessions(database);
  return { status: 200, body: { success: true } };
}

export async function POST(request: NextRequest) {
  // Loopback-only, defense in depth: Electron main reaches this over
  // http://localhost:PORT. A non-loopback Host means the request did not
  // originate from the local shell — refuse before touching the credential.
  if (!isLoopbackHost(request.headers.get("host"))) {
    return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
  }

  const check = verifyElectronCred(request.headers.get("x-electron-cred"));
  if (!check.ok) {
    return NextResponse.json({ success: false, error: check.error }, { status: check.status });
  }

  const result = handleRevokeAll(db);
  return NextResponse.json(result.body, { status: result.status });
}
