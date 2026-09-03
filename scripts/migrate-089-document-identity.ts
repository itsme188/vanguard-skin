/**
 * migrate-089-document-identity.ts — run the 089 document-identity rebuild
 * EXPLICITLY (plan M7/M18). The migration itself already hard-gates
 * candidate conservation and a clean `foreign_key_check` (it throws before
 * returning if either breaks). This script's OWN added gate is bytes-on-
 * disk: every surviving document's bytes must exist on disk, or the run
 * refuses — unless explicitly accepted with --allow-missing-bytes (the
 * migration has already rejected those documents durably and archived
 * their evidence; the flag is recorded in the report). In --live mode the
 * script adds two more gates: no other process holds the database file,
 * and a FRESH, integrity-verified backup exists. Every gate and the
 * rebuild itself share one transaction — a failed gate ROLLS BACK and
 * exits 2.
 *
 * Two modes, run FROM THE REPO ROOT (tsx `@/` alias trap), mutually
 * exclusive — passing both, or any unrecognized flag, refuses before
 * anything else runs:
 *
 *   --rehearse   REPAIR_DB_PATH must point at a VACUUM copy; refuses the live
 *                database by real path AND (dev, ino) — a symlink or hardlink
 *                to the live file is still the live file.
 *   --live       operates on the live database (resolveDbPath()). Refuses unless
 *                lsof VERIFIES no other process holds the file (a failure to run
 *                lsof itself is a refusal, never treated as "no holders") and the
 *                newest data/backups/pre-089-*.db made in the last 10 minutes
 *                passes PRAGMA integrity_check = 'ok' and has a non-empty
 *                schema_migrations table. Records 089 in schema_migrations, so
 *                the app skips it at the next start.
 *
 *   sqlite3 data/vanguard.db "VACUUM INTO 'data/backups/rehearse-089.db'"
 *   REPAIR_DB_PATH=data/backups/rehearse-089.db \
 *     PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/migrate-089-document-identity.ts --rehearse
 *
 * Exit 0 = clean; exit 1 = refused; exit 2 = an invariant failed (rolled back).
 *
 * Either mode ALSO refuses while any migration numbered after 089 is still
 * pending: `runMigrations` applies pending files in numeric order, so a later
 * `.sql` would land ahead of 089 against a schema it was never written for.
 *
 * A target that is not a Portfolio Desk database is refused WITHOUT any
 * write: `new Database(path)` (read-write) on a 0-byte or brand-new file
 * would itself write the standard SQLite header the instant a pragma like
 * `journal_mode = WAL` runs — so the "is this ours?" check (a
 * `schema_migrations` table, and whether 089 is already applied) opens the
 * target `{ readonly: true }` first, closes it, and only reopens read-write
 * once that check has passed. `--rehearse` additionally refuses a 0-byte
 * `REPAIR_DB_PATH` up front, before any open at all.
 */
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { resolveDbPath } from "../lib/db/db-path";
import { pendingMigrationsAfter, runMigrations } from "../lib/db/migrate";
import { rebuildDocumentIdentity } from "../lib/db/migrations/089_print_watch_document_identity";

const NAME = "089_print_watch_document_identity.ts";
const BACKUP_MAX_AGE_MS = 10 * 60_000;
const KNOWN_FLAGS = new Set(["--rehearse", "--live", "--allow-missing-bytes"]);
const USAGE = "usage: migrate-089-document-identity.ts --rehearse (REPAIR_DB_PATH=<copy>) | --live [--allow-missing-bytes]";

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

/** Throws when lsof itself could not be run or gave an unexpected result — a
 *  verification failure is a REFUSAL, never silently "no holders" (fail-closed). */
function otherHolders(file: string): string[] {
  try {
    return execFileSync("lsof", ["-t", file], { encoding: "utf8" })
      .split("\n")
      .filter((p) => p && Number(p) !== process.pid);
  } catch (err) {
    const status = (err as { status?: number | null }).status;
    if (status === 1) return []; // lsof: nothing has the file open
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`could not verify that no process holds the database: ${message}`);
  }
}

type BackupGateResult = { ok: true; file: string } | { ok: false; reason: string };

