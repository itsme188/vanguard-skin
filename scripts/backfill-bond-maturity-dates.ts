/**
 * Backfill securities.maturity_date for bond rows where the column is NULL
 * but the name field contains a parseable date.
 *
 * Idempotent: only queries rows where maturity_date IS NULL. Re-running is safe.
 *
 * Once maturity_date is populated, scripts/backfill-bond-durations.ts becomes
 * useful (it gates on maturity_date IS NOT NULL) and scenario rate-shock
 * estimates use per-bond duration instead of the 5-year flat fallback.
 *
 * Usage:
 *   DATABASE_PATH=/path/to/vanguard.db npx tsx scripts/backfill-bond-maturity-dates.ts
 *   DATABASE_PATH=/path/to/vanguard.db npx tsx scripts/backfill-bond-maturity-dates.ts --dry-run
 *
 * The extractor is in lib/bonds.ts (shared with vanguard-pdf parser and upsertSecurity).
 */

// Re-export for plan-spec test compatibility — actual logic lives in lib/bonds.ts
export { extractMaturityDate } from "@/lib/bonds";

import Database from "better-sqlite3";
import path from "path";
import { extractMaturityDate } from "@/lib/bonds";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const dbPath =
    process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "vanguard.db");

  const db = new Database(dbPath);

  const rows = db
    .prepare(
      `SELECT id, symbol, name
       FROM securities
       WHERE LOWER(security_type) = 'bond'
         AND maturity_date IS NULL
         AND name IS NOT NULL
       ORDER BY symbol`,
    )
    .all() as Array<{ id: number; symbol: string; name: string }>;

  if (rows.length === 0) {
    console.log("No bonds with NULL maturity_date — nothing to do.");
    return;
  }

  console.log(
    `Scanning ${rows.length} bond${rows.length === 1 ? "" : "s"} with NULL maturity_date${dryRun ? " (dry-run)" : ""}...\n`,
  );

  const update = db.prepare("UPDATE securities SET maturity_date = ? WHERE id = ?");
  let updated = 0;
  let skipped = 0;

  for (const r of rows) {
    const parsed = extractMaturityDate(r.name);
    if (parsed) {
      if (!dryRun) update.run(parsed, r.id);
      const sym = r.symbol.length > 28 ? r.symbol.slice(0, 25) + "..." : r.symbol;
      console.log(
        `  ${dryRun ? "·" : "✓"} ${sym.padEnd(30)} ${parsed}   "${r.name.slice(0, 70)}"`,
      );
      updated++;
    } else {
      console.log(`  SKIP  ${r.symbol.padEnd(30)}  (no date in "${r.name.slice(0, 70)}")`);
      skipped++;
    }
  }

  console.log("\n" + "─".repeat(70));
  console.log(
    `Backfill ${dryRun ? "preview (no writes)" : "complete"}: ${updated} updated, ${skipped} skipped`,
  );

  if (skipped > 0 && !dryRun) {
    console.log(
      "\nSkipped bonds need manual maturity_date entry via the securities editor\n" +
        "or a POST /api/calendar/events actuals override.",
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
