import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { uniqueTempPath } from "./archive";
import { backupFileName, backupPaths, isLiveDatabase, resolveBackupHome, resolveLiveDbPath } from "./backup-home";
import { ensureRestoreNotes } from "./restore-notes";
import { rollOldBackups, type RollResult } from "./roll";
import type { EnvLike } from "../db/db-path";

export interface TakeBackupOptions {
  purpose: string;
  now?: Date;
  env?: EnvLike;
  /** Required for a `:memory:` database; otherwise derived. */
  backupDir?: string;
  /** Script name for the log line. Defaults to path.basename(process.argv[1] ?? ""). */
  script?: string;
  /** Injected roll; defaults to rollOldBackups. Tests pass a spy. */
  roll?: (home: string) => Promise<RollResult> | RollResult;
  log?: (line: string) => void;
}

export interface BackupResult {
  path: string;
  sizeBytes: number;
  rolled: boolean;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Real path when it exists, else the plain resolved path. */
function realOrResolved(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** True when `child` is `parent` or anywhere beneath it. */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Opens the finished copy read-only, checks it, and reads its migration count. */
function verifyCopy(file: string): { migrations: number | null } {
  const copy = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const rows = copy.pragma("integrity_check") as { integrity_check: string }[];
    if (rows.length !== 1 || rows[0].integrity_check !== "ok") {
      throw new Error(`integrity check failed: ${rows.map((r) => r.integrity_check).join("; ")}`);
    }
    const hasTable = copy
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get();
    if (!hasTable) return { migrations: null };
    const row = copy.prepare("SELECT count(*) AS n FROM schema_migrations").get() as { n: number };
    return { migrations: row.n };
  } finally {
    copy.close();
  }
}

/**
 * Takes one backup of `db` with `VACUUM INTO`, proves the copy with an
 * integrity check, and only then gives it its final name. It never reports
 * success for a copy that is not valid, and never reuses an existing file.
 *
 * A backup of the live database (the same file as the main checkout's
 * `data/vanguard.db`, wherever the script runs from) goes to `<home>/recent`,
 * is logged, and triggers the roll. Any other database keeps its backups
 * beside it, with no log line and no roll, except that nothing is ever written
 * under the main checkout's `data/` folder: that case is refused. A roll
 * failure never fails the backup.
 */
export async function takeBackup(
  db: Database.Database,
  opts: TakeBackupOptions,
): Promise<BackupResult> {
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const log = opts.log ?? console.log;
  const script = opts.script ?? path.basename(process.argv[1] ?? "");

  const dbName = db.name;
  const inMemory = dbName === "" || dbName === ":memory:";
  if (inMemory && !opts.backupDir) {
    throw new Error("takeBackup: an in-memory database needs an explicit backupDir");
  }

  const home = resolveBackupHome(env);
  const live = !inMemory && !opts.backupDir && isLiveDatabase(dbName, env);
  let dir: string;
  if (opts.backupDir) {
    dir = opts.backupDir;
  } else if (live) {
    dir = backupPaths(home).recent;
  } else {
    dir = path.join(path.dirname(dbName), "backups");
    const liveDb = resolveLiveDbPath(env);
    const beside = path.join(realOrResolved(path.dirname(dbName)), "backups");
    if (liveDb !== null && isInside(realOrResolved(path.dirname(liveDb)), beside)) {
      throw new Error(
        `Refusing to back up ${dbName}: backups are never written under the project's data folder ` +
          `(${path.dirname(liveDb)}). Choose a place with the backupDir option (VANGUARD_BACKUP_DIR only moves the live database's backup home). Nothing written.`,
      );
    }
  }

  const target = path.join(dir, backupFileName(opts.purpose, now));
  if (fs.existsSync(target)) {
    throw new Error(`Backup target already exists, refusing to reuse it: ${target}`);
  }
  fs.mkdirSync(dir, { recursive: true });

  // Unique to this run, so two runs with the same purpose in the same second never share
  // (or delete) each other's copy in progress. A crashed run's leftover `.partial` in
  // recent/ is swept by the roll once it is stale.
  const partial = uniqueTempPath(target, ".partial");
  let migrations: number | null;
  try {
    db.prepare("VACUUM INTO ?").run(partial);
    // Flush to disk. Opened "r+" because fsync on a read-only handle is not enough on macOS.
    const fd = fs.openSync(partial, "r+");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    ({ migrations } = verifyCopy(partial));
    // No-clobber finish: link fails with EEXIST if the target exists, unlike rename.
    fs.linkSync(partial, target);
    fs.rmSync(partial);
  } catch (err) {
    fs.rmSync(partial, { force: true });
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Backup target already exists; refusing to reuse it. Nothing written: ${target}`);
    }
    throw err;
  }

  const sizeBytes = fs.statSync(target).size;
  if (!live) return { path: target, sizeBytes, rolled: false };

  // A throw here is deliberate: the caller is about to mutate data, so failing loud is the
  // safe direction, even though a valid unlogged backup remains in recent/.
  fs.appendFileSync(
    backupPaths(home).log,
    `${JSON.stringify({ file: target, purpose: opts.purpose, script, takenAt: now.toISOString(), sizeBytes, migrations, source: fs.realpathSync(dbName) })}\n`,
  );

  // Restore steps travel with the backups. Never fails the backup.
  try {
    ensureRestoreNotes(home);
  } catch (err) {
    log(`backup taken; restore notes not written: ${errMessage(err)}`);
  }

  let rolled = false;
  try {
    const roll = opts.roll ?? ((h: string) => rollOldBackups(h, { env, now, log }));
    const result = await roll(home);
    if (result.skipped) log(`backup taken; roll skipped: ${result.skipped}`);
    else rolled = true;
  } catch (err) {
    log(`backup taken; roll skipped: ${errMessage(err)}`);
  }
  return { path: target, sizeBytes, rolled };
}
