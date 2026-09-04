import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Runs before every test file: pin DATABASE_PATH at a scratch database so no
 * test can reach the real one.
 *
 * `lib/db.ts` opens `resolveDbPath()` and runs every pending migration at
 * MODULE LOAD, so merely importing the singleton — directly or transitively —
 * migrates whatever database that resolves to. Unpinned it is
 * `<cwd>/data/vanguard.db`: harmless in a worktree (creates a throwaway),
 * live-firing in the main checkout. See
 * tests/repo/tests-never-touch-live-db.test.ts for the 2026-09-04 incident.
 *
 * Per worker PROCESS, so parallel workers never share one file and race each
 * other's migrations.
 */
const liveDb = path.resolve(process.cwd(), "data", "vanguard.db");

if (!process.env.DATABASE_PATH) {
  process.env.DATABASE_PATH = path.join(
    os.tmpdir(),
    `vanguard-skin-vitest-${process.pid}`,
    "vanguard.db",
  );
}

/** Real-path AND (dev, ino) identity — a symlink or hardlink to the live file
 *  IS the live file. Same test the 089 cutover runner uses. */
function isLiveDb(candidate: string): boolean {
  try {
    const a = fs.statSync(fs.realpathSync(candidate));
    const b = fs.statSync(fs.realpathSync(liveDb));
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    // Either path may not exist yet (a scratch file on first run) — fall back
    // to the string comparison rather than letting the guard itself throw.
    return path.resolve(candidate) === liveDb;
  }
}

// An explicitly-set DATABASE_PATH is honoured (the QA sandbox recipe uses one),
// but never when it points at the live database.
if (isLiveDb(process.env.DATABASE_PATH)) {
  throw new Error(
    `tests refuse to run against the live database (${liveDb}) — ` +
      `unset DATABASE_PATH or point it at a scratch copy`,
  );
}
