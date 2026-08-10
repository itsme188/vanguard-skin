/**
 * repair-december-snapshots.ts — Repairs `monthly_snapshots` December rows
 * poisoned by an early draft of the canonical CSV that carried
 * ANNUAL-summary figures in December month-end slots (qa/plan:
 * 2026-08-10-twr-december-repair).
 *
 * Root cause: import batch 26 (an early canonical CSV draft) wrote 4
 * December rows for the Vanguard Taxable account with annual-summary
 * total/starting/deposits/twr values instead of the real December
 * month-end figures. The corrected CSV (batch 35) was imported 52 minutes
 * later, but the deterministic `source_key` dedupe in the import engine
 * skipped the 4 existing December keys instead of overwriting them — so
 * the poisoned rows survived. This poisoned the December legs of every TWR
 * chain that crosses a year boundary (the Analysis `?view=performance`
 * scope=all headline TWR sat below every per-account row, which is
 * impossible for a value-weighted blend).
 *
 * The canonical CSV (statement-verified against the real Vanguard PDFs at
 * all four year-ends) is the authority for this repair. It is parsed at
 * runtime — this script never hardcodes financial figures.
 *
 * What it does:
 *   1. Parses the CSV (header:
 *      account,month_end_date,total_value,starting_value,
 *      deposits_withdrawals,dividends,interest,commissions,fees,
 *      investment_gain,twr). Resolves `account` by an EXACT
 *      `accounts.name` match; CSV rows whose account has no DB match are
 *      skipped and reported (never guessed).
 *   2. Audit phase (ALL rows, any month): compares every resolved CSV row
 *      against its DB row (matched on account_id + month_end_date) on
 *      total_value, starting_value, deposits_withdrawals, twr,
 *      investment_gain — float tolerance 0.005, NULL vs non-NULL always
 *      counts as a mismatch. Reports every mismatch found, December or not.
 *   3. Repair phase (December rows only — `SUBSTR(month_end_date,6,2) =
 *      '12'`): on `--apply`, overwrites the five compared columns with the
 *      CSV's values and appends a note (preserving any existing note).
 *      Non-December mismatches are REPORT-ONLY — this script refuses to
 *      write them, on purpose (a December-specific defect should not
 *      license blanket overwrites of unrelated months).
 *   4. Backs up `data/vanguard.db` to `data/backups/` (VACUUM INTO, same
 *      helper + "fail hard" behavior as repair-ah-closes.ts) before any
 *      write. All December repairs happen in ONE transaction; every
 *      repaired row is re-read and re-compared against the CSV inside that
 *      same transaction — any row still mismatched rolls the ENTIRE batch
 *      back rather than leaving a partially-repaired December chain.
 *
 * Idempotent: after a successful apply the December rows agree with the
 * CSV, so a re-run finds 0 December mismatches and writes nothing.
 *
 * Safety: if ANY December row's account can't be resolved against
 * `accounts.name`, this script refuses to repair ANY December row (even
 * ones that resolved fine) and exits non-zero — a partial repair with an
 * unexplained gap is worse than no repair.
 *
 * NOT touched: rows with no CSV counterpart (the Roth December rows are
 * healthy and never appear in this repair's scope unless the CSV grows a
 * Roth section), and non-December rows (reported, never written).
 *
 * Usage:
 *   npx tsx scripts/repair-december-snapshots.ts                # dry-run (default)
 *   npx tsx scripts/repair-december-snapshots.ts --apply         # write
 *   npx tsx scripts/repair-december-snapshots.ts --csv <path>    # override CSV
 *   npx tsx scripts/repair-december-snapshots.ts --db <path>     # override DB
 */

import type Database from "better-sqlite3";
import Papa from "papaparse";

// ─── Types ────────────────────────────────────────────────────────

export interface CsvSnapshotRow {
  account: string;
  monthEndDate: string;
  totalValue: number;
  startingValue: number | null;
  depositsWithdrawals: number | null;
  twr: number | null;
  investmentGain: number | null;
}

export interface ParsedSnapshotCsv {
  rows: CsvSnapshotRow[];
  /** 1-indexed CSV row numbers (header = row 1) skipped for missing/invalid required fields. */
  malformedRowNumbers: number[];
}

/** The 5 columns this repair compares + (on December rows) overwrites. */
export interface CompareFields {
  totalValue: number;
  startingValue: number | null;
  depositsWithdrawals: number | null;
  twr: number | null;
  investmentGain: number | null;
}

