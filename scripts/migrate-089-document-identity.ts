/**
 * migrate-089-document-identity.ts — run the 089 document-identity rebuild
 * EXPLICITLY, with the invariant gates the migration itself only reports
 * (plan M7/M18): every surviving document's bytes exist on disk, kept +
 * archived candidates equal the original count, and foreign_key_check is
 * clean. A failed gate ROLLS BACK (the rebuild and the gates share one
 * transaction) and exits 2. Missing bytes can be accepted explicitly with
 * --allow-missing-bytes (the migration has already rejected those documents
 * durably and archived their evidence; the flag is recorded in the report).
 *
 * Two modes, run FROM THE REPO ROOT (tsx `@/` alias trap):
 *
 *   --rehearse   REPAIR_DB_PATH must point at a VACUUM copy; refuses the live
 *                database by real path AND (dev, ino) — a symlink or hardlink
 *                to the live file is still the live file.
 *   --live       operates on the live database (resolveDbPath()). Refuses unless
 *                no other process holds the file (lsof) and a backup made in the
 *                last 10 minutes exists at data/backups/pre-089-*.db. Records 089
 *                in schema_migrations, so the app skips it at the next start.
 *
 *   sqlite3 data/vanguard.db "VACUUM INTO 'data/backups/rehearse-089.db'"
 *   REPAIR_DB_PATH=data/backups/rehearse-089.db \
 *     PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/migrate-089-document-identity.ts --rehearse
 *
 * Exit 0 = clean; exit 1 = refused; exit 2 = an invariant failed (rolled back).
 */
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { resolveDbPath } from "../lib/db/db-path";
import { runMigrations } from "../lib/db/migrate";
import { rebuildDocumentIdentity } from "../lib/db/migrations/089_print_watch_document_identity";

const NAME = "089_print_watch_document_identity.ts";
const BACKUP_MAX_AGE_MS = 10 * 60_000;

/** Real-path AND (dev, ino) identity — a symlink or hardlink to the live file is the live file. */
function sameFile(a: string, b: string): boolean {
  try {
    const sa = fs.statSync(fs.realpathSync(a));
    const sb = fs.statSync(fs.realpathSync(b));
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

function otherHolders(file: string): string[] {
  try {
    return execFileSync("lsof", ["-t", file], { encoding: "utf8" })
      .split("\n")
      .filter((p) => p && Number(p) !== process.pid);
  } catch {
    return []; // lsof exits 1 when nobody holds the file
  }
}

function freshBackupExists(): boolean {
  const dir = path.join(process.cwd(), "data", "backups");
  if (!fs.existsSync(dir)) return false;
  return fs
    .readdirSync(dir)
    .some((f) => f.startsWith("pre-089-") && f.endsWith(".db") && Date.now() - fs.statSync(path.join(dir, f)).mtimeMs < BACKUP_MAX_AGE_MS);
}

function main(): void {
  const argv = process.argv.slice(2);
  const mode = argv.includes("--live") ? "live" : argv.includes("--rehearse") ? "rehearse" : null;
  const allowMissing = argv.includes("--allow-missing-bytes");
  if (!mode) {
    console.error("usage: migrate-089-document-identity.ts --rehearse (REPAIR_DB_PATH=<copy>) | --live [--allow-missing-bytes]");
    process.exit(1);
  }
  const live = resolveDbPath({ ...process.env, REPAIR_DB_PATH: undefined });
  let target: string;
  if (mode === "rehearse") {
    target = process.env.REPAIR_DB_PATH ?? "";
    if (!target) {
      console.error("--rehearse: REPAIR_DB_PATH is required (a VACUUM copy, never the live DB)");
      process.exit(1);
    }
    if (!fs.existsSync(target)) {
      console.error(`--rehearse: no such file ${target}`);
      process.exit(1);
    }
    if (sameFile(target, live)) {
      console.error(`--rehearse: REPAIR_DB_PATH is the LIVE database (${live}); refusing`);
      process.exit(1);
    }
  } else {
    target = live;
    const holders = otherHolders(target);
    if (holders.length > 0) {
      console.error(`--live: ${holders.length} other process(es) hold ${target} (pids ${holders.join(", ")}); quit them first`);
      process.exit(1);
    }
    if (!freshBackupExists()) {
      console.error("--live: no data/backups/pre-089-*.db newer than 10 minutes; take one first (VACUUM INTO, then PRAGMA integrity_check)");
      process.exit(1);
    }
  }

  const db = new Database(target);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  if (db.prepare(`SELECT 1 FROM schema_migrations WHERE filename = ?`).get(NAME)) {
    console.error(`${NAME} is already applied on ${target}`);
    process.exit(1);
  }
  // Every migration BEFORE 089 (A's 088 included when present); the registry is
  // passed empty so no later code migration can ride along.
  runMigrations(db, { codeMigrations: {} });

  const lines: string[] = [];
  let report;
  try {
    report = db.transaction(() => {
      const r = rebuildDocumentIdentity(db, { log: (l) => lines.push(l) });
      const problems: string[] = [];
      if (r.missingBytes.length > 0 && !allowMissing) {
        problems.push(`${r.missingBytes.length} surviving document(s) have no bytes on disk (re-run with --allow-missing-bytes to accept the durable rejection)`);
      }
      if (r.candidates.kept + r.candidates.archived !== r.candidates.before) problems.push("kept + archived != original candidates");
      const fk = db.prepare(`PRAGMA foreign_key_check`).all();
      if (fk.length > 0) problems.push(`foreign_key_check reported ${fk.length} row(s)`);
      if (problems.length > 0) throw new Error(`INVARIANT FAILED: ${problems.join("; ")}`);
      db.prepare(`INSERT INTO schema_migrations (filename) VALUES (?)`).run(NAME);
      return r;
    })();
  } catch (err) {
    console.log(JSON.stringify({ mode, target, allowMissing, rolledBack: true }, null, 2));
    for (const l of lines) console.log(`  ${l}`);
    console.error(err instanceof Error ? err.message : String(err));
    db.close();
    process.exit(2);
  }
  console.log(JSON.stringify({ mode, target, allowMissing, ...report }, null, 2));
  for (const l of lines) console.log(`  ${l}`);
  db.close();
  process.exit(0);
}

main();
