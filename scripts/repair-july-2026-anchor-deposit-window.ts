/**
 * Repair: July 2026 pre-Plaid anchor window missing the 07-02 $40k deposit
 * (Vanguard Taxable, account 1).
 *
 * Before Plaid daily anchoring went live on 2026-07-11, daily_valuations
 * cash was a residual plug anchored to the June-30 statement — frozen at
 * exactly $[REDACTED] through 07-10. The recorded 2026-07-02 DEPOSIT of
 * [REDACTED] (ACH, transactions row exists, is_external_flow=1) was therefore
 * invisible to the VALUATION series until the first Plaid anchor released
 * it on 07-11. That leaves two fake flow-adjusted return days poisoning
 * vol/Sharpe/drawdown: 07-03 (flow recorded, no value move → fake −2.9%)
 * and 07-11 (value jump, no flow → part of the fake +7.1%).
 *
 * Fix: add the [REDACTED] to cash_balance AND total_value on the rows dated
 * 2026-07-02..2026-07-10 (in practice 07-03/06/07/09/10 — no 07-02 row
 * exists), so the deposit appears in the series from the day it arrived.
 * The 07-11 artifact shrinks to the [REDACTED] stale-pricing drift, which the
 * data-confidence cash-flow flag discloses (user-decided 2026-08-12: the
 * residual drift is NOT reconstructed — see
 * qa:analysis-risk-decomposition--vol-drawdown-sharpe-count-cash-flows-as-returns).
 *
 * Idempotent: only rows whose cash_balance still equals the stale plug
 * value ($[REDACTED] ± $0.01) are touched — a second --apply run finds zero
 * rows. Dry-run by default; --apply takes a VACUUM INTO backup first and
 * writes inside one transaction.
 *
 * Usage:
 *   npx tsx scripts/repair-july-2026-anchor-deposit-window.ts          # dry-run
 *   npx tsx scripts/repair-july-2026-anchor-deposit-window.ts --apply  # write
 */
import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

const ACCOUNT_ID = 1; // Vanguard Taxable
const WINDOW_START = "2026-07-02"; // deposit trade_date
const WINDOW_END = "2026-07-10"; // last pre-Plaid-anchor row
const STALE_PLUG_CASH = [REDACTED]; // June-30 anchor plug, frozen through 07-10
const PLUG_TOLERANCE = 0.01;
const DEPOSIT_AMOUNT = [REDACTED]; // recorded 2026-07-02 ACH deposit

interface RepairRow {
  id: number;
  valuation_date: string;
  total_value: number;
  cash_balance: number;
}

export interface RepairResult {
  candidates: RepairRow[];
  applied: boolean;
}

/** Rows still carrying the stale plug inside the deposit window. */
export function findRepairRows(db: Database.Database): RepairRow[] {
  return db
    .prepare(
      `SELECT id, valuation_date, total_value, cash_balance
       FROM daily_valuations
       WHERE account_id = ?
         AND valuation_date BETWEEN ? AND ?
         AND ABS(cash_balance - ?) <= ?
       ORDER BY valuation_date`
    )
    .all(ACCOUNT_ID, WINDOW_START, WINDOW_END, STALE_PLUG_CASH, PLUG_TOLERANCE) as RepairRow[];
}

export function runRepair(db: Database.Database, apply: boolean): RepairResult {
  const candidates = findRepairRows(db);
  if (apply && candidates.length > 0) {
    const update = db.prepare(
      `UPDATE daily_valuations
       SET cash_balance = cash_balance + ?, total_value = total_value + ?
       WHERE id = ?`
    );
    const tx = db.transaction((rows: RepairRow[]) => {
      for (const r of rows) update.run(DEPOSIT_AMOUNT, DEPOSIT_AMOUNT, r.id);
    });
    tx(candidates);
  }
  return { candidates, applied: apply };
}

// ── Backup (mirrors scripts/repair-etf-types.ts::backupDatabase) ──────
function backupDatabase(db: Database.Database): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(process.cwd(), "data", "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `pre-july-anchor-deposit-repair-${timestamp}.db`);
  db.prepare("VACUUM INTO ?").run(backupPath);
  if (fs.statSync(backupPath).size === 0) {
    throw new Error(
      `backup at ${backupPath} is 0 bytes — aborting, refusing to write without a verified backup`
    );
  }
  return backupPath;
}

function main() {
  const apply = process.argv.includes("--apply");
  const dbPath = path.join(process.cwd(), "data", "vanguard.db");
  const db = new Database(dbPath, apply ? {} : { readonly: true });
  try {
    if (apply) {
      const backupPath = backupDatabase(db);
      console.log(`Backup: ${backupPath}`);
    }
    const result = runRepair(db, apply);
    console.log(
      `July 2026 anchor-window deposit repair [${apply ? "APPLY" : "DRY RUN"}] — account ${ACCOUNT_ID}, window ${WINDOW_START}..${WINDOW_END}`
    );
    if (result.candidates.length === 0) {
      console.log(
        "No rows carry the stale plug cash value — nothing to do (already repaired or window absent)."
      );
      return;
    }
    for (const r of result.candidates) {
      console.log(
        `  ${r.valuation_date}: cash ${r.cash_balance.toFixed(2)} -> ${(r.cash_balance + DEPOSIT_AMOUNT).toFixed(2)}, ` +
          `total ${r.total_value.toFixed(2)} -> ${(r.total_value + DEPOSIT_AMOUNT).toFixed(2)}` +
          `${apply ? "  [written]" : ""}`
      );
    }
    console.log(
      `${result.candidates.length} row(s) ${apply ? "updated" : "would be updated"} (+$${DEPOSIT_AMOUNT.toLocaleString()} cash & total).`
    );
    if (apply) {
      console.log(
        "Reminder: force-regenerate any cached AI risk narrative (POST /api/analysis/narrative) — the old prose reads the artifact as real risk."
      );
    } else {
      console.log("Dry-run (default). Re-run with --apply to write.");
    }
  } finally {
    db.close();
  }
}

// tsx runs this file directly; only execute when invoked as a script (the
// vitest import path must not fire main()).
if (process.argv[1] && process.argv[1].includes("repair-july-2026-anchor-deposit-window")) {
  main();
}
