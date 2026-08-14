-- Convenience PIN for quick re-unlock of an existing device session (#35,
-- task 16). The PIN is NOT a second password: it only re-activates an
-- existing, non-expired session on the SAME device (spec §B2). It is a UX
-- veneer bound to one app_sessions row, so it lives and dies with that
-- session — the FK ON DELETE CASCADE means "revoke device -> PIN dead"
-- is enforced by the database itself, not application code.
--
-- Storage is the same scrypt slow-hash used for the account password
-- (hashPin/verifyPin in lib/auth/credentials.ts). fail_count + locked drive
-- lockout: after N wrong attempts the PIN is disabled and the full password
-- is required again (a fresh full-password login mints a new session with
-- no PIN). One row per session at most (session_id is the PRIMARY KEY).
CREATE TABLE IF NOT EXISTS session_pins (
  session_id  INTEGER PRIMARY KEY REFERENCES app_sessions(id) ON DELETE CASCADE,
  pin_hash    TEXT NOT NULL,
  fail_count  INTEGER NOT NULL DEFAULT 0,
  locked      INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
