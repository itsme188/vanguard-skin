import path from "node:path";

/** Just the shape these readers need. Deliberately NOT NodeJS.ProcessEnv:
 *  Next augments that type with a REQUIRED NODE_ENV, so a test could not pass
 *  a small literal env object. */
export type EnvLike = Record<string, string | undefined>;

/**
 * Where the SQLite database lives at runtime — the single source of that
 * resolution, shared by the db singleton (lib/db.ts) and anything that must
 * put a sidecar file NEXT TO the database rather than next to `process.cwd()`.
 *
 * Why the distinction matters: in the packaged Electron app the server's cwd
 * is the read-only, code-signed bundle
 * (/Applications/Vanguard Dashboard.app/Contents/Resources/standalone) while
 * the database lives in the user's writable data dir, which electron/main.ts
 * injects as VANGUARD_DB_DIR. Anything anchored to cwd is unwritable there
 * (QA import-undo--500-eperm-recovery-manifest-in-app-bundle).
 *
 * Precedence (unchanged): DATABASE_PATH (full path to a .db file) wins, so a
 * worktree can point at the main repo's live DB; otherwise
 * VANGUARD_DB_DIR/vanguard.db; otherwise <cwd>/data/vanguard.db.
 *
 * `env` / `cwd` are injectable so tests never mutate the real environment.
 */
export function resolveDbPath(
  env: EnvLike = process.env,
  cwd: string = process.cwd(),
): string {
  return (
    env.DATABASE_PATH ||
    path.join(env.VANGUARD_DB_DIR || path.join(cwd, "data"), "vanguard.db")
  );
}

/** The directory holding the resolved database file — the writable home for
 *  DB sidecars (recovery manifests, exports). */
export function resolveDbDir(
  env: EnvLike = process.env,
  cwd: string = process.cwd(),
): string {
  return path.dirname(resolveDbPath(env, cwd));
}
