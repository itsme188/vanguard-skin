/**
 * Plaid session-dating repair: read-only acceptance audit (plan v4, D7 and
 * OPEN-7). Nothing is written to any database.
 *
 * Modes (run from the repo root):
 *
 *   Full gates G1-G7: the database before the repair (its backup), the
 *   database after it, and the manifest that was applied.
 *     npx tsx scripts/audit-plaid-session-dating.ts --before <db> --after <db> --manifest <file> [--out <dir>]
 *
 *   Closure check (OPEN-7): after an undo or restore of a Vanguard statement
 *   batch dated in the Plaid era, checks that every zero row the manifest
 *   wrote is still there (keyed by account, security and date). A missing
 *   zero is re-minted by `scripts/repair-plaid-session-dating.ts --remint-closures`.
 *     npx tsx scripts/audit-plaid-session-dating.ts --check-repair-closures --db <db> --manifest <file>
 *     (or REPAIR_DB_PATH=<db> instead of --db)
 *
 * The console prints PASS or FAIL per gate with counts only. Details (dates,
 * security ids, ratios) are private and go to `audit-<stamp>.txt` under
 * --out, REPAIR_OUT_DIR, or docs/private/plaid-session-dating/. Exit code 1
 * when any gate fails (or any zero row is missing).
 */

import fs from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import {
  checkRepairClosures,
  formatAuditReport,
  runPlaidSessionDatingAudit,
} from "../lib/repair/plaid-session-dating-audit";
import type { PlaidSessionDatingManifest } from "../lib/repair/plaid-session-dating-plan";

const TAG = "[audit-plaid-session-dating]";
const DEFAULT_OUT = path.join("docs", "private", "plaid-session-dating");

export interface AuditDeps {
  env: Record<string, string | undefined>;
  cwd: string;
  log: (line: string) => void;
  now: () => Date;
}

interface Args {
  before: string | null;
  after: string | null;
  db: string | null;
  manifest: string | null;
  out: string | null;
  checkClosures: boolean;
}

const VALUE_FLAGS = new Set(["--before", "--after", "--db", "--manifest", "--out"]);
const KNOWN_FLAGS = new Set([...VALUE_FLAGS, "--check-repair-closures"]);

function flagValue(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${name} needs a value`);
  return v;
}

export function parseArgs(argv: string[]): Args {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!KNOWN_FLAGS.has(a)) throw new Error(`unknown argument: ${a}`);
    if (VALUE_FLAGS.has(a)) i++;
  }
  return {
    before: flagValue(argv, "--before"),
    after: flagValue(argv, "--after"),
    db: flagValue(argv, "--db"),
    manifest: flagValue(argv, "--manifest"),
    out: flagValue(argv, "--out"),
    checkClosures: argv.includes("--check-repair-closures"),
  };
}

/**
 * Opens a database for reading only. Read-only first; a WAL-mode database
 * whose shared-memory file is absent cannot be opened read-only, so it is then
 * opened with `PRAGMA query_only = ON`, on which SQLite refuses every write.
 */
export function openReadOnly(dbPath: string, log: (l: string) => void): Database.Database {
  if (!fs.existsSync(dbPath)) throw new Error(`database not found: ${dbPath}`);
  let db: Database.Database | null = null;
  try {
    db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
    db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get();
    return db;
  } catch (err) {
    db?.close();
    if ((err as { code?: string }).code !== "SQLITE_CANTOPEN") throw err;
  }
  const rw = new BetterSqlite3(dbPath, { fileMustExist: true, timeout: 60_000 });
  rw.pragma("query_only = ON");
  log(`Opened ${path.basename(dbPath)} with query_only (WAL without its shared-memory file); nothing is written.`);
  return rw;
}

function readManifest(p: string): PlaidSessionDatingManifest {
  const m = JSON.parse(fs.readFileSync(p, "utf8")) as PlaidSessionDatingManifest;
  if (m?.format !== "plaid-session-dating-manifest/1") throw new Error(`not a plaid-session-dating manifest: ${p}`);
  return m;
}

function stamp(now: Date): string {
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

function writeReport(outDir: string, name: string, text: string): string {
  fs.mkdirSync(outDir, { recursive: true });
  const p = path.join(outDir, name);
  fs.writeFileSync(p, text, { flag: "wx" });
  return p;
}

async function runGates(args: Args, deps: AuditDeps): Promise<number> {
  if (!args.before || !args.after || !args.manifest) {
    throw new Error("The full audit needs --before <db> --after <db> --manifest <file>.");
  }
  const beforePath = path.resolve(deps.cwd, args.before);
  const afterPath = path.resolve(deps.cwd, args.after);
  const manifestPath = path.resolve(deps.cwd, args.manifest);
  // Printed BEFORE either database is opened.
  deps.log(`${TAG} mode=gates, before: ${beforePath}`);
  deps.log(`${TAG} after: ${afterPath}`);
  if (fs.realpathSync(beforePath) === fs.realpathSync(afterPath)) throw new Error("--before and --after name the same file");
  const manifest = readManifest(manifestPath);
  const before = openReadOnly(beforePath, deps.log);
  let after: Database.Database | null = null;
  try {
    after = openReadOnly(afterPath, deps.log);
    const result = runPlaidSessionDatingAudit(before, after, manifest);
    for (const g of result.gates) {
      deps.log(`${g.id} ${g.pass ? "PASS" : "FAIL"} ${g.title}: ${Object.entries(g.counts).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    }
    const outDir = path.resolve(deps.cwd, args.out ?? deps.env.REPAIR_OUT_DIR ?? DEFAULT_OUT);
    const reportPath = writeReport(
      outDir,
      `audit-${stamp(deps.now())}.txt`,
      formatAuditReport(result, [`Before: ${beforePath}`, `After: ${afterPath}`, `Manifest: ${manifestPath}`]),
    );
    deps.log(`Report (private): ${reportPath}`);
    deps.log(result.pass ? "All gates PASS." : `Gates failing: ${result.gates.filter((g) => !g.pass).map((g) => g.id).join(", ")}`);
    return result.pass ? 0 : 1;
  } finally {
    after?.close();
    before.close();
  }
}