type CompareFieldKey = keyof CompareFields;

const FIELD_LABELS: Record<CompareFieldKey, string> = {
  totalValue: "total_value",
  startingValue: "starting_value",
  depositsWithdrawals: "deposits_withdrawals",
  twr: "twr",
  investmentGain: "investment_gain",
};

const COMPARE_FIELD_KEYS = Object.keys(FIELD_LABELS) as CompareFieldKey[];

export interface SnapshotMismatch {
  accountId: number;
  accountName: string;
  monthEndDate: string;
  isDecember: boolean;
  db: CompareFields & { notes: string | null };
  csv: CompareFields;
  mismatchedFields: CompareFieldKey[];
}

export interface UnresolvedCsvRow {
  account: string;
  monthEndDate: string;
}

export interface SnapshotAudit {
  /** Every mismatch found, December and non-December alike. */
  mismatches: SnapshotMismatch[];
  /** CSV rows whose `account` had no exact accounts.name match. */
  unresolved: UnresolvedCsvRow[];
}

export interface DecemberRepairResult {
  mismatches: SnapshotMismatch[];
  decemberMismatches: SnapshotMismatch[];
  nonDecemberMismatches: SnapshotMismatch[];
  unresolved: UnresolvedCsvRow[];
  /** Distinct account names referenced by an unresolved DECEMBER row — blocks apply entirely. */
  unknownDecemberAccounts: string[];
  updated: number;
}

// ─── Pure helpers ───────────────────────────────────────────────────

const FLOAT_TOLERANCE = 0.005;

/** NULL vs non-NULL always mismatches; otherwise compares within FLOAT_TOLERANCE. */
function numsMismatch(a: number | null, b: number | null): boolean {
  if (a === null && b === null) return false;
  if (a === null || b === null) return true;
  return Math.abs(a - b) > FLOAT_TOLERANCE;
}

function isDecemberDate(monthEndDate: string): boolean {
  return monthEndDate.slice(5, 7) === "12";
}

interface OptionalNumberResult {
  value: number | null;
  ok: boolean;
}

/**
 * Empty/absent -> null (ok). Non-empty and unparsable (including
 * comma-grouped numerics, which parseFloat/Number silently mis-parse or
 * NaN) -> not ok, so the caller can skip the row instead of writing NaN.
 */
function parseOptionalNumber(raw: string | undefined): OptionalNumberResult {
  if (raw === undefined) return { value: null, ok: true };
  const trimmed = raw.trim();
  if (trimmed === "") return { value: null, ok: true };
  if (trimmed.includes(",")) return { value: null, ok: false };
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return { value: null, ok: false };
  return { value: n, ok: true };
}

// ─── CSV parsing ────────────────────────────────────────────────────

/**
 * Parses the canonical monthly-snapshots CSV. Never throws on a malformed
 * row — it's skipped and reported via `malformedRowNumbers` so a single bad
 * line doesn't abort the whole audit.
 */
export function parseSnapshotCsv(csvContent: string): ParsedSnapshotCsv {
  const parsed = Papa.parse<Record<string, string>>(csvContent, {
    header: true,
    skipEmptyLines: true,
  });

  const rows: CsvSnapshotRow[] = [];
  const malformedRowNumbers: number[] = [];

  parsed.data.forEach((raw, idx) => {
    const rowNum = idx + 2; // 1-indexed data row, +1 for the header line
    const account = raw.account?.trim();
    const monthEndDate = raw.month_end_date?.trim();
    if (!account || !monthEndDate) {
      malformedRowNumbers.push(rowNum);
      return;
    }

    const totalValue = parseOptionalNumber(raw.total_value);
    if (!totalValue.ok || totalValue.value === null) {
      malformedRowNumbers.push(rowNum);
      return;
    }

    const startingValue = parseOptionalNumber(raw.starting_value);
    const depositsWithdrawals = parseOptionalNumber(raw.deposits_withdrawals);
    const twr = parseOptionalNumber(raw.twr);
    const investmentGain = parseOptionalNumber(raw.investment_gain);

    if (!startingValue.ok || !depositsWithdrawals.ok || !twr.ok || !investmentGain.ok) {
      malformedRowNumbers.push(rowNum);
      return;
    }

    rows.push({
      account,
      monthEndDate,
      totalValue: totalValue.value,
      startingValue: startingValue.value,
      depositsWithdrawals: depositsWithdrawals.value,
      twr: twr.value,
      investmentGain: investmentGain.value,
    });
  });

  return { rows, malformedRowNumbers };
}

