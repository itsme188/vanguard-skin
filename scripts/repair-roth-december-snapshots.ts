/**
 * repair-roth-december-snapshots.ts: replaces annual-summary figures in
 * December `monthly_snapshots` rows with the December-only figures from the
 * year-end statement, so each row reads as an ordinary month.
 *
 * The defect (owner ruling 2026-11-15: repair the data): an early draft of a
 * canonical snapshots CSV wrote some December rows with YEAR figures
 * (`deposits_withdrawals` = the whole year's contributions, `twr` NULL, and
 * `starting_value` either NULL or the year-start value). The corrected CSV
 * was imported later, but the import engine's ON CONFLICT clause only
 * overwrites live rows (tws / manual / plaid), so the draft rows survived.
 * A row with `starting_value` NULL is not caught by `isAnnualSummaryRow`
 * (lib/compute/monthly-snapshot-utils.ts), so the TWR chain, the Dietz lane
 * and XIRR read a year of contributions as one December flow. Same class as
 * scripts/repair-december-snapshots.ts (the taxable account, 2026-08-10).
 *
 * The figures come from a GITIGNORED config (the repo is public), default
 * `data/repair-configs/roth-december-snapshots.json`:
 *
 *   {
 *     "accountName": "<exact accounts.name>",
 *     "note": "optional text appended to notes",
 *     "rows": [{
 *       "monthEndDate": "YYYY-12-31",
 *       "before": { "total_value", "starting_value", "deposits_withdrawals",
 *                   "twr", "investment_gain", "dividends" },
 *       "after":  { "starting_value", "deposits_withdrawals", "twr",
 *                   "investment_gain", "dividends" }
 *     }]
 *   }
 *
 * `total_value` (the statement's ending value) is never written; it must
 * equal `before.total_value`. The script does not trust the config's "after"
 * figures blindly: `starting_value` must equal the prior month-end row's
 * `total_value`, `investment_gain` must equal total - start - deposits, and
 * `twr` must equal investment_gain / starting_value (the convention every
 * other canonical month uses; stored as a FRACTION).
 *
 * Safety:
 *   - The database path is REQUIRED (`--db <path>` or REPAIR_DB_PATH) and is
 *     printed before the database is opened. There is no default: the live
 *     database is written only when it is named explicitly.
 *   - Dry-run by default; `--apply` writes. Dry-run opens the file read-only.
 *   - Every row must be in its exact "before" state (or already in its
 *     "after" state, which is skipped). Anything else refuses the WHOLE run.
 *   - All writes happen in ONE transaction and are re-read and re-checked
 *     before commit; any mismatch rolls everything back.
 *   - Idempotent: a second run finds every row already repaired and writes
 *     nothing.
 *   - On --apply a VACUUM INTO backup is written next to the database
 *     (`<db dir>/backups/pre-roth-december-snapshot-repair-<today>.db`).
 *
 * Invalidation: none needed. `monthly_snapshots` flows/returns feed no stored
 * cache: TWR, Dietz, XIRR and the performance window are computed on read;
 * daily_valuations read only total_value and cash_value (unchanged here);
 * AI narratives detect drift by input fingerprint on read; and
 * tax_input_generation tracks tax-lot inputs (transactions, holdings,
 * corporate actions), which a snapshot import does not bump either.
 *
 * Usage (run from the repo root):
 *   npx tsx scripts/repair-roth-december-snapshots.ts --db /path/copy.db
 *   npx tsx scripts/repair-roth-december-snapshots.ts --db /path/copy.db --apply
 *   REPAIR_DB_PATH=/path/copy.db REPAIR_CONFIG_PATH=/path/cfg.json \
 *     npx tsx scripts/repair-roth-december-snapshots.ts --apply
 */

import type Database from "better-sqlite3";

// ─── Types ────────────────────────────────────────────────────────

export const AFTER_COLUMNS = [
  "starting_value",
  "deposits_withdrawals",
  "twr",
  "investment_gain",
  "dividends",
] as const;
export type AfterColumn = (typeof AFTER_COLUMNS)[number];
export const BEFORE_COLUMNS = ["total_value", ...AFTER_COLUMNS] as const;
export type BeforeColumn = (typeof BEFORE_COLUMNS)[number];

export type RowFigures<K extends string> = Record<K, number | null>;

export interface RepairRowConfig {
  monthEndDate: string;
  before: RowFigures<BeforeColumn>;
  after: RowFigures<AfterColumn>;
}

export interface RepairConfig {
  accountName: string;
  note?: string;
  rows: RepairRowConfig[];
}

export type RowState = "needs-repair" | "already-repaired";

export interface PlannedRow {
  monthEndDate: string;
  state: RowState;
  current: RowFigures<BeforeColumn> & { notes: string | null };
  after: RowFigures<AfterColumn>;
}

