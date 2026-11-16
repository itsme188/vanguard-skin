import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { backupFileName, backupPaths, isLiveDatabase, resolveBackupHome } from "./backup-home";
import { rollOldBackups, type RollResult } from "./roll";
import type { EnvLike } from "../db/db-path";

export interface TakeBackupOptions {
  purpose: string;
  now?: Date;
  env?: EnvLike;
  cwd?: string;
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
 * A backup of the live database goes to `<home>/recent`, is logged, and
 * triggers the roll. Any other database keeps its backups beside it, with no
 * log line and no roll. A roll failure never fails the backup.
 */
export async function takeBackup(
  db: Database.Database,
  opts: TakeBackupOptions,
): Promise<BackupResult> {
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const log = opts.log ?? console.log;
  const script = opts.script ?? path.basename(process.argv[1] ?? "");

  const dbName = db.name;
  const inMemory = dbName === "" || dbName === ":memory:";
  if (inMemory && !opts.backupDir) {
    throw new Error("takeBackup: an in-memory database needs an explicit backupDir");
  }

  const home = resolveBackupHome(env);
  const live = !inMemory && !opts.backupDir && isLiveDatabase(dbName, env, cwd);
  const dir = opts.backupDir ?? (live ? backupPaths(home).recent : path.join(path.dirname(dbName), "backups"));

  const target = path.join(dir, backupFileName(opts.purpose, now));
  if (fs.existsSync(target)) {
    throw new Error(`Backup target already exists, refusing to reuse it: ${target}`);
  }
  fs.mkdirSync(dir, { recursive: true });

  const partial = `${target}.partial`;
  // A leftover of a crashed run would make VACUUM INTO refuse. A concurrent run with the
  // same purpose in the same second is the only way this removes a live partial; the
  // link step below still protects the target.
  fs.rmSync(partial, { force: true });
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
    `${JSON.stringify({ file: target, purpose: opts.purpose, script, takenAt: now.toISOString(), sizeBytes, migrations })}\n`,
  );

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