// ─── Audit phase (pure read, ALL rows) ─────────────────────────────

interface AccountRow {
  id: number;
  name: string;
}

interface DbSnapshotRow extends CompareFields {
  notes: string | null;
}

/**
 * Pure read: audits every CSV row (any month) against its DB counterpart.
 * Never writes. Safe to call for reporting in both dry-run and apply modes.
 */
export function findSnapshotMismatches(
  db: Database.Database,
  csvRows: CsvSnapshotRow[],
): SnapshotAudit {
  const accounts = db.prepare("SELECT id, name FROM accounts").all() as AccountRow[];
  const accountIdByName = new Map(accounts.map((a) => [a.name, a.id]));

  const dbRowStmt = db.prepare(
    `SELECT total_value AS totalValue, starting_value AS startingValue,
            deposits_withdrawals AS depositsWithdrawals, twr AS twr,
            investment_gain AS investmentGain, notes AS notes
       FROM monthly_snapshots
      WHERE account_id = ? AND month_end_date = ?`,
  );

  const mismatches: SnapshotMismatch[] = [];
  const unresolved: UnresolvedCsvRow[] = [];

  for (const row of csvRows) {
    const accountId = accountIdByName.get(row.account);
    if (accountId === undefined) {
      unresolved.push({ account: row.account, monthEndDate: row.monthEndDate });
      continue;
    }

    const dbRow = dbRowStmt.get(accountId, row.monthEndDate) as DbSnapshotRow | undefined;
    // No DB row for this (account, month) at all — nothing to compare or
    // repair (this script only heals existing poisoned rows, never inserts).
    if (!dbRow) continue;

    const csvFields: CompareFields = {
      totalValue: row.totalValue,
      startingValue: row.startingValue,
      depositsWithdrawals: row.depositsWithdrawals,
      twr: row.twr,
      investmentGain: row.investmentGain,
    };

    const mismatchedFields = COMPARE_FIELD_KEYS.filter((key) =>
      numsMismatch(dbRow[key], csvFields[key]),
    );
    if (mismatchedFields.length === 0) continue;

    mismatches.push({
      accountId,
      accountName: row.account,
      monthEndDate: row.monthEndDate,
      isDecember: isDecemberDate(row.monthEndDate),
      db: dbRow,
      csv: csvFields,
      mismatchedFields,
    });
  }

  return { mismatches, unresolved };
}

// ─── Repair phase (December-only conditional write) ────────────────

/**
 * Audits (see `findSnapshotMismatches`) and, when `opts.apply` is true AND
 * every December row resolved to a known account, rewrites the 5 compared
 * columns + appends a note for every December-mismatched row inside ONE
 * transaction. Every repaired row is re-read and re-compared against the
 * CSV before the transaction commits; any row still mismatched throws,
 * which rolls the WHOLE batch back (better-sqlite3 `db.transaction`
 * auto-rollbacks on a thrown error) rather than leaving a partially
 * repaired December chain.
 *
 * `opts.apply: false` computes the identical plan and returns it with
 * `updated: 0` — nothing is written. Non-December mismatches are NEVER
 * written regardless of `apply` — they're report-only.
 *
 * `opts.today` is the ET-anchored "today" string used in the repair note
 * (`repaired <today> from canonical CSV (annual-row defect, batch 26)`) —
 * injected by the caller (`todayET()` at the CLI boundary) so this function
 * stays a pure, deterministic function of its arguments.
 */
