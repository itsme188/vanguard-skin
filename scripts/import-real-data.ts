/**
 * import-real-data.ts — Reset the database and import real portfolio data.
 *
 * Usage:
 *   npx tsx scripts/import-real-data.ts
 *
 * Sources: ~/Desktop/Portfolio - Dashboard/data/
 * Imports: monthly values, IBKR activity + holdings, Vanguard holdings + cost basis, factors
 */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { runMigrations } from "../lib/db/migrate";
import { parseImport } from "../lib/import/engine";
import { commitImport, type CommitResult } from "../lib/import/engine";
import { classifySecurities } from "../lib/compute/classify-securities";
import { computeTaxLots } from "../lib/compute/tax-lots";
import { computeDailyValuations } from "../lib/compute/daily-valuation";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "vanguard.db");
const SOURCE_DIR = path.resolve(
  process.env.HOME!,
  "Desktop/Portfolio - Dashboard/data"
);

// Files to import, in order. Paths relative to SOURCE_DIR.
const IMPORT_FILES = [
  // 1. Historical monthly account values (ground truth totals from broker statements)
  "reconciliation/monthly_values.csv",
  // 2. IBKR full year 2025 activity (trades, dividends, fees)
  "ibkr/IBKR 2025 activity statement.csv",
  // 3. IBKR 2026 YTD activity
  "vanguard/IBKR YTD activity 2-25-2026.csv",
  // 4. IBKR current holdings — single source of truth for IBKR positions
  "ibkr/holdings_current.csv",
  // 5. Vanguard Taxable YTD — single source for Taxable holdings + transactions + prices
  "vanguard/3-27-26 Vanguard YTD Holdings csv.csv",
  // 6. Vanguard Roth IRA YTD — single source for Roth holdings + prices
  "vanguard/Roth YTD 4-01-26.csv",
  // 7. Vanguard cost basis (per-lot detail — updates cost_basis on existing holdings only)
  "vanguard/Vanguard cost basis 3-23-26.csv",
  // 8. Factor/sector mapping
  "sector_mapping.csv",
];

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Vanguard Skin — Real Data Import");
  console.log("═══════════════════════════════════════════════════════════\n");

  // Step 1: Delete existing database
  for (const ext of ["", "-shm", "-wal"]) {
    const p = DB_PATH + ext;
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log(`  Deleted ${path.basename(p)}`);
    }
  }

  // Step 2: Create fresh database with migrations
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  console.log("\n  ✓ Fresh database created with migrations\n");

  // Step 3: Import each file
  let totalResults: CommitResult[] = [];
  let fileNum = 0;

  for (const relPath of IMPORT_FILES) {
    fileNum++;
    const fullPath = path.join(SOURCE_DIR, relPath);
    const basename = path.basename(relPath);

    if (!fs.existsSync(fullPath)) {
      console.log(`  [${fileNum}/${IMPORT_FILES.length}] SKIP ${basename} — file not found`);
      continue;
    }

    process.stdout.write(
      `  [${fileNum}/${IMPORT_FILES.length}] ${basename}...`
    );

    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      const parsed = await parseImport(content, basename);

      if (parsed.errors.length > 0) {
        console.log(` ERRORS:`);
        for (const e of parsed.errors) console.log(`    ✗ ${e}`);
        continue;
      }

      const totalRecords =
        parsed.transactions.length +
        parsed.holdings.length +
        parsed.prices.length +
        parsed.snapshots.length +
        (parsed.factors?.length ?? 0);

      if (totalRecords === 0) {
        console.log(` (empty — 0 records)`);
        continue;
      }

      const result = commitImport(db, parsed);
      totalResults.push(result);

      const parts = [
        result.newTransactions > 0 ? `${result.newTransactions} txns` : null,
        result.newHoldings > 0 ? `${result.newHoldings} holdings` : null,
        result.newPrices > 0 ? `${result.newPrices} prices` : null,
        result.newSnapshots > 0 ? `${result.newSnapshots} snapshots` : null,
        result.newFactors > 0 ? `${result.newFactors} factors` : null,
        result.skippedDuplicates > 0
          ? `${result.skippedDuplicates} dupes skipped`
          : null,
      ]
        .filter(Boolean)
        .join(", ");

      console.log(` ✓ ${parts}`);

      if (parsed.warnings.length > 0) {
        for (const w of parsed.warnings) console.log(`    ⚠ ${w}`);
      }
      if (result.unmatchedFactors && result.unmatchedFactors.length > 0) {
        console.log(
          `    ⚠ Unmatched factor symbols: ${result.unmatchedFactors.join(", ")}`
        );
      }
    } catch (err) {
      console.log(` FAILED: ${(err as Error).message}`);
    }
  }

  // Step 4: Post-import computations
  console.log("\n───────────────────────────────────────────────────────────");
  console.log("  Post-import computations\n");

  process.stdout.write("  Classifying securities...");
  const classResult = classifySecurities(db);
  console.log(` ✓ ${classResult.classified} classified`);

  process.stdout.write("  Computing tax lots (FIFO)...");
  const taxResult = computeTaxLots(db);
  console.log(
    ` ✓ ${taxResult.lotsCreated} lots created, ${taxResult.salesProcessed} sales processed`
  );

  process.stdout.write("  Computing daily valuations...");
  const valResult = computeDailyValuations(db);
  console.log(` ✓ ${valResult.datesComputed} dates, ${valResult.accountsProcessed} accounts`);

  // Step 5: Summary
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  Summary\n");

  const totals = totalResults.reduce(
    (acc, r) => ({
      transactions: acc.transactions + r.newTransactions,
      holdings: acc.holdings + r.newHoldings,
      prices: acc.prices + r.newPrices,
      snapshots: acc.snapshots + r.newSnapshots,
      securities: acc.securities + r.newSecurities,
      factors: acc.factors + r.newFactors,
      dupes: acc.dupes + r.skippedDuplicates,
    }),
    {
      transactions: 0,
      holdings: 0,
      prices: 0,
      snapshots: 0,
      securities: 0,
      factors: 0,
      dupes: 0,
    }
  );

  console.log(`  Securities:    ${totals.securities}`);
  console.log(`  Transactions:  ${totals.transactions}`);
  console.log(`  Holdings:      ${totals.holdings}`);
  console.log(`  Prices:        ${totals.prices}`);
  console.log(`  Snapshots:     ${totals.snapshots}`);
  console.log(`  Factors:       ${totals.factors}`);
  console.log(`  Dupes skipped: ${totals.dupes}`);
  console.log(
    `\n  Database: ${DB_PATH} (${(fs.statSync(DB_PATH).size / 1024).toFixed(0)} KB)`
  );
  console.log("═══════════════════════════════════════════════════════════\n");

  db.close();
}

main().catch((err) => {
  console.error("\nFatal error:", err);
  process.exit(1);
});
