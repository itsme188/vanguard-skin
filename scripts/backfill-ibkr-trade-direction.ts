/**
 * Dry-run default. Explicit --db and --manifest required; no database singleton.
 * Manifest: [{ "batchId": 123, "path": "/absolute/original-statement.csv" }].
 * --apply backs up the DB first, then adds broker evidence to matching rows.
 * Run from the repository root. Rehearse on a copy before any live application.
 * Does not recompute lots or regenerate reviews.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { parseIbkrActivity } from "../lib/import/parsers/ibkr-activity";
import { backfillIbkrTradeDirection } from "../lib/mutations/ibkr-trade-direction";

async function main() {
  const args = process.argv.slice(2);
  const option = (key: string) => args[args.indexOf(key) + 1];
  if (!args.includes("--db") || !args.includes("--manifest")) {
    throw new Error("Required: --db <copy.db> --manifest <manifest.json> [--apply]");
  }
  const dbPath = path.resolve(option("--db"));
  const apply = args.includes("--apply");
  const manifest: unknown = JSON.parse(fs.readFileSync(option("--manifest"), "utf8"));
  if (!Array.isArray(manifest)) throw new Error("Manifest must be an array");
  const entries = manifest.map((entry: unknown) => {
    if (entry == null || typeof entry !== "object" ||
        !("batchId" in entry) || typeof entry.batchId !== "number" || !Number.isInteger(entry.batchId) ||
        !("path" in entry) || typeof entry.path !== "string" || !path.isAbsolute(entry.path)) {
      throw new Error("Each manifest entry requires an integer batchId and absolute path");
    }
    return { batchId: entry.batchId, path: entry.path };
  });
  if (new Set(entries.map((e) => e.batchId)).size !== entries.length) throw new Error("Duplicate batch in manifest");
  const db = new Database(dbPath, { readonly: !apply, fileMustExist: true });
  try {
    const prepared = entries.map((entry) => {
      const batch = db.prepare("SELECT filename FROM import_batches WHERE id=?").get(entry.batchId) as { filename: string } | undefined;
      if (batch?.filename !== path.basename(entry.path)) throw new Error(`Batch ${entry.batchId} filename does not match`);
      return { ...entry, transactions: parseIbkrActivity(fs.readFileSync(entry.path, "utf8"), batch.filename).transactions };
    });
    if (apply) {
      const backup = `${dbPath}.before-direction-${Date.now()}.bak`;
      await db.backup(backup);
      console.error(`Backup: ${backup}`);
    }
    const reports = db.transaction(() => prepared.map((entry) => ({
      batchId: entry.batchId,
      ...backfillIbkrTradeDirection(db, entry.batchId, entry.transactions, apply),
    })))();
    console.log(JSON.stringify({ applied: apply, reports }, null, 2));
  } finally { db.close(); }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
