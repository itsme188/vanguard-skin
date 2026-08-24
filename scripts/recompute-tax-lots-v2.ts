/**
 * recompute-tax-lots-v2.ts — v2 recompute + rehearsal script
 * (spec: number-trust durable fixes, task 10).
 *
 * This IS the USER-RUN runbook step that lands the v2 tax-lots dollar
 * convention (Task 3's `computeTaxLots`, which stamps the convention marker
 * itself as its final in-transaction act) onto a real DB. A run:
 *
 *   1. Rebuilds tax_lots/tax_lot_sales from transactions (computeTaxLots).
 *   2. Recomputes daily_valuations with the SAME function the auto-refresh
 *      pipeline's Step 4 calls (computeDailyValuations — see
 *      lib/tws/auto-refresh.ts).
 *   3. Verifies the daily accounting identity — cash_balance +
 *      holdings_value = total_value — holds on EVERY daily_valuations row
 *      (the identity-check query pattern this reuses is
 *      scripts/repair-security-type-corruption.ts's printDailyIdentityCheck,
 *      generalized here from "latest date only, eyeball" to "every row,
 *      pass/fail gate").
 *
 * No task in this spec performs a live mutation — this script is that
 * runbook step, run by a human, later.
 *
 * RUN FROM THE REPO ROOT. tsx only resolves the "@/" alias for DYNAMIC
 * imports when process.cwd() is the repo root (the rehearsal workflow runs
 * scripts from a scratch directory) — caught live during the 2026-08-23
 * repair-security-type-corruption.ts rehearsal. This file follows that
 * script's convention of avoiding "@/" entirely (even for the static
 * imports below, which tsx resolves fine off-cwd) so every import in this
 * file stays safe to reason about under the same rule.
 *
 * CLI contract (mirrors repair-security-type-corruption.ts's conventions):
 *
 *   - No --apply: REPORT-ONLY (Codex plan review #20). Opens the DB
 *     READ-ONLY, prints the current tax_lots/tax_lot_sales counts, the
 *     tax-convention marker state, and what a run WOULD do. Executes
 *     NOTHING destructive.
 *   - --apply: opens the DB read-write and actually runs the recompute.
 *     Refused unless REPAIR_DB_PATH is set (pointing at a rehearsal copy)
 *     or --live is ALSO passed (a deliberate live run) — never both silently
 *     assumed.
 *   - Any writable run takes a WAL-safe backup FIRST via better-sqlite3's
 *     native `db.backup()` API into data/backups/, timestamped — never a
 *     bare file copy of a hot WAL database.
 *   - --verify-idempotent (only meaningful with --apply): after the primary
 *     recompute, runs `computeTaxLots` a SECOND time and diffs the
 *     BUSINESS columns of tax_lots/tax_lot_sales against a snapshot taken
 *     right after the first run — reports IDENTICAL / NOT IDENTICAL.
 *   - After the primary recompute, prints the elapsed ms of one
 *     `runIntegrityChecks(db)` call, so a rehearsal run against a live-size
 *     DB copy captures real latency evidence.
 *
 * REPAIR_DB_PATH env override lets the rehearsal workflow point this script
 * at a scratch copy of the DB while still running from the repo root.
 */

import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { computeTaxLots } from "../lib/compute/tax-lots";
import { computeDailyValuations } from "../lib/compute/daily-valuation";
import { getTaxConventionState } from "../lib/compute/tax-convention";
import { runIntegrityChecks } from "../lib/queries/integrity-checks";

// ─── Core (Step 1 test target) ─────────────────────────────────────────

export interface RecomputeResult {
  lots: number;
  sales: number;
  identityOk: boolean;
}

const IDENTITY_TOLERANCE = 0.01;

interface IdentityRow {
  cash_balance: number;
  holdings_value: number;
  total_value: number;
}

/** cash_balance + holdings_value = total_value on EVERY daily_valuations
 *  row. computeDailyValuations derives total_value as cash + holdings by
 *  construction, so a mismatch here means something wrote to
 *  daily_valuations outside that function — flagged, never silently
 *  trusted. Vacuously true with zero rows. */
