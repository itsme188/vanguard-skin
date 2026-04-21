/**
 * Phase 3 backfill — upload every existing Vanguard/IBKR statement PDF to R2
 * and record the key in `import_batches.raw_file_r2_key`.
 *
 * Idempotent: skips uploads that already exist in R2, skips batches that
 * already have a r2 key recorded. Safe to run multiple times.
 *
 * Usage:
 *   npx tsx scripts/backfill-r2-statements.ts [--dry-run] [--source-dir=PATH]
 *
 * Default source dir: ~/Desktop/Portfolio - Dashboard/data/vanguard
 *
 * Env vars required: R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 * (R2_ACCOUNT_ID falls back to CLOUDFLARE_ACCOUNT_ID).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import Database from "better-sqlite3";
import {
  buildStatementKey,
  isR2Configured,
  statementExists,
  uploadStatementPdf,
} from "../lib/storage/r2";

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const sourceArg = args.find((a) => a.startsWith("--source-dir="));
  const sourceDir = sourceArg
    ? sourceArg.split("=")[1]
    : join(homedir(), "Desktop", "Portfolio - Dashboard", "data", "vanguard");

  if (!isR2Configured()) {
    console.error(
      "R2 is not configured. Set R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY in .env.local."
    );
    process.exit(1);
  }

  console.log(`Source: ${sourceDir}`);
  console.log(`Dry run: ${dryRun}`);
  console.log("");

  const dbPath = process.env.VANGUARD_DB_PATH ?? "data/vanguard.db";
  const db = new Database(dbPath);

  const updateBatch = db.prepare(
    `UPDATE import_batches SET raw_file_r2_key = ? WHERE filename = ? AND raw_file_r2_key IS NULL`
  );

  const allFiles = readdirSync(sourceDir)
    .filter((f) => f.toLowerCase().endsWith(".pdf"))
    .filter((f) => {
      try {
        return statSync(join(sourceDir, f)).isFile();
      } catch {
        return false;
      }
    });

  console.log(`Found ${allFiles.length} PDF(s) in source dir.\n`);

  let uploaded = 0;
  let skippedExists = 0;
  let skippedUnparseable = 0;
  let batchLinked = 0;
  let batchMissing = 0;

  for (const filename of allFiles) {
    // Backfill uses sourceType "vanguard_pdf" to match what the import
    // pipeline writes at commit time. Keeps keys consistent between paths.
    const key = buildStatementKey({
      sourceType: "vanguard_pdf",
      filename,
    });

    const existsInR2 = await statementExists(key);
    if (existsInR2) {
      console.log(`  exists in R2, skipping upload: ${key}`);
      skippedExists++;
    } else if (dryRun) {
      console.log(`  [dry-run] would upload: ${key}`);
    } else {
      const buffer = readFileSync(join(sourceDir, filename));
      await uploadStatementPdf(key, buffer);
      console.log(`  uploaded: ${key} (${(buffer.length / 1024).toFixed(0)} KB)`);
      uploaded++;
    }

    if (dryRun) continue;

    const result = updateBatch.run(key, filename);
    if (result.changes > 0) {
      batchLinked++;
    } else {
      batchMissing++;
    }
  }

  db.close();

  console.log("");
  console.log("Summary:");
  console.log(`  PDFs inspected:        ${allFiles.length}`);
  console.log(`  Uploaded:              ${uploaded}`);
  console.log(`  Already in R2:         ${skippedExists}`);
  console.log(`  import_batches linked: ${batchLinked}`);
  console.log(
    `  No matching batch row: ${batchMissing} (these PDFs aren't in the DB or already had a key)`
  );
  console.log(`  (skippedUnparseable counter retained for future non-PDF sources: ${skippedUnparseable})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
