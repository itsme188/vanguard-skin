-- DB-backed opaque session store for the packaged-app auth boundary (#35,
-- task 1). No HTTP/cookies/proxy here yet — this is storage only. Sessions
-- are identified by a 256-bit random token; only its SHA-256 hash is stored
-- (token_hash), so a DB leak alone can't be replayed as a live session.
CREATE TABLE IF NOT EXISTS app_sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash    TEXT NOT NULL,
  csrf_secret   TEXT NOT NULL,
  label         TEXT NOT NULL DEFAULT 'device',
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_sessions_token ON app_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_app_sessions_expires ON app_sessions(expires_at);
