/**
 * Chat evaluation: the database guard.
 *
 * Every chat-eval script opens exactly the database named by `--db` and
 * refuses:
 *   1. a missing `--db` (there is no default: the live database is the
 *      default everywhere else in the repo);
 *   2. any file named `vanguard.db`, after symlinks are resolved, in any
 *      directory: that is the live database's name in every checkout
 *      (`data/vanguard.db`) and in the packaged app's data folder;
 *      (the app's default, `resolveDbPath()` with no DATABASE_PATH, always
 *      ends in that name, so this covers it);
 *   3. (runner and probe) a database without the eval marker that
 *      build-eval-db.ts writes, so a renamed copy of the live database, or
 *      any other database, is refused too.
 *
 * The resolved path is printed first by each script.
 */

import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

/** settings key written by build-eval-db.ts; its value is the fixture version. */
export const EVAL_MARKER_KEY = "chat_eval_fixture";
export const EVAL_FIXTURE_VERSION = "1";

const LIVE_BASENAME = "vanguard.db";

function realOrResolved(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    // Not there yet (an output path): resolve the parent instead.
    try {
      return path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
    } catch {
      return abs;
    }
  }
}

/** Why `dbPath` may not be used, or null when it may. Pure apart from resolving symlinks. */
export function liveDbRefusal(dbPath: string | undefined): string | null {
  if (!dbPath || !dbPath.trim()) return "--db is required (there is no default database)";
  const resolved = realOrResolved(dbPath);
  if (path.basename(resolved).toLowerCase() === LIVE_BASENAME) {
    return `refusing ${resolved}: a file named ${LIVE_BASENAME} is the live database's name`;
  }
  return null;
}

/** The resolved absolute path (symlinks followed where they exist). */
export function resolvedDbPath(dbPath: string): string {
  return realOrResolved(dbPath);
}

/** The eval marker's value in an open database, or null. */
export function readEvalMarker(db: Database.Database): string | null {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(EVAL_MARKER_KEY) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}
