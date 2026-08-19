/**
 * import-canonical-files.ts — Incrementally import one or more canonical CSV
 * files into the EXISTING live database (no reset). Mirrors the API route's
 * parse → commit path for headless/backfill use; deterministic source_keys
 * make re-imports no-ops.
 *
 * Usage:
 *   npx tsx scripts/import-canonical-files.ts <file.csv> [...more]        # dry-run (parse + counts only)
 *   npx tsx scripts/import-canonical-files.ts --commit <file.csv> [...]   # write
 *   npx tsx scripts/import-canonical-files.ts --commit --compute <files>  # + classify/tax-lots/valuations after
 *   npx tsx scripts/import-canonical-files.ts --db <path> ...             # DB override (default data/vanguard.db)
 *
 * Every commit creates an import_batches row per file (normal undo road).
 */

import fs from "node:fs";
import path from "node:path";

async function main() {
  const { default: Database } = await import("better-sqlite3");
  const { parseImport, commitImport } = await import("@/lib/import/engine");

  const args = process.argv.slice(2);
  const commit = args.includes("--commit");
  const compute = args.includes("--compute");
  const dbFlagIdx = args.indexOf("--db");
  const dbPath =
    dbFlagIdx !== -1 && args[dbFlagIdx + 1]
      ? args[dbFlagIdx + 1]
      : path.join(process.cwd(), "data", "vanguard.db");
  const files = args.filter(
    (a, i) => !a.startsWith("--") && (dbFlagIdx === -1 || i !== dbFlagIdx + 1)
  );

  if (files.length === 0) {
    console.error("No files given. Usage: npx tsx scripts/import-canonical-files.ts [--commit] [--compute] <file.csv> ...");
    process.exit(1);
  }
  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}`);
    process.exit(1);
  }

  // The live app may hold the write lock briefly during background sync.
  const db = new Database(dbPath, { timeout: 60000 });
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  console.log(`Importing ${files.length} file(s) into ${dbPath} ${commit ? "[COMMIT]" : "[DRY RUN]"}\n`);

  let anyErrors = false;
  for (const file of files) {
    const basename = path.basename(file);
    if (!fs.existsSync(file)) {
      console.log(`  ✗ ${basename} — file not found`);
      anyErrors = true;
      continue;
    }
    const content = fs.readFileSync(file, "utf-8");
    const parsed = await parseImport(content, basename);
    if (parsed.errors.length > 0) {
      console.log(`  ✗ ${basename} — parse errors:`);
      for (const e of parsed.errors) console.log(`      ${e}`);
      anyErrors = true;
      continue;
    }
    const counts =
      `txns=${parsed.transactions.length} holdings=${parsed.holdings.length} ` +
      `prices=${parsed.prices.length} snapshots=${parsed.snapshots.length}`;
    if (parsed.warnings.length > 0) {
      for (const w of parsed.warnings.slice(0, 8)) console.log(`  ⚠ ${basename}: ${w}`);
      if (parsed.warnings.length > 8) console.log(`  ⚠ ${basename}: … +${parsed.warnings.length - 8} more warnings`);
    }
    if (!commit) {
      console.log(`  ○ ${basename} — parsed OK (${counts})`);
      continue;
    }
    const result = commitImport(db, parsed);
    console.log(
      `  ✓ ${basename} — batch ${result.batchId}: +${result.newTransactions} txns ` +
        `(${result.skippedDuplicates} dup-skipped), +${result.newHoldings} holdings, +${result.newPrices} prices`
    );
  }

  if (commit && compute && !anyErrors) {
    const { classifySecurities } = await import("@/lib/compute/classify-securities");
    const { computeTaxLots } = await import("@/lib/compute/tax-lots");
    const { computeDailyValuations } = await import("@/lib/compute/daily-valuation");
    console.log("\nPost-import compute:");
    const cls = classifySecurities(db);
    console.log(`  classified ${JSON.stringify(cls).slice(0, 120)}`);
    const lots = computeTaxLots(db);
    console.log(`  tax lots: ${lots.lotsCreated} created`);
    const vals = computeDailyValuations(db);
    console.log(`  valuations: ${JSON.stringify(vals).slice(0, 120)}`);
  }
  db.close();
  if (anyErrors) process.exit(1);
}

main();
