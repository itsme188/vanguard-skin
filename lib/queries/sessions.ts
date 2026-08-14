import type Database from "better-sqlite3";
import { createHash } from "node:crypto";

// Packaged-app trust boundary (#35, task 1) — DB-backed opaque session store.
// No HTTP/cookies here; this file is the read side only.

/** Absolute session lifetime: 30 days from creation, regardless of activity. */
export const ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
/** Idle timeout: a session with no activity for 7 days is treated as expired,
 * even while still inside the absolute window. */
export const IDLE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Single source of truth for hashing the raw bearer token before storage
 * or lookup. Only this hash ever touches the database. */
export function hashSessionToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

interface AppSessionRow {
  id: number;
  token_hash: string;
  csrf_secret: string;
  label: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
}

export interface VerifiedSession {
  id: number;
  csrfSecret: string;
  label: string;
}

/**
 * Looks up a session by its raw bearer token and validates both expiry
 * windows: absolute (expires_at, set at creation) and idle (last_seen_at +
 * IDLE_WINDOW_MS). Side-effect-free — does not touch last_seen_at; callers
 * that want to slide the idle window call touchSession() separately.
 */
export function verifySession(
  db: Database.Database,
  rawToken: string,
  nowMs: number
): VerifiedSession | null {
  const tokenHash = hashSessionToken(rawToken);
  const row = db
    .prepare("SELECT * FROM app_sessions WHERE token_hash = ?")
    .get(tokenHash) as AppSessionRow | undefined;
  if (!row) return null;

  const expiresAtMs = Date.parse(row.expires_at);
  if (expiresAtMs <= nowMs) return null;

  const lastSeenMs = Date.parse(row.last_seen_at);
  if (lastSeenMs + IDLE_WINDOW_MS <= nowMs) return null;

  return { id: row.id, csrfSecret: row.csrf_secret, label: row.label };
}
