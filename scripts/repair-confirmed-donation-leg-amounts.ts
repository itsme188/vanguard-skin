/**
 * One-off repair: stamp FMV onto CONFIRMED donation out-legs left at amount 0.
 *
 * Gap this closes (2026-08-17): the Giving confirm-match UI links a donation
 * to its out-leg via POST /api/donations/[id]/links WITHOUT amountForOutLeg,
 * so the leg keeps amount 0/NULL. repair-inkind-transfer-fmv.ts only stamps
 * UNLINKED legs (its candidate pool requires no donation_leg_links row), so a
 * leg confirmed in the app before that script's --apply is never stamped by
 * either writer — violating the in-kind-FMV-in-amount invariant and hiding
 * the donation outflow from flow-adjusted return math.
 *
 * Stamp value = donations.fmv_usd — the DAF provider's authoritative FMV.
 * Guards (all must hold, else the row is report-only):
 *   - link role = 'out' and current leg amount is 0/NULL (idempotent)
 *   - leg quantity equals donation quantity (fmv_usd covers the full gift)
 *   - leg security matches the donation's security when both are set
 *
 * Usage:
 *   npx tsx scripts/repair-confirmed-donation-leg-amounts.ts           # dry-run (default)
 *   npx tsx scripts/repair-confirmed-donation-leg-amounts.ts --apply   # write
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const DB_PATH = path.join(process.cwd(), "data", "vanguard.db");
const EPS = 1e-9;

interface Row {
  donation_id: number;
  leg_id: number;
  trade_date: string;
  leg_type: string;
  symbol: string | null;
  leg_quantity: number | null;
  leg_security_id: number | null;
  donation_security_id: number | null;
  donation_quantity: number | null;
  fmv_usd: number;
}

function fetchUnstampedConfirmedOutLegs(db: Database.Database): Row[] {
  return db
    .prepare(
      `SELECT l.donation_id, t.id AS leg_id, t.trade_date, t.type AS leg_type,
              s.symbol, t.quantity AS leg_quantity, t.security_id AS leg_security_id,
              d.security_id AS donation_security_id, d.quantity AS donation_quantity,
              d.fmv_usd
       FROM donation_leg_links l
       JOIN transactions t ON t.id = l.transaction_id
       JOIN donations d ON d.id = l.donation_id
       LEFT JOIN securities s ON s.id = t.security_id
       WHERE l.role = 'out'
         AND COALESCE(t.amount, 0) = 0
       ORDER BY t.trade_date, t.id`
    )
    .all() as Row[];
}

function backupDatabase(db: Database.Database): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(process.cwd(), "data", "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `pre-confirmed-donation-leg-amounts-${timestamp}.db`);
  db.prepare(`VACUUM INTO ?`).run(backupPath);
  return backupPath;
}

function main() {
  const apply = process.argv.includes("--apply");
  // 60s lock wait — the live app's background sync can hold the write lock
  // past better-sqlite3's 5s default (SQLITE_BUSY seen 2026-08-17).
  const db = new Database(DB_PATH, { timeout: 60000 });
  db.pragma("foreign_keys = ON");

  const rows = fetchUnstampedConfirmedOutLegs(db);
  const writable: Row[] = [];
  const anomalies: { row: Row; reason: string }[] = [];

  for (const row of rows) {
    if (row.leg_quantity == null || row.donation_quantity == null) {
      anomalies.push({ row, reason: "leg or donation quantity missing — cannot verify fmv_usd covers the leg" });
    } else if (Math.abs(row.leg_quantity - row.donation_quantity) > EPS) {
      anomalies.push({
        row,
        reason: `leg quantity ${row.leg_quantity} != donation quantity ${row.donation_quantity} — partial-leg stamp needs manual review`,
      });
    } else if (
      row.leg_security_id != null &&
      row.donation_security_id != null &&
      row.leg_security_id !== row.donation_security_id
    ) {
      anomalies.push({ row, reason: "leg security differs from donation security — needs manual review" });
    } else {
      writable.push(row);
    }
  }

  console.log(`\n── Confirmed out-leg FMV stamps (UPDATE amount from donations.fmv_usd) — ${writable.length} ──`);
  for (const row of writable) {
    console.log(
      `  leg ${row.leg_id} (${row.symbol ?? "?"} ${row.leg_type} ${row.leg_quantity} on ${row.trade_date}): ` +
        `stamp amount ${row.fmv_usd.toFixed(2)} (donation ${row.donation_id} DAF fmv_usd)`
    );
  }

  console.log(`\n── Anomalies (report only) — ${anomalies.length} ──`);
  for (const { row, reason } of anomalies) {
    console.log(`  leg ${row.leg_id} (donation ${row.donation_id}): ${reason}`);
  }

  if (!apply) {
    console.log(`\nDry-run (default). Re-run with --apply to write ${writable.length} row(s).`);
    db.close();
    return;
  }

  if (writable.length === 0) {
    console.log(`\nNothing to write.`);
    db.close();
    return;
  }

  const backupPath = backupDatabase(db);
  console.log(`\nBackup: ${backupPath}`);

  const stamp = db.prepare(`UPDATE transactions SET amount = ? WHERE id = ? AND COALESCE(amount, 0) = 0`);
  const run = db.transaction(() => {
    let applied = 0;
    for (const row of writable) {
      applied += stamp.run(row.fmv_usd, row.leg_id).changes;
    }
    return applied;
  });
  const applied = run();
  console.log(`Applied ${applied} of ${writable.length} stamp(s).`);
  db.close();
}

main();
