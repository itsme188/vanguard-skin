/**
 * Backfill securities.maturity_date for bonds whose name carries an embedded
 * maturity date (Vanguard "DUE MM/DD/YY", IBKR "MTD YYYY-MM-DD", or
 * two-date treasury format).
 *
 * Idempotent: only touches rows where maturity_date IS NULL. Re-running after
 * an import is safe.
 *
 * Once populated, scripts/backfill-bond-durations.ts becomes useful (it gates
 * on maturity_date IS NOT NULL) and scenario rate-shock estimates use
 * per-bond duration instead of the 5-year flat fallback.
 *
 * Usage:
 *   npx tsx scripts/backfill-bond-maturity.ts          # write
 *   npx tsx scripts/backfill-bond-maturity.ts --dry-run # preview
 */

import { db } from "../lib/db";
import { extractMaturityDate } from "../lib/bonds";

const dryRun = process.argv.includes("--dry-run");

interface BondRow {
  id: number;
  symbol: string;
  name: string | null;
}

const bonds = db
  .prepare(
    `SELECT id, symbol, name FROM securities
     WHERE LOWER(security_type) = 'bond'
       AND maturity_date IS NULL
     ORDER BY symbol`,
  )
  .all() as BondRow[];

if (bonds.length === 0) {
  console.log("No bonds with NULL maturity_date.");
  process.exit(0);
}

console.log(
  `Scanning ${bonds.length} bond${bonds.length === 1 ? "" : "s"} with NULL maturity_date${dryRun ? " (dry-run)" : ""}...\n`,
);

const update = db.prepare(`UPDATE securities SET maturity_date = ? WHERE id = ?`);
let extracted = 0;
const skipped: BondRow[] = [];

for (const bond of bonds) {
  const maturity = bond.name ? extractMaturityDate(bond.name) : null;
  if (maturity) {
    if (!dryRun) update.run(maturity, bond.id);
    const symbolCol = bond.symbol.length > 28 ? bond.symbol.slice(0, 25) + "..." : bond.symbol;
    console.log(
      `  ${dryRun ? "·" : "✓"} ${symbolCol.padEnd(30)} ${maturity}   ${(bond.name ?? "").slice(0, 70)}`,
    );
    extracted++;
  } else {
    skipped.push(bond);
  }
}

console.log("\n" + "=".repeat(60));
console.log(`Extracted: ${extracted}/${bonds.length}${dryRun ? " (dry-run, no writes)" : ""}`);
console.log(`Skipped:   ${skipped.length}`);

if (skipped.length > 0) {
  console.log("\nSkipped (no recognized format — needs parser extension or manual entry):");
  for (const s of skipped) {
    console.log(`  id=${s.id} symbol=${s.symbol}  name="${s.name ?? ""}"`);
  }
}
