/**
 * restore-import-batch.ts — Operator recovery for an undone import batch
 * (task 20, #35 §G).
 *
 * `undoImport` deletes a batch's source rows and clears the derived tax-lot /
 * valuation layer before recompute — unrecoverable on its own. Before every
 * destructive undo, `undoImportWithRecovery` writes a checksum-sealed JSON
 * manifest to data/undo-recovery/<batchId>-<ts>.json. This script re-inserts
 * exactly those manifested rows, preserving the statement-authoritative
 * invariant (a restored statement holding/price/snapshot overwrites a live
 * row that took its slot, never the reverse), then regenerates the derived
 * layer.
 *
 * Usage:
 *   # restore from a specific manifest file
 *   npx tsx scripts/restore-import-batch.ts data/undo-recovery/12-2026-08-14T18-00-00-000Z.json
 *
 *   # restore the newest manifest for a given batch id
 *   npx tsx scripts/restore-import-batch.ts --batch 12
 *
 *   # list available manifests
 *   npx tsx scripts/restore-import-batch.ts --list
 *
 * Run with node@24 (see CLAUDE.md):
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/restore-import-batch.ts ...
 */

import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { db } from "@/lib/db";
import {
  defaultManifestDir,
  readRecoveryManifest,
  verifyManifest,
  restoreImportBatch,
} from "@/lib/import/recovery";

function listManifests(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse();
}

/** Newest manifest filename for a batch id, or null. */
function latestForBatch(dir: string, batchId: number): string | null {
  const match = listManifests(dir).filter((f) => f.startsWith(`${batchId}-`));
  return match.length > 0 ? match[0] : null;
}

function main(): void {
  const args = process.argv.slice(2);
  const dir = defaultManifestDir();

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(
      "Usage:\n" +
        "  restore-import-batch.ts <manifest.json>\n" +
        "  restore-import-batch.ts --batch <id>\n" +
        "  restore-import-batch.ts --list",
    );
    process.exit(args.length === 0 ? 1 : 0);
  }

  if (args[0] === "--list") {
    const files = listManifests(dir);
    if (files.length === 0) {
      console.log(`No recovery manifests in ${dir}`);
      return;
    }
    console.log(`Recovery manifests in ${dir} (newest first):`);
    for (const f of files) console.log(`  ${f}`);
    return;
  }

  let manifestPath: string;
  if (args[0] === "--batch") {
    const batchId = parseInt(args[1] ?? "", 10);
    if (Number.isNaN(batchId)) {
      console.error("--batch requires a numeric batch id");
      process.exit(1);
    }
    const found = latestForBatch(dir, batchId);
    if (!found) {
      console.error(`No recovery manifest found for batch ${batchId} in ${dir}`);
      process.exit(1);
    }
    manifestPath = join(dir, found);
  } else {
    manifestPath = args[0];
  }

  if (!existsSync(manifestPath)) {
    console.error(`Manifest not found: ${manifestPath}`);
    process.exit(1);
  }

  const manifest = readRecoveryManifest(manifestPath);
  if (!verifyManifest(manifest)) {
    console.error(`Refusing to restore: checksum does not validate for ${manifestPath}`);
    process.exit(1);
  }

  const existing = db.prepare("SELECT id FROM import_batches WHERE id = ?").get(manifest.batchId);
  if (existing) {
    console.warn(
      `Import batch ${manifest.batchId} already exists — restore will upsert rows (statement authority preserved) and recompute.`,
    );
  }

  console.log(`Restoring import batch ${manifest.batchId} from ${manifestPath} ...`);
  const result = restoreImportBatch(db, manifest);
  console.log("Restored rows:");
  for (const [table, n] of Object.entries(result.restored)) {
    console.log(`  ${table}: ${n}`);
  }
  console.log("Derived tax lots + daily valuations recomputed. Done.");
}

main();