export function repairDecemberSnapshots(
  db: Database.Database,
  csvRows: CsvSnapshotRow[],
  opts: { apply: boolean; today: string },
): DecemberRepairResult {
  const audit = findSnapshotMismatches(db, csvRows);
  const decemberMismatches = audit.mismatches.filter((m) => m.isDecember);
  const nonDecemberMismatches = audit.mismatches.filter((m) => !m.isDecember);
  const unknownDecemberAccounts = Array.from(
    new Set(
      audit.unresolved
        .filter((r) => isDecemberDate(r.monthEndDate))
        .map((r) => r.account),
    ),
  );

  let updated = 0;

  // All-or-nothing: an unresolved December account means we can't be sure
  // we're seeing every poisoned row for that account, so we refuse to write
  // ANY December repair this run rather than leave an unexplained gap.
  const canWrite =
    opts.apply && decemberMismatches.length > 0 && unknownDecemberAccounts.length === 0;

  if (canWrite) {
    const noteLine = `repaired ${opts.today} from canonical CSV (annual-row defect, batch 26)`;

    const updateStmt = db.prepare(
      `UPDATE monthly_snapshots
          SET total_value = ?, starting_value = ?, deposits_withdrawals = ?,
              twr = ?, investment_gain = ?, notes = ?
        WHERE account_id = ? AND month_end_date = ?`,
    );
    const verifyStmt = db.prepare(
      `SELECT total_value AS totalValue, starting_value AS startingValue,
              deposits_withdrawals AS depositsWithdrawals, twr AS twr,
              investment_gain AS investmentGain
         FROM monthly_snapshots
        WHERE account_id = ? AND month_end_date = ?`,
    );

    const tx = db.transaction(() => {
      for (const m of decemberMismatches) {
        const newNotes = m.db.notes ? `${m.db.notes}\n${noteLine}` : noteLine;
        updateStmt.run(
          m.csv.totalValue,
          m.csv.startingValue,
          m.csv.depositsWithdrawals,
          m.csv.twr,
          m.csv.investmentGain,
          newNotes,
          m.accountId,
          m.monthEndDate,
        );
      }

      // Re-read every repaired row and verify it now matches the CSV before
      // committing. Any surviving mismatch throws -> the WHOLE batch rolls
      // back (never a partially-repaired December chain).
      for (const m of decemberMismatches) {
        const after = verifyStmt.get(m.accountId, m.monthEndDate) as
          | CompareFields
          | undefined;
        if (!after) {
          throw new Error(
            `verification failed: row (account_id=${m.accountId}, ${m.monthEndDate}) ` +
              `not found after update — transaction rolled back, no changes were written.`,
          );
        }
        const stillMismatched = COMPARE_FIELD_KEYS.some((key) =>
          numsMismatch(after[key], m.csv[key]),
        );
        if (stillMismatched) {
          throw new Error(
            `verification failed: row (account_id=${m.accountId}, ${m.monthEndDate}) ` +
              `still disagrees with the CSV after update — transaction rolled back, no changes were written.`,
          );
        }
        updated++;
      }
    });

    tx();
  }

  return {
    mismatches: audit.mismatches,
    decemberMismatches,
    nonDecemberMismatches,
    unresolved: audit.unresolved,
    unknownDecemberAccounts,
    updated,
  };
}

// ─── CLI formatting ─────────────────────────────────────────────────

function formatMismatch(m: SnapshotMismatch): string {
  const header = `  ${m.accountName} ${m.monthEndDate}${m.isDecember ? "" : " (non-December)"}`;
  const fieldLines = m.mismatchedFields.map((key) => {
    const dbVal = m.db[key];
    const csvVal = m.csv[key];
    return `      ${FIELD_LABELS[key]}: ${dbVal ?? "NULL"} -> ${csvVal ?? "NULL"}`;
  });
  return [header, ...fieldLines].join("\n");
}

// ─── CLI entry point ──────────────────────────────────────────────

// Detect if this file is being run directly (not imported by tests) —
// mirrors scripts/repair-ah-closes.ts.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("repair-december-snapshots.ts") ||
    process.argv[1].endsWith("repair-december-snapshots.js"));

