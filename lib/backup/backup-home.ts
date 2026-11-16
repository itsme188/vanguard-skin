import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EnvLike } from "../db/db-path";

/** This file's own folder: the start of the walk up to the main checkout. */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** How many recent backups stay in `recent/` before older ones are archived. */
export const RECENT_BACKUPS_KEPT = 3;

/** Folder name of the backup home, created in the user's home directory. */
export const DEFAULT_BACKUP_DIRNAME = "portfolio-desk-backups";

/**
 * Where backups live. VANGUARD_BACKUP_DIR wins; otherwise a folder in the home
 * directory, deliberately outside the project and the app bundle.
 * `env` / `homeDir` are injectable so tests never touch the real environment.
 */
export function resolveBackupHome(
  env: EnvLike = process.env,
  homeDir: string = os.homedir(),
): string {
  const configured = env.VANGUARD_BACKUP_DIR;
  // A relative value resolves under the home directory, never the process cwd
  // (which could be inside the project).
  if (configured) return path.resolve(homeDir, configured);
  return path.join(homeDir, DEFAULT_BACKUP_DIRNAME);
}

/** The fixed layout inside a backup home. */
export function backupPaths(home: string): {
  recent: string;
  archives: string;
  log: string;
  rollLock: string;
} {
  return {
    recent: path.join(home, "recent"),
    archives: path.join(home, "archives"),
    log: path.join(home, "backup-log.jsonl"),
    rollLock: path.join(home, ".roll.lock"),
  };
}

/**
 * Eastern wall-clock date and time to the second, safe in a file name
 * (`YYYY-MM-DD_HH-MM-SS`). Every backup gets its own name, so a second
 * run on the same day never reuses an earlier, stale backup.
 */
export function backupStamp(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")}_${part("hour")}-${part("minute")}-${part("second")}`;
}

const PURPOSE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** `pre-<purpose>-<stamp>.db`. A leading `pre-` on `purpose` is not doubled.
 *  Throws when `purpose` is not a plain lowercase slug (no path pieces). */
export function backupFileName(purpose: string, now: Date): string {
  if (!PURPOSE_PATTERN.test(purpose)) {
    throw new Error(`Invalid backup purpose: ${JSON.stringify(purpose)}`);
  }
  const slug = purpose.startsWith("pre-") ? purpose.slice(4) : purpose;
  if (!PURPOSE_PATTERN.test(slug)) {
    throw new Error(`Invalid backup purpose: ${JSON.stringify(purpose)}`);
  }
  return `pre-${slug}-${backupStamp(now)}.db`;
}

/** The `YYYY-MM` of the LAST valid `YYYY-MM-DD` in a backup file name (the
 *  stamp is always at the end; a purpose could itself contain a date), or null
 *  when the name carries no valid date (month 01-12, day 01-31). Handles
 *  `_HH-MM-SS`, ISO `T...Z`, and date-only stamps. */
export function archiveMonth(fileName: string): string | null {
  let found: string | null = null;
  for (const m of fileName.matchAll(/(\d{4}-(\d{2}))-(\d{2})/g)) {
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) found = m[1];
  }
  return found;
}

/** The main checkout's folder, found by walking up from `startDir` to the first
 *  `.git`. A `.git` folder marks the main checkout itself; a `.git` file marks a
 *  linked worktree, whose `gitdir` + `commondir` lead back to the main `.git`. */
function findMainCheckout(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    const dotGit = path.join(dir, ".git");
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      stat = null;
    }
    if (stat?.isDirectory()) return dir;
    if (stat?.isFile()) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, "utf8"));
      if (!m) return null;
      const gitdir = path.resolve(dir, m[1]);
      const commondir = fs.readFileSync(path.join(gitdir, "commondir"), "utf8").trim();
      return path.dirname(path.resolve(gitdir, commondir));
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Absolute path of the owner's real database file (the main checkout's
 * `data/vanguard.db`), or null when it cannot be determined.
 * VANGUARD_LIVE_DB_PATH wins; otherwise the main checkout is found from where
 * this source file lives, never from the working folder, DATABASE_PATH or
 * VANGUARD_DB_DIR. `moduleDir` is injectable for tests.
 */
export function resolveLiveDbPath(
  env: EnvLike = process.env,
  moduleDir: string = MODULE_DIR,
): string | null {
  if (env.VANGUARD_LIVE_DB_PATH) return path.resolve(env.VANGUARD_LIVE_DB_PATH);
  let main: string | null;
  try {
    main = findMainCheckout(moduleDir);
  } catch {
    return null; // an unreadable .git file or commondir: cannot tell
  }
  return main ? path.join(main, "data", "vanguard.db") : null;
}

/** True when `dbPath` is the same file as the owner's real database, by file
 *  identity (device and inode), which sees through symlinks. False for an
 *  in-memory database, or when either file does not exist. */
export function isLiveDatabase(
  dbPath: string,
  env: EnvLike = process.env,
  moduleDir: string = MODULE_DIR,
): boolean {
  if (dbPath === "" || dbPath === ":memory:") return false;
  const live = resolveLiveDbPath(env, moduleDir);
  if (live === null) return false;
  try {
    const a = fs.statSync(dbPath);
    const b = fs.statSync(live);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}