/** The newest data/backups/pre-089-*.db made in the last 10 minutes must be a
 *  REAL, intact Portfolio Desk backup — filename + mtime alone (a zero-byte or
 *  unrelated file would pass that) is not enough. Opens read-only, checks
 *  PRAGMA integrity_check = 'ok' and a non-empty schema_migrations table,
 *  and always closes. */
function checkFreshBackup(): BackupGateResult {
  const dir = path.join(process.cwd(), "data", "backups");
  if (!fs.existsSync(dir)) return { ok: false, reason: "no data/backups directory" };
  const candidates = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("pre-089-") && f.endsWith(".db"))
    .map((f) => ({ file: f, full: path.join(dir, f), mtimeMs: fs.statSync(path.join(dir, f)).mtimeMs }))
    .filter((c) => Date.now() - c.mtimeMs < BACKUP_MAX_AGE_MS)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (candidates.length === 0) {
    return { ok: false, reason: "no data/backups/pre-089-*.db newer than 10 minutes; take one first (VACUUM INTO, then PRAGMA integrity_check)" };
  }
  const newest = candidates[0];
  let backupDb: Database.Database | undefined;
  try {
    backupDb = new Database(newest.full, { readonly: true });
    const integrity = backupDb.pragma("integrity_check", { simple: true }) as string;
    if (integrity !== "ok") {
      return { ok: false, reason: `${newest.file}: PRAGMA integrity_check returned "${integrity}", not "ok"` };
    }
    const hasTable = backupDb
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`)
      .get();
    if (!hasTable) {
      return { ok: false, reason: `${newest.file}: no schema_migrations table — not a Portfolio Desk database` };
    }
    const rowCount = (backupDb.prepare(`SELECT COUNT(*) AS n FROM schema_migrations`).get() as { n: number }).n;
    if (rowCount < 1) {
      return { ok: false, reason: `${newest.file}: schema_migrations table is empty` };
    }
    return { ok: true, file: newest.file };
  } catch (err) {
    return { ok: false, reason: `${newest.file}: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    backupDb?.close();
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const unknown = argv.filter((a) => !KNOWN_FLAGS.has(a));
  if (unknown.length > 0) {
    console.error(`unknown flag(s): ${unknown.join(", ")}`);
    console.error(USAGE);
    process.exit(1);
  }
  const hasRehearse = argv.includes("--rehearse");
  const hasLive = argv.includes("--live");
  if (hasRehearse && hasLive) {
    console.error("refusing: --rehearse and --live are mutually exclusive");
    process.exit(1);
  }
  const mode = hasLive ? "live" : hasRehearse ? "rehearse" : null;
  const allowMissing = argv.includes("--allow-missing-bytes");
  if (!mode) {
    console.error(USAGE);
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
    if (fs.statSync(target).size === 0) {
      console.error(`--rehearse: ${target} is 0 bytes — not a Portfolio Desk database`);
      process.exit(1);
    }
    if (sameFile(target, live)) {
      console.error(`--rehearse: REPAIR_DB_PATH is the LIVE database (${live}); refusing`);
      process.exit(1);
    }
  } else {
    target = live;
    // The holder check and every later reference to `target` must agree on
    // the SAME real path — resolveDbPath() can return a symlink, and a
    // symlink path fed to lsof/otherwise could disagree with the real file
    // an actual holder has open.
    try {
      target = fs.realpathSync(target);
    } catch {
      // Leave target as computed; the open below will fail with a clear,
      // uncorrupted message rather than crash here.
    }
    let holders: string[];
    try {
      holders = otherHolders(target);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    if (holders.length > 0) {
      console.error(`--live: ${holders.length} other process(es) hold ${target} (pids ${holders.join(", ")}); quit them first`);
      process.exit(1);
    }
    const backupCheck = checkFreshBackup();
    if (!backupCheck.ok) {
      console.error(`--live: backup gate failed: ${backupCheck.reason}`);
      process.exit(1);
    }
  }

  // process.exit() does NOT run pending `finally` blocks (confirmed
  // empirically), AND a bare `return` from inside a try exits this whole
  // function — there is no "resume after the try/finally" once a nested
  // return fires. So every branch below sets process.exitCode (which Node
  // applies once the event loop drains naturally — recompute-tax-lots-v2.ts's
  // own pattern) and returns; nothing after a try/finally relies on being
  // reached.

  // Phase A — READ-ONLY inspection. Whether `target` is even a Portfolio
  // Desk database (has schema_migrations) and whether 089 is already
  // applied MUST be answered without writing a byte: a read-write
  // `new Database()` on a 0-byte or brand-new file, followed by a pragma
  // like journal_mode, itself writes the standard SQLite header before any
  // refusal fires. { readonly: true } cannot do that.
  let probe: Database.Database | undefined;
  try {
    probe = new Database(target, { readonly: true });
    const hasSchemaMigrations = probe
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`)
      .get();
    if (!hasSchemaMigrations) {
      console.error(`target has no schema_migrations table — not a Portfolio Desk database (${target})`);
      process.exitCode = 1;
      return;
    }
    if (probe.prepare(`SELECT 1 FROM schema_migrations WHERE filename = ?`).get(NAME)) {
      console.error(`${NAME} is already applied on ${target}`);
      process.exitCode = 1;
      return;
    }
  } catch (err) {
    console.error(`could not inspect ${target}: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  } finally {
    probe?.close();
  }

  // Phase B — read-write. Only reached once Phase A has confirmed `target`
  // is a Portfolio Desk database with 089 still pending.
  let db: Database.Database | undefined;
  try {
    try {
      db = new Database(target);
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = ON");
    } catch (err) {
      console.error(`could not open ${target}: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }
    const conn = db;

    // A migration numbered ABOVE 089 must not exist yet on a database that is
    // still pre-089: `runMigrations` walks every pending `.sql` on disk in
    // numeric order, so a 090 added after this cutover was written would be
    // applied AHEAD of 089, against a schema it was never written for. Refuse
    // rather than half-migrate — the fix is to land 089 first, on a checkout
    // whose migrations directory stops at it.
    const later = pendingMigrationsAfter(conn, NAME, { codeMigrations: {} });
    if (later.length > 0) {
      console.error(
        `refusing: ${later.length} migration(s) numbered after ${NAME} are still pending (${later.join(", ")}). ` +
          `Apply 089 from a checkout whose migrations stop at it, then run the rest normally.`,
      );
      process.exitCode = 1;
      return;
    }

    try {
      // Every migration BEFORE 089 (A's 088 included when present); the registry is
      // passed empty so no later code migration can ride along.
      runMigrations(conn, { codeMigrations: {} });
    } catch (err) {
      console.error(`could not bring ${target} to the pre-089 schema: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }

    const lines: string[] = [];
    let report;
    try {
      report = conn.transaction(() => {
        const r = rebuildDocumentIdentity(conn, { log: (l) => lines.push(l) });
        const problems: string[] = [];
        if (r.missingBytes.length > 0 && !allowMissing) {
          problems.push(`${r.missingBytes.length} surviving document(s) have no bytes on disk (re-run with --allow-missing-bytes to accept the durable rejection)`);
        }
        if (r.candidates.kept + r.candidates.archived !== r.candidates.before) problems.push("kept + archived != original candidates");
        const fk = conn.prepare(`PRAGMA foreign_key_check`).all();
        if (fk.length > 0) problems.push(`foreign_key_check reported ${fk.length} row(s)`);
        if (problems.length > 0) throw new Error(`INVARIANT FAILED: ${problems.join("; ")}`);
        conn.prepare(`INSERT INTO schema_migrations (filename) VALUES (?)`).run(NAME);
        return r;
      })();
    } catch (err) {
      console.log(JSON.stringify({ mode, target, allowMissing, rolledBack: true }, null, 2));
      for (const l of lines) console.log(`  ${l}`);
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 2;
      return;
    }
    console.log(JSON.stringify({ mode, target, allowMissing, ...report }, null, 2));
    for (const l of lines) console.log(`  ${l}`);
    process.exitCode = 0;
  } finally {
    db?.close();
  }
}

main();
