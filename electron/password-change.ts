// Packaged-app trust boundary (#35, task 15) — the change-password transaction
// SEQUENCER. Pure + dependency-injected (no `electron`, no HTTP, no DB import)
// so it is unit-testable under vitest's plain Node environment and lives under
// electron/ so it compiles with electron/tsconfig.json (rootDir ".").
//
// The order is load-bearing and enforced here so main.ts's wiring can't get it
// wrong (spec §B):
//   1. verify the CURRENT password         — abort with no side effects if wrong
//   2. write the NEW hash to safeStorage    — the durable source of truth
//   3. revoke ALL sessions                  — old cookies (incl. lost phones) die
//   4. restart the child server             — it re-reads APP_PASSWORD_HASH from env
//                                             (a running server cannot hot-swap it)
//   5. re-bootstrap the desktop session     — re-mint + reinstall the window cookie
//
// revoke-before-restart is deliberate: the revoke-all endpoint is served by the
// still-running old child; after the restart the new child owns a session store
// with the old rows already gone, so a stale hash can never keep validating and
// a stolen cookie is dead the moment the transaction completes.

export interface PasswordChangeDeps {
  /** Returns false if the supplied current password does not match the stored hash. */
  verifyCurrent: () => boolean;
  /** Persists the new scrypt hash via safeStorage (setEncryptedSecret). */
  writeHash: () => void;
  /** Calls the server-owned POST /api/auth/revoke-all (Electron main can't open the DB). */
  revokeAll: () => Promise<void>;
  /** Tears down and respawns the child server so it re-reads APP_PASSWORD_HASH. */
  restart: () => Promise<void>;
  /** Re-runs desktop-bootstrap and reinstalls the window's session cookies. */
  rebootstrap: () => Promise<void>;
}

export interface PasswordChangeResult {
  success: boolean;
  error?: string;
}

export async function runPasswordChange(deps: PasswordChangeDeps): Promise<PasswordChangeResult> {
  if (!deps.verifyCurrent()) {
    return { success: false, error: "Current password is incorrect." };
  }
  deps.writeHash();
  await deps.revokeAll();
  await deps.restart();
  await deps.rebootstrap();
  return { success: true };
}