if (isMain) {
  (async () => {
    const { default: BetterSqlite3 } = await import("better-sqlite3");
    const { runMigrations } = await import("@/lib/db/migrate");
    const { ensureBackup } = await import("@/scripts/rebuild-ibkr-ledger");
    const { todayET } = await import("@/lib/calendar/date-utils");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const os = await import("node:os");

    const args = process.argv.slice(2);
    const apply = args.includes("--apply");

    function argValue(flag: string): string | undefined {
      const eqArg = args.find((a) => a.startsWith(`${flag}=`));
      if (eqArg) return eqArg.slice(flag.length + 1);
      const idx = args.indexOf(flag);
      if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
      return undefined;
    }

    const defaultCsvPath = path.default.join(
      os.default.homedir(),
      "Desktop",
      "Trading - Local",
      "dashboard_Vanguard_Brokerage_monthly_snapshots.csv",
    );
    const csvPath = argValue("--csv") ?? defaultCsvPath;

    const dataDir = process.env.VANGUARD_DB_DIR || path.default.join(process.cwd(), "data");
    const defaultDbPath = path.default.join(dataDir, "vanguard.db");
    const dbPath = argValue("--db") ?? defaultDbPath;

    let csvContent: string;
    try {
      csvContent = fs.default.readFileSync(csvPath, "utf-8");
    } catch (err) {
      console.error(
        `Cannot read CSV at ${csvPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
      return;
    }

    const parsedCsv = parseSnapshotCsv(csvContent);
    if (parsedCsv.malformedRowNumbers.length > 0) {
      console.warn(
        `WARNING: ${parsedCsv.malformedRowNumbers.length} CSV row(s) skipped ` +
          `(missing/invalid required fields): rows ${parsedCsv.malformedRowNumbers.join(", ")}`,
      );
    }

    if (!fs.default.existsSync(dbPath)) {
      console.error(`Database not found at ${dbPath}`);
      process.exit(1);
      return;
    }

    const db = new BetterSqlite3(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    // Gated on --apply (mirrors repair-ah-closes.ts): a dry run must never
    // write, and runMigrations() is a write the instant a migration is pending.
    if (apply) {
      runMigrations(db);
    }

    console.log(
      `Auditing monthly_snapshots against canonical CSV (${csvPath}) ` +
        `${apply ? "[APPLY]" : "[DRY RUN]"}`,
    );

    const audit = findSnapshotMismatches(db, parsedCsv.rows);

    if (audit.unresolved.length > 0) {
      const names = Array.from(new Set(audit.unresolved.map((r) => r.account)));
      console.warn(
        `\nSkipped CSV row(s) for unknown account(s) (no exact accounts.name match): ${names.join(", ")}`,
      );
    }

    const decemberMismatches = audit.mismatches.filter((m) => m.isDecember);
    const nonDecemberMismatches = audit.mismatches.filter((m) => !m.isDecember);

    console.log(
      `\n${audit.mismatches.length} total mismatch(es) found ` +
        `(${decemberMismatches.length} December, ${nonDecemberMismatches.length} non-December).`,
    );

    if (nonDecemberMismatches.length > 0) {
      console.log("\nNon-December mismatches — REPORT-ONLY, this script refuses to touch them:");
      for (const m of nonDecemberMismatches) console.log(formatMismatch(m));
    }

    if (decemberMismatches.length > 0) {
      console.log("\nDecember mismatches:");
      for (const m of decemberMismatches) console.log(formatMismatch(m));
    }

    const unknownDecemberAccounts = Array.from(
      new Set(
        audit.unresolved
          .filter((r) => isDecemberDate(r.monthEndDate))
          .map((r) => r.account),
      ),
    );

    if (unknownDecemberAccounts.length > 0) {
      console.error(
        `\nERROR: December row(s) reference account(s) not found in accounts.name: ` +
          `${unknownDecemberAccounts.join(", ")}. Refusing to repair ANY December row until resolved.`,
      );
      db.close();
      process.exit(1);
      return;
    }

    if (decemberMismatches.length === 0) {
      console.log("\nNo December mismatches — nothing to repair.");
      db.close();
      return;
    }

    if (!apply) {
      console.log("\nDry-run (default). Re-run with --apply to write.");
      db.close();
      return;
    }

    // NEVER proceed past this line without a verified backup — same
    // VACUUM-INTO convention + "fail hard" behavior as
    // rebuild-ibkr-ledger.ts::ensureBackup / repair-ah-closes.ts.
    const today = todayET();
    const backupPath = path.default.join(
      dataDir,
      "backups",
      `pre-december-snapshot-repair-${today}.db`,
    );
    const backup = ensureBackup(db, backupPath);
    console.log(
      `\nBackup ${backup.created ? "created" : "already present"} at ${backup.path} ` +
        `(${backup.sizeBytes.toLocaleString()} bytes).`,
    );

    let result: DecemberRepairResult;
    try {
      result = repairDecemberSnapshots(db, parsedCsv.rows, { apply: true, today });
    } catch (err) {
      console.error(`\nERROR: ${err instanceof Error ? err.message : String(err)}`);
      db.close();
      process.exit(1);
      return;
    }

    console.log(`\nRepaired ${result.updated} December row(s).`);
    console.log(
      "\nReminder — this script does NOT recompute downstream derived data (TWR chains, " +
        "risk metrics). Task 2 of this plan reads the repaired rows directly; no recompute " +
        "step is required for monthly_snapshots consumers.",
    );

    db.close();
  })();
}
