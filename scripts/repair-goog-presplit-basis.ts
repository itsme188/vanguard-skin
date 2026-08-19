/**
 * One-off repair: normalize the single pre-split GOOG BUY to post-split basis.
 *
 * Root cause (found 2026-08-18 during donation lot assignment): the
 * 2020-03-12 BUY of 3 GOOG @ $1,134.5118 predates Alphabet's 20-for-1 split
 * (completed 2022-07-15; split-adjusted trading began 2022-07-18). No
 * corporate-action row exists for it (the canonical CSV format carries no
 * CA rows and the split predates IBKR-parser coverage), so the tax-lot
 * replay treats the lot as 3 post-split shares — the engine could only find
 * 28.291 of the 35 GOOG shares donated on 2025-02-26.
 *
 * Fix follows the repo's split-basis convention (product-preserving
 * normalization, repair-split-basis-2024-year-end.ts precedent): 3 sh @
 * $1,134.5118 -> 60 sh @ $56.725667; `amount` (-3403.54) and therefore the
 * source_key (which embeds amount cents) are UNTOUCHED, so re-importing the
 * original canonical CSV stays a no-op. Verified 2026-08-18: this is the
 * ONLY pre-2022-07-18 GOOG/GOOGL row in transactions, holdings, or prices.
 * After the update the script recomputes tax lots (computeTaxLots).
 *
 * Usage:
 *   npx tsx scripts/repair-goog-presplit-basis.ts           # dry-run (default)
 *   npx tsx scripts/repair-goog-presplit-basis.ts --apply   # write
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { computeTaxLots } from "@/lib/compute/tax-lots";

const DB_PATH = path.join(process.cwd(), "data", "vanguard.db");

const SPLIT_RATIO = 20;
const SPLIT_TRADING_DATE = "2022-07-18";

function main() {
  const apply = process.argv.includes("--apply");
  const db = new Database(DB_PATH, { timeout: 60000 });
  db.pragma("foreign_keys = ON");

  // Sweep, don't hardcode the row id: every share-bearing GOOG/GOOGL row
  // before the split's first adjusted trading day is pre-split basis.
  const rows = db
    .prepare(
      `SELECT t.id, t.account_id, t.trade_date, t.type, t.quantity, t.price_per_share, t.amount, s.symbol
       FROM transactions t JOIN securities s ON s.id = t.security_id
       WHERE s.symbol IN ('GOOG','GOOGL') AND t.trade_date < ? AND t.quantity IS NOT NULL
       ORDER BY t.trade_date`
    )
    .all(SPLIT_TRADING_DATE) as {
    id: number; account_id: number; trade_date: string; type: string;
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
  const backupPath = path.join(backupDir, `pre-goog-presplit-basis-${timestamp}.db`);
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