export interface RepairPlan {
  accountId: number;
  rows: PlannedRow[];
  /** Reasons the run is refused. Non-empty = nothing may be written. */
  refusals: string[];
}

export interface RepairResult {
  plan: RepairPlan;
  applied: boolean;
  updated: number;
}

// ─── Tolerances ───────────────────────────────────────────────────

/** Money columns: half a cent. */
const MONEY_TOLERANCE = 0.005;
/** twr is a fraction stored to ~6 decimal places. */
const TWR_TOLERANCE = 1e-6;
/** investment_gain recomputed from three rounded money figures. */
const GAIN_TOLERANCE = 0.015;

function tolerance(col: BeforeColumn): number {
  return col === "twr" ? TWR_TOLERANCE : MONEY_TOLERANCE;
}

function same(a: number | null, b: number | null, tol: number): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= tol;
}

// ─── Config parsing ───────────────────────────────────────────────

function readFigure(obj: Record<string, unknown>, key: string, where: string): number | null {
  if (!(key in obj)) throw new Error(`${where}: missing "${key}" (use null for an empty column)`);
  const v = obj[key];
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`${where}: "${key}" must be a finite number or null`);
  }
  return v;
}

/** Validates the config shape. Throws with a precise message on any defect. */
export function parseRepairConfig(raw: unknown): RepairConfig {
  if (!raw || typeof raw !== "object") throw new Error("config: not an object");
  const obj = raw as Record<string, unknown>;
  if (typeof obj.accountName !== "string" || obj.accountName.trim() === "") {
    throw new Error("config: accountName must be a non-empty string");
  }
  if (obj.note !== undefined && typeof obj.note !== "string") {
    throw new Error("config: note must be a string when present");
  }
  if (!Array.isArray(obj.rows) || obj.rows.length === 0) {
    throw new Error("config: rows must be a non-empty array");
  }
  const seen = new Set<string>();
  const rows = obj.rows.map((r, i): RepairRowConfig => {
    const where = `config.rows[${i}]`;
    if (!r || typeof r !== "object") throw new Error(`${where}: not an object`);
    const row = r as Record<string, unknown>;
    const monthEndDate = row.monthEndDate;
    if (typeof monthEndDate !== "string" || !/^\d{4}-12-31$/.test(monthEndDate)) {
      throw new Error(`${where}: monthEndDate must be a December month-end (YYYY-12-31)`);
    }
    if (seen.has(monthEndDate)) throw new Error(`${where}: duplicate monthEndDate ${monthEndDate}`);
    seen.add(monthEndDate);
    const before = row.before as Record<string, unknown> | undefined;
    const after = row.after as Record<string, unknown> | undefined;
    if (!before || typeof before !== "object") throw new Error(`${where}: before must be an object`);
    if (!after || typeof after !== "object") throw new Error(`${where}: after must be an object`);
    const b = {} as RowFigures<BeforeColumn>;
    for (const col of BEFORE_COLUMNS) b[col] = readFigure(before, col, `${where}.before`);
    if (b.total_value === null) throw new Error(`${where}.before: total_value cannot be null`);
    const a = {} as RowFigures<AfterColumn>;
    for (const col of AFTER_COLUMNS) a[col] = readFigure(after, col, `${where}.after`);
    if ("total_value" in after) {
      throw new Error(`${where}.after: total_value is never written; leave it out`);
    }
    return { monthEndDate, before: b, after: a };
  });
  return { accountName: obj.accountName, note: obj.note as string | undefined, rows };
}

// ─── Plan (read only) ─────────────────────────────────────────────

const LIVE_SOURCES = new Set(["tws", "plaid"]);

function priorMonthEnd(monthEndDate: string): string {
  const d = new Date(monthEndDate + "T00:00:00Z");
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)).toISOString().slice(0, 10);
}

/**
 * Pure read. Works out, for every configured row, whether it is in its
 * expected "before" state, already repaired, or neither (a refusal), and
 * checks the configured "after" figures against the row's own total and the
 * prior month-end total.
 */
