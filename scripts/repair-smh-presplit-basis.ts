/**
 * One-off repair: normalize the three pre-split SMH rows to post-split basis.
 *
 * Root cause (found 2026-08-18 during donation lot assignment): VanEck ran a
 * 2-for-1 share split of SMH credited 2023-05-05 — the broker's own custom
 * activity report shows "5/5/2023  SMH  Stock split  35.4160" (the position
 * was exactly 35.416, doubling it to 70.832) — but the row was never
 * transcribed into dashboard_Vanguard_Brokerage_transactions_2023.csv, so
 * the engine's SMH ledger underlies reality by half. With the split applied
 * the account reconciles to the third decimal: 70.832 + 0.424 reinvest
 * − 36 sold (2024) + 0.151 reinvest = 35.407 → 35 donated 2025-04-10 +
 * 0.407 sold 2025-04-14 → 0. Without it, the 2024 sells looked like they
 * emptied the position and the 35-share donation had nothing to draw from.
 *
 * Fix follows the same product-preserving convention as
 * repair-goog-presplit-basis.ts: quantity ×2, price ÷2, `amount` (and the
 * source_key embedding it) untouched. Verified 2026-08-18: the three
 * account-1 rows below are the ONLY pre-2023-05-05 SMH rows in
 * transactions, holdings, or prices. Recomputes tax lots after the update.
 *
 * Usage:
 *   npx tsx scripts/repair-smh-presplit-basis.ts           # dry-run (default)
 *   npx tsx scripts/repair-smh-presplit-basis.ts --apply   # write
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { computeTaxLots } from "@/lib/compute/tax-lots";

const DB_PATH = path.join(process.cwd(), "data", "vanguard.db");

const SPLIT_RATIO = 2;
const SPLIT_DATE = "2023-05-05"; // credit date per the broker activity report

function main() {
  const apply = process.argv.includes("--apply");
  const db = new Database(DB_PATH, { timeout: 60000 });
  db.pragma("foreign_keys = ON");

  const rows = db
    .prepare(
      `SELECT t.id, t.trade_date, t.type, t.quantity, t.price_per_share, t.amount, s.symbol
       FROM transactions t JOIN securities s ON s.id = t.security_id
       WHERE s.symbol = 'SMH' AND t.trade_date < ? AND t.quantity IS NOT NULL
       ORDER BY t.trade_date`
    )
    .all(SPLIT_DATE) as {
    id: number; trade_date: string; type: string;
    quantity: number; price_per_share: number | null; amount: number | null; symbol: string;
  }[];

  console.log(`\n── Pre-split ${SPLIT_RATIO}:1 normalization (product-preserving) — ${rows.length} row(s) ──`);
  for (const r of rows) {
    const newQty = r.quantity * SPLIT_RATIO;
    const newPrice = r.price_per_share != null ? r.price_per_share / SPLIT_RATIO : null;
    console.log(
      `  txn ${r.id} (${r.symbol} ${r.type} ${r.trade_date}): ${r.quantity} sh @ ${r.price_per_share ?? "—"} ` +
        `-> ${newQty} sh @ ${newPrice != null ? newPrice.toFixed(6) : "—"} (amount ${r.amount ?? "—"} unchanged)`
    );
  }

  if (!apply) {
    console.log(`\nDry-run (default). Re-run with --apply to normalize ${rows.length} row(s) + recompute tax lots.`);
    db.close();
    return;
  }
  if (rows.length === 0) {
    console.log(`\nNothing to normalize.`);
    db.close();
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(process.cwd(), "data", "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `pre-smh-presplit-basis-${timestamp}.db`);
  db.prepare(`VACUUM INTO ?`).run(backupPath);
  console.log(`\nBackup: ${backupPath}`);

  const update = db.prepare(`UPDATE transactions SET quantity = ?, price_per_share = ? WHERE id = ?`);
  const run = db.transaction(() => {
    for (const r of rows) {
      update.run(r.quantity * SPLIT_RATIO, r.price_per_share != null ? r.price_per_share / SPLIT_RATIO : null, r.id);
    }
  });
  run();

  const lots = computeTaxLots(db);
  console.log(`Normalized ${rows.length} row(s); tax lots recomputed (${lots.lotsCreated} lots).`);
  db.close();
}

main();
