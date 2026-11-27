/**
 * Plaid session-dating history repair (plan v4, section D).
 *
 * Legacy Plaid rows are dated on the run day of the pre-open read; that read
 * describes the previous trading session. This script moves or drops each
 * legacy Plaid book, tombstone and price as the planner in
 * lib/repair/plaid-session-dating-plan.ts decides, and BLOCKS on anything
 * outside the measured set.
 *
 * Modes (run from the repo root; the database is never guessed):
 *
 *   Dry run (default): plans, writes manifest-<stamp>.json and
 *   report-<stamp>.txt to the output folder, prints counts only.
 *     REPAIR_DB_PATH=/path/to/copy.db npx tsx scripts/repair-plaid-session-dating.ts
 *     npx tsx scripts/repair-plaid-session-dating.ts --db /path/to/copy.db [--config <file>] [--out <dir>]
 *     ... --compare-to <rehearsal manifest>   (lists how this plan differs from a rehearsal's)
 *
 *   Apply: one transaction; refuses unless the recomputed plan equals the
 *   manifest exactly.
 *     ... --apply --manifest <file> [--live]
 *
 *   Re-mint closures (OPEN-7): after an undo and restore of a statement batch,
 *   writes back only the zero rows of the manifest that are missing (keyed by
 *   account, security and date). Dry run unless --apply.
 *     ... --remint-closures --manifest <file> [--apply] [--live]
 *
 * Inputs:
 *   --db <path> or REPAIR_DB_PATH        the database (required; no default)
 *   --config <path> or REPAIR_CONFIG_PATH the measured set (default
 *     data/repair-configs/plaid-session-dating.json under the working folder;
 *     gitignored, never committed)
 *   --out <dir> or REPAIR_OUT_DIR        where the dry run writes (default
 *     docs/private/plaid-session-dating/ under the working folder)
 *
 * Safety: --apply refuses the live database unless --live, refuses while
 * another process holds the file open (/usr/sbin/lsof), refuses a second run
 * (dating version 2), and on any UNCLASSIFIED or BLOCK line. It takes a
 * backup through takeBackup first. The report may contain dates and names;
 * it is private. The console prints counts and file paths only.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import {
  applyManifestChanges,
  applyRemintClosures,
  captureApplySnapshot,
  manifestComparable,
  parseMeasuredSetConfig,
  planPlaidSessionDatingRepair,
  planRemintClosures,
  proveApplied,
  type ActionCode,
  type ManifestLine,
  type PlaidSessionDatingManifest,
  type PlanReport,
} from "../lib/repair/plaid-session-dating-plan";
import { getDatingBoundary, setDatingRepaired } from "../lib/plaid/session-dating";
import { getTaxInputGeneration } from "../lib/compute/tax-convention";
import { computeDailyValuations } from "../lib/compute/daily-valuation";
import { previousTradingDay } from "../lib/calendar/market-holidays";

const TAG = "[repair-plaid-session-dating]";
export const BACKUP_PURPOSE = "plaid-session-dating";
export const REMINT_BACKUP_PURPOSE = "plaid-session-dating-remint";
const DEFAULT_CONFIG = path.join("data", "repair-configs", "plaid-session-dating.json");
const DEFAULT_OUT = path.join("docs", "private", "plaid-session-dating");
const LSOF = "/usr/sbin/lsof";

/** Actions a live dry run may add after the rehearsal backup (spec E5c). */
const LATE_ALLOWED: readonly ActionCode[] = [
  "MOVE_BOOK",
  "DROP_STATEMENT_TARGET",
  "TOMBSTONE_MOVE",
  "PRICE_FUND_SHIFT",
  "PRICE_FUND_DROP_AUTHORITY",
  "PRICE_F2_SESSION_DATED",
];

export interface ScriptDeps {
  env: Record<string, string | undefined>;
  cwd: string;
  log: (line: string) => void;
  now: () => Date;
  /** PIDs (other than this process) holding any of the paths open. Throws when it cannot tell. */
  openHolders: (paths: string[]) => number[];
  isLive: (dbPath: string) => boolean;
  makeBackup: (db: Database.Database, purpose: string) => Promise<{ path: string }>;
}