export function checkDailyIdentity(db: Database.Database): boolean {
  const rows = db
    .prepare(`SELECT cash_balance, holdings_value, total_value FROM daily_valuations`)
    .all() as IdentityRow[];
  return rows.every(
    (r) => Math.abs(r.cash_balance + r.holdings_value - r.total_value) < IDENTITY_TOLERANCE,
  );
}

/** Rebuilds tax lots/sales (computeTaxLots stamps the v2 convention marker
 *  itself) and recomputes daily valuations with the SAME function the
 *  auto-refresh pipeline's Step 4 calls, then verifies the daily accounting
 *  identity holds on every daily_valuations row. */
export function runRecompute(db: Database.Database): RecomputeResult {
  const lotResult = computeTaxLots(db);
  computeDailyValuations(db);
  return {
    lots: lotResult.lotsCreated,
    sales: lotResult.salesProcessed,
    identityOk: checkDailyIdentity(db),
  };
}

// ─── Business-column snapshot + diff (--verify-idempotent) ─────────────

/**
 * Snapshot of tax_lots/tax_lot_sales BUSINESS columns only, keyed by a
 * STABLE natural key so two different computeTaxLots runs can be lined up
 * for comparison. Excluded on purpose: tax_lots.id / tax_lot_sales.id (both
 * AUTOINCREMENT — DELETE+INSERT hands out fresh, ever-increasing ids every
 * run even when every computed number is identical) and created_at
 * timestamps. tax_lot_sales.tax_lot_id is likewise a surrogate (it points
 * at the same ever-incrementing tax_lots.id), so it is replaced below with
 * the origin lot's acquisition_transaction_id, which IS stable — it points
 * at a transactions row, and computeTaxLots never touches transactions.
 */
export function snapshotBusinessColumns(
  db: Database.Database,
): Map<string, Record<string, unknown>> {
  const snapshot = new Map<string, Record<string, unknown>>();

  const lots = db
    .prepare(
      `SELECT acquisition_transaction_id, account_id, security_id, acquisition_date,
              acquisition_price, quantity_acquired, quantity_remaining, cost_basis,
              is_from_opening_snapshot, is_short
         FROM tax_lots
        ORDER BY acquisition_transaction_id, account_id, security_id`,
    )
    .all() as Array<{
    acquisition_transaction_id: number | null;
    [key: string]: unknown;
  }>;
  for (const { acquisition_transaction_id, ...data } of lots) {
    snapshot.set(`lot:${acquisition_transaction_id}`, data);
  }

  const sales = db
    .prepare(
      `SELECT s.sale_transaction_id, s.quantity_sold, s.sale_price, s.proceeds,
              s.cost_basis_allocated, s.realized_gain_loss, s.is_long_term,
              s.holding_period_days, s.sale_date, s.premium_rollover,
              l.acquisition_transaction_id AS lot_acquisition_transaction_id
         FROM tax_lot_sales s
         JOIN tax_lots l ON l.id = s.tax_lot_id
        ORDER BY s.sale_transaction_id, l.acquisition_transaction_id`,
    )
    .all() as Array<{
    sale_transaction_id: number;
    lot_acquisition_transaction_id: number | null;
    [key: string]: unknown;
  }>;
  for (const { sale_transaction_id, lot_acquisition_transaction_id, ...data } of sales) {
    snapshot.set(`sale:${sale_transaction_id}:${lot_acquisition_transaction_id}`, {
      sale_transaction_id,
      ...data,
    });
  }

  return snapshot;
}

export interface IdempotenceDiff {
  identical: boolean;
  /** One entry per key whose business columns differ, or that appeared in
   *  only one of the two runs. */
  differences: string[];
}

export function diffBusinessSnapshots(
  before: Map<string, Record<string, unknown>>,
  after: Map<string, Record<string, unknown>>,
): IdempotenceDiff {
  const differences: string[] = [];
  const allKeys = new Set([...before.keys(), ...after.keys()]);
  for (const key of allKeys) {
    const b = before.get(key);
    const a = after.get(key);
    if (!b || !a) {
      differences.push(`${key}: present in only one run`);
      continue;
    }
    if (JSON.stringify(b) !== JSON.stringify(a)) {
      differences.push(key);
    }
  }
  return { identical: differences.length === 0, differences };
}

// ─── CLI driver ─────────────────────────────────────────────────────

