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

/** Revokes a single session (e.g. explicit sign-out on one device). */
export function revokeSession(db: Database.Database, id: number): void {
  db.prepare("DELETE FROM app_sessions WHERE id = ?").run(id);
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
