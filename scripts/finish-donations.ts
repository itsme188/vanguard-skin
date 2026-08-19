/**
 * One-command finisher for the 2026-08-18 donation backfill (no app UI needed):
 *   1. Backup (VACUUM INTO data/backups/).
 *   2. Undo import batch "cien-missing-buy-backfill.csv" via lib undoImport —
 *      the same refusal-gated path the Import tab's Undo button uses. Removes
 *      the duplicate CIEN buy (the real one, txn 10201, was in the DB all
 *      along) and recomputes tax lots + daily valuations. Skips cleanly if
 *      the batch is already gone (idempotent).
 *   3. Assign lots for every remaining lot-less donation via
 *      runAssignment() from scripts/assign-donation-lots-by-method.ts.
 *   4. Print a final verification summary (links / stamps / lots coverage).
 *
 * NOTE: step 2's valuation recompute takes a few MINUTES on this dataset —
 * a long quiet pause after "Undoing batch…" is normal, not a hang.
 *
 * Usage:
 *   npx tsx scripts/finish-donations.ts           # dry-run (default)
 *   npx tsx scripts/finish-donations.ts --apply   # do everything
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { undoImport } from "@/lib/import/engine";
import { runAssignment } from "./assign-donation-lots-by-method";

const DB_PATH = path.join(process.cwd(), "data", "vanguard.db");
const UNDO_FILENAME = "cien-missing-buy-backfill.csv";

function main() {
  const apply = process.argv.includes("--apply");
  const db = new Database(DB_PATH, { timeout: 60000 });
  db.pragma("foreign_keys = ON");

  // ── Step 1+2: undo the duplicate-CIEN batch ──
  const batch = db
    .prepare("SELECT id, filename, status FROM import_batches WHERE filename = ?")
    .get(UNDO_FILENAME) as { id: number; filename: string; status: string } | undefined;

  if (!batch) {
    console.log(`\nUndo: batch '${UNDO_FILENAME}' not found — already undone, skipping.`);
  } else if (!apply) {
    const txns = db
      .prepare("SELECT COUNT(*) AS n FROM transactions WHERE import_batch_id = ?")
      .get(batch.id) as { n: number };
    console.log(`\nUndo (dry-run): would undo batch ${batch.id} '${batch.filename}' (${txns.n} transaction(s)) + recompute lots/valuations.`);
  } else {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = path.join(process.cwd(), "data", "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, `pre-finish-donations-${timestamp}.db`);
    db.prepare(`VACUUM INTO ?`).run(backupPath);
    console.log(`\nBackup: ${backupPath}`);
    console.log(`Undoing batch ${batch.id} '${batch.filename}' — the valuation recompute takes a few minutes, hang tight…`);
    undoImport(db, batch.id);
    console.log(`Undo complete.`);
  }

  // ── Step 3: lot assignment for everything still lot-less ──
  runAssignment(db, apply);

  // ── Step 4: verification summary ──
  const summary = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM donations WHERE kind='stock' AND reversed_date IS NULL) AS stock_donations,
        (SELECT COUNT(*) FROM donations d WHERE d.kind='stock' AND d.reversed_date IS NULL
           AND NOT EXISTS (SELECT 1 FROM donation_leg_links l WHERE l.donation_id=d.id AND l.role='out')) AS missing_link,
        (SELECT COUNT(*) FROM donation_leg_links l JOIN transactions t ON t.id=l.transaction_id
           WHERE l.role='out' AND COALESCE(t.amount,0)=0) AS unstamped_legs,
        (SELECT COUNT(*) FROM donations d WHERE d.kind='stock' AND d.reversed_date IS NULL
           AND NOT EXISTS (SELECT 1 FROM donation_lots dl WHERE dl.donation_id=d.id)) AS missing_lots,
        (SELECT COUNT(*) FROM (
           SELECT d.id FROM donations d JOIN donation_lots dl ON dl.donation_id=d.id
           WHERE d.kind='stock' GROUP BY d.id HAVING ABS(SUM(dl.quantity)-d.quantity) > 0.001)) AS lot_qty_mismatches,
        (SELECT COUNT(*) FROM transactions WHERE source_key LIKE '%CIEN:2025-04-10:BUY%') AS cien_apr_buys`
    )
    .get() as Record<string, number>;

  console.log(`\n── Verification ──`);
  console.log(`  stock donations (unreversed):        ${summary.stock_donations}`);
  console.log(`  missing out-link:                    ${summary.missing_link}  (want 0)`);
  console.log(`  confirmed out-legs still unstamped:  ${summary.unstamped_legs}  (want 0)`);
  console.log(`  donations without lots:              ${summary.missing_lots}  (want 0)`);
  console.log(`  lot-quantity mismatches:             ${summary.lot_qty_mismatches}  (want 0)`);
  console.log(`  CIEN 2025-04-10 buy rows:            ${summary.cien_apr_buys}  (want 1)`);

  const clean =
    summary.missing_link === 0 &&
    summary.unstamped_legs === 0 &&
    summary.missing_lots === 0 &&
    summary.lot_qty_mismatches === 0 &&
    summary.cien_apr_buys === 1;
  console.log(clean && apply ? `\nALL CLEAN — donations fully linked, stamped, and lotted. 🎉` : apply ? `\nNot fully clean — see counts above.` : `\n(dry-run — counts reflect current state, not the planned result)`);
  db.close();
}

main();