// REPAIR_DB_PATH lets the rehearsal workflow point at a scratch DB copy
// while STILL running from the repo root — see the header doc's "@/" alias
// note. The backup lands next to whichever DB is being recomputed, never
// blindly in the repo's data/.
const DB_PATH = process.env.REPAIR_DB_PATH ?? path.join(process.cwd(), "data", "vanguard.db");

function countRows(db: Database.Database, table: "tax_lots" | "tax_lot_sales"): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function printMarkerState(db: Database.Database): void {
  const state = getTaxConventionState(db);
  console.log(
    `  marker: generation=${state.generation} recomputeCurrent=${state.recomputeCurrent} ` +
      `acceptanceCurrent=${state.acceptance.current}`,
  );
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const live = process.argv.includes("--live");
  const verifyIdempotent = process.argv.includes("--verify-idempotent");

  if (apply && !process.env.REPAIR_DB_PATH && !live) {
    console.error(
      "ABORTING — --apply refused: set REPAIR_DB_PATH to a rehearsal copy, or pass " +
        "--live for a deliberate live run.",
    );
    process.exitCode = 1;
    return;
  }

  const { default: BetterSqlite3 } = await import("better-sqlite3");
  const db = new BetterSqlite3(DB_PATH, { readonly: !apply }) as Database.Database;
  if (apply) {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
  }

  try {
    console.log(`v2 recompute ${apply ? "[APPLY]" : "[REPORT-ONLY]"} — db: ${DB_PATH}\n`);

    console.log("Current state:");
    console.log(`  tax_lots: ${countRows(db, "tax_lots")}`);
    console.log(`  tax_lot_sales: ${countRows(db, "tax_lot_sales")}`);
    printMarkerState(db);

    if (!apply) {
      console.log(
        "\nA run WOULD: rebuild tax_lots/tax_lot_sales from transactions (computeTaxLots), " +
          "recompute daily_valuations with the auto-refresh pipeline's own function " +
          "(computeDailyValuations), verify cash_balance + holdings_value = total_value on " +
          "every daily_valuations row, and stamp the v2 convention marker at the current " +
          "tax-input generation.",
      );
      console.log(
        "\nReport-only (default) — nothing executed. Re-run with --apply (plus " +
          "REPAIR_DB_PATH or --live) to write.",
      );
      return;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(
      path.dirname(DB_PATH),
      "backups",
      `vanguard-pre-v2-recompute-${stamp}.db`,
    );
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    console.log(`\nBacking up to ${backupPath} ...`);
    const backupMeta = await db.backup(backupPath);
    console.log(`  backup complete (${backupMeta.totalPages} pages).`);

    const result = runRecompute(db);
    console.log("\nRecompute result:");
    console.log(`  lots: ${result.lots}`);
    console.log(`  sales: ${result.sales}`);
    console.log(`  identityOk: ${result.identityOk}`);
    printMarkerState(db);

    const integrityStart = Date.now();
    runIntegrityChecks(db);
    console.log(`\nrunIntegrityChecks: ${Date.now() - integrityStart}ms`);

    if (verifyIdempotent) {
      const firstSnapshot = snapshotBusinessColumns(db);
      const second = computeTaxLots(db);
      const secondSnapshot = snapshotBusinessColumns(db);
      const diff = diffBusinessSnapshots(firstSnapshot, secondSnapshot);
      console.log(
        `\nIdempotence check (second computeTaxLots run): lots=${second.lotsCreated} ` +
          `sales=${second.salesProcessed}`,
      );
      console.log(`  ${diff.identical ? "IDENTICAL" : "NOT IDENTICAL"}`);
      if (!diff.identical) {
        for (const d of diff.differences.slice(0, 20)) {
          console.log(`    ${d}`);
        }
        if (diff.differences.length > 20) {
          console.log(`    ... and ${diff.differences.length - 20} more`);
        }
      }
    }
  } finally {
    db.close();
  }
}

// Detect if this file is being run directly (not imported by tests) —
// mirrors scripts/repair-security-type-corruption.ts / repair-etf-types.ts.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("recompute-tax-lots-v2.ts") ||
    process.argv[1].endsWith("recompute-tax-lots-v2.js"));

if (isMain) {
  main().catch((err) => {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
