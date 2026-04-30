/**
 * Backfill securities.duration_years for held bonds with null duration.
 *
 * Estimate: years_to_maturity × 0.85. This is a simple but defensible
 * proxy — exact duration depends on coupon and YTM which we don't have
 * for most issues, but for investment-grade bonds 0.85 of remaining
 * maturity is within ~10% of true duration.
 *
 * Replaces the 5-year flat fallback in lib/compute/scenarios.ts so that
 * scenario rate-shock estimates are accurate per-bond rather than using
 * a single average.
 *
 * Usage:
 *   npx tsx scripts/backfill-bond-durations.ts          # write
 *   npx tsx scripts/backfill-bond-durations.ts --dry-run # preview
 */

import { db } from "../lib/db";

interface BondRow {
  id: number;
  symbol: string;
  name: string | null;
  maturity_date: string | null;
  duration_years: number | null;
}

const dryRun = process.argv.includes("--dry-run");

const bonds = db
  .prepare(
    `SELECT DISTINCT s.id, s.symbol, s.name, s.maturity_date, s.duration_years
     FROM securities s
     JOIN holdings h ON h.security_id = s.id
     WHERE LOWER(s.security_type) = 'bond'
       AND s.duration_years IS NULL
       AND s.maturity_date IS NOT NULL
       AND h.quantity > 0
     ORDER BY s.symbol`,
  )
  .all() as BondRow[];

if (bonds.length === 0) {
  console.log("No held bonds with null duration_years and known maturity_date.");
  process.exit(0);
}

const today = new Date();
today.setHours(0, 0, 0, 0);

const update = db.prepare(
  "UPDATE securities SET duration_years = ? WHERE id = ?",
);

let written = 0;
console.log(`${dryRun ? "[DRY-RUN] " : ""}Bond duration backfill — ${bonds.length} bonds:\n`);

for (const bond of bonds) {
  if (!bond.maturity_date) continue;
  const maturity = new Date(bond.maturity_date + "T00:00:00");
  const yearsToMaturity = (maturity.getTime() - today.getTime()) / (365.25 * 86_400_000);

  if (yearsToMaturity <= 0) {
    console.log(`  ${bond.symbol.padEnd(20)} matured (${bond.maturity_date}), skipping`);
    continue;
  }

  const duration = yearsToMaturity * 0.85;
  console.log(
    `  ${bond.symbol.padEnd(20)} maturity ${bond.maturity_date}  →  ${duration.toFixed(2)}y duration`,
  );

  if (!dryRun) {
    update.run(duration, bond.id);
    written++;
  }
}

console.log(
  `\n${dryRun ? "[DRY-RUN] would update" : "Updated"} ${written} bond rows.`,
);
