// Packaged-app trust boundary (#35, task 17) — the Electron-main SERVICE
// CREDENTIAL rotation SEQUENCER. Pure + dependency-injected (no `electron`, no
// HTTP, no DB import) so it is unit-testable under vitest's plain Node
// environment and lives under electron/ so it compiles with
// electron/tsconfig.json (rootDir ".") — mirrors password-change.ts (task 15).
//
// ELECTRON_SERVICE_CRED lives in the already-spawned child server's env, so a
// running server can never hot-swap it. The order below is load-bearing:
//   1. mint + persist a NEW credential (setEncryptedSecret via rotateSecret)
//      — the durable source of truth, and the caller updates its in-memory
//      copy here so later steps see the new value immediately.
//   2. restart the child server                — it re-reads
//                                                  ELECTRON_SERVICE_CRED from
//                                                  env on spawn (a running
//                                                  process cannot hot-swap it)
//   3. re-run desktop-bootstrap                 — the restarted server now
//                                                  expects the NEW credential;
//                                                  re-mint + reinstall the
//                                                  window's session cookies
//
// Unlike password change, rotation has no "verify current" step (there is no
// human secret to check — the Electron main process is inherently the only
// caller) and no separate revoke-all step: the credential only gates the
// main process's own service-to-service calls (bootstrap + tws/*), not human
// sessions, so nothing else needs to be invalidated. The old credential dies
// naturally the instant the restarted server is running with the new
// expected value in its env — any caller still presenting the old value 401s.

export interface CredentialRotationDeps {
  /**
   * Generates a NEW credential, persists it (rotateSecret ->
   * setEncryptedSecret), updates any in-memory copy the caller holds, and
   * returns the new value. Throws (fail-closed) if it can't be written, e.g.
   * safeStorage/OS keychain unavailable — the transaction aborts before
   * restarting or re-bootstrapping, so the app is never left half-rotated.
   */
  writeCred: () => string;
  /** Tears down and respawns the child server so it re-reads ELECTRON_SERVICE_CRED. */
  restart: () => Promise<void>;
  /** Re-runs desktop-bootstrap (with the NEW cred) and reinstalls the window's session cookies. */
  rebootstrap: () => Promise<void>;
}

export interface CredentialRotationResult {
  success: true;
  newCred: string;
}

export async function runCredentialRotation(
  deps: CredentialRotationDeps,
): Promise<CredentialRotationResult> {
  const newCred = deps.writeCred();
  await deps.restart();
  await deps.rebootstrap();
  return { success: true, newCred };
}

/**
 * The IPC/renderer-facing result shape for the Settings "rotate" action.
 * Deliberately narrower than `CredentialRotationResult`: it never carries
 * `newCred` — the raw service credential must never cross the IPC boundary
 * into the renderer (spec §F.3 isolation: injected only into the child
 * server's env, never exposed via preload/get-settings). main.ts's
 * transaction wrapper catches a thrown sequencer error and maps it to
 * `{ success: false, error }`; a clean run maps to `{ success: true }`.
 */
export interface RotateCredentialResult {
  success: boolean;
  error?: string;
}
