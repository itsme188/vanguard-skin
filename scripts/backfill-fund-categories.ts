/**
 * backfill-fund-categories.ts — Normalize existing securities.fund_category
 * rows through normalizeFundCategory (single source). The Claude
 * classification fallback emitted bare sector names ("Technology",
 * "Semiconductor", "Financial Services") while the static map uses the
 * "US Sector Equity (X)" scheme, fragmenting the Classification allocation
 * into parallel buckets for the same exposure.
 *
 * Idempotent — only writes when the normalized value differs.
 *
 * Usage: npx tsx scripts/backfill-fund-categories.ts [--dry-run]
 */

import Database from "better-sqlite3";
import path from "node:path";
import { normalizeFundCategory } from "../lib/securities/normalize-fund-category";

const DB_PATH = path.join(process.cwd(), "data", "vanguard.db");

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  const rows = db
    .prepare(
      `SELECT id, symbol, fund_category FROM securities WHERE fund_category IS NOT NULL`
    )
    .all() as Array<{ id: number; symbol: string; fund_category: string }>;

  const update = db.prepare(`UPDATE securities SET fund_category = ? WHERE id = ?`);

  const changes = new Map<string, { to: string; count: number }>();
  let updated = 0;

  const run = db.transaction(() => {
    for (const row of rows) {
      const normalized = normalizeFundCategory(row.fund_category);
      if (normalized !== null && normalized !== row.fund_category) {
        if (!dryRun) update.run(normalized, row.id);
        updated++;
        const entry = changes.get(row.fund_category) ?? { to: normalized, count: 0 };
        entry.count++;
        changes.set(row.fund_category, entry);
      }
    }
  });
  run();

  console.log(`${dryRun ? "Would normalize" : "Normalized"} ${updated} of ${rows.length} classified securities:`);
  for (const [from, { to, count }] of [...changes.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${String(count).padStart(4)}  ${from} → ${to}`);
  }

  db.close();
}

main();
