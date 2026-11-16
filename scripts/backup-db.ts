/**
 * Take a backup of the live database now.
 * Run: npm run backup -- --purpose <slug> [--db <path>]
 * With no --db, the database is the owner's real one (the main checkout's
 * data/vanguard.db, wherever this runs from). It is opened read-only; a backup
 * of it goes to the backup home, any other file's backup goes beside that file.
 */
import Database from "better-sqlite3";
import { isLiveDatabase, resolveLiveDbPath } from "../lib/backup/backup-home";
import { takeBackup } from "../lib/backup/take-backup";

export const USAGE = "Usage: npm run backup -- --purpose <slug> [--db <path>]";

export interface BackupArgs {
  purpose: string;
  db: string | null;
}

/** Returns the parsed flags, or null when `--purpose` is missing or a value is absent. */
export function parseBackupArgs(argv: string[]): BackupArgs | null {
  const value = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    if (i === -1) return null;
    const v = argv[i + 1];
    return v === undefined || v.startsWith("--") ? null : v;
  };
  const purpose = value("--purpose");
  if (!purpose) return null;
  return { purpose, db: value("--db") };
}

async function main(): Promise<void> {
  const args = parseBackupArgs(process.argv.slice(2));
  if (!args) {
    console.error(USAGE);
    process.exit(2);
  }
  const dbPath = args.db ?? resolveLiveDbPath();
  if (dbPath === null) {
    console.error(
      "Could not find the live database (no git checkout above this script). Pass --db <path> or set VANGUARD_LIVE_DB_PATH.",
    );
    process.exit(2);
  }
  const live = isLiveDatabase(dbPath);
  console.log(`Backing up ${dbPath} (${live ? "the live database" : "not the live database: the backup goes beside it"})`);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const result = await takeBackup(db, { purpose: args.purpose });
    console.log(`Backup written: ${result.path} (${(result.sizeBytes / 1024 ** 2).toFixed(1)} MiB)`);
  } finally {
    db.close();
  }
}

const isMain =
  typeof process !== "undefined" && process.argv[1] != null && /backup-db\.(ts|js)$/.test(process.argv[1]);

if (isMain) {
  main().catch((err) => {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