async function runClosureCheck(args: Args, deps: AuditDeps): Promise<number> {
  const p = args.db ?? deps.env.REPAIR_DB_PATH ?? null;
  if (!p) throw new Error("--check-repair-closures needs --db <path> or REPAIR_DB_PATH (there is no default).");
  if (!args.manifest) throw new Error("--check-repair-closures needs --manifest <file> (the manifest that was applied)");
  const dbPath = path.resolve(deps.cwd, p);
  deps.log(`${TAG} mode=check-repair-closures, db: ${dbPath}`);
  const manifest = readManifest(path.resolve(deps.cwd, args.manifest));
  const db = openReadOnly(dbPath, deps.log);
  try {
    const r = checkRepairClosures(db, manifest);
    deps.log(`Zero rows in the manifest: checked ${r.checked}, present ${r.present}, missing ${r.missing}, non-zero ${r.nonZero}`);
    if (r.missing + r.nonZero === 0) {
      deps.log("PASS: every repaired closure is in place.");
      return 0;
    }
    const outDir = path.resolve(deps.cwd, args.out ?? deps.env.REPAIR_OUT_DIR ?? DEFAULT_OUT);
    const reportPath = writeReport(
      outDir,
      `audit-closures-${stamp(deps.now())}.txt`,
      `Plaid session-dating closure check (PRIVATE)\nDatabase: ${dbPath}\n${r.details.join("\n")}\n`,
    );
    deps.log(`Report (private): ${reportPath}`);
    deps.log(
      "FAIL: re-mint the missing zero rows with scripts/repair-plaid-session-dating.ts --remint-closures --manifest <file> (dry run first).",
    );
    return 1;
  } finally {
    db.close();
  }
}

export async function main(argv: string[], partial: Partial<AuditDeps> = {}): Promise<number> {
  const deps: AuditDeps = {
    env: partial.env ?? process.env,
    cwd: partial.cwd ?? process.cwd(),
    log: partial.log ?? ((l) => console.log(l)),
    now: partial.now ?? (() => new Date()),
  };
  const args = parseArgs(argv);
  if (args.checkClosures) {
    if (args.before || args.after) throw new Error("--check-repair-closures takes --db, not --before/--after");
    return runClosureCheck(args, deps);
  }
  if (args.db) throw new Error("--db is only for --check-repair-closures; the full audit takes --before and --after");
  return runGates(args, deps);
}

if (process.argv[1]?.endsWith("audit-plaid-session-dating.ts")) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    });
}