function defaultOpenHolders(paths: string[]): number[] {
  const existing = paths.filter((p) => fs.existsSync(p));
  if (existing.length === 0) return [];
  if (!fs.existsSync(LSOF)) throw new Error(`${LSOF} not found: cannot check that nothing else holds the database`);
  let out = "";
  try {
    out = execFileSync(LSOF, ["-t", "--", ...existing], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    // lsof exits 1 when no process holds any of the files.
    if (e.status === 1 && !(e.stdout ?? "").trim()) return [];
    if (e.status === 1) out = e.stdout ?? "";
    else throw new Error(`lsof failed: cannot check that nothing else holds the database`);
  }
  return [...new Set(out.split(/\s+/).filter(Boolean).map(Number))].filter((pid) => pid !== process.pid);
}

async function defaultBackup(db: Database.Database, purpose: string): Promise<{ path: string }> {
  // Relative specifier: the "@/" alias is not resolved for dynamic imports
  // outside the repo cwd.
  const { takeBackup } = await import("../lib/backup/take-backup");
  return takeBackup(db, { purpose });
}

async function defaultIsLive(dbPath: string): Promise<boolean> {
  const { isLiveDatabase } = await import("../lib/backup/backup-home");
  return isLiveDatabase(dbPath);
}

interface Args {
  db: string | null;
  config: string | null;
  out: string | null;
  manifest: string | null;
  compareTo: string | null;
  apply: boolean;
  live: boolean;
  remint: boolean;
}

function flagValue(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${name} needs a value`);
  return v;
}

const KNOWN_FLAGS = new Set(["--db", "--config", "--out", "--manifest", "--compare-to", "--apply", "--live", "--remint-closures"]);
const VALUE_FLAGS = new Set(["--db", "--config", "--out", "--manifest", "--compare-to"]);

export function parseArgs(argv: string[]): Args {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!KNOWN_FLAGS.has(a)) throw new Error(`unknown argument: ${a}`);
    if (VALUE_FLAGS.has(a)) i++;
  }
  return {
    db: flagValue(argv, "--db"),
    config: flagValue(argv, "--config"),
    out: flagValue(argv, "--out"),
    manifest: flagValue(argv, "--manifest"),
    compareTo: flagValue(argv, "--compare-to"),
    apply: argv.includes("--apply"),
    live: argv.includes("--live"),
    remint: argv.includes("--remint-closures"),
  };
}

function resolveDbPath(args: Args, deps: ScriptDeps): string {
  const p = args.db ?? deps.env.REPAIR_DB_PATH ?? null;
  if (!p) throw new Error("No database named. Pass --db <path> or set REPAIR_DB_PATH (there is no default).");
  return path.resolve(deps.cwd, p);
}

function realDbPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
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

function loadConfig(args: Args, deps: ScriptDeps) {
  const p = path.resolve(deps.cwd, args.config ?? deps.env.REPAIR_CONFIG_PATH ?? DEFAULT_CONFIG);
  if (!fs.existsSync(p)) throw new Error(`measured-set config not found: ${p}`);
  return { path: p, ...parseMeasuredSetConfig(fs.readFileSync(p)) };
}

function readManifest(p: string): PlaidSessionDatingManifest {
  const m = JSON.parse(fs.readFileSync(p, "utf8")) as PlaidSessionDatingManifest;
  if (m?.format !== "plaid-session-dating-manifest/1") throw new Error(`not a plaid-session-dating manifest: ${p}`);
  return m;
}

function printCounts(manifest: PlaidSessionDatingManifest, log: (l: string) => void): void {
  const books = new Map<string, number>();
  for (const b of manifest.books) books.set(b.action, (books.get(b.action) ?? 0) + 1);
  log(`Dating state: ${manifest.datingState}`);
  log(`Books: ${manifest.books.length} (${[...books].sort().map(([k, v]) => `${k} ${v}`).join(", ") || "none"})`);
  log(
    `Lines by kind: ${Object.entries(manifest.counts.byKind).sort().map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`,
  );
  log(
    `Lines by action: ${Object.entries(manifest.counts.byAction).sort().map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`,
  );
  log(`Blocking lines (BLOCK or UNCLASSIFIED): ${manifest.counts.blocking}`);
  log(
    `Price pairs for the synthetic-close check: ${manifest.predicted.pricePairs.length}; ` +
      `tax generation bump predicted: ${manifest.predicted.bumpFires ? "yes" : "no"}`,
  );
}

/** The private report (counts, measured set, repeat reads, census, comparisons, blocks). */
export function formatReport(manifest: PlaidSessionDatingManifest, report: PlanReport): string {
  const out: string[] = [];
  const push = (l = "") => out.push(l);
  push("Plaid session-dating repair: dry-run report (PRIVATE: may contain dates and names)");
  push(`Database: ${manifest.binding.dbPath}`);
  push(`Dating state: ${manifest.datingState}; config sha256 ${manifest.binding.configSha256}`);
  push(`Scope sha256: ${manifest.binding.scopeSha256}`);
  push(`Tax generation: ${manifest.binding.taxInputGeneration} -> predicted ${manifest.predicted.taxInputGenerationAfter}`);
  push();
  push("Accounts:");
  for (const a of report.accounts) push(`  ${a.id} ${a.name}: role ${a.role ?? "none"}${a.reason ? ` (${a.reason})` : ""}`);
  push();
  push("Counts per action and account:");
  const per = new Map<string, number>();
  for (const b of manifest.books) per.set(`${b.accountId} book ${b.action}`, (per.get(`${b.accountId} book ${b.action}`) ?? 0) + 1);
  for (const l of manifest.lines) {
    const acct = l.old?.account_id ?? (l.rule.startsWith("book:") ? l.rule.split(":")[1] : "-");
    const k = `${acct} ${l.kind} ${l.action}`;
    per.set(k, (per.get(k) ?? 0) + 1);
  }
  for (const [k, v] of [...per].sort()) push(`  ${k}: ${v}`);
  push();
  push("Measured set:");
  for (const m of report.measuredSet) {
    const f = m.found.map((x) => `${x.accountId}=${x.found ? "found" : "MISSING"}`).join(" ");
    push(`  [${m.index}] ${m.row.accountRole} ${m.row.runDay} ${m.row.class} ${m.row.action}: ${f}`);
  }
  push();
  push("Books (account, run day, session, class, action):");
  for (const b of manifest.books) {
    push(`  ${b.accountId} ${b.runDay} -> ${b.session} ${b.class} ${b.action}${b.reason ? ` (${b.reason})` : ""}`);
  }
  push();
  push("Repeat reads (listed, not blocking):");
  if (report.repeatReads.length === 0) push("  none");
  for (const r of report.repeatReads) push(`  ${r.accountId} run day ${r.runDay} identical to ${r.previousRunDay}`);
  push();
  push("Books dropped onto a statement date (Plaid vs statement):");
  if (report.statementTargets.length === 0) push("  none");
  for (const s of report.statementTargets) {
    push(
      `  ${s.accountId} run day ${s.runDay} -> ${s.target}: ratio ${s.ratio ?? "n/a"}; ` +
        `cash ${s.plaidCash ?? "n/a"} / ${s.statementCash ?? "n/a"}; ` +
        `quantity differences ${s.quantityDifferences.length}`,
    );
    for (const d of s.quantityDifferences) push(`    security ${d.securityId}: plaid ${d.plaid} statement ${d.statement}`);
  }
  push();
  push("Moved books on the session a weekend statement describes (listed; G1 judges them):");
  if (report.weekendStatements.length === 0) push("  none");
  for (const w of report.weekendStatements) {
    push(
      `  ${w.accountId} run day ${w.runDay} -> ${w.session} (statement ${w.statementDate}): ` +
        `${w.differences.length === 0 ? "quantities match" : `STATEMENT MISMATCH, ${w.differences.length} name(s)`}`,
    );
    for (const d of w.differences) {
      push(
        `    security ${d.securityId}: plaid ${d.plaid} statement ${d.statement}; ` +
          `closing ledger row ${d.closingLedgerRow ? "yes" : "no"}`,
      );
    }
  }
  push();
  push("Traced-trade census (trade date, kind, first book showing the new quantity, its class):");
  if (report.census.length === 0) push("  none");
  for (const c of report.census) {
    push(
      `  ${c.accountId} ${c.tradeDate} ${c.type} security ${c.securityId} (${c.securityKind ?? "?"}): ` +
        `${c.firstBookRunDay ?? "not seen"} ${c.firstBookClass ?? ""}`,
    );
  }
  push();
  push(`Full-book evidence: ${report.fullBookEvidence}`);
  push(`Fund prices: ${report.fundPriceNote}`);
  push();
  push("BLOCK and UNCLASSIFIED lines:");
  const blocking = manifest.lines.filter((l) => l.kind === "BLOCK" || l.kind === "UNCLASSIFIED");
  if (blocking.length === 0) push("  none");
  for (const l of blocking) {
    push(`  ${l.kind} ${l.action} ${l.rule}${l.table ? ` ${l.table}#${l.id}` : ""}: ${l.reason ?? ""}`);
  }
  push();
  push("Notes:");
  for (const l of manifest.lines.filter((x) => x.kind === "INFO")) push(`  ${l.action} ${l.rule}: ${l.reason ?? ""}`);
  return `${out.join("\n")}\n`;
}

/** How a live plan differs from the rehearsal's (spec E5c). */
export function compareToRehearsal(
  current: PlaidSessionDatingManifest,
  rehearsal: PlaidSessionDatingManifest,
): { allowed: ManifestLine[]; disallowed: ManifestLine[] } {
  const newestRunDay = rehearsal.books.reduce((m, b) => (b.runDay > m ? b.runDay : m), "");
  const priceFloor = newestRunDay ? previousTradingDay(previousTradingDay(newestRunDay)) : "";
  const key = (l: ManifestLine) => `${l.table}:${l.id}`;
  const sig = (l: ManifestLine) => `${l.kind}|${l.action}|${l.hash}|${JSON.stringify(l.new ?? null)}`;
  const rehearsalByKey = new Map(rehearsal.lines.filter((l) => l.table).map((l) => [key(l), l]));
  const currentByKey = new Map(current.lines.filter((l) => l.table).map((l) => [key(l), l]));
  const maxId: Record<string, number> = {
    holdings: rehearsal.binding.maxHoldingsId,
    prices: rehearsal.binding.maxPricesId,
    monthly_snapshots: rehearsal.binding.maxSnapshotsId,
  };
  const allowed: ManifestLine[] = [];
  const disallowed: ManifestLine[] = [];
  for (const l of currentByKey.values()) {
    const r = rehearsalByKey.get(key(l));
    if (r && sig(r) === sig(l)) continue;
    const date =
      l.table === "prices" ? String(l.old?.date ?? "") : String(l.old?.as_of_date ?? l.old?.month_end_date ?? "");
    const late =
      (l.id ?? 0) > (maxId[l.table as string] ?? 0) ||
      (l.table === "prices" ? date >= priceFloor : date >= newestRunDay);
    if (late && LATE_ALLOWED.includes(l.action) && l.kind !== "BLOCK" && l.kind !== "UNCLASSIFIED") allowed.push(l);
    else disallowed.push(l);
  }
  for (const r of rehearsalByKey.values()) if (!currentByKey.has(key(r))) disallowed.push(r);
  for (const l of current.lines.filter((x) => !x.table && x.kind === "BLOCK")) disallowed.push(l);
  return { allowed, disallowed };
}

function refuseIfHeld(dbPath: string, deps: ScriptDeps): void {
  const holders = deps.openHolders([dbPath, `${dbPath}-wal`, `${dbPath}-shm`]);
  if (holders.length > 0) {
    throw new Error(`refusing: another process holds the database open (pid ${holders.join(", ")}). Quit the app first.`);
  }
}

function integrityCheck(db: Database.Database): void {
  const rows = db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
  if (rows.length !== 1 || rows[0].integrity_check !== "ok") {
    throw new Error(`PRAGMA integrity_check did not print ok: ${rows.map((r) => r.integrity_check).join("; ")}`);
  }
}

/**
 * Opens the database for a dry run. Read-only first. A WAL-mode database
 * whose shared-memory file is absent (the app was quit cleanly) cannot be
 * opened read-only, so it is then opened read-write with
 * `PRAGMA query_only = ON`: SQLite refuses every write on that connection.
 */
function openForReading(dbPath: string, log: (l: string) => void): Database.Database {
  let db: Database.Database | null = null;
  try {
    db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
    db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get();
    return db;
  } catch (err) {
    db?.close();
    const code = (err as { code?: string }).code;
    if (code !== "SQLITE_CANTOPEN") throw err;
  }
  const rw = new BetterSqlite3(dbPath, { fileMustExist: true, timeout: 60_000 });
  rw.pragma("query_only = ON");
  log("Opened with query_only (a WAL database cannot be opened read-only without its shared-memory file); nothing is written.");
  return rw;
}

async function runDryRun(args: Args, dbPath: string, deps: ScriptDeps): Promise<number> {
  const cfg = loadConfig(args, deps);
  const outDir = path.resolve(deps.cwd, args.out ?? deps.env.REPAIR_OUT_DIR ?? DEFAULT_OUT);
  const db = openForReading(dbPath, deps.log);
  let manifest: PlaidSessionDatingManifest;
  let report: PlanReport;
  try {
    ({ manifest, report } = planPlaidSessionDatingRepair(db, {
      dbPath: realDbPath(dbPath),
      config: cfg.config,
      configSha256: cfg.sha256,
    }));
  } finally {
    db.close();
  }
  const s = stamp(deps.now());
  const manifestPath = path.join(outDir, `manifest-${s}.json`);
  const reportPath = path.join(outDir, `report-${s}.txt`);
  if (fs.existsSync(manifestPath) || fs.existsSync(reportPath)) {
    throw new Error(`refusing to overwrite an earlier output with the same stamp in ${outDir}`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  manifest.generatedAt = deps.now().toISOString();
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  fs.writeFileSync(reportPath, formatReport(manifest, report), { flag: "wx" });
  printCounts(manifest, deps.log);
  deps.log(`Manifest: ${manifestPath}`);
  deps.log(`Report (private): ${reportPath}`);
  if (args.compareTo) {
    const rehearsal = readManifest(path.resolve(deps.cwd, args.compareTo));
    const diff = compareToRehearsal(manifest, rehearsal);
    deps.log(`Compared with the rehearsal: ${diff.allowed.length} allowed difference(s), ${diff.disallowed.length} not allowed`);
    if (diff.disallowed.length > 0) deps.log("STOP: this plan differs from the rehearsal in a way the window does not allow.");
    fs.appendFileSync(
      reportPath,
      `\nDifferences from the rehearsal manifest:\n${[...diff.allowed.map((l) => `  allowed ${l.action} ${l.table}#${l.id}`), ...diff.disallowed.map((l) => `  NOT ALLOWED ${l.kind} ${l.action} ${l.table ?? l.rule}#${l.id ?? ""}`)].join("\n")}\n`,
    );
  }
  if (manifest.counts.blocking > 0) deps.log("The plan has blocking lines: --apply will refuse. See the report.");
  else deps.log("Dry run (default). Re-run with --apply --manifest <file> on a rehearsed copy to write.");
  return 0;
}

async function runApply(args: Args, dbPath: string, deps: ScriptDeps): Promise<number> {
  if (!args.manifest) throw new Error("--apply needs --manifest <file> (from a dry run)");
  const manifest = readManifest(path.resolve(deps.cwd, args.manifest));
  if (deps.isLive(dbPath) && !args.live) throw new Error("refusing: this is the live database. Pass --live to apply to it.");
  refuseIfHeld(dbPath, deps);
  if (manifest.datingState === "repaired") throw new Error("refusing: the manifest was made on a repaired database");
  const blocking = manifest.lines.filter((l) => l.kind === "BLOCK" || l.kind === "UNCLASSIFIED");
  if (blocking.length > 0 || manifest.counts.blocking > 0) {
    throw new Error(`refusing: the manifest has ${blocking.length} BLOCK or UNCLASSIFIED line(s)`);
  }
  const cfg = loadConfig(args, deps);
  if (cfg.sha256 !== manifest.binding.configSha256) {
    throw new Error("refusing: the measured-set config differs from the one the manifest was made with");
  }

  const db = new BetterSqlite3(dbPath, { fileMustExist: true, timeout: 60_000 });
  try {
    db.pragma("foreign_keys = ON");
    if (getDatingBoundary(db).repaired) throw new Error("refusing: the database is already repaired (dating version 2)");
    const backup = await deps.makeBackup(db, BACKUP_PURPOSE);
    deps.log(`Backup created at ${backup.path}`);

    const { manifest: recomputed } = planPlaidSessionDatingRepair(db, {
      dbPath: realDbPath(dbPath),
      config: cfg.config,
      configSha256: cfg.sha256,
    });
    if (manifestComparable(recomputed) !== manifestComparable(manifest)) {
      throw new Error("refusing: the recomputed plan differs from the manifest (the database or the config changed). Run a new dry run.");
    }
    if (recomputed.counts.blocking > 0) throw new Error("refusing: the recomputed plan has blocking lines");

    let valuations: { datesComputed: number; accountsProcessed: number } | null = null;
    db.transaction(() => {
      const before = captureApplySnapshot(db, manifest);
      applyManifestChanges(db, manifest);
      proveApplied(db, manifest, before);
      const gen = getTaxInputGeneration(db);
      if (gen !== manifest.predicted.taxInputGenerationAfter) {
        throw new Error(`tax generation ${gen} differs from the predicted ${manifest.predicted.taxInputGenerationAfter}; rolled back`);
      }
      const v = computeDailyValuations(db);
      valuations = { datesComputed: v.datesComputed, accountsProcessed: v.accountsProcessed };
      setDatingRepaired(db);
    })();
    integrityCheck(db);
    const changed = manifest.lines.filter((l) => l.kind === "CHANGE").length;
    deps.log(`Applied ${changed} change line(s); proof passed; dating version set to 2.`);
    const v = valuations as { datesComputed: number; accountsProcessed: number } | null;
    if (v) deps.log(`Daily valuations rebuilt: datesComputed=${v.datesComputed} accountsProcessed=${v.accountsProcessed}`);
    deps.log("PRAGMA integrity_check: ok");
  } finally {
    db.close();
  }
  return 0;
}

async function runRemint(args: Args, dbPath: string, deps: ScriptDeps): Promise<number> {
  if (!args.manifest) throw new Error("--remint-closures needs --manifest <file> (the manifest that was applied)");
  const manifest = readManifest(path.resolve(deps.cwd, args.manifest));
  if (args.apply) {
    if (deps.isLive(dbPath) && !args.live) throw new Error("refusing: this is the live database. Pass --live to apply to it.");
    refuseIfHeld(dbPath, deps);
  }
  const db = args.apply
    ? new BetterSqlite3(dbPath, { fileMustExist: true, timeout: 60_000 })
    : openForReading(dbPath, deps.log);
  try {
    if (!getDatingBoundary(db).repaired) {
      throw new Error("refusing: the database is not repaired yet; there is nothing to re-mint");
    }
    const plan = planRemintClosures(db, manifest);
    deps.log(`Zero rows in the manifest: present ${plan.present}, missing ${plan.missing.length}, conflicts ${plan.conflicts.length}`);
    if (!args.apply) {
      deps.log("Dry run (default). Re-run with --apply to write the missing rows.");
      return plan.conflicts.length > 0 ? 1 : 0;
    }
    if (plan.conflicts.length > 0) throw new Error(`refusing: ${plan.conflicts.length} conflict(s); nothing written`);
    if (plan.missing.length === 0) {
      deps.log("Nothing to write.");
      return 0;
    }
    db.pragma("foreign_keys = ON");
    const backup = await deps.makeBackup(db, REMINT_BACKUP_PURPOSE);
    deps.log(`Backup created at ${backup.path}`);
    db.transaction(() => {
      const written = applyRemintClosures(db, plan);
      if (written !== plan.missing.length) throw new Error("the re-mint wrote a different number of rows; rolled back");
      const again = planRemintClosures(db, manifest);
      if (again.missing.length > 0 || again.conflicts.length > 0) throw new Error("the re-mint did not close every gap; rolled back");
      const fk = db.prepare("PRAGMA foreign_key_check").all();
      if (fk.length > 0) throw new Error("foreign_key_check reports a violation; rolled back");
      computeDailyValuations(db);
    })();
    integrityCheck(db);
    deps.log(`Re-minted ${plan.missing.length} zero row(s). PRAGMA integrity_check: ok`);
  } finally {
    db.close();
  }
  return 0;
}

export async function main(argv: string[], partial: Partial<ScriptDeps> = {}): Promise<number> {
  const liveCheck = partial.isLive;
  const deps: ScriptDeps = {
    env: partial.env ?? process.env,
    cwd: partial.cwd ?? process.cwd(),
    log: partial.log ?? ((l) => console.log(l)),
    now: partial.now ?? (() => new Date()),
    openHolders: partial.openHolders ?? defaultOpenHolders,
    isLive: liveCheck ?? (() => false),
    makeBackup: partial.makeBackup ?? defaultBackup,
  };
  const args = parseArgs(argv);
  const dbPath = resolveDbPath(args, deps);
  const mode = args.remint ? (args.apply ? "REMINT-APPLY" : "remint-dry-run") : args.apply ? "APPLY" : "dry-run";
  // Printed BEFORE the database is opened (rehearsable-repair rule).
  deps.log(`${TAG} mode=${mode}, db: ${dbPath}`);
  if (!liveCheck) {
    const live = await defaultIsLive(dbPath);
    deps.isLive = () => live;
  }
  if (args.remint) return runRemint(args, dbPath, deps);
  if (args.apply) return runApply(args, dbPath, deps);
  if (args.manifest) throw new Error("--manifest is only for --apply or --remint-closures");
  return runDryRun(args, dbPath, deps);
}

if (process.argv[1]?.endsWith("repair-plaid-session-dating.ts")) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    });
}
