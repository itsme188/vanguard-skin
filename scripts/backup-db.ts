/**
 * Take a backup of the live database now.
 * Run: npm run backup -- --purpose <slug> [--db <path>]
 * The database is opened read-only; the copy goes to the backup home.
 */
import Database from "better-sqlite3";
import { takeBackup } from "@/lib/backup/take-backup";
import { resolveDbPath } from "@/lib/db/db-path";

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
  const dbPath = args.db ?? resolveDbPath();
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