export function planRothDecemberRepair(db: Database.Database, config: RepairConfig): RepairPlan {
  const refusals: string[] = [];
  const account = db
    .prepare("SELECT id FROM accounts WHERE name = ?")
    .get(config.accountName) as { id: number } | undefined;
  if (!account) {
    return { accountId: -1, rows: [], refusals: [`no account named exactly "${config.accountName}"`] };
  }

  const rowStmt = db.prepare(
    `SELECT total_value, starting_value, deposits_withdrawals, twr, investment_gain,
            dividends, notes, source
       FROM monthly_snapshots
      WHERE account_id = ? AND month_end_date = ?`,
  );

  const rows: PlannedRow[] = [];
  for (const cfg of config.rows) {
    const label = cfg.monthEndDate;
    const cur = rowStmt.get(account.id, cfg.monthEndDate) as
      | (RowFigures<BeforeColumn> & { notes: string | null; source: string | null })
      | undefined;
    if (!cur) {
      refusals.push(`${label}: no monthly_snapshots row for this account`);
      continue;
    }
    if (cur.source && LIVE_SOURCES.has(cur.source)) {
      refusals.push(`${label}: row is a live ${cur.source} snapshot, not a statement row`);
      continue;
    }

    const isBefore = BEFORE_COLUMNS.every((col) => same(cur[col], cfg.before[col], tolerance(col)));
    const isAfter =
      same(cur.total_value, cfg.before.total_value, MONEY_TOLERANCE) &&
      AFTER_COLUMNS.every((col) => same(cur[col], cfg.after[col], tolerance(col)));

    if (!isBefore && !isAfter) {
      const differing = BEFORE_COLUMNS.filter(
        (col) => !same(cur[col], cfg.before[col], tolerance(col)),
      );
      refusals.push(
        `${label}: row matches neither the expected before-state nor the repaired state ` +
          `(differs from before on: ${differing.join(", ")})`,
      );
      continue;
    }

    // Independent checks on the configured after-figures.
    const prior = rowStmt.get(account.id, priorMonthEnd(cfg.monthEndDate)) as
      | { total_value: number; source: string | null }
      | undefined;
    const a = cfg.after;
    if (!prior || (prior.source && LIVE_SOURCES.has(prior.source))) {
      refusals.push(`${label}: no statement row for the prior month-end to check starting_value`);
    } else if (a.starting_value === null || !same(a.starting_value, prior.total_value, MONEY_TOLERANCE)) {
      refusals.push(`${label}: after.starting_value does not equal the prior month-end total_value`);
    }
    if (a.starting_value !== null && a.deposits_withdrawals !== null && a.investment_gain !== null) {
      const gain = cfg.before.total_value! - a.starting_value - a.deposits_withdrawals;
      if (!same(a.investment_gain, gain, GAIN_TOLERANCE)) {
        refusals.push(`${label}: after.investment_gain is not total - starting - deposits`);
      }
      if (a.twr === null || a.starting_value === 0 || !same(a.twr, a.investment_gain / a.starting_value, TWR_TOLERANCE)) {
        refusals.push(`${label}: after.twr is not investment_gain / starting_value`);
      }
    } else {
      refusals.push(`${label}: after.starting_value, deposits_withdrawals and investment_gain must all be set`);
    }

    rows.push({
      monthEndDate: cfg.monthEndDate,
      state: isBefore && !isAfter ? "needs-repair" : "already-repaired",
      current: {
        total_value: cur.total_value,
        starting_value: cur.starting_value,
        deposits_withdrawals: cur.deposits_withdrawals,
        twr: cur.twr,
        investment_gain: cur.investment_gain,
        dividends: cur.dividends,
        notes: cur.notes,
      },
      after: cfg.after,
    });
  }

  return { accountId: account.id, rows, refusals };
}

// ─── Apply (one transaction) ──────────────────────────────────────

export function defaultRepairNote(today: string): string {
  return `repaired ${today}: annual-summary figures replaced with December-only figures from the year-end statement`;
}

/**
 * Plans and, with `apply: true`, writes every "needs-repair" row in ONE
 * transaction. Refuses (throws, writes nothing) when the plan has any
 * refusal. Re-reads each written row inside the transaction; a mismatch
 * throws and rolls the whole batch back.
 */
