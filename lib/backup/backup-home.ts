import os from "node:os";
import path from "node:path";
import { resolveDbPath, type EnvLike } from "@/lib/db/db-path";

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
  return env.VANGUARD_BACKUP_DIR || path.join(homeDir, DEFAULT_BACKUP_DIRNAME);
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
  return `pre-${slug}-${backupStamp(now)}.db`;
}

/** The `YYYY-MM` of the first `YYYY-MM-DD` in a backup file name, or null
 *  when the name carries no date. Handles `_HH-MM-SS`, ISO `T...Z`, and
 *  date-only stamps. */
export function archiveMonth(fileName: string): string | null {
  const m = /(\d{4}-\d{2})-\d{2}/.exec(fileName);
  return m ? m[1] : null;
}

/** True when `dbPath` is the live database (same resolved path). */
export function isLiveDatabase(
  dbPath: string,
  env: EnvLike = process.env,
  cwd: string = process.cwd(),
): boolean {
  return path.resolve(dbPath) === path.resolve(resolveDbPath(env, cwd));
}
