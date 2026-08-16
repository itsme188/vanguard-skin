import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { ABSOLUTE_MS, hashSessionToken } from "@/lib/queries/sessions";

// Packaged-app trust boundary (#35, task 1) — DB-backed opaque session store.
// No HTTP/cookies here; this file is the write side only.

export { ABSOLUTE_MS, IDLE_WINDOW_MS } from "@/lib/queries/sessions";

export interface CreatedSession {
  rawToken: string;
  csrfToken: string;
  id: number;
}

/**
 * Creates a new session: a 256-bit random bearer token (only its SHA-256 is
 * stored; the raw value is returned once and never persisted) plus a
 * 256-bit CSRF secret (stored in plaintext — verifySession hands it back on
 * every call so a later HTTP layer can compare it against a submitted
 * header/form value). expires_at is fixed at creation to now + ABSOLUTE_MS.
 */
export function createSession(
  db: Database.Database,
  { label }: { label?: string },
  nowMs: number
): CreatedSession {
  const rawToken = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  const tokenHash = hashSessionToken(rawToken);
  const nowIso = new Date(nowMs).toISOString();
  const expiresIso = new Date(nowMs + ABSOLUTE_MS).toISOString();

  const result = db
    .prepare(
      `INSERT INTO app_sessions (token_hash, csrf_secret, label, created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(tokenHash, csrfToken, label ?? "device", nowIso, nowIso, expiresIso);

  return { rawToken, csrfToken, id: result.lastInsertRowid as number };
}

/**
 * Slides the idle window forward, but only when outside the throttle —
 * a conditional UPDATE (not a read-then-write) so concurrent requests never
 * race and every call inside the window is a cheap no-op.
 */
export function touchSession(db: Database.Database, id: number, nowMs: number, throttleMs: number): void {
  const nowIso = new Date(nowMs).toISOString();
  const throttleIso = new Date(nowMs - throttleMs).toISOString();
  db.prepare("UPDATE app_sessions SET last_seen_at = ? WHERE id = ? AND last_seen_at < ?").run(
    nowIso,
    id,
    throttleIso
  );
}

/** Revokes a single session (e.g. explicit sign-out on one device). Its
 * convenience-PIN row (if any) is removed automatically by the
 * session_pins FK ON DELETE CASCADE — revoke device => PIN dead. */
export function revokeSession(db: Database.Database, id: number): void {
  db.prepare("DELETE FROM app_sessions WHERE id = ?").run(id);
}

/**
 * Sets (or replaces) the convenience PIN bound to a session (#35, task 16).
 * Upsert: re-setting a PIN always clears any accumulated failure/lockout
 * state, so `fail_count`/`locked` reset to 0. Never touches app_sessions —
 * a PIN is a veneer over an already-created session, never a way to make one.
 */
export function setSessionPin(
  db: Database.Database,
  sessionId: number,
  pinHash: string,
  nowMs: number
): void {
  const nowIso = new Date(nowMs).toISOString();
  db.prepare(
    `INSERT INTO session_pins (session_id, pin_hash, fail_count, locked, created_at, updated_at)
     VALUES (?, ?, 0, 0, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       pin_hash = excluded.pin_hash,
       fail_count = 0,
       locked = 0,
       updated_at = excluded.updated_at`
  ).run(sessionId, pinHash, nowIso, nowIso);
}

/** Records one wrong-PIN attempt and locks the PIN out once the running
 * count reaches `maxAttempts`. Returns the post-update state so the caller
 * can report attempts-remaining / the just-tripped lockout. A no-op (row
 * absent) returns failCount 0, locked false. */
export function recordPinFailure(
  db: Database.Database,
  sessionId: number,
  maxAttempts: number,
  nowMs: number
): { failCount: number; locked: boolean } {
  const nowIso = new Date(nowMs).toISOString();
  db.prepare(
    `UPDATE session_pins
        SET fail_count = fail_count + 1,
            locked = CASE WHEN fail_count + 1 >= ? THEN 1 ELSE locked END,
            updated_at = ?
      WHERE session_id = ?`
  ).run(maxAttempts, nowIso, sessionId);
  const row = db
    .prepare("SELECT fail_count, locked FROM session_pins WHERE session_id = ?")
    .get(sessionId) as { fail_count: number; locked: number } | undefined;
  return { failCount: row?.fail_count ?? 0, locked: !!row?.locked };
}

/** Clears failure/lockout state after a correct PIN (or an admin reset). */
export function resetPinFailures(db: Database.Database, sessionId: number, nowMs: number): void {
  const nowIso = new Date(nowMs).toISOString();
  db.prepare(
    "UPDATE session_pins SET fail_count = 0, locked = 0, updated_at = ? WHERE session_id = ?"
  ).run(nowIso, sessionId);
}

/** Revokes every session (e.g. "sign out everywhere"). */
export function revokeAllSessions(db: Database.Database): void {
  db.prepare("DELETE FROM app_sessions").run();
}

/**
 * Bounded sweep of absolute-expired sessions (expires_at < now). Idle-expired
 * sessions still inside their absolute window are left alone — verifySession
 * already rejects them; this just reclaims rows once they're unambiguously
 * dead. Bounded by `limit` so a large backlog can't block the caller (e.g. a
 * cron tick) with one giant DELETE.
 */
export function cleanupExpiredSessions(db: Database.Database, nowMs: number, limit: number = 500): number {
  const nowIso = new Date(nowMs).toISOString();
  const result = db
    .prepare(
      `DELETE FROM app_sessions WHERE id IN (
         SELECT id FROM app_sessions WHERE expires_at < ? LIMIT ?
       )`
    )
    .run(nowIso, limit);
  return result.changes;
}