export function runRothDecemberRepair(
  db: Database.Database,
  config: RepairConfig,
  opts: { apply: boolean; today: string },
): RepairResult {
  const plan = planRothDecemberRepair(db, config);
  if (plan.refusals.length > 0) {
    if (opts.apply) {
      throw new Error(`refusing to write; nothing changed:\n  - ${plan.refusals.join("\n  - ")}`);
    }
    return { plan, applied: false, updated: 0 };
  }
  const todo = plan.rows.filter((r) => r.state === "needs-repair");
  if (!opts.apply || todo.length === 0) return { plan, applied: opts.apply, updated: 0 };

  const noteLine = config.note ?? defaultRepairNote(opts.today);
  const update = db.prepare(
    `UPDATE monthly_snapshots
        SET starting_value = ?, deposits_withdrawals = ?, twr = ?,
            investment_gain = ?, dividends = ?, notes = ?
      WHERE account_id = ? AND month_end_date = ?`,
  );
  const reread = db.prepare(
    `SELECT total_value, starting_value, deposits_withdrawals, twr, investment_gain, dividends
       FROM monthly_snapshots WHERE account_id = ? AND month_end_date = ?`,
  );

  const updated = db.transaction(() => {
    let n = 0;
    for (const r of todo) {
      const notes = r.current.notes ? `${r.current.notes}\n${noteLine}` : noteLine;
      const res = update.run(
        r.after.starting_value,
        r.after.deposits_withdrawals,
        r.after.twr,
        r.after.investment_gain,
        r.after.dividends,
        notes,
        plan.accountId,
        r.monthEndDate,
      );
      if (res.changes !== 1) {
        throw new Error(`${r.monthEndDate}: expected 1 row updated, got ${res.changes}; rolled back`);
      }
      const after = reread.get(plan.accountId, r.monthEndDate) as RowFigures<BeforeColumn>;
      const ok =
        same(after.total_value, r.current.total_value, MONEY_TOLERANCE) &&
        AFTER_COLUMNS.every((col) => same(after[col], r.after[col], tolerance(col)));
      if (!ok) throw new Error(`${r.monthEndDate}: re-read does not match the repaired figures; rolled back`);
      n++;
    }
    return n;
  })();

  return { plan, applied: true, updated };
}

// ─── CLI ──────────────────────────────────────────────────────────

function fmt(v: number | null): string {
  return v === null ? "NULL" : String(v);
}

function printPlan(result: RepairResult): void {
  for (const r of result.plan.rows) {
    console.log(`  ${r.monthEndDate}: ${r.state}`);
    if (r.state === "needs-repair") {
      for (const col of AFTER_COLUMNS) {
        if (!same(r.current[col], r.after[col], tolerance(col))) {
          console.log(`      ${col}: ${fmt(r.current[col])} -> ${fmt(r.after[col])}`);
        }
      }
    }
  }
  for (const reason of result.plan.refusals) console.log(`  REFUSED: ${reason}`);
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  /repair-roth-december-snapshots\.(ts|js)$/.test(process.argv[1]);

if (isMain) {
  (async () => {
    const path = await import("node:path");
    const fs = await import("node:fs");
    const args = process.argv.slice(2);
    const argValue = (flag: string): string | undefined => {
      const eq = args.find((a) => a.startsWith(`${flag}=`));
      if (eq) return eq.slice(flag.length + 1);
      const i = args.indexOf(flag);
      return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
    };
    const apply = args.includes("--apply");
    const dbPath = argValue("--db") ?? process.env.REPAIR_DB_PATH;
    const configPath =
      argValue("--config") ??
      process.env.REPAIR_CONFIG_PATH ??
      path.default.join(process.cwd(), "data", "repair-configs", "roth-december-snapshots.json");

    if (!dbPath) {
      console.error("No database named. Pass --db <path> or set REPAIR_DB_PATH (there is no default).");
      process.exit(1);
    }
    console.log(`[repair-roth-december-snapshots] ${apply ? "APPLY" : "DRY RUN"}, db: ${dbPath}`);
    console.log(`[repair-roth-december-snapshots] config: ${configPath}`);
    if (!fs.default.existsSync(dbPath)) {
      console.error(`Database not found at ${dbPath}`);
      process.exit(1);
    }

    const config = parseRepairConfig(JSON.parse(fs.default.readFileSync(configPath, "utf8")));
    const { default: BetterSqlite3 } = await import("better-sqlite3");
    const { todayET } = await import("@/lib/calendar/date-utils");
    const today = todayET();
    const db = new BetterSqlite3(dbPath, { readonly: !apply, fileMustExist: true, timeout: 60_000 });
    try {
      const preview = runRothDecemberRepair(db, config, { apply: false, today });
      printPlan(preview);
      if (preview.plan.refusals.length > 0) {
        console.error("Refused: nothing written.");
        process.exitCode = 1;
        return;
      }
      const todo = preview.plan.rows.filter((r) => r.state === "needs-repair").length;
      if (todo === 0) {
        console.log("Every row is already repaired. Nothing to do.");
        return;
      }
      if (!apply) {
        console.log(`Dry run: ${todo} row(s) would be repaired. Re-run with --apply to write.`);
        return;
      }
      const { ensureBackup } = await import("@/scripts/rebuild-ibkr-ledger");
      const backupPath = path.default.join(
        path.default.dirname(dbPath),
        "backups",
        `pre-roth-december-snapshot-repair-${today}.db`,
      );
      const backup = ensureBackup(db, backupPath);
      console.log(`Backup ${backup.created ? "created" : "already present"}: ${backup.path}`);
      const result = runRothDecemberRepair(db, config, { apply: true, today });
      console.log(`Repaired ${result.updated} row(s) in one transaction.`);
    } finally {
      db.close();
    }
  })().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
